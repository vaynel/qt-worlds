import type { IncomingMessage, ServerResponse } from 'node:http';
import { adminEmails, isAdmin, safeReturn, type MockProvider, type OidcFlow, type Sessions, type SessionUser, type Users } from './auth.js';
import { HttpError, originAllowed, RateLimiter, readJson, redirect, requestInfo, sendJson, type RequestInfo } from './http.js';
import type { GroupChatService, GroupService, LanternService, WordBookService } from './services.js';
import type { GroupMessage } from '../../shared/protocol.js';
import { TokenBucket } from './rateLimit.js';
import type { PushService } from './push.js';
import type { AccountService } from './account.js';
import type { LookService } from './looks.js';
import type { ShopService } from './shop.js';
import { kstDateOf, SHOT_MAX_BYTES, TERMS_VERSION } from '../../shared/protocol.js';
import type { FootprintService } from './footprints.js';
import type { LibraryService } from './library.js';
import { readBody, type ShotService } from './shots.js';

/** What the API tells the realtime room about. */
export interface RoomEvents {
  lanternChanged(id: number): void;
  lanternRemoved(id: number): void;
  membershipChanged(userId: number): void;
  nicknameChanged(userId: number, nickname: string): void;
  voiceCount(groupId: number): number;
  groupChat(message: GroupMessage, update: boolean): void;
  groupRead(userId: number, groupId: number, lastReadId: number): void;
  /** 꾸미기: that account's appearance or worn drawing changed (or was hidden/restored). */
  lookChanged(userId: number): void;
  /** 회원 탈퇴: take the lanterns down for everyone and drop that account's connections. */
  accountDeleted(userId: number, lanternIds: number[]): void;
  /** 이야기 도서관: books were added, removed, hidden or restored (shelf counts for people inside). */
  libraryChanged(): void;
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
  looks: LookService;
  shop: ShopService;
  library: LibraryService;
  footprints: FootprintService;
  shots: ShotService;
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
  private readonly ipLimit = new RateLimiter(Number(process.env.IP_RATE_LIMIT ?? 600), 60_000);
  private readonly authLimit = new RateLimiter(Number(process.env.AUTH_RATE_LIMIT ?? 30), 60_000);
  private readonly nicknameLimit = new RateLimiter(10, 3_600_000);
  private readonly joinLimit = new RateLimiter(10, 60_000);
  private readonly iceLimit = new RateLimiter(10, 60_000);
  private readonly pushLimit = new RateLimiter(30, 3_600_000);
  private readonly exportLimit = new RateLimiter(Number(process.env.EXPORT_RATE_LIMIT ?? 10), 3_600_000);
  private readonly deleteLimit = new RateLimiter(5, 3_600_000);
  private readonly deleteIpLimit = new RateLimiter(20, 3_600_000);
  private readonly lookLimit = new RateLimiter(Number(process.env.LOOK_RATE_LIMIT ?? 60), 3_600_000);
  private readonly outfitLimit = new RateLimiter(Number(process.env.OUTFIT_RATE_LIMIT ?? 20), 3_600_000);
  private readonly reportLimit = new RateLimiter(30, 3_600_000);
  private readonly shopLimit = new RateLimiter(Number(process.env.SHOP_RATE_LIMIT ?? 60), 600_000);
  private readonly storyReportLimit = new RateLimiter(Number(process.env.STORY_REPORT_RATE_LIMIT ?? 30), 3_600_000);
  private readonly libraryWriteLimit = new RateLimiter(Number(process.env.LIBRARY_RATE_LIMIT ?? 240), 3_600_000);
  private readonly shotLimit = new RateLimiter(60, 3_600_000);
  private readonly admins = adminEmails();
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
        ...(isAdmin(user, this.admins) ? { admin: true } : {}),
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
      d.footprints.forget(u.id);
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
        d.footprints.forget(u.id);
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
        d.room.libraryChanged();
        this.chatBuckets.delete(u.id);
        console.log(`account deleted: user ${u.id} (${out.lanternIds.length} lanterns, ${out.transferred.length} groups handed over, ${out.deletedGroups.length} groups removed)`);
        sendJson(res, 200, { ok: true, deletedGroups: out.deletedGroups.length, transferredGroups: out.transferred.length }, { 'set-cookie': d.sessions.clearCookie(info) });
      },
      open,
    );

    // ---------------- 꾸미기 (M8): appearance and pixel outfits (signed-in accounts only)
    r('GET', '/api/me/look', ({ res, user }) => sendJson(res, 200, d.looks.mine(this.signedIn(user).id)));
    r('PUT', '/api/me/look', async ({ req, res, user }) => {
      const u = this.signedIn(user);
      this.limit(this.lookLimit, `user:${u.id}`);
      const body = await readJson(req);
      const mine = d.looks.setLook(u.id, body.appearance, body.worn);
      d.room.lookChanged(u.id);
      sendJson(res, 200, mine);
    });
    r('PUT', '/api/me/outfits/:slot', async ({ req, res, user, params }) => {
      const u = this.signedIn(user);
      const slot = Number(params[0]);
      const body = await readJson(req);
      this.limit(this.outfitLimit, `user:${u.id}`);
      const out = d.looks.saveOutfit(u.id, slot, body.pixels);
      if (out.wornChanged) d.room.lookChanged(u.id);
      sendJson(res, 200, out.mine);
    });
    r('DELETE', '/api/me/outfits/:slot', ({ res, user, params }) => {
      const u = this.signedIn(user);
      const out = d.looks.deleteOutfit(u.id, Number(params[0]));
      if (out.wornChanged) d.room.lookChanged(u.id);
      sendJson(res, 200, out.mine);
    });
    // Pixels by id, batched (?ids=1,2,3): a crowd joining costs one small request.
    r('GET', '/api/outfits', ({ res, user, query }) => {
      const ids = [...new Set((query.get('ids') ?? '').split(',').map(Number))].filter((n) => Number.isInteger(n) && n > 0).slice(0, 60);
      sendJson(res, 200, { outfits: d.looks.pixels(ids, user?.id ?? null, isAdmin(user, this.admins)) }, { 'cache-control': 'private, max-age=60' });
    });
    r('POST', '/api/outfits/:id/report', async ({ req, res, user, params }) => {
      const u = this.signedIn(user);
      const oid = id(params[0]);
      const body = await readJson(req);
      this.limit(this.reportLimit, `user:${u.id}`);
      const out = d.looks.report(u.id, oid, body.reason);
      if (out.changed) {
        d.room.lookChanged(out.ownerId);
        console.log(`outfit ${oid} hidden after ${out.reporters} reports`);
      }
      sendJson(res, 200, { ok: true, duplicate: out.duplicate });
    });

    // ---------------- admin (WORLDS_ADMIN_EMAILS). Everyone else gets a plain 404.
    r('GET', '/api/admin/outfits', ({ res, user }) => {
      this.admin(user);
      sendJson(res, 200, { outfits: d.looks.adminList() });
    }, open);
    r('POST', '/api/admin/outfits/:id', async ({ req, res, user, params }) => {
      const u = this.admin(user);
      const oid = id(params[0]);
      const body = await readJson(req);
      const out = d.looks.adminAction(oid, body.action, body.days);
      d.room.lookChanged(out.ownerId);
      console.log(`admin ${u.id}: outfit ${oid} ${String(body.action).slice(0, 10)}`);
      sendJson(res, 200, { ok: true });
    }, open);

    // ---------------- 나눔 소품 가게 (M9). Everyone may look; renting needs an account,
    // a nickname and consent (the route table blocks writes until consent).
    r('GET', '/api/shop', ({ res, user }) => {
      sendJson(res, 200, { shop: d.shop.status(), mine: user?.nickname ? d.shop.mine(user.id) : null, signedIn: !!user?.nickname });
    });
    r('POST', '/api/shop/rent', async ({ req, res, user }) => {
      const u = this.signedIn(user);
      const body = await readJson(req);
      this.limit(this.shopLimit, `user:${u.id}`);
      const out = d.shop.rent(u.id, body.requestId, body.item);
      if (out.ok && !out.replayed) d.footprints.event(u.id, 'rent', String(out.rental.id), { item: out.rental.item });
      const extra = { shop: d.shop.status(), mine: d.shop.mine(u.id), replayed: out.replayed };
      if (out.ok) sendJson(res, 200, { ok: true, rental: out.rental, ...extra });
      else sendJson(res, out.status, { error: out.error, message: out.message, ...extra });
    });
    // 반납 is always allowed (even before agreeing to new terms): it only gives something back.
    r(
      'POST',
      '/api/shop/return',
      async ({ req, res, user }) => {
        const u = this.signedIn(user);
        const body = await readJson(req);
        this.limit(this.shopLimit, `user:${u.id}`);
        const out = d.shop.returnRental(u.id, body.rentalId);
        sendJson(res, 200, { ...out, mine: d.shop.mine(u.id) });
      },
      open,
    );
    r('GET', '/api/admin/shop', ({ res, user }) => {
      this.admin(user);
      sendJson(res, 200, d.shop.adminOverview());
    }, open);
    r('PUT', '/api/admin/shop/stock', async ({ req, res, user }) => {
      const u = this.admin(user);
      const body = await readJson(req);
      const out = d.shop.adminSetWindowStock(body.win, body.item, body.total);
      console.log(`admin ${u.id}: shop stock window ${Number(body.win)} ${String(body.item).slice(0, 12)} = ${Number(body.total)}`);
      sendJson(res, 200, out);
    }, open);
    r('PUT', '/api/admin/shop/defaults', async ({ req, res, user }) => {
      const u = this.admin(user);
      const body = await readJson(req);
      const out = d.shop.adminSetDefault(body.item, body.stock);
      console.log(`admin ${u.id}: shop default ${String(body.item).slice(0, 12)} = ${Number(body.stock)}`);
      sendJson(res, 200, out);
    }, open);
    if (d.testMode) {
      // Test-only fake clock for the shop (windows, expiry, reminders). Never in production.
      r('POST', '/api/test/shop/clock', async ({ req, res }) => {
        const now = (await readJson(req)).now;
        d.shop.now = typeof now === 'number' && Number.isFinite(now) ? () => now : () => Date.now();
        if (d.push.mock) d.push.now = d.shop.now;
        // Everyone's clock offset follows the jump (a real clock never jumps).
        d.shop.events?.shopChanged();
        sendJson(res, 200, { now: d.shop.now(), shop: d.shop.status() });
      });
      r('POST', '/api/test/shop/tick', async ({ res }) => sendJson(res, 200, await d.shop.tick()));
      r('POST', '/api/test/shop/ensure', async ({ res }) => {
        const s = d.shop.status();
        sendJson(res, 200, { added: s.open && s.win !== null ? d.shop.ensureStock(s.date, s.win) : 0, shop: d.shop.status() });
      });
    }

    // ---------------- word book (owner only)
    r('GET', '/api/wordbook', ({ res, user }) => sendJson(res, 200, d.wordbook.list(this.signedIn(user).id)));
    r('PUT', '/api/wordbook/pages/:date', ({ res, user, params }) => {
      const date = d.wordbook.ensurePage(this.signedIn(user).id, params[0]);
      sendJson(res, 200, { date });
    });
    r('POST', '/api/wordbook/meditations', async ({ req, res, user }) => {
      const u = this.signedIn(user);
      const m = d.wordbook.addMeditation(u.id, await readJson(req));
      // 발자취: where, and the first ~40 characters of my own words.
      const text = (m.meditation || m.feeling || m.application).replace(/\s+/g, ' ').trim();
      const chars = [...text];
      d.footprints.event(u.id, 'meditation', String(m.id), { place: m.place, excerpt: chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : text });
      sendJson(res, 201, m);
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

    // ---------------- 이야기 도서관 (L-A). Reading is open to everyone (visibility is
    // enforced in LibraryService); writing needs an account, a nickname and consent.
    const lib = d.library;
    const viewer = (user: SessionUser | null) => (user?.nickname ? user.id : null);
    r('GET', '/api/library/shelves', ({ res, user }) => sendJson(res, 200, { shelves: lib.shelfCounts(viewer(user)) }));
    r('GET', '/api/library/shelves/:shelf', ({ res, user, params, query }) => sendJson(res, 200, lib.list(viewer(user), params[0], query.get('page'))));
    r('GET', '/api/library/today', ({ res, user }) => sendJson(res, 200, { items: lib.today(viewer(user)) }));
    r('GET', '/api/library/popular', ({ res, user }) => sendJson(res, 200, { items: lib.popular(viewer(user)) }));
    r('GET', '/api/library/mine', ({ res, user }) => sendJson(res, 200, lib.mine(this.signedIn(user).id)));
    r('GET', '/api/library/stories/:id', ({ res, user, params }) => sendJson(res, 200, lib.detail(id(params[0]), viewer(user), isAdmin(user, this.admins))));
    r('POST', '/api/library/stories', async ({ req, res, user }) => {
      const u = this.signedIn(user);
      this.limit(this.libraryWriteLimit, `user:${u.id}`);
      const story = lib.createTestimony(u.id, await readJson(req));
      d.room.libraryChanged();
      sendJson(res, 201, story);
    });
    r('PUT', '/api/library/stories/:id', async ({ req, res, user, params }) => {
      const u = this.signedIn(user);
      this.limit(this.libraryWriteLimit, `user:${u.id}`);
      const story = lib.updateTestimony(u.id, id(params[0]), await readJson(req));
      d.room.libraryChanged();
      sendJson(res, 200, story);
    });
    r('DELETE', '/api/library/stories/:id', ({ res, user, params }) => {
      lib.delete(this.signedIn(user).id, id(params[0]));
      d.room.libraryChanged();
      sendJson(res, 200, { ok: true });
    });
    r('POST', '/api/library/stories/:id/reactions', async ({ req, res, user, params }) => {
      const u = this.signedIn(user);
      this.limit(this.libraryWriteLimit, `user:${u.id}`);
      sendJson(res, 200, lib.react(u.id, id(params[0]), (await readJson(req)).type));
    });
    r('POST', '/api/library/stories/:id/bookmark', ({ res, user, params }) => {
      const u = this.signedIn(user);
      this.limit(this.libraryWriteLimit, `user:${u.id}`);
      sendJson(res, 200, lib.bookmark(u.id, id(params[0])));
    });
    r('POST', '/api/library/stories/:id/report', async ({ req, res, user, params }) => {
      const u = this.signedIn(user);
      const sid = id(params[0]);
      const body = await readJson(req);
      this.limit(this.storyReportLimit, `user:${u.id}`);
      const out = lib.report(u.id, sid, body.reason);
      if (out.changed) {
        console.log(`story ${sid} hidden after reports`);
        d.room.libraryChanged();
      }
      sendJson(res, 200, { ok: true, duplicate: out.duplicate });
    });
    r('GET', '/api/library/draft', ({ res, user }) => sendJson(res, 200, lib.getDraft(this.signedIn(user).id)));
    r('PUT', '/api/library/draft', async ({ req, res, user }) => {
      const u = this.signedIn(user);
      this.limit(this.libraryWriteLimit, `user:${u.id}`);
      sendJson(res, 200, lib.saveDraft(u.id, await readJson(req)));
    });
    r('DELETE', '/api/library/draft', ({ res, user }) => {
      lib.deleteDraft(this.signedIn(user).id);
      sendJson(res, 200, { ok: true });
    });
    // 📔 오늘의 일기: the template draft (only my own 발자취), and publish/replace today's diary.
    r('GET', '/api/diary/draft', ({ res, user }) => sendJson(res, 200, lib.diaryDraft(this.signedIn(user).id)));
    r('POST', '/api/diary', async ({ req, res, user }) => {
      const u = this.signedIn(user);
      this.limit(this.libraryWriteLimit, `user:${u.id}`);
      const story = lib.publishDiary(u.id, await readJson(req));
      d.room.libraryChanged();
      sendJson(res, 200, story);
    });
    // 발자취 settings (private to the account).
    r('GET', '/api/footprints', ({ res, user }) => sendJson(res, 200, d.footprints.summary(this.signedIn(user).id, kstDateOf(d.footprints.now()))));
    r(
      'PUT',
      '/api/footprints/settings',
      async ({ req, res, user }) => {
        const u = this.signedIn(user);
        d.footprints.setEnabled(u.id, (await readJson(req)).enabled === true);
        sendJson(res, 200, d.footprints.summary(u.id, kstDateOf(d.footprints.now())));
      },
      open,
    );
    r('DELETE', '/api/footprints/today', ({ res, user }) => {
      const u = this.signedIn(user);
      const removed = d.footprints.clearDay(u.id, kstDateOf(d.footprints.now()));
      sendJson(res, 200, { removed, ...d.footprints.summary(u.id, kstDateOf(d.footprints.now())) });
    });
    r('POST', '/api/footprints/letter', ({ res, user }) => {
      const u = this.signedIn(user);
      const now = d.footprints.now();
      sendJson(res, 200, { recorded: d.footprints.event(u.id, 'letter', kstDateOf(now), {}, now) });
    });
    // 📸 screenshots: owner-only until a published diary shows them.
    r('POST', '/api/shots', async ({ req, res, user, query }) => {
      const u = this.signedIn(user);
      this.limit(this.shotLimit, `user:${u.id}`);
      const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (type !== 'image/webp' && type !== 'image/jpeg') throw new HttpError(415, 'bad_type', 'WebP나 JPEG 사진만 올릴 수 있어요.');
      const buf = await readBody(req, SHOT_MAX_BYTES);
      const shot = d.shots.upload(u.id, buf, type, query.get('place'));
      d.footprints.event(u.id, 'shot', String(shot.id), { shotId: shot.id });
      sendJson(res, 201, { shot, usedToday: d.shots.usedToday(u.id) });
    });
    r('GET', '/api/shots', ({ res, user, query }) => {
      const u = this.signedIn(user);
      const date = query.get('date');
      sendJson(res, 200, { shots: d.shots.list(u.id, date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined), usedToday: d.shots.usedToday(u.id) });
    });
    r('GET', '/api/shots/:id', ({ res, user, params }) => {
      const sid = id(params[0]);
      const row = d.shots.row(sid);
      if (!row || !lib.canSeeShot(sid, row.user_id, viewer(user) ?? user?.id ?? null, isAdmin(user, this.admins))) throw new HttpError(404, 'not_found', '사진을 찾을 수 없어요.');
      const data = d.shots.read(row);
      if (!data) throw new HttpError(404, 'not_found', '사진을 찾을 수 없어요.');
      res.writeHead(200, { 'content-type': row.mime, 'content-length': data.length, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
      res.end(data);
    });
    r('DELETE', '/api/shots/:id', ({ res, user, params }) => {
      const u = this.signedIn(user);
      const sid = id(params[0]);
      d.shots.delete(u.id, sid);
      d.footprints.forgetEvent(u.id, 'shot', String(sid));
      d.room.libraryChanged();
      sendJson(res, 200, { ok: true });
    });
    r('GET', '/api/admin/library', ({ res, user }) => {
      this.admin(user);
      sendJson(res, 200, { stories: lib.adminList() });
    }, open);
    r('POST', '/api/admin/library/:id', async ({ req, res, user, params }) => {
      const u = this.admin(user);
      const sid = id(params[0]);
      const body = await readJson(req);
      lib.adminAction(sid, body.action, body.days);
      d.room.libraryChanged();
      console.log(`admin ${u.id}: story ${sid} ${String(body.action).slice(0, 10)}`);
      sendJson(res, 200, { ok: true });
    }, open);
    if (d.testMode) {
      // Test-only: run the 발자취/screenshot 파기 as if the clock were `days` later.
      r('POST', '/api/test/library/sweep', async ({ req, res }) => {
        const days = Number((await readJson(req)).days) || 0;
        const at = Date.now() + days * 86_400_000;
        sendJson(res, 200, { footprints: d.footprints.sweep(at), shots: d.shots.sweep(at) });
      });
    }

    // ---------------- lanterns (visibility enforced in LanternService)
    r('GET', '/api/lanterns', ({ res, user }) => sendJson(res, 200, { lanterns: d.lanterns.listFor(user?.id ?? null) }));
    r('POST', '/api/lanterns', async ({ req, res, user }) => {
      const u = this.signedIn(user);
      const lid = d.lanterns.create(u.id, await readJson(req));
      d.room.lanternChanged(lid);
      sendJson(res, 201, d.lanterns.detail(lid, u.id));
    });
    r('GET', '/api/lanterns/:id', ({ res, user, params }) => {
      const lid = id(params[0]);
      const detail = d.lanterns.detail(lid, user?.id ?? null);
      // 발자취: which lantern (an id only; never whose it was).
      if (user?.nickname && !detail.mine) d.footprints.event(user.id, 'lantern_read', `${kstDateOf(Date.now())}:${lid}`, { lanternId: lid });
      sendJson(res, 200, detail);
    });
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
      if (typeof type === 'string' && detail.myReactions.includes(type as never) && !detail.mine) {
        d.footprints.event(u.id, 'lantern_react', `${kstDateOf(Date.now())}:${lid}:${type}`, { lanternId: lid, type });
      }
      // 🤲 to the lantern's author (never who prayed; throttled and batched in PushService).
      if (type === 'pray' && detail.myReactions.includes('pray')) void d.push.prayed(lid, u.id).catch((e) => console.error('push prayed', e));
      sendJson(res, 200, detail);
    });
  }

  private limit(limiter: RateLimiter, key: string) {
    if (!limiter.hit(key)) throw new HttpError(429, 'rate_limited', '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.');
  }

  private admin(user: SessionUser | null): SessionUser {
    if (!user || !isAdmin(user, this.admins)) throw new HttpError(404, 'not_found', '찾을 수 없어요.');
    return user;
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
