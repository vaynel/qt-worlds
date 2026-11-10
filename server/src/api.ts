import type { IncomingMessage, ServerResponse } from 'node:http';
import { safeReturn, type MockProvider, type OidcFlow, type Sessions, type SessionUser, type Users } from './auth.js';
import { HttpError, originAllowed, RateLimiter, readJson, redirect, requestInfo, sendJson, type RequestInfo } from './http.js';
import type { GroupChatService, GroupService, LanternService, WordBookService } from './services.js';
import type { GroupMessage } from '../../shared/protocol.js';
import { TokenBucket } from './rateLimit.js';
import type { PushService } from './push.js';
import type { AccountService } from './account.js';
import { TERMS_VERSION } from '../../shared/protocol.js';

/** What the API tells the realtime room about. */
export interface RoomEvents {
  lanternChanged(id: number): void;
  lanternRemoved(id: number): void;
  membershipChanged(userId: number): void;
  nicknameChanged(userId: number, nickname: string): void;
  voiceCount(groupId: number): number;
  groupChat(message: GroupMessage, update: boolean): void;
  groupRead(userId: number, groupId: number, lastReadId: number): void;
  /** 회원 탈퇴: take the lanterns down for everyone and drop that account's connections. */
  accountDeleted(userId: number, lanternIds: number[]): void;
}

/** ICE servers for WebRTC: short-lived Cloudflare TURN credentials, minted server-side. */
export class IceServers {
  private readonly cache = new Map<number, { servers: unknown[]; expires: number }>();
  private warned = false;
  private readonly keyId = process.env.TURN_KEY_ID?.trim() ?? '';
  private readonly token = process.env.TURN_KEY_API_TOKEN?.trim() ?? '';
  /** Overridable for tests (a local mock of the Cloudflare API). */
  private readonly base = (process.env.TURN_API_BASE?.trim() || 'https://rtc.live.cloudflare.com').replace(/\/$/, '');
  static readonly TTL_S = 1800;
  /** Re-use minted credentials per user for a few minutes. */
  static readonly CACHE_MS = 5 * 60 * 1000;
  calls = 0;

  get configured(): boolean {
    return !!(this.keyId && this.token);
  }

