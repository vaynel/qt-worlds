import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createLocalJWKSet, createRemoteJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT, type JWK, type JWTVerifyGetKey } from 'jose';
import { cleanText, nicknameKey, validateNickname, type AccountInfo } from '../../shared/protocol.js';
import type { DB } from './db.js';
import { cookie, HttpError, parseCookies, type RequestInfo } from './http.js';

export const SESSION_COOKIE = 'worlds_session';
export const OAUTH_COOKIE = 'worlds_oauth';
const PERSISTENT_SECONDS = 30 * 24 * 3600;
const SHORT_SECONDS = 12 * 3600;
const OAUTH_TTL_MS = 10 * 60 * 1000;
const NEW_ACCOUNTS_PER_HOUR = Number(process.env.NEW_ACCOUNTS_PER_HOUR ?? 60);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const b64url = (buf: Buffer) => buf.toString('base64url');

export interface UserRow {
  id: number;
  google_sub: string;
  email: string | null;
  email_verified: number;
  nickname: string | null;
}

export interface SessionUser {
  id: number;
  nickname: string | null;
  email: string | null;
  onboarded: boolean;
}

// =============================================================================
// Sessions: random 32-byte tokens; only their SHA-256 is stored.
// =============================================================================

export class Sessions {
  constructor(private readonly db: DB) {}

