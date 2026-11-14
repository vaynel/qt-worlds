import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { brotliCompress, constants as zlibConstants, gzipSync } from 'node:zlib';

export const MAX_BODY_BYTES = 64 * 1024;

// ------------------------------------------------------------------ trusted proxies

/** A parsed IPv4 CIDR, or an exact IPv6 address. */
type Rule = { v4: true; base: number; mask: number } | { v4: false; addr: string };

const ALIASES: Record<string, string[]> = {
  loopback: ['127.0.0.0/8', '::1'],
  // Docker bridge / compose networks (default address pools).
  docker: ['172.16.0.0/12'],
};

function v4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** "::ffff:1.2.3.4" -> "1.2.3.4"; trims brackets/whitespace. */
export function normalizeIp(ip: string): string {
  return ip
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1')
    .toLowerCase();
}

export function parseTrusted(spec: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    for (const entry of ALIASES[raw] ?? [raw]) {
      const [addr, bitsRaw] = entry.split('/');
      const n = v4ToInt(addr);
      if (n !== null) {
        const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
        if (!Number.isInteger(bits) || bits < 0 || bits > 32) throw new Error(`bad TRUSTED_PROXIES entry: ${entry}`);
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        rules.push({ v4: true, base: (n & mask) >>> 0, mask });
      } else if (addr.includes(':') && bitsRaw === undefined) {
        rules.push({ v4: false, addr: normalizeIp(addr) });
      } else {
        throw new Error(`bad TRUSTED_PROXIES entry: ${entry}`);
      }
    }
  }
  return rules;
}

export function isTrusted(ip: string, rules: Rule[]): boolean {
  const norm = normalizeIp(ip);
  const n = v4ToInt(norm);
  return rules.some((r) => (r.v4 ? n !== null && ((n & r.mask) >>> 0) === r.base : r.addr === norm));
}

/**
 * Which peers may set X-Real-IP / X-Forwarded-*. Default: loopback only (nginx
 * or Vite on this host). The live compose file adds the Docker bridge range,
 * because nginx's requests reach the container through the bridge gateway.
 * Accepts aliases (loopback, docker), IPv4 CIDRs and exact IPv6 addresses.
 */
const TRUSTED_RULES = parseTrusted(process.env.TRUSTED_PROXIES ?? 'loopback');
const LOOPBACK_RULES = parseTrusted('loopback');

const looksLikeIp = (ip: string) => v4ToInt(ip) !== null || /^[0-9a-f:]+$/.test(ip);

/** Cloudflare Tunnel sends the visitor in Cf-Connecting-Ip (no X-Real-IP). Opt-in. */
const TRUST_CF = process.env.TRUST_CF_CONNECTING_IP === '1';

const single = (v: string | string[] | undefined) => normalizeIp((Array.isArray(v) ? v[v.length - 1] : v) ?? '');

/**
 * The visitor's IP. Proxy headers count only when the TCP peer is trusted:
 *  1. Cf-Connecting-Ip, if TRUST_CF_CONNECTING_IP=1 (Cloudflare Tunnel);
 *  2. X-Real-IP (set by an nginx in front);
 *  3. the right-most X-Forwarded-For entry that isn't itself a trusted proxy.
 * Anything sent by an untrusted peer is ignored (spoofing-proof).
 */
export function resolveClientIp(
  peer: string,
  headers: Record<string, string | string[] | undefined>,
  rules: Rule[] = TRUSTED_RULES,
  trustCf: boolean = TRUST_CF,
): string {
  const p = normalizeIp(peer);
  if (!isTrusted(p, rules)) return p;
  if (trustCf) {
    const cf = single(headers['cf-connecting-ip']);
    if (cf && looksLikeIp(cf)) return cf;
  }
  const real = single(headers['x-real-ip']);
  if (real && looksLikeIp(real)) return real;
  const xff = headers['x-forwarded-for'];
  const chain = (Array.isArray(xff) ? xff.join(',') : (xff ?? ''))
    .split(',')
    .map((s) => normalizeIp(s))
    .filter((s) => s && looksLikeIp(s));
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!isTrusted(chain[i], rules)) return chain[i];
  }
  return chain[0] ?? p;
}

/** Who is really calling, honouring proxy headers only from trusted proxies. */
export interface RequestInfo {
  ip: string;
  host: string;
  proto: 'http' | 'https';
  /** Cookies should carry Secure. */
  secure: boolean;
  /** Direct loopback call with no proxy in between (local ops tools). */
  local: boolean;
}