  /** Only urls/username/credential are passed on: never the API key or token. */
  private sanitize(list: unknown): unknown[] {
    if (!Array.isArray(list)) return [];
    const out: unknown[] = [];
    for (const raw of list.slice(0, 8)) {
      if (!raw || typeof raw !== 'object') continue;
      const s = raw as Record<string, unknown>;
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u): u is string => typeof u === 'string' && /^(stun|turns?):/.test(u)).slice(0, 8);
      if (urls.length === 0) continue;
      const entry: Record<string, unknown> = { urls };
      if (typeof s.username === 'string') entry.username = s.username;
      if (typeof s.credential === 'string') entry.credential = s.credential;
      out.push(entry);
    }
    return out;
  }

  async forUser(userId: number): Promise<unknown[]> {
    const hit = this.cache.get(userId);
    if (hit && hit.expires > Date.now()) return hit.servers;
    if (!this.configured) {
      if (!this.warned) {
        console.warn('TURN_KEY_ID / TURN_KEY_API_TOKEN not set: voice uses STUN only (may fail behind CGNAT)');
        this.warned = true;
      }
      return [{ urls: ['stun:stun.cloudflare.com:3478'] }];
    }
    this.calls++;
    const res = await fetch(`${this.base}/v1/turn/keys/${encodeURIComponent(this.keyId)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: IceServers.TTL_S }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (!res || !res.ok) {
      console.error(`TURN credential request failed (${res?.status ?? 'network'})`);
      return [{ urls: ['stun:stun.cloudflare.com:3478'] }];
    }
    const servers = this.sanitize(((await res.json().catch(() => ({}))) as { iceServers?: unknown }).iceServers);
    this.cache.set(userId, { servers, expires: Date.now() + IceServers.CACHE_MS });
    if (this.cache.size > 5000) this.cache.clear();
    return servers;
  }

  forget(userId: number) {
    this.cache.delete(userId);
  }
}

export interface ApiDeps {
  sessions: Sessions;
  users: Users;
  oidc: OidcFlow;
  mock: MockProvider | null;
  wordbook: WordBookService;
  groups: GroupService;
  lanterns: LanternService;
  room: RoomEvents;
  ice: IceServers;
  chat: GroupChatService;
  push: PushService;
  accounts: AccountService;
  /** Test-only endpoints (simulated clock). Never in production. */
  testMode: boolean;
}

type Handler = (ctx: Ctx) => Promise<void> | void;
interface RouteOpts {
  /**
   * Allowed before agreeing to the current terms. Writes that create or share
   * something are blocked until then; leaving, deleting, consenting, logging out
   * and the 정보주체 rights (export, 탈퇴) are not. DELETE routes are always open.
   */
  consentFree?: boolean;
}
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  info: RequestInfo;
  params: string[];
  query: URLSearchParams;
  user: SessionUser | null;
}

const id = (s: string) => {
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'not_found', '찾을 수 없어요.');
  return n;
};

export class Api {
  private readonly routes: { method: string; pattern: RegExp; handler: Handler; opts: RouteOpts }[] = [];
  private readonly ipLimit = new RateLimiter(600, 60_000);
  private readonly authLimit = new RateLimiter(Number(process.env.AUTH_RATE_LIMIT ?? 30), 60_000);
  private readonly nicknameLimit = new RateLimiter(10, 3_600_000);
  private readonly joinLimit = new RateLimiter(10, 60_000);
  private readonly iceLimit = new RateLimiter(10, 60_000);
  private readonly pushLimit = new RateLimiter(30, 3_600_000);
  private readonly exportLimit = new RateLimiter(Number(process.env.EXPORT_RATE_LIMIT ?? 10), 3_600_000);
  private readonly deleteLimit = new RateLimiter(5, 3_600_000);
  private readonly deleteIpLimit = new RateLimiter(20, 3_600_000);
  /** Group chat: burst 5, then 1 every 2 s, per user. */
  private readonly chatBuckets = new Map<number, TokenBucket>();

  private chatAllowed(userId: number): boolean {
    let b = this.chatBuckets.get(userId);
    if (!b) {
      b = new TokenBucket(5, 0.5);
      this.chatBuckets.set(userId, b);
      if (this.chatBuckets.size > 10_000) this.chatBuckets.clear();
    }
    return b.take();
  }

  constructor(private readonly d: ApiDeps) {
    const r = (method: string, path: string, handler: Handler, opts: RouteOpts = {}) =>
      this.routes.push({ method, pattern: new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`), handler, opts });
    const open: RouteOpts = { consentFree: true };

    // ---------------- auth
    r('GET', '/api/auth/config', ({ res }) =>
      sendJson(res, 200, { ready: d.oidc.enabled, provider: d.oidc.providerName, push: d.push.enabled }),
    );
    r('GET', '/api/auth/google/start', ({ res, info, query }) => {
      this.limit(this.authLimit, `ip:${info.ip}`);
      const { location, setCookie } = d.oidc.start(info, query.get('remember') === '1', query.get('hint'), safeReturn(query.get('return')));
      redirect(res, location, { 'set-cookie': setCookie });
    });
    r('GET', '/api/auth/google/callback', async ({ req, res, info, query }) => {
      this.limit(this.authLimit, `ip:${info.ip}`);
      try {
        const { setCookies, needsNickname, returnTo } = await d.oidc.callback(req, info, query);
        const back = new URL(returnTo, 'http://x');
        back.searchParams.set('login', needsNickname ? 'nickname' : 'ok');
        redirect(res, `${back.pathname}${back.search}`, { 'set-cookie': setCookies });
      } catch (err) {
        const code = err instanceof HttpError ? err.code : 'error';
        if (!(err instanceof HttpError)) console.error('oauth callback failed', err);
        redirect(res, `/?login_error=${encodeURIComponent(code)}`);
      }
    });
    if (d.mock) {
      const mock = d.mock;
      r('GET', '/api/auth/mock/authorize', ({ res, query }) => {
        const out = mock.authorize(query);
        if (out.redirect) return redirect(res, out.redirect);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(out.html);
      });
      r('POST', '/api/auth/mock/token', async ({ req, res }) => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const out = await mock.token(new URLSearchParams(Buffer.concat(chunks).toString('utf-8')));
        sendJson(res, out.status, out.body);
      });
    }
    r(
      'POST',
      '/api/auth/logout',
      ({ req, res, info }) => {
        sendJson(res, 200, { ok: true }, { 'set-cookie': d.sessions.destroy(req, info) });
      },
      open,
    );
    r('GET', '/api/me', ({ res, user }) => {
      sendJson(res, 200, {
        user: user ? { id: user.id, nickname: user.nickname, onboarded: user.onboarded } : null,
        needsNickname: !!user && !user.nickname,
        // Accounts from before M7 (or after a terms update) are asked once, gently.
        needsConsent: !!user && !!user.nickname && !user.consented,
        termsVersion: TERMS_VERSION,
      });
    });
    r(
      'POST',
      '/api/me/onboarded',
      ({ res, user }) => {
        const u = this.signedIn(user, false);
        d.users.markOnboarded(u.id);
        sendJson(res, 200, { ok: true });
      },
      open,
    );
    r('POST', '/api/me/nickname', async ({ req, res, user }) => {
      const u = this.signedIn(user, false);
      this.limit(this.nicknameLimit, `user:${u.id}`);
      const body = await readJson(req);
      // Finishing sign-up needs 만 14세 이상 + 이용약관/개인정보처리방침 consent.
      const agree = body.agree === true;
      if (!u.nickname && !agree) throw new HttpError(400, 'consent_required', '만 14세 이상인지 확인하고 이용약관과 개인정보처리방침에 동의해 주세요.');
      const nickname = d.users.setNickname(u.id, body.nickname);
      if (agree) d.users.recordConsent(u.id);
      d.room.nicknameChanged(u.id, nickname);
      sendJson(res, 200, { user: { id: u.id, nickname } });
    });
    r(
      'POST',
      '/api/me/consent',
      async ({ req, res, user }) => {
        const u = this.signedIn(user, false);
        if ((await readJson(req)).agree !== true) throw new HttpError(400, 'consent_required', '만 14세 이상인지 확인하고 동의해 주세요.');
        d.users.recordConsent(u.id);
        sendJson(res, 200, { ok: true, termsVersion: TERMS_VERSION });
      },
      open,
    );
    // 정보주체 권리: 열람 (내 데이터 내려받기) and 삭제 (회원 탈퇴). No consent needed for either.
    r('GET', '/api/me/export', ({ res, user, info }) => {
      const u = this.signedIn(user, false);
      this.limit(this.exportLimit, `user:${u.id}`);
      this.limit(this.exportLimit, `ip:${info.ip}`);
      const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
      sendJson(res, 200, d.accounts.export(u.id), { 'content-disposition': `attachment; filename="qt-world-my-data-${day}.json"` });
    });
    r(
      'POST',
      '/api/me/delete',
      async ({ req, res, user, info }) => {
        const u = this.signedIn(user, false);
        this.limit(this.deleteLimit, `user:${u.id}`);
        this.limit(this.deleteIpLimit, `ip:${info.ip}`);
        const body = await readJson(req);
        const out = d.accounts.delete(u.id, body.nickname);
        // Live: lanterns go dark for everyone, counts drop, sockets of this account close.
        d.room.accountDeleted(u.id, out.lanternIds);
        for (const lid of out.reactedLanternIds) d.room.lanternChanged(lid);
        for (const t of out.transferred) {
          d.room.groupChat(d.chat.system(t.groupId, `모임을 만든 분이 떠나서 ${t.newOwner}님이 모임장이 되었어요`), false);
          d.room.membershipChanged(t.newOwnerId);
        }
        d.push.forget(u.id);
        d.ice.forget(u.id);
        this.chatBuckets.delete(u.id);
        console.log(`account deleted: user ${u.id} (${out.lanternIds.length} lanterns, ${out.transferred.length} groups handed over, ${out.deletedGroups.length} groups removed)`);
        sendJson(res, 200, { ok: true, deletedGroups: out.deletedGroups.length, transferredGroups: out.transferred.length }, { 'set-cookie': d.sessions.clearCookie(info) });
      },
      open,
    );

    // ---------------- word book (owner only)
    r('GET', '/api/wordbook', ({ res, user }) => sendJson(res, 200, d.wordbook.list(this.signedIn(user).id)));
    r('PUT', '/api/wordbook/pages/:date', ({ res, user, params }) => {
      const date = d.wordbook.ensurePage(this.signedIn(user).id, params[0]);
      sendJson(res, 200, { date });
    });
    r('POST', '/api/wordbook/meditations', async ({ req, res, user }) => {
      const u = this.signedIn(user);
      sendJson(res, 201, d.wordbook.addMeditation(u.id, await readJson(req)));
    });
    r('GET', '/api/wordbook/meditations/:id', ({ res, user, params }) => sendJson(res, 200, d.wordbook.get(this.signedIn(user).id, id(params[0]))));
    r('PATCH', '/api/wordbook/meditations/:id', async ({ req, res, user, params }) => {
      const u = this.signedIn(user);
      sendJson(res, 200, d.wordbook.update(u.id, id(params[0]), await readJson(req)));
    });
    r('DELETE', '/api/wordbook/meditations/:id', ({ res, user, params }) => {
      const removed = d.wordbook.delete(this.signedIn(user).id, id(params[0]));
      for (const l of removed) d.room.lanternRemoved(l);
      sendJson(res, 200, { ok: true, lanternsRemoved: removed });
    });
    r('POST', '/api/wordbook/import', async ({ req, res, user }) => {
      const u = this.signedIn(user);
      sendJson(res, 200, d.wordbook.import(u.id, await readJson(req)));
    });
    r('DELETE', '/api/wordbook/saved/:id', ({ res, user, params }) => {
      const lanternId = id(params[0]);
      d.lanterns.unsave(this.signedIn(user).id, lanternId);
      d.room.lanternChanged(lanternId);
      sendJson(res, 200, { ok: true });
    });

    // ---------------- groups
    r('GET', '/api/groups', ({ res, user }) =>
      sendJson(res, 200, {
        groups: d.groups.list(this.signedIn(user).id).map((g) => ({ ...g, voice: d.room.voiceCount(g.id), unread: d.chat.unread(user!.id, g.id) })),
      }),
    );

    // ---------------- 모임 채팅 (members only; others get 404)
    r('GET', '/api/groups/:id/messages', ({ res, user, params, query }) => {
      const u = this.signedIn(user);
      const before = query.get('before') ? Number(query.get('before')) : null;
      sendJson(res, 200, d.chat.list(u.id, id(params[0]), Number.isInteger(before) ? before : null));
    });
    r('POST', '/api/groups/:id/messages', async ({ req, res, user, params }) => {
      const u = this.signedIn(user);
      const gid = id(params[0]);
      const body = await readJson(req);
      if (!d.groups.isMember(u.id, gid)) throw new HttpError(404, 'not_found', '모임을 찾을 수 없어요.');
      if (!this.chatAllowed(u.id)) throw new HttpError(429, 'rate_limited', '조금 천천히 보내 주세요.');
      const m = d.chat.post(u.id, gid, body.text);
      d.room.groupChat(m, false);
      d.room.groupRead(u.id, gid, m.id);
      sendJson(res, 201, m);
    });
    r('DELETE', '/api/groups/:id/messages/:mid', ({ res, user, params }) => {
      const m = d.chat.remove(this.signedIn(user).id, id(params[0]), id(params[1]));
      d.room.groupChat(m, true);
      sendJson(res, 200, m);
    });
    r(
      'POST',
      '/api/groups/:id/messages/:mid/hide',
      ({ res, user, params }) => {
        const m = d.chat.hide(this.signedIn(user).id, id(params[0]), id(params[1]));
        d.room.groupChat(m, true);
        sendJson(res, 200, m);
      },
      open,
    );
    r(
      'POST',
      '/api/groups/:id/read',
      async ({ req, res, user, params }) => {
        const u = this.signedIn(user);
        const gid = id(params[0]);
        const body = await readJson(req);
        const last = d.chat.markRead(u.id, gid, Number(body.lastId));
        d.room.groupRead(u.id, gid, last);
        sendJson(res, 200, { lastReadId: last, unread: d.chat.unread(u.id, gid) });
      },
      open,
    );
    if (d.testMode) {
      // Test-only: purge as if the clock were `days` later.
      r('POST', '/api/test/chat-purge', async ({ req, res }) => {
        const days = Number((await readJson(req)).days) || 0;
        sendJson(res, 200, { removed: d.chat.purge(Date.now() + days * 86_400_000) });
      });
    }

    // ---------------- web push (signed-in accounts only; guests can't subscribe)
    const pushOn = () => {
      if (!d.push.enabled) throw new HttpError(404, 'push_disabled', '알림을 쓸 수 없어요.');
    };
    r('GET', '/api/push/key', ({ res, user }) => {
      this.signedIn(user);
      pushOn();
      sendJson(res, 200, { publicKey: d.push.publicKey });
    });
    r('POST', '/api/push/subscribe', async ({ req, res, user }) => {
      const u = this.signedIn(user);
      pushOn();
      this.limit(this.pushLimit, `user:${u.id}`);
      const body = await readJson(req);
      sendJson(res, 200, d.push.subscribe(u.id, body, String(req.headers['user-agent'] ?? '')));
    });
    r(
      'POST',
      '/api/push/unsubscribe',
      async ({ req, res, user }) => {
        const u = this.signedIn(user);
        pushOn();
        sendJson(res, 200, d.push.unsubscribe(u.id, await readJson(req)));
      },
      open,
    );
    r('GET', '/api/push/prefs', ({ res, user }) => {
      const u = this.signedIn(user);
      pushOn();
      sendJson(res, 200, d.push.prefs(u.id));
    });
    r('PUT', '/api/push/prefs', async ({ req, res, user }) => {
      const u = this.signedIn(user);
      pushOn();
      sendJson(res, 200, d.push.setPrefs(u.id, await readJson(req)));
    });
    if (d.testMode && d.push.mock) {
      // Test-only: drive the scheduler with a fake clock and inspect mock deliveries.
      r('POST', '/api/test/push/clock', async ({ req, res }) => {
        const now = (await readJson(req)).now;
        d.push.now = typeof now === 'number' ? () => now : () => Date.now();
        sendJson(res, 200, { now: d.push.now() });
      });
      r('POST', '/api/test/push/tick', async ({ res }) => sendJson(res, 200, await d.push.tick()));
      r('GET', '/api/test/push/sent', ({ res }) => sendJson(res, 200, { deliveries: d.push.deliveries }));
      r('POST', '/api/test/push/reset', ({ res }) => {
        d.push.deliveries.length = 0;
        sendJson(res, 200, { ok: true });
      });
      r('POST', '/api/test/push/status', async ({ req, res }) => {
        const b = await readJson(req);
        d.push.mockStatus.set(String(b.endpoint), Number(b.status));
        sendJson(res, 200, { ok: true });
      });
    }

    // ---------------- voice (ICE servers for group members only)
    r('GET', '/api/voice/ice', async ({ res, user, query }) => {
      const u = this.signedIn(user);
      const groupId = Number(query.get('group'));
      if (!Number.isInteger(groupId) || !d.groups.isMember(u.id, groupId)) throw new HttpError(403, 'voice_not_member', '모임 사람만 음성 기도방을 쓸 수 있어요.');
      this.limit(this.iceLimit, `user:${u.id}`);
      sendJson(res, 200, { iceServers: await d.ice.forUser(u.id) });
    });
    r('POST', '/api/groups', async ({ req, res, user }) => {
      const u = this.signedIn(user);
      const g = d.groups.create(u.id, (await readJson(req)).name);
      d.room.membershipChanged(u.id);
      d.room.groupChat(d.chat.system(g.id, `${u.nickname}님이 모임을 만들었어요`), false);
      sendJson(res, 201, g);
    });
    r('POST', '/api/groups/join', async ({ req, res, user }) => {
      const u = this.signedIn(user);
      this.limit(this.joinLimit, `user:${u.id}`);
      const before = d.groups.list(u.id).length;
      const g = d.groups.join(u.id, (await readJson(req)).code);
      d.room.membershipChanged(u.id);
      if (d.groups.list(u.id).length > before) d.room.groupChat(d.chat.system(g.id, `${u.nickname}님이 모임에 함께했어요`), false);
      sendJson(res, 200, g);
    });
    r(
      'POST',
      '/api/groups/:id/leave',
      ({ res, user, params }) => {
        const u = this.signedIn(user);
        const gid = id(params[0]);
        d.groups.leave(u.id, gid);
        d.room.membershipChanged(u.id);
        d.room.groupChat(d.chat.system(gid, `${u.nickname}님이 모임을 떠났어요`), false);
        sendJson(res, 200, { ok: true });
      },
      open,
    );

    // ---------------- lanterns (visibility enforced in LanternService)
    r('GET', '/api/lanterns', ({ res, user }) => sendJson(res, 200, { lanterns: d.lanterns.listFor(user?.id ?? null) }));
    r('POST', '/api/lanterns', async ({ req, res, user }) => {
      const u = this.signedIn(user);
      const lid = d.lanterns.create(u.id, await readJson(req));
      d.room.lanternChanged(lid);
      sendJson(res, 201, d.lanterns.detail(lid, u.id));
    });
    r('GET', '/api/lanterns/:id', ({ res, user, params }) => sendJson(res, 200, d.lanterns.detail(id(params[0]), user?.id ?? null)));
    r('DELETE', '/api/lanterns/:id', ({ res, user, params }) => {
      const lid = id(params[0]);
      d.lanterns.remove(this.signedIn(user).id, lid);
      d.room.lanternRemoved(lid);
      sendJson(res, 200, { ok: true });
    });
    r('POST', '/api/lanterns/:id/reactions', async ({ req, res, user, params }) => {
      const u = this.signedIn(user);
      const lid = id(params[0]);
      const type = (await readJson(req)).type;
      const detail = d.lanterns.toggle(u.id, lid, type);
      d.room.lanternChanged(lid);
      // 🤲 to the lantern's author (never who prayed; throttled and batched in PushService).
      if (type === 'pray' && detail.myReactions.includes('pray')) void d.push.prayed(lid, u.id).catch((e) => console.error('push prayed', e));
      sendJson(res, 200, detail);
    });
  }

  private limit(limiter: RateLimiter, key: string) {
    if (!limiter.hit(key)) throw new HttpError(429, 'rate_limited', '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.');
  }

  /** Writes need an account with a nickname; guests get a gentle 401. */
  private signedIn(user: SessionUser | null, needNickname = true): SessionUser {
    if (!user) throw new HttpError(401, 'login_required', '로그인하면 저장하고 나눌 수 있어요.');
    if (needNickname && !user.nickname) throw new HttpError(403, 'needs_nickname', '먼저 닉네임을 정해 주세요.');
    return user;
  }

  /** Returns false when the path isn't an API route. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith('/api/')) return false;
    const info = requestInfo(req);
    try {
      this.limit(this.ipLimit, `ip:${info.ip}`);
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD' && !originAllowed(req, info)) {
        throw new HttpError(403, 'origin', '허용되지 않은 요청이에요.');
      }
      let matchedPath = false;
      for (const route of this.routes) {
        const m = route.pattern.exec(url.pathname);
        if (!m) continue;
        matchedPath = true;
        if (route.method !== method) continue;
        const user = this.d.sessions.user(req);
        // Saving and sharing wait until the account agrees to the current terms.
        const writes = method !== 'GET' && method !== 'HEAD' && method !== 'DELETE';
        if (writes && !route.opts.consentFree && user?.nickname && !user.consented) {
          throw new HttpError(403, 'needs_consent', '이용약관과 개인정보처리방침에 동의하면 저장하고 나눌 수 있어요. ⚙ 설정 → 계정에서 동의할 수 있어요.');
        }
        await route.handler({
          req,
          res,
          info,
          params: m.slice(1).map((p) => decodeURIComponent(p)),
          query: url.searchParams,
          user,
        });
        return true;
      }
      throw matchedPath ? new HttpError(405, 'method', '지원하지 않는 요청이에요.') : new HttpError(404, 'not_found', '찾을 수 없어요.');
    } catch (err) {
      if (res.headersSent) return true;
      if (err instanceof HttpError) sendJson(res, err.status, { error: err.code, message: err.message });
      else {
        console.error('api error', err);
        sendJson(res, 500, { error: 'server', message: '잠시 문제가 생겼어요.' });
      }
      return true;
    }
  }
}
