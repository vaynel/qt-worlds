import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { MAX_FRAME_BYTES, MAX_PLAYERS } from '../../shared/protocol.js';
import { AccountService } from './account.js';
import { Api, IceServers } from './api.js';
import { googleProvider, MockProvider, OidcFlow, Sessions, Users, type AuthConfig } from './auth.js';
import { DailyWord } from './dailyWord.js';
import { defaultDbPath, openDb, serverRoot } from './db.js';
import { originAllowed, requestInfo, StaticClient } from './http.js';
import { PushService } from './push.js';
import { LookService } from './looks.js';
import { Room } from './Room.js';
import { ShopService } from './shop.js';
import { FootprintService } from './footprints.js';
import { LibraryService } from './library.js';
import { LetterService } from './letters.js';
import { ShotService } from './shots.js';
import { GroupChatService, GroupService, LanternService, WordBookService } from './services.js';

const PORT = Number(process.env.PORT ?? 5181);
const HOST = process.env.HOST ?? '127.0.0.1';
const SEED = process.env.WORLD_SEED ?? 'worlds-v1';
const MAX = Math.min(Number(process.env.MAX_PLAYERS ?? MAX_PLAYERS), 500);
const MAX_CONN_PER_IP = Number(process.env.MAX_CONN_PER_IP ?? 12);
const QUIET = process.env.QUIET === '1';
const HEARTBEAT_MS = 15_000;
const PRODUCTION = process.env.NODE_ENV === 'production';
const SERVE_CLIENT = process.env.SERVE_CLIENT === '1' || PRODUCTION;

const log = (msg: string) => {
  if (!QUIET) console.log(`[${new Date().toISOString()}] ${msg}`);
};

// Test-only switches. Refused outright in production.
const TEST_MODE = process.env.WORLDS_TEST_MODE === '1' || process.env.WORLDS_ALLOW_TEST_DATES === '1';
const AUTH_MOCK = process.env.WORLDS_AUTH_MOCK === '1';
const PUSH_MOCK = process.env.WORLDS_PUSH_MOCK === '1';
if (PRODUCTION && (TEST_MODE || AUTH_MOCK || PUSH_MOCK)) {
  console.error('FATAL: WORLDS_TEST_MODE / WORLDS_ALLOW_TEST_DATES / WORLDS_AUTH_MOCK / WORLDS_PUSH_MOCK cannot be used with NODE_ENV=production');
  process.exit(1);
}

let dailyWord: DailyWord | null = null;
try {
  dailyWord = new DailyWord();
  if (dailyWord.mode === 'curated') log(`daily word: curated pool of ${dailyWord.curatedSize} passages`);
  else log(`daily word: curated list missing, rule-based pool of ${dailyWord.poolSize} verses`);
  for (const e of dailyWord.curatedErrors) console.error(`curated-verses.json: ${e}`);
} catch (err) {
  console.error('daily word disabled:', (err as Error).message);
}

const dbPath = defaultDbPath();
const db = openDb(dbPath);
log(`database: ${dbPath}`);
const sessions = new Sessions(db);
const users = new Users(db);
const groups = new GroupService(db);
const lanterns = new LanternService(db, groups);
const wordbook = new WordBookService(db, dailyWord, TEST_MODE);
const chat = new GroupChatService(db, groups);
const looks = new LookService(db);
const push = new PushService(db, dailyWord, {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
  subject: process.env.VAPID_SUBJECT,
  mock: PUSH_MOCK,
  testMode: TEST_MODE,
});
const shop = new ShopService(db, push);
const footprints = new FootprintService(db);
// 📸 Screenshots live next to the database (/data/screenshots in Docker), so they
// survive container rebuilds with the volume. WORLDS_SHOTS_DIR overrides it.
const shotsDir = process.env.WORLDS_SHOTS_DIR ?? resolve(dirname(dbPath), 'screenshots');
const shots = new ShotService(db, shotsDir);
const library = new LibraryService(db, groups, dailyWord, footprints, shots);
const letters = new LetterService(db, library);
log(`screenshots: ${shotsDir}`);
const accounts = new AccountService(db, looks, shop, { library, footprints, shots, letters });
if (!push.enabled) log('Web Push not configured (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT): notifications off');
else if (push.mock) log('WARNING: Web Push mock sender (tests only): nothing is delivered');

const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, '') || null;
const mock = AUTH_MOCK ? await MockProvider.create(`http://127.0.0.1:${PORT}/api/auth/mock`) : null;
const authConfig: AuthConfig = {
  provider: mock ? mock.provider(`http://127.0.0.1:${PORT}`) : googleProvider(),
  publicBaseUrl,
  mock,
};
const oidc = new OidcFlow(authConfig, users, sessions);
if (mock) log('WARNING: mock OIDC login is enabled (tests only)');
else if (!oidc.enabled) log('Google login not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET): guest mode only');
{
  const admins = (process.env.WORLDS_ADMIN_EMAILS ?? '').split(',').filter((e) => e.includes('@')).length;
  log(admins ? `admins: ${admins} account(s) from WORLDS_ADMIN_EMAILS` : 'WORLDS_ADMIN_EMAILS not set: no outfit admin');
}
if (TEST_MODE) log('WARNING: test mode (date overrides, test teleports) is enabled');