const lastHeader = (v: string | string[] | undefined): string | undefined => {
  const raw = Array.isArray(v) ? v[v.length - 1] : v;
  if (!raw) return undefined;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1];
};

export function requestInfo(req: IncomingMessage, rules: Rule[] = TRUSTED_RULES, trustCf: boolean = TRUST_CF): RequestInfo {
  const peer = req.socket.remoteAddress ?? '';
  const trusted = isTrusted(peer, rules);
  const fwdHost = trusted ? lastHeader(req.headers['x-forwarded-host']) : undefined;
  const fwdProto = trusted ? lastHeader(req.headers['x-forwarded-proto']) : undefined;
  const proto = fwdProto === 'https' ? 'https' : 'http';
  const proxied = !!(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']);
  return {
    ip: resolveClientIp(peer, req.headers, rules, trustCf),
    host: (fwdHost ?? req.headers.host ?? '').toLowerCase(),
    proto,
    secure: proto === 'https' || process.env.COOKIE_SECURE === '1',
    local: isTrusted(peer, LOOPBACK_RULES) && !proxied,
  };
}

/**
 * Browsers always send Origin on WebSocket upgrades and cross-site POSTs.
 * Allowed: no Origin (non-browser clients), same origin as the (forwarded)
 * Host, or one listed in WORLDS_ALLOWED_ORIGINS.
 */
export function originAllowed(req: IncomingMessage, info = requestInfo(req)): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  // Strict mode (live): only the configured origins, no Host matching.
  if (process.env.WORLDS_ORIGIN_STRICT !== '1' && host === info.host) return true;
  const extra = (process.env.WORLDS_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return extra.includes(origin.toLowerCase());
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}

export function cookie(
  name: string,
  value: string,
  opts: { secure: boolean; maxAge?: number; path?: string; httpOnly?: boolean },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`, 'SameSite=Lax'];
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  return parts.join('; ');
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

export function redirect(res: ServerResponse, location: string, headers: Record<string, string | string[]> = {}) {
  res.writeHead(302, { location, 'cache-control': 'no-store', ...headers });
  res.end();
}

/** Read a JSON body (application/json only, size-limited). */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'bad_type', 'JSON으로 보내 주세요.');
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'too_large', '내용이 너무 길어요.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'too_large', '내용이 너무 길어요.');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    throw new HttpError(400, 'bad_json', '잘못된 요청이에요.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'bad_json', '잘못된 요청이에요.');
  return body as Record<string, unknown>;
}

/** Fixed-window counter: at most `limit` hits per key per `windowMs`. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; start: number }>();
  /** Keys hold IPs: drop finished windows regularly, not only when the map is huge. */
  private lastSweep = Date.now();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  hit(key: string): boolean {
    const now = Date.now();
    if (now - this.lastSweep > this.windowMs) {
      this.sweep(now);
      this.lastSweep = now;
    }
    const h = this.hits.get(key);
    if (!h || now - h.start > this.windowMs) {
      this.hits.set(key, { count: 1, start: now });
      if (this.hits.size > 10_000) this.sweep(now);
      return true;
    }
    h.count++;
    return h.count <= this.limit;
  }

  private sweep(now: number) {
    for (const [k, v] of this.hits) if (now - v.start > this.windowMs) this.hits.delete(k);
  }
}

// ------------------------------------------------------------------ static client (production)

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt']);

/** Is `enc` in this Accept-Encoding header (and not refused with q=0)? */
export function acceptsEncoding(header: string | string[] | undefined, enc: string): boolean {
  for (const part of String(header ?? '').toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    if (name.trim() !== enc) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  }
  return false;
}

interface Entry {
  body: Buffer;
  gz: Buffer | null;
  /** Brotli copy (quality 11), filled in the background; gzip is served until it's ready. */
  br: Buffer | null;
  type: string;
  etag: string;
}

/**
 * Serves client/dist with SPA fallback. Hashed files under /assets/ are
 * immutable; index.html is never cached. Text is compressed once and kept:
 * gzip right away, brotli (≈20 % smaller) on the libuv thread pool so the
 * event loop never waits for it. warm() does all of it at startup.
 */
export class StaticClient {
  private readonly cache = new Map<string, Entry>();

  constructor(private readonly root: string) {}

  static available(root: string): boolean {
    return existsSync(join(root, 'index.html'));
  }

  /** Load and compress every file up front (call once at startup); resolves when the brotli copies are ready. */
  warm(): Promise<void> {
    const pending: Promise<void>[] = [];
    const walk = (dir: string) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, d.name);
        if (d.isDirectory()) walk(path);
        else if (d.isFile()) {
          this.load(path);
          const job = this.brJobs.get(path);
          if (job) pending.push(job);
        }
      }
    };
    walk(this.root);
    return Promise.all(pending).then(() => undefined);
  }

  private readonly brJobs = new Map<string, Promise<void>>();

  private load(file: string): Entry {
    let entry = this.cache.get(file);
    if (!entry) {
      const body = readFileSync(file);
      const ext = extname(file).toLowerCase();
      const type = MIME[ext] ?? 'application/octet-stream';
      const gz = COMPRESSIBLE.has(ext) && body.length > 1024 ? gzipSync(body, { level: 6 }) : null;
      entry = { body, gz, br: null, type, etag: `"${createHash('sha1').update(body).digest('base64url').slice(0, 16)}"` };
      this.cache.set(file, entry);
      if (gz) {
        const e = entry;
        const job = new Promise<void>((done) =>
          brotliCompress(
            body,
            {
              params: {
                [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
                [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
                [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length,
              },
            },
            (err, out) => {
              // Only kept when it actually wins over gzip.
              if (!err && out.length < e.gz!.length) e.br = out;
              done();
            },
          ),
        );
        this.brJobs.set(file, job);
      }
    }
    return entry;
  }

  handle(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const url = new URL(req.url ?? '/', 'http://x');
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return false;
    }
    const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    let file = resolve(this.root, '.' + (rel.startsWith('/') ? rel : `/${rel}`));
    if (!file.startsWith(this.root + sep) && file !== this.root) return false;
    let isIndex = false;
    // The service worker must always be revalidated, and never be the SPA page.
    const isWorker = pathname === '/sw.js';
    // Static pages (/privacy, /terms): an extensionless path with a matching .html file.
    if (!extname(pathname) && pathname !== '/' && existsSync(`${file}.html`) && statSync(`${file}.html`).isFile()) file = `${file}.html`;
    if (!existsSync(file) || statSync(file).isDirectory()) {
      // Unknown asset files (and a missing sw.js) are real 404s; everything else falls back to the SPA.
      if (isWorker || pathname.startsWith('/assets/') || extname(pathname)) return false;
      file = join(this.root, 'index.html');
      isIndex = true;
    }
    isIndex ||= file.endsWith('index.html');
    const isHtml = file.endsWith('.html');
    const info = requestInfo(req);
    const entry = this.load(file);
    const headers: Record<string, string> = {
      'content-type': entry.type,
      etag: entry.etag,
      'x-content-type-options': 'nosniff',
      'cache-control': isHtml || isWorker ? 'no-cache' : pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      vary: 'accept-encoding',
      ...(isHtml ? securityHeaders(info) : {}),
    };
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    const accept = req.headers['accept-encoding'];
    const brOk = entry.br !== null && acceptsEncoding(accept, 'br');
    const gzipOk = !brOk && entry.gz !== null && acceptsEncoding(accept, 'gzip');
    const body = brOk ? entry.br! : gzipOk ? entry.gz! : entry.body;
    if (brOk) headers['content-encoding'] = 'br';
    else if (gzipOk) headers['content-encoding'] = 'gzip';
    headers['content-length'] = String(body.length);
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }
}

/**
 * Headers for HTML documents. The CSP allows our own origin (+ ws/wss to it)
 * and Google sign-in as a form/navigation target. No third-party scripts,
 * frames or images.
 */
export function securityHeaders(info: RequestInfo): Record<string, string> {
  const host = (info.host || 'localhost').replace(/[^a-z0-9.:\-]/g, '');
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    `connect-src 'self' ws://${host} wss://${host}`,
    "media-src 'self' blob:",
    "worker-src 'self'",
    "manifest-src 'self'",
    "form-action 'self' https://accounts.google.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ');
  return {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'DENY',
    // microphone=(self): the group voice rooms need the mic on our own origin.
    'permissions-policy': 'camera=(), microphone=(self), geolocation=()',
  };
}