  create(userId: number, persistent: boolean, info: RequestInfo): string {
    const token = b64url(randomBytes(32));
    const now = Date.now();
    const ttl = (persistent ? PERSISTENT_SECONDS : SHORT_SECONDS) * 1000;
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, persistent) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(token), userId, now, now + ttl, persistent ? 1 : 0);
    return cookie(SESSION_COOKIE, token, { secure: info.secure, maxAge: persistent ? PERSISTENT_SECONDS : undefined });
  }

  /** The signed-in user for a request (cookie), or null. */
  user(req: IncomingMessage): SessionUser | null {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token || token.length > 100) return null;
    const row = this.db
      .prepare(
        `SELECT u.id, u.nickname, u.email, u.onboarded_at, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(sha256(token)) as
      | { id: number; nickname: string | null; email: string | null; onboarded_at: number | null; expires_at: number }
      | undefined;
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
      return null;
    }
    return { id: row.id, nickname: row.nickname, email: row.email, onboarded: row.onboarded_at !== null };
  }

  destroy(req: IncomingMessage, info: RequestInfo): string {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    return cookie(SESSION_COOKIE, '', { secure: info.secure, maxAge: 0 });
  }

  sweep() {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  }
}

export function accountOf(user: SessionUser | null): AccountInfo | null {
  return user && user.nickname ? { id: user.id, nickname: user.nickname } : null;
}

// =============================================================================
// Users
// =============================================================================

export class Users {
  constructor(private readonly db: DB) {}

  upsertGoogle(sub: string, email: string | null, emailVerified: boolean): UserRow {
    const existing = this.db.prepare('SELECT * FROM users WHERE google_sub = ?').get(sub) as UserRow | undefined;
    if (existing) {
      this.db.prepare('UPDATE users SET email = ?, email_verified = ? WHERE id = ?').run(email, emailVerified ? 1 : 0, existing.id);
      return { ...existing, email, email_verified: emailVerified ? 1 : 0 };
    }
    // Global brake on brand-new accounts (public site): N per rolling hour.
    const recent = (this.db.prepare('SELECT COUNT(*) n FROM users WHERE created_at >= ?').get(Date.now() - 3_600_000) as { n: number }).n;
    if (recent >= NEW_ACCOUNTS_PER_HOUR) throw new HttpError(429, 'signup_busy', '지금은 새로 가입하는 분이 많아요. 잠시 후 다시 시도해 주세요.');
    const info = this.db
      .prepare('INSERT INTO users (google_sub, email, email_verified, created_at) VALUES (?, ?, ?, ?)')
      .run(sub, email, emailVerified ? 1 : 0, Date.now());
    return { id: Number(info.lastInsertRowid), google_sub: sub, email, email_verified: emailVerified ? 1 : 0, nickname: null };
  }

  /** Set or change a nickname. Unique by NFC + case-insensitive key. */
  setNickname(userId: number, raw: unknown): string {
    const name = validateNickname(raw);
    if (!name) throw new HttpError(400, 'bad_nickname', '닉네임은 1~12자로 정해 주세요.');
    const key = nicknameKey(name);
    const taken = this.db.prepare('SELECT id FROM users WHERE nickname_key = ? AND id != ?').get(key, userId);
    if (taken) throw new HttpError(409, 'name_taken', '이미 다른 분이 쓰고 있는 닉네임이에요.');
    this.db.prepare('UPDATE users SET nickname = ?, nickname_key = ? WHERE id = ?').run(name, key, userId);
    return name;
  }

  markOnboarded(userId: number) {
    this.db.prepare('UPDATE users SET onboarded_at = COALESCE(onboarded_at, ?) WHERE id = ?').run(Date.now(), userId);
  }

  /** Guests may not use a registered nickname. */
  isRegistered(name: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM users WHERE nickname_key = ?').get(nicknameKey(cleanText(name)));
  }
}

// =============================================================================
// OpenID Connect (authorization code + PKCE + state + nonce)
// =============================================================================

export interface OidcProvider {
  name: 'google' | 'mock';
  clientId: string;
  clientSecret: string;
  issuer: string[];
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwks: JWTVerifyGetKey;
}

export interface AuthConfig {
  provider: OidcProvider | null;
  /** Fixed public origin (https://qt.log2u.me); otherwise derived from the request. */
  publicBaseUrl: string | null;
  mock: MockProvider | null;
}

export function googleProvider(): OidcProvider | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return {
    name: 'google',
    clientId,
    clientSecret,
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    // jose caches the key set and refreshes it when Google rotates keys.
    jwks: createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')),
  };
}

interface PendingLogin {
  verifier: string;
  nonce: string;
  remember: boolean;
  returnTo: string;
  createdAt: number;
}

/** Only same-site relative paths ("/..." but not "//host"). */
export function safeReturn(raw: string | null): string {
  if (!raw || raw.length > 512 || !raw.startsWith('/') || raw.startsWith('//') || /[\\\s]/.test(raw)) return '/';
  return raw;
}

export class OidcFlow {
  private readonly pending = new Map<string, PendingLogin>();

  constructor(
    private readonly config: AuthConfig,
    private readonly users: Users,
    private readonly sessions: Sessions,
  ) {}

  get enabled(): boolean {
    return this.config.provider !== null;
  }

  get providerName(): 'google' | 'mock' | null {
    return this.config.provider?.name ?? null;
  }

  redirectUri(info: RequestInfo): string {
    const base = this.config.publicBaseUrl ?? `${info.proto}://${info.host}`;
    return `${base.replace(/\/$/, '')}/api/auth/google/callback`;
  }

  /** Step 1: remember state/nonce/PKCE verifier and send the browser to the provider. */
  start(info: RequestInfo, remember: boolean, loginHint: string | null, returnTo = '/'): { location: string; setCookie: string } {
    const provider = this.config.provider;
    if (!provider) throw new HttpError(503, 'auth_disabled', '로그인 준비 중이에요.');
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.createdAt > OAUTH_TTL_MS) this.pending.delete(k);
    if (this.pending.size > 5000) throw new HttpError(429, 'too_many', '잠시 후 다시 시도해 주세요.');

    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    this.pending.set(state, { verifier, nonce, remember, returnTo, createdAt: now });

    // A relative endpoint (the mock) is resolved against the public origin.
    const url = new URL(provider.authorizationEndpoint, this.config.publicBaseUrl ?? `${info.proto}://${info.host}`);
    url.searchParams.set('client_id', provider.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri(info));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('prompt', 'select_account');
    if (loginHint && provider.name === 'mock') url.searchParams.set('login_hint', loginHint);
    // The state is also bound to this browser via a short-lived cookie (login CSRF).
    const setCookie = cookie(OAUTH_COOKIE, state, { secure: info.secure, maxAge: OAUTH_TTL_MS / 1000, path: '/api/auth' });
    return { location: url.toString(), setCookie };
  }

  /** Step 2: check state, exchange the code, verify the ID token, start our session. */
  async callback(
    req: IncomingMessage,
    info: RequestInfo,
    query: URLSearchParams,
  ): Promise<{ setCookies: string[]; needsNickname: boolean; returnTo: string }> {
    const provider = this.config.provider;
    if (!provider) throw new HttpError(503, 'auth_disabled', '로그인 준비 중이에요.');
    const clearState = cookie(OAUTH_COOKIE, '', { secure: info.secure, maxAge: 0, path: '/api/auth' });
    const state = query.get('state') ?? '';
    const code = query.get('code') ?? '';
    const pending = this.pending.get(state);
    const bound = parseCookies(req)[OAUTH_COOKIE];
    if (query.get('error')) throw new HttpError(400, 'denied', '로그인이 취소되었어요.');
    if (!state || !pending || bound !== state || Date.now() - pending.createdAt > OAUTH_TTL_MS) {
      throw new HttpError(400, 'bad_state', '로그인 요청이 만료되었거나 올바르지 않아요. 다시 시도해 주세요.');
    }
    this.pending.delete(state); // single use
    if (!code || code.length > 2048) throw new HttpError(400, 'bad_code', '로그인 응답이 올바르지 않아요.');

    const tokenRes = await fetch(provider.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri(info),
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        code_verifier: pending.verifier,
      }),
    });
    if (!tokenRes.ok) throw new HttpError(400, 'token_exchange', '로그인을 마치지 못했어요. 다시 시도해 주세요.');
    const tokens = (await tokenRes.json()) as { id_token?: string };
    // Access/refresh tokens are deliberately ignored and never stored.
    if (typeof tokens.id_token !== 'string') throw new HttpError(400, 'no_id_token', '로그인 응답이 올바르지 않아요.');

    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(tokens.id_token, provider.jwks, {
        issuer: provider.issuer,
        audience: provider.clientId,
        clockTolerance: 30,
      }));
    } catch {
      throw new HttpError(401, 'bad_id_token', '로그인 정보를 확인하지 못했어요.');
    }
    if (payload.nonce !== pending.nonce) throw new HttpError(401, 'bad_nonce', '로그인 정보를 확인하지 못했어요.');
    const sub = payload.sub;
    if (typeof sub !== 'string' || !sub || sub.length > 255) throw new HttpError(401, 'bad_id_token', '로그인 정보를 확인하지 못했어요.');
    const email = typeof payload.email === 'string' ? payload.email.slice(0, 320) : null;
    const user = this.users.upsertGoogle(sub, email, payload.email_verified === true);
    const sessionCookie = this.sessions.create(user.id, pending.remember, info);
    return { setCookies: [sessionCookie, clearState], needsNickname: !user.nickname, returnTo: pending.returnTo };
  }
}