const room = new Room({
  seed: SEED,
  maxPlayers: MAX,
  log,
  dailyWord,
  allowTestDates: TEST_MODE,
  testMode: TEST_MODE,
  users,
  groups,
  lanterns,
  looks,
  shop,
  library,
  footprints,
  footprintTickMs: Number(process.env.WORLDS_FOOTPRINT_TICK_MS ?? 20_000),
});
shop.events = room;
const ice = new IceServers();
if (!ice.configured) log('TURN not configured (TURN_KEY_ID / TURN_KEY_API_TOKEN): voice uses STUN only');
const api = new Api({ sessions, users, oidc, mock, wordbook, groups, lanterns, room, ice, chat, push, accounts, looks, shop, library, letters, footprints, shots, testMode: TEST_MODE });

// WORLDS_CLIENT_DIST: tests serve a second build to simulate a deploy.
const clientDist = process.env.WORLDS_CLIENT_DIST ? resolve(process.env.WORLDS_CLIENT_DIST) : resolve(serverRoot(), '../client/dist');
const staticClient = SERVE_CLIENT && StaticClient.available(clientDist) ? new StaticClient(clientDist) : null;
if (SERVE_CLIENT) log(staticClient ? `serving client from ${clientDist}` : `WARNING: SERVE_CLIENT set but ${clientDist} has no build`);
if (staticClient) {
  const t0 = Date.now();
  void staticClient.warm().then(() => log(`client assets compressed (gzip + brotli) in ${Date.now() - t0} ms`));
}

const http = createServer((req, res) => {
  if (req.url === '/health') {
    // Public callers only learn that we're up; details are for direct local checks.
    const local = requestInfo(req).local;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(local ? { ok: true, players: room.playerCount } : { ok: true }));
    return;
  }
  void api.handle(req, res).then((handled) => {
    if (handled) return;
    if (staticClient?.handle(req, res)) return;
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  });
});

// ---------------------------------------------------------------- WebSocket

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
const connectionsPerIp = new Map<string, number>();
const alive = new WeakSet<object>();

http.on('upgrade', (req, socket, head) => {
  const reject = (status: number, text: string) => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname !== '/ws') return reject(404, 'Not Found');
  const info = requestInfo(req);
  if (!originAllowed(req, info)) return reject(403, 'Forbidden');
  const count = connectionsPerIp.get(info.ip) ?? 0;
  if (count >= MAX_CONN_PER_IP) return reject(429, 'Too Many Requests');
  const user = sessions.user(req);
  wss.handleUpgrade(req, socket, head, (ws) => {
    connectionsPerIp.set(info.ip, count + 1);
    ws.on('close', () => {
      const n = (connectionsPerIp.get(info.ip) ?? 1) - 1;
      if (n <= 0) connectionsPerIp.delete(info.ip);
      else connectionsPerIp.set(info.ip, n);
    });
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
    room.attach(ws, user);
  });
});

// Drop connections that stopped answering pings (closed phones, dead tabs).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) {
      ws.terminate();
      continue;
    }
    alive.delete(ws);
    ws.ping();
  }
}, HEARTBEAT_MS);
// Hourly 파기: expired sessions, group chat older than 7 days, old lantern
// copies (내린: after a day; expired: a day after leaving the hill), and
// sign-ups that never finished (no nickname, no consent) after a day.
const sweep = () => {
  sessions.sweep();
  chat.purge();
  const gone = accounts.sweep();
  if (gone.lanterns || gone.signups || gone.outfits || gone.rentals || gone.footprints || gone.shots)
    log(
      `sweep: ${gone.lanterns} old lanterns, ${gone.signups} unfinished sign-ups, ${gone.outfits} replaced drawings, ${gone.rentals} old rental records, ${gone.footprints} old 발자취 records, ${gone.shots} unused screenshots deleted`,
    );
};
const sweeper = setInterval(sweep, 3_600_000);
sweep();
// Every minute: daily words that are due (Asia/Seoul), batched prayer and 공감 notices,
// and 📔 밤 일기 알림.
// Mock push (tests) is driven by /api/test/push/tick with a fake clock instead.
// Every second: shop windows (stock release), prop expiry and 10-minute reminders (server clock).
const shopTimer = setInterval(() => void shop.tick().catch((e) => console.error('shop tick', e)), 1000);
void shop.tick().catch((e) => console.error('shop tick', e));
const pushTimer = push.enabled && !push.mock ? setInterval(() => void push.tick().catch((e) => console.error('push tick', e)), 60_000) : null;

http.listen(PORT, HOST, () => log(`worlds server on http://${HOST}:${PORT} (ws /ws, api /api) seed=${SEED} max=${MAX}`));

const shutdown = () => {
  clearInterval(heartbeat);
  clearInterval(sweeper);
  clearInterval(shopTimer);
  if (pushTimer) clearInterval(pushTimer);
  room.close();
  wss.close();
  http.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
