import type { IncomingMessage, ServerResponse } from 'node:http';
import { safeReturn, type MockProvider, type OidcFlow, type Sessions, type SessionUser, type Users } from './auth.js';
import { HttpError, originAllowed, RateLimiter, readJson, redirect, requestInfo, sendJson, type RequestInfo } from './http.js';
import type { GroupService, LanternService, WordBookService } from './services.js';

/** What the API tells the realtime room about. */
export interface RoomEvents {
  lanternChanged(id: number): void;
  lanternRemoved(id: number): void;
  membershipChanged(userId: number): void;
  nicknameChanged(userId: number, nickname: string): void;
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
}

type Handler = (ctx: Ctx) => Promise<void> | void;
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
  private readonly routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
  private readonly ipLimit = new RateLimiter(600, 60_000);
  private readonly authLimit = new RateLimiter(Number(process.env.AUTH_RATE_LIMIT ?? 30), 60_000);
  private readonly nicknameLimit = new RateLimiter(10, 3_600_000);
  private readonly joinLimit = new RateLimiter(10, 60_000);

  constructor(private readonly d: ApiDeps) {
    const r = (method: string, path: string, handler: Handler) =>
      this.routes.push({ method, pattern: new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`), handler });

    // ---------------- auth
    r('GET', '/api/auth/config', ({ res }) =>
      sendJson(res, 200, { ready: d.oidc.enabled, provider: d.oidc.providerName }),
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
    r('POST', '/api/auth/logout', ({ req, res, info }) => {
      sendJson(res, 200, { ok: true }, { 'set-cookie': d.sessions.destroy(req, info) });
    });
    r('GET', '/api/me', ({ res, user }) => {
      sendJson(res, 200, {
        user: user ? { id: user.id, nickname: user.nickname, onboarded: user.onboarded } : null,
        needsNickname: !!user && !user.nickname,
      });
    });
    r('POST', '/api/me/onboarded', ({ res, user }) => {
      const u = this.signedIn(user, false);
      d.users.markOnboarded(u.id);
      sendJson(res, 200, { ok: true });
    });
    r('POST', '/api/me/nickname', async ({ req, res, user }) => {
      const u = this.signedIn(user, false);
      this.limit(this.nicknameLimit, `user:${u.id}`);
      const body = await readJson(req);
      const nickname = d.users.setNickname(u.id, body.nickname);
      d.room.nicknameChanged(u.id, nickname);
      sendJson(res, 200, { user: { id: u.id, nickname } });
    });

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
    r('GET', '/api/groups', ({ res, user }) => sendJson(res, 200, { groups: d.groups.list(this.signedIn(user).id) }));
    r('POST', '/api/groups', async ({ req, res, user }) => {
      const u = this.signedIn(user);
      const g = d.groups.create(u.id, (await readJson(req)).name);
      d.room.membershipChanged(u.id);
      sendJson(res, 201, g);
    });
    r('POST', '/api/groups/join', async ({ req, res, user }) => {
      const u = this.signedIn(user);
      this.limit(this.joinLimit, `user:${u.id}`);
      const g = d.groups.join(u.id, (await readJson(req)).code);
      d.room.membershipChanged(u.id);
      sendJson(res, 200, g);
    });
    r('POST', '/api/groups/:id/leave', ({ res, user, params }) => {
      const u = this.signedIn(user);
      d.groups.leave(u.id, id(params[0]));
      d.room.membershipChanged(u.id);
      sendJson(res, 200, { ok: true });
    });

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
      const detail = d.lanterns.toggle(u.id, lid, (await readJson(req)).type);
      d.room.lanternChanged(lid);
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
        await route.handler({
          req,
          res,
          info,
          params: m.slice(1).map((p) => decodeURIComponent(p)),
          query: url.searchParams,
          user: this.d.sessions.user(req),
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