// =============================================================================
// Test-only mock provider. Enabled only by WORLDS_AUTH_MOCK=1 and never when
// NODE_ENV=production. login_hint picks the fake user; prefixes make bad tokens:
//   "alice", "expired:alice", "bad-sig:alice", "wrong-aud:alice", "bad-nonce:alice"
// =============================================================================

interface MockCode {
  sub: string;
  nonce: string;
  challenge: string;
  clientId: string;
  redirectUri: string;
  flavour: string;
}

export class MockProvider {
  readonly clientId = 'mock-client-id';
  readonly clientSecret = 'mock-client-secret';
  private readonly codes = new Map<string, MockCode>();

  private constructor(
    readonly issuer: string,
    private readonly key: CryptoKey,
    private readonly otherKey: CryptoKey,
    readonly jwks: JWTVerifyGetKey,
  ) {}

  static async create(issuer: string): Promise<MockProvider> {
    if (process.env.NODE_ENV === 'production') throw new Error('mock auth is refused in production');
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const other = await generateKeyPair('RS256');
    const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'mock-1', alg: 'RS256', use: 'sig' };
    return new MockProvider(issuer, privateKey as CryptoKey, other.privateKey as CryptoKey, createLocalJWKSet({ keys: [jwk] }));
  }

  /** internalBaseUrl: how this server reaches itself for the token call. */
  provider(internalBaseUrl: string): OidcProvider {
    return {
      name: 'mock',
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      issuer: [this.issuer],
      // Browser-facing, resolved against the public origin at request time.
      authorizationEndpoint: '/api/auth/mock/authorize',
      tokenEndpoint: `${internalBaseUrl}/api/auth/mock/token`,
      jwks: this.jwks,
    };
  }

  /** GET /api/auth/mock/authorize: with login_hint redirect straight back, else show a tiny form. */
  authorize(query: URLSearchParams): { redirect?: string; html?: string } {
    const hint = query.get('login_hint');
    if (!hint) {
      const hidden = [...query.entries()]
        .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
        .join('');
      return {
        html: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Mock Google</title>
<body style="font-family:sans-serif;padding:24px"><h1>테스트용 로그인</h1><p>개발/테스트 전용 가짜 로그인이에요.</p>
<form method="get">${hidden}<label>사용자 ID <input name="login_hint" required value="tester"></label> <button>계속</button></form></body>`,
      };
    }
    const [flavour, sub] = hint.includes(':') ? hint.split(':', 2) : ['ok', hint];
    const code = b64url(randomBytes(24));
    this.codes.set(code, {
      sub: `mock-${sub.slice(0, 60)}`,
      nonce: query.get('nonce') ?? '',
      challenge: query.get('code_challenge') ?? '',
      clientId: query.get('client_id') ?? '',
      redirectUri: query.get('redirect_uri') ?? '',
      flavour,
    });
    const back = new URL(query.get('redirect_uri') ?? '/');
    back.searchParams.set('code', code);
    back.searchParams.set('state', query.get('state') ?? '');
    return { redirect: back.toString() };
  }

  /** POST /api/auth/mock/token: checks PKCE and client credentials, returns a signed ID token. */
  async token(form: URLSearchParams): Promise<{ status: number; body: unknown }> {
    const entry = this.codes.get(form.get('code') ?? '');
    if (!entry) return { status: 400, body: { error: 'invalid_grant' } };
    this.codes.delete(form.get('code') ?? '');
    const verifier = form.get('code_verifier') ?? '';
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    if (challenge !== entry.challenge) return { status: 400, body: { error: 'invalid_grant', error_description: 'pkce' } };
    if (form.get('client_id') !== this.clientId || form.get('client_secret') !== this.clientSecret) {
      return { status: 401, body: { error: 'invalid_client' } };
    }
    if (form.get('redirect_uri') !== entry.redirectUri) return { status: 400, body: { error: 'invalid_grant' } };
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT({
      nonce: entry.flavour === 'bad-nonce' ? 'wrong-nonce' : entry.nonce,
      email: `${entry.sub}@example.test`,
      email_verified: true,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'mock-1' })
      .setIssuer(this.issuer)
      .setAudience(entry.flavour === 'wrong-aud' ? 'someone-else' : this.clientId)
      .setSubject(entry.sub)
      .setIssuedAt(entry.flavour === 'expired' ? now - 7200 : now)
      .setExpirationTime(entry.flavour === 'expired' ? now - 3600 : now + 300);
    const idToken = await jwt.sign(entry.flavour === 'bad-sig' ? this.otherKey : this.key);
    return { status: 200, body: { id_token: idToken, access_token: 'mock-access-token', token_type: 'Bearer', expires_in: 300 } };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
