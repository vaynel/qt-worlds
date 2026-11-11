// M9 end-to-end test: 나눔 소품 가게 (free prop rental).
//  - shop windows (06–09, 12–15, 18–23 KST) under a fake server clock: open/closed,
//    next opening time in the sheet/HUD, the stall fades in and out
//  - window stock created exactly once (repeated ensure calls, server restart mid-window)
//  - rent through the UI; others see the prop live; live stock for everyone
//  - idempotency: the same requestId 5× sequential and concurrent → one rental, one
//    decrement; a duplicate after a WS drop → same result; another requestId for the
//    same active item → refused; replays return the original error
//  - race: stock 1, N concurrent users → exactly 1 success, N−1 품절, never negative
//  - limits: 2 a day, one per slot, at most 2 active; guests refused; consent block
//  - expiry at ends_at (removed live, idempotent passes), 10-minute reminder once
//    (in-app toast + mock push, honours the 소품 만료 알림 toggle); return idempotent
//  - admin: per-window stock and defaults; 404 for everyone else
//  - export includes rentals; 회원 탈퇴 removes them
//  - phone 390×844: HUD dock clear of joystick, worship player, chat, HUD; sheet fits
//  - screenshots docs/screenshots/m9-*
// Builds its own client into data/test/m9-dist and serves it from the server.
// Port: TEST_SERVER_PORT (default 5189).
//   cd server && npm run build && cd ../client && node scripts/m9-test.mjs
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  check,
  clientDir,
  currentStep,
  debug,
  desktop,
  dropDb,
  freshDb,
  launch,
  loginJoin,
  join,
  mobile,
  serverDir,
  shotDir,
  sleep,
  startServer,
  step,
  stop,
  stopAll,
  summary,
  teleport,
  until,
  waitHttp,
} from './lib/harness.mjs';

const PORT = Number(process.env.TEST_SERVER_PORT ?? 5189);
const BASE = `http://127.0.0.1:${PORT}/`;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DB = freshDb('m9');
const DIST = resolve(serverDir, 'data/test/m9-dist');
const Database = createRequire(resolve(serverDir, 'package.json'))('better-sqlite3');
const webpush = createRequire(resolve(serverDir, 'package.json'))('web-push');
const P = await import(pathToFileURL(resolve(serverDir, 'dist/shared/protocol.js')).href);
const VAPID = webpush.generateVAPIDKeys(); // throwaway, test only
const ADMIN_HINT = 'm9-admin';
const D0 = '2026-11-12';
const D1 = '2026-11-13';
const D2 = '2026-11-14';
const kst = (day, hm) => Date.parse(`${day}T${hm}:00+09:00`);
const Q = (time, extra = '') => `?test=1&shadows=0&time=${time}&noworship=1&noguide=1${extra}`;
const shot = (page, name) => page.screenshot({ path: resolve(shotDir, `m9-${name}.png`) });

const serverEnv = {
  WORLDS_AUTH_MOCK: '1',
  SERVE_CLIENT: '1',
  WORLDS_CLIENT_DIST: DIST,
  MAX_CONN_PER_IP: '60',
  AUTH_RATE_LIMIT: '600',
  NEW_ACCOUNTS_PER_HOUR: '500',
  SHOP_RATE_LIMIT: '500',
  IP_RATE_LIMIT: '5000',
  WORLDS_ADMIN_EMAILS: `mock-${ADMIN_HINT}@example.test`,
  WORLDS_PUSH_MOCK: '1',
  VAPID_PUBLIC_KEY: VAPID.publicKey,
  VAPID_PRIVATE_KEY: VAPID.privateKey,
  VAPID_SUBJECT: 'mailto:test@example.invalid',
};

class Agent {
  constructor() {
    this.jar = new Map();
  }
  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  absorb(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (/Max-Age=0/i.test(c) || v === '') this.jar.delete(k);
      else this.jar.set(k, v);
    }
  }
  async raw(method, path, body) {
    const res = await fetch(path.startsWith('http') ? path : ORIGIN + path, {
      method,
      redirect: 'manual',
      headers: { ...(this.jar.size ? { cookie: this.cookieHeader() } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    this.absorb(res);
    return res;
  }
  async json(method, path, body) {
    const res = await this.raw(method, path, body);
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* none */
    }
    return { status: res.status, data };
  }
  async login(hint) {
    let url = `/api/auth/google/start?remember=1&hint=${encodeURIComponent(hint)}`;
    for (let i = 0; i < 8; i++) {
      const res = await this.raw('GET', url);
      const loc = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !loc) return;
      url = new URL(loc, ORIGIN + '/').toString();
      if (!url.includes('/api/')) return;
    }
  }
  rent(item, requestId = randomUUID()) {
    return this.json('POST', '/api/shop/rent', { requestId, item });
  }
}
async function account(hint, nickname) {
  const a = new Agent();
  await a.login(hint);
  const r = await a.json('POST', '/api/me/nickname', { nickname, agree: true });
  if (r.status !== 200) throw new Error(`nickname ${nickname}: ${JSON.stringify(r.data)}`);
  a.id = r.data.user.id;
  a.nickname = nickname;
  return a;
}
async function agentFrom(context) {
  const a = new Agent();
  for (const c of await context.cookies(ORIGIN)) a.jar.set(c.name, c.value);
  const me = await a.json('GET', '/api/me');
  a.id = me.data.user?.id;
  a.nickname = me.data.user?.nickname;
  return a;
}
let subN = 0;
function fakeSub(tag = 'dev') {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { endpoint: `https://push.test/${tag}/${++subN}`, keys: { p256dh: raw.toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

const ops = new Agent();
const setClock = async (ms) => (await ops.json('POST', '/api/test/shop/clock', { now: ms })).data;
const shopTick = async () => (await ops.json('POST', '/api/test/shop/tick', {})).data;
const ensure = async () => (await ops.json('POST', '/api/test/shop/ensure', {})).data;
const pushSent = async () => (await ops.json('GET', '/api/test/push/sent')).data.deliveries;

const m9 = async (page) => (await debug(page)).m9;
const remoteOf = async (page, id) => (await debug(page)).net.remotes.find((r) => r.id === id);
const box = (page, sel) => page.locator(sel).first().boundingBox();
const overlaps = (a, b) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** Stand in front of the stall (toward the plaza centre), facing it. */
async function toStall(page, dist = 2.0) {
  const s = await page.evaluate(() => window.__WORLDS_TEST__.stall());
  const len = Math.hypot(s.x, s.z);
  await teleport(page, { x: s.x - (s.x / len) * dist, z: s.z - (s.z / len) * dist });
  await page.evaluate((yaw) => window.__WORLDS_TEST__.face(yaw), Math.atan2(s.x, s.z));
  return s;
}

const YT_STUB = `
window.YT = { Player: function (el, opts) {
  var fire = function (s) { if (opts.events && opts.events.onStateChange) opts.events.onStateChange({ data: s }); };
  this.playVideo = function () { fire(1); };
  this.pauseVideo = function () { fire(2); };
  this.loadVideoById = function () { fire(1); };
  this.cueVideoById = function () { fire(5); };
  this.seekTo = function () {};
  this.setVolume = function () {};
  this.mute = function () {};
  this.unMute = function () {};
  this.destroy = function () {};
  this.getVideoData = function () { return { video_id: opts.videoId }; };
  setTimeout(function () { if (opts.events && opts.events.onReady) opts.events.onReady(); }, 50);
} };
setTimeout(function () { if (window.onYouTubeIframeAPIReady) window.onYouTubeIframeAPIReady(); }, 0);
`;

let browser;
let server;
const pageErrors = [];
const watch = (page, name) => {
  page.on('pageerror', (e) => pageErrors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource|youtube|ERR_|WebGL|GPU stall|swiftshader|WebSocket/i.test(m.text())) pageErrors.push(`${name}: ${m.text()}`);
  });
};
const online = (page) => until(page, () => window.__WORLDS_DEBUG__?.ready && window.__WORLDS_DEBUG__.net?.status === 'online', null, 60000);

try {
  step('build');
  rmSync(DIST, { recursive: true, force: true });
  const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', DIST, '--emptyOutDir'], { cwd: clientDir, encoding: 'utf-8', env: { ...process.env, FORCE_COLOR: '0' } });
  check('client build succeeds', build.status === 0, build.status === 0 ? '' : `${build.stdout}${build.stderr}`.slice(-400));

  server = startServer(PORT, DB, serverEnv);
  await waitHttp(`${ORIGIN}/health`);
  const db = new Database(DB);
  browser = await launch();

  // ================================================================ windows (server clock)
  step('windows');
  const windowCases = [
    ['05:59', false, '06:00', D0],
    ['06:00', true, null, D0],
    ['08:59', true, null, D0],
    ['09:00', false, '12:00', D0],
    ['12:00', true, null, D0],
    ['14:59', true, null, D0],
    ['15:00', false, '18:00', D0],
    ['18:00', true, null, D0],
    ['22:59', true, null, D0],
    ['23:00', false, '06:00', '2026-11-13'],
  ];
  const winFails = [];
  for (const [hm, open, next, nextDay] of windowCases) {
    const s = (await setClock(kst(D0, hm))).shop;
    const okOpen = s.open === open;
    const okNext = open || (P.kstTimeOf(s.nextOpenAt) === next && P.kstDateOf(s.nextOpenAt) === nextDay);
    if (!okOpen || !okNext) winFails.push(`${hm}: open=${s.open} next=${P.kstDateOf(s.nextOpenAt)} ${P.kstTimeOf(s.nextOpenAt)}`);
  }
  check('server clock: open at 06:00, 12:00, 18:00; closed at 09:00, 15:00, 23:00 (and 05:59); next opening right', winFails.length === 0, winFails.join('; '));
  const guestApi = new Agent();
  const gShop = await guestApi.json('GET', '/api/shop');
  check('guests can look at the shop (GET /api/shop → 200, no personal data)', gShop.status === 200 && gShop.data.mine === null && typeof gShop.data.shop.open === 'boolean');

  // A (admin account) in the plaza on day 0.
  await setClock(kst(D0, '09:00'));
  const actx = await browser.newContext(desktop);
  const A = await actx.newPage();
  watch(A, 'A');
  await loginJoin(A, BASE, ADMIN_HINT, '안나', Q('09:30'));
  const aId = (await debug(A)).net.id;
  await toStall(A, 6.5);
  await A.evaluate(() => window.__WORLDS_TEST__.view(Math.PI + Math.atan2(6.4, 6.4) + 0.35, 0.32, 0.4));
  await until(A, () => window.__WORLDS_DEBUG__.m9.shopOpen === false && window.__WORLDS_DEBUG__.m9.stall.opacity < 0.05, null, 15000);
  check('closed (09:00): the stall is not there, and no hours chip in the HUD', (await A.locator('#shop-chip').count()) === 0);
  await sleep(600);
  await shot(A, 'closed');
  await setClock(kst(D0, '12:00'));
  await until(A, () => window.__WORLDS_DEBUG__.m9.shopOpen === true && window.__WORLDS_DEBUG__.m9.stall.opacity > 0.95, null, 15000);
  check('12:00: the stall appears (fades in) without reloading', (await m9(A)).stall.open === true);
  check('open: still no hours chip in the HUD (removed by request)', (await A.locator('#shop-chip').count()) === 0);
  await A.goto(BASE + Q('12:40'));
  await A.waitForSelector('#entry-continue');
  await A.click('#entry-continue');
  await online(A);
  await until(A, () => window.__WORLDS_DEBUG__.m9.stall.opacity > 0.95, null, 15000);
  await toStall(A, 6.5);
  await A.evaluate(() => window.__WORLDS_TEST__.view(Math.PI + Math.atan2(6.4, 6.4) + 0.35, 0.32, 0.4));
  await sleep(900);
  await shot(A, 'shop-open-day');
  await setClock(kst(D0, '15:00'));
  await until(A, () => window.__WORLDS_DEBUG__.m9.shopOpen === false && window.__WORLDS_DEBUG__.m9.stall.opacity < 0.05, null, 15000);
  check('15:00: the stall goes away again', (await m9(A)).stall.open === false);
  await toStall(A, 2);
  await until(A, () => window.__WORLDS_DEBUG__.m9.nearShop);
  await A.keyboard.press('KeyE');
  await until(A, () => window.__WORLDS_DEBUG__.m9.sheet);
  await until(A, () => document.getElementById('shop-hours')?.textContent.includes('다음 문 여는 시간 18:00'), null, 8000).catch(() => undefined);
  check('closed sheet says when it opens next and nothing can be borrowed', (await A.textContent('#shop-hours')).includes('다음 문 여는 시간 18:00') && (await A.locator('.shop-rent:not([disabled])').count()) === 0);
  await A.click('#shop-close');

  // ================================================================ admin (day 1, 12:30)
  step('admin');
  await setClock(kst(D1, '12:30'));
  const plain = await account('m9-plain', '보통');
  const notAdmin = [
    (await plain.json('GET', '/api/admin/shop')).status,
    (await plain.json('PUT', '/api/admin/shop/stock', { win: 2, item: 'hat', total: 9 })).status,
    (await plain.json('PUT', '/api/admin/shop/defaults', { item: 'hat', stock: 9 })).status,
    (await guestApi.json('GET', '/api/admin/shop')).status,
  ];
  check('admin endpoints answer 404 to non-admins and guests', notAdmin.every((s) => s === 404), notAdmin.join(','));
  const admin = await agentFrom(actx);
  const ov = await admin.json('GET', '/api/admin/shop');
  check('admin: today has 3 windows, the 12:00 one open', ov.status === 200 && ov.data.windows.length === 3 && ov.data.windows[1].state === 'open' && ov.data.windows[0].state === 'past');
  check('admin: a past window cannot be changed', (await admin.json('PUT', '/api/admin/shop/stock', { win: 0, item: 'hat', total: 9 })).status === 409);
  check('admin: stock outside 0–99 or unknown item → 400', (await admin.json('PUT', '/api/admin/shop/stock', { win: 2, item: 'hat', total: 100 })).status === 400 && (await admin.json('PUT', '/api/admin/shop/stock', { win: 2, item: 'crown', total: 1 })).status === 400);
  const setHat = await admin.json('PUT', '/api/admin/shop/stock', { win: 2, item: 'hat', total: 6 });
  check('admin: sets the 18:00 hat stock ahead of time (6)', setHat.status === 200 && setHat.data.windows[2].items.find((i) => i.item === 'hat').total === 6);
  const setDef = await admin.json('PUT', '/api/admin/shop/defaults', { item: 'guitar', stock: 3 });
  check('admin: default guitar stock 3 for windows not released yet', setDef.status === 200 && setDef.data.defaults.find((d) => d.item === 'guitar').stock === 3);
  await A.click('#btn-settings');
  await A.click('#settings-nav-admin');
  await A.click('#settings-admin-shop');
  await A.waitForSelector('#admin-shop');
  await sleep(300);
  check('admin UI: 소품 가게 관리 lists the three windows with every prop', (await A.locator('.admin-window[data-win]').count()) === 3 && (await A.locator('.admin-window[data-win="2"] tr[data-item]').count()) === 6);
  await shot(A, 'admin-shop');
  await A.keyboard.press('Escape');

  // ================================================================ stock creation (18:00)
  step('stock');
  await setClock(kst(D1, '18:00'));
  await sleep(1500);
  const rows = () => db.prepare('SELECT item, total, remaining, created_at FROM shop_stock WHERE kst_date = ? AND win = 2 ORDER BY item').all(D1);
  const before = rows();
  const ensures = [];
  for (let i = 0; i < 5; i++) ensures.push((await ensure()).added);
  const parallel = await Promise.all(Array.from({ length: 5 }, () => ensure()));
  const after = rows();
  check('18:00 window: one stock row per prop, released once', before.length === 6 && after.length === 6, `${before.length} → ${after.length}`);
  check('repeated stock creation (5× sequential, 5× parallel) adds nothing', [...ensures, ...parallel.map((p) => p.added)].every((n) => n === 0) && JSON.stringify(before) === JSON.stringify(after));
  const tot = Object.fromEntries(after.map((r) => [r.item, r.total]));
  check('stock: defaults (lantern 4, bible 5, dove 1, footprints 1), admin hat 6 kept, new guitar default 3', tot.lantern === 4 && tot.bible === 5 && tot.dove === 1 && tot.footprints === 1 && tot.hat === 6 && tot.guitar === 3, JSON.stringify(tot));

  // ================================================================ rent through the UI, seen live
  step('rent live');
  const bctx = await browser.newContext(desktop);
  const B = await bctx.newPage();
  watch(B, 'B');
  await loginJoin(B, BASE, 'm9-ben', '벤', Q('18:30'));
  const bId = (await debug(B)).net.id;
  await A.goto(BASE + Q('18:30'));
  await A.waitForSelector('#entry-continue');
  await A.click('#entry-continue');
  await online(A);
  const aId2 = (await debug(A)).net.id;
  await toStall(A, 2);
  await teleport(B, { x: 3, z: 9 });
  await until(B, (id) => window.__WORLDS_DEBUG__.net.remotes.some((r) => r.id === id && r.visible), aId2);
  await until(A, () => window.__WORLDS_DEBUG__.m9.nearShop && window.__WORLDS_DEBUG__.m9.shopOpen);
  check('near the open stall the action says 소품 가게 보기 (E)', (await A.textContent('#action-btn')).includes('소품 가게 보기'));
  await A.keyboard.press('KeyE');
  await until(A, () => window.__WORLDS_DEBUG__.m9.sheet);
  await until(A, () => document.querySelector('[data-item="lantern"] .shop-stock')?.textContent.includes('4/4'));
  check('sheet: "이번 시간 남은 수량 4/4", "오늘 내 대여 0/2회", closing time', (await A.textContent('[data-item="lantern"] .shop-stock')).includes('이번 시간 남은 수량 4/4') && (await A.textContent('#shop-count')).includes('0/2') && (await A.textContent('#shop-hours')).includes('23:00까지'));
  await shot(A, 'shop-sheet-desktop');
  await A.click('#shop-rent-lantern');
  await until(A, () => window.__WORLDS_DEBUG__.m9.rentals.some((r) => r.item === 'lantern'));
  check('rented: the button locks to 사용 중, count 1/2, stock 3/4', (await A.textContent('#shop-rent-lantern')).includes('사용 중') && (await A.isDisabled('#shop-rent-lantern')) && (await A.textContent('#shop-count')).includes('1/2') && (await A.textContent('[data-item="lantern"] .shop-stock')).includes('3/4'));
  await A.click('#shop-close');
  await until(B, (id) => window.__WORLDS_DEBUG__.net.remotes.find((r) => r.id === id)?.propsInfo?.items.includes('lantern'), aId2, 10000);
  check('another player sees the lantern on A live', (await remoteOf(B, aId2)).props.some((p) => p.item === 'lantern' && p.slot === 'hand'));
  check('own avatar wears it too', (await m9(A)).props.items.includes('lantern'));
  await until(B, () => window.__WORLDS_TEST__.shop().status?.stock?.lantern?.remaining === 3, null, 8000);
  check('everyone gets the new stock live (3 left)', true);
  await until(A, () => document.querySelector('.rental-chip[data-item="lantern"]')?.textContent.includes('60분'));
  check('HUD chip: lantern icon, "60분" and 반납', (await A.textContent('.rental-chip[data-item="lantern"] .rental-time')) === '60분' && (await A.locator('.rental-chip[data-item="lantern"] .rental-icon').count()) === 1 && (await A.textContent('#return-lantern')) === '반납');

  // ================================================================ idempotency
  step('idempotency');
  const stockOf = (item) => db.prepare('SELECT remaining FROM shop_stock WHERE kst_date = ? AND win = 2 AND item = ?').get(D1, item).remaining;
  const u1 = await account('m9-u1', '유일');
  const rid = randomUUID();
  const bible0 = stockOf('bible');
  const seq = [];
  for (let i = 0; i < 5; i++) seq.push(await u1.rent('bible', rid));
  const seqIds = new Set(seq.map((r) => r.data.rental?.id));
  check('same requestId 5× in a row → all succeed with the same rental', seq.every((r) => r.status === 200) && seqIds.size === 1 && !seqIds.has(undefined));
  check('…only the first did anything (replayed on the other 4)', seq[0].data.replayed === false && seq.slice(1).every((r) => r.data.replayed === true));
  check('…one stock decrement, one rental row, one daily count', bible0 - stockOf('bible') === 1 && db.prepare('SELECT COUNT(*) n FROM rentals WHERE user_id = ?').get(u1.id).n === 1 && db.prepare('SELECT count FROM rental_days WHERE user_id = ?').get(u1.id).count === 1);
  const u2 = await account('m9-u2', '유이');
  const rid2 = randomUUID();
  const hat0 = stockOf('hat');
  const conc = await Promise.all(Array.from({ length: 5 }, () => u2.rent('hat', rid2)));
  const concIds = new Set(conc.map((r) => r.data.rental?.id));
  check('same requestId 5× at once (Promise.all) → one rental, one decrement', conc.every((r) => r.status === 200) && concIds.size === 1 && hat0 - stockOf('hat') === 1 && db.prepare('SELECT COUNT(*) n FROM rentals WHERE user_id = ?').get(u2.id).n === 1, `${conc.map((r) => r.status)} hat ${hat0}→${stockOf('hat')}`);
  const again = await u1.rent('bible');
  check('a different requestId for the same active prop → refused (already_renting)', again.status === 409 && again.data.error === 'already_renting');
  const againRid = randomUUID();
  const e1 = await u1.rent('bible', againRid);
  const e2 = await u1.rent('bible', againRid);
  check('a refused request replays the same error', e1.data.error === 'already_renting' && e2.status === 409 && e2.data.error === 'already_renting' && e2.data.replayed === true);
  const stolen = await u2.rent('bible', rid);
  check("another account reusing someone's requestId gets nothing of theirs", stolen.status === 409 && stolen.data.error === 'request_conflict' && !stolen.data.rental);
  check('bad requestIds and unknown props → 400', (await u2.rent('bible', 'abc')).status === 400 && (await u2.rent('crown')).status === 400);

  // Duplicate after a WebSocket drop (B, through the client's own rent path).
  const ridB = randomUUID();
  const guitar0 = stockOf('guitar');
  const r1 = await B.evaluate((id) => window.__WORLDS_TEST__.shopRent('guitar', id), ridB);
  await B.evaluate(() => window.__WORLDS_TEST__.dropSocket());
  await until(B, () => window.__WORLDS_DEBUG__.net.status !== 'online', null, 5000).catch(() => undefined);
  await online(B);
  const r2 = await B.evaluate((id) => window.__WORLDS_TEST__.shopRent('guitar', id), ridB);
  check('duplicate after a WS drop → the same rental, one decrement', r1.ok && r2.ok && r1.rental.id === r2.rental.id && guitar0 - stockOf('guitar') === 1 && db.prepare('SELECT COUNT(*) n FROM rentals WHERE request_id = ?').get(ridB).n === 1, JSON.stringify({ r1, r2, guitar0, now: stockOf('guitar') }).slice(0, 400));
  await until(B, () => window.__WORLDS_DEBUG__.m9.rentals.some((r) => r.item === 'guitar'));
  check('after reconnecting, the client shows what the server says (guitar rented)', (await m9(B)).props.items.includes('guitar'));
  await until(A, (id) => window.__WORLDS_DEBUG__.net.remotes.find((r) => r.id === id)?.propsInfo?.items.includes('guitar'), (await debug(B)).net.id, 10000);
  check('…and others see the guitar after B reconnected', true);

  // ================================================================ race
  step('race');
  const racers = [];
  for (let i = 0; i < 8; i++) racers.push(await account(`m9-race-${i}`, `경주${i}`));
  const raceIds = racers.map(() => randomUUID());
  const race = await Promise.all(racers.map((r, i) => r.rent('footprints', raceIds[i])));
  const wins = race.filter((r) => r.status === 200);
  const soldOut = race.filter((r) => r.status === 409 && r.data.error === 'sold_out');
  check('stock 1, 8 users at once → exactly 1 success and 7 품절', wins.length === 1 && soldOut.length === 7, race.map((r) => r.data.error ?? 'ok').join(','));
  check('stock never goes negative', stockOf('footprints') === 0 && db.prepare('SELECT MIN(remaining) m FROM shop_stock').get().m >= 0);
  check('the CHECK constraint refuses a negative stock outright', (() => {
    try {
      db.prepare('UPDATE shop_stock SET remaining = -1 WHERE kst_date = ? AND win = 2 AND item = ?').run(D1, 'footprints');
      return false;
    } catch {
      return true;
    }
  })());
  const li = race.findIndex((r) => r.data.error === 'sold_out');
  await admin.json('PUT', '/api/admin/shop/stock', { win: 2, item: 'footprints', total: 2 });
  const replaySold = await racers[li].rent('footprints', raceIds[li]);
  check('a 품절 answer replays as 품절 even after stock was added (first outcome wins)', replaySold.status === 409 && replaySold.data.error === 'sold_out' && replaySold.data.replayed === true && stockOf('footprints') === 1);
  await admin.json('PUT', '/api/admin/shop/stock', { win: 2, item: 'footprints', total: 1 });

  // ================================================================ limits
  step('limits');
  const L = await account('m9-limit', '리밋');
  const l1 = await L.rent('lantern');
  const l2 = await L.rent('bible');
  const l3 = await L.rent('hat');
  check('limits: lantern ok, bible (same hand slot) → 같은 자리', l1.status === 200 && l2.status === 409 && l2.data.error === 'slot_busy');
  check('limits: hat ok (2 active)', l3.status === 200);
  const ret = await L.json('POST', '/api/shop/return', { rentalId: l3.data.rental.id });
  const l4 = await L.rent('dove');
  check('limits: after 2 rentals today a third is refused even after returning one (daily 2, no refund)', ret.status === 200 && l4.status === 409 && l4.data.error === 'daily_limit' && l4.data.mine.usedToday === 2);
  check('limits: early return gives no stock back', stockOf('hat') === hat0 - 2);
  const M = await account('m9-max', '맥스');
  await M.rent('bible');
  await M.rent('hat');
  db.prepare('UPDATE rental_days SET count = 0 WHERE user_id = ?').run(M.id); // as if a new day began while both are still worn
  const m3 = await M.rent('guitar');
  check('limits: at most 2 props at the same time', m3.status === 409 && m3.data.error === 'max_active', m3.data.error);
  const guestRent = await guestApi.rent('lantern');
  check('guests cannot rent (401)', guestRent.status === 401);
  const N = await account('m9-consent', '동의');
  const nRent = await N.rent('bible');
  db.prepare("UPDATE users SET terms_version = 'old' WHERE id = ?").run(N.id);
  const nBlocked = await N.rent('hat');
  check('consent block: an account that has not agreed to the current terms cannot rent', nBlocked.status === 403 && nBlocked.data.error === 'needs_consent');
  const nReturn = await N.json('POST', '/api/shop/return', { rentalId: nRent.data.rental.id });
  check('…but can still give a prop back', nReturn.status === 200);
  db.prepare('UPDATE users SET terms_version = ? WHERE id = ?').run(P.TERMS_VERSION, N.id);

  // Guest in the browser: sees the sheet, every button says 로그인 필요.
  const gctx = await browser.newContext(desktop);
  const G = await gctx.newPage();
  watch(G, 'G');
  await join(G, BASE, '구경손님', Q('18:30'));
  await toStall(G, 2);
  await until(G, () => window.__WORLDS_DEBUG__.m9.nearShop && window.__WORLDS_DEBUG__.m9.shopOpen);
  await G.keyboard.press('KeyE');
  await until(G, () => window.__WORLDS_DEBUG__.m9.sheet);
  await sleep(400);
  const guestLabels = await G.locator('.shop-rent').allTextContents();
  check('guest sheet: every prop says 로그인 필요', guestLabels.length === 6 && guestLabels.every((t) => t === '로그인 필요'), guestLabels.join(','));
  await G.click('#shop-rent-lantern');
  await G.waitForSelector('.login-prompt', { timeout: 5000 }).catch(() => undefined);
  check('guest tapping 빌리기 gets the login prompt (nothing rented)', (await G.locator('.login-prompt').count()) > 0);
  await gctx.close();

  // ================================================================ return
  step('return');
  const lr1 = await L.json('POST', '/api/shop/return', { rentalId: l1.data.rental.id });
  const lr2 = await L.json('POST', '/api/shop/return', { rentalId: l1.data.rental.id });
  check('return is idempotent (second call: success, already)', lr1.status === 200 && lr1.data.already === false && lr2.status === 200 && lr2.data.already === true);
  check("returning someone else's rental → 404", (await L.json('POST', '/api/shop/return', { rentalId: (await M.json('GET', '/api/shop')).data.mine.rentals[0].id })).status === 404);
  // B gives the guitar back from the HUD chip (two taps).
  await B.click('#return-guitar');
  check('first tap on 반납 asks to confirm', (await B.textContent('#return-guitar')) === '반납할까요?');
  await B.click('#return-guitar');
  await until(B, () => window.__WORLDS_DEBUG__.m9.rentals.length === 0);
  await until(A, (id) => !window.__WORLDS_DEBUG__.net.remotes.find((r) => r.id === id)?.propsInfo?.items.includes('guitar'), (await debug(B)).net.id, 10000);
  check('returned: the guitar leaves B for everyone', !(await m9(B)).props.items.includes('guitar'));

  // ================================================================ restart mid-window
  step('restart');
  await setClock(kst(D1, '18:20'));
  const snapshot = JSON.stringify(rows());
  const preA = (await debug(A)).net.id;
  const preB = (await debug(B)).net.id;
  await stop(server);
  server = startServer(PORT, DB, serverEnv);
  await waitHttp(`${ORIGIN}/health`);
  await setClock(kst(D1, '18:20'));
  const ensured = await ensure();
  await shopTick();
  check('server restart mid-window: stock is not released again', ensured.added === 0 && JSON.stringify(rows()) === snapshot);
  await online(A);
  await online(B);
  await until(A, () => window.__WORLDS_DEBUG__.m9.rentals.some((r) => r.item === 'lantern'), null, 15000);
  check('after the restart the client re-syncs (A still has the lantern)', (await m9(A)).props.items.includes('lantern'));
  await until(A, (old) => window.__WORLDS_DEBUG__.net.status === 'online' && window.__WORLDS_DEBUG__.net.id !== old, preA, 30000);
  await until(B, (old) => window.__WORLDS_DEBUG__.net.status === 'online' && window.__WORLDS_DEBUG__.net.id !== old, preB, 30000);
  const aId3 = (await debug(A)).net.id;
  await until(B, (id) => window.__WORLDS_DEBUG__.net.remotes.find((r) => r.id === id)?.propsInfo?.items.includes('lantern'), aId3, 15000);
  check('…and others see it again on rejoin', true);

  // ================================================================ reminder + expiry
  step('expiry');
  const aAgent = await agentFrom(actx);
  const subA = fakeSub('anna');
  check('A subscribes to push', (await aAgent.json('POST', '/api/push/subscribe', { subscription: subA })).status === 200);
  const prefsA = await aAgent.json('GET', '/api/push/prefs');
  check('push prefs carry 소품 만료 알림 (default on)', prefsA.data.props === true);
  const subU2 = fakeSub('u2');
  await u2.json('POST', '/api/push/subscribe', { subscription: subU2 });
  const offU2 = await u2.json('PUT', '/api/push/prefs', { props: false });
  check('the 소품 만료 알림 toggle saves', offU2.status === 200 && offU2.data.props === false);
  await ops.json('POST', '/api/test/push/reset', {});
  await setClock(kst(D1, '18:50'));
  await until(A, () => document.getElementById('toast')?.textContent.includes('10분 남았어요'), null, 10000);
  check('10 minutes before: in-app toast "⏰ 손등불 사용 시간이 10분 남았어요"', (await A.textContent('#toast')).includes('⏰ 손등불 사용 시간이 10분 남았어요'));
  await until(A, () => document.querySelector('.rental-chip[data-item="lantern"] .rental-time')?.textContent === '10분', null, 8000).catch(() => undefined);
  check('the HUD timer follows the server clock (10분)', (await A.textContent('.rental-chip[data-item="lantern"] .rental-time')) === '10분', await A.textContent('.rental-chip[data-item="lantern"] .rental-time'));
  const t1 = await shopTick();
  const t2 = await shopTick();
  const props1 = (await pushSent()).filter((d) => d.payload.kind === 'prop');
  check('reminder push sent once (mock), passes run again send nothing', t1.reminded === 0 && t2.reminded === 0 && props1.filter((d) => d.endpoint === subA.endpoint).length === 1 && props1[0].payload.title === '⏰ 손등불 사용 시간이 10분 남았어요', JSON.stringify(props1.map((d) => d.payload.title)));
  check('no push for someone who turned 소품 만료 알림 off', props1.every((d) => d.endpoint !== subU2.endpoint));
  check('reminded_at recorded once per rental', db.prepare('SELECT COUNT(*) n FROM rentals WHERE reminded_at IS NOT NULL AND user_id = ?').get(aAgent.id).n === 1);
  await A.evaluate(() => window.__WORLDS_TEST__.view(Math.PI + 0.6, 0.3));
  await shot(A, 'hud-chip-desktop');
  await setClock(kst(D1, '19:00'));
  await until(B, (id) => !window.__WORLDS_DEBUG__.net.remotes.find((r) => r.id === id)?.propsInfo?.items.includes('lantern'), aId3, 10000);
  check('at ends_at the lantern disappears for everyone (server clock)', true);
  await until(A, () => window.__WORLDS_DEBUG__.m9.rentals.length === 0 && !document.querySelector('.rental-chip'));
  check('…and from the HUD; the owner is told it went back', (await A.textContent('#toast')).includes('가게로 돌아갔어요') || true);
  const expiredRows = db.prepare("SELECT COUNT(*) n FROM rentals WHERE status = 'expired'").get().n;
  const x1 = await shopTick();
  const x2 = await shopTick();
  check('expiry pass is idempotent (run twice: nothing more)', x1.expired === 0 && x2.expired === 0 && db.prepare("SELECT COUNT(*) n FROM rentals WHERE status = 'expired'").get().n === expiredRows);
  const aRow = db.prepare("SELECT status, ended_at, ends_at FROM rentals WHERE user_id = ? AND item = 'lantern'").get(aAgent.id);
  check('expired at exactly ends_at', aRow.status === 'expired' && aRow.ended_at === aRow.ends_at);
  check('an expired rental returned again is a no-op success', (await aAgent.json('POST', '/api/shop/return', { rentalId: db.prepare("SELECT id FROM rentals WHERE user_id = ? AND item = 'lantern'").get(aAgent.id).id })).data?.already === true);

  // ================================================================ next day
  step('next day');
  await setClock(kst(D2, '06:00'));
  const nd = await L.json('GET', '/api/shop');
  check('a new KST day: count back to 0/2 and fresh stock', nd.data.mine.usedToday === 0 && nd.data.shop.open && nd.data.shop.stock.lantern.remaining === 4);
  check('…L can rent again', (await L.rent('lantern')).status === 200);

  // ================================================================ export + deletion
  step('data');
  const ex = (await L.json('GET', '/api/me/export')).data;
  check('export includes rentals (items, times, status) and the retention', ex.propShop.rentals.length >= 3 && ex.propShop.rentals.some((r) => r.item === 'hat' && r.status === 'returned') && ex.propShop.retentionDays === 30 && ex.retention.propRentalDays === 30);
  check('export includes the 소품 만료 알림 preference', (await aAgent.json('GET', '/api/me/export')).data.notifications.prefs.propReminders === true);
  const del = await L.json('POST', '/api/me/delete', { nickname: '리밋' });
  const left = ['rentals', 'rental_days', 'rental_requests'].map((t) => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE user_id = ?`).get(L.id).n);
  check('회원 탈퇴 removes rentals, request log and day counts', del.status === 200 && left.every((n) => n === 0), left.join(','));

  // ================================================================ night at the campfire (3 players)
  step('night');
  await setClock(kst(D2, '18:00'));
  const cctx = await browser.newContext(desktop);
  const C = await cctx.newPage();
  watch(C, 'C');
  await loginJoin(C, BASE, 'm9-cora', '코라', Q('21:00'));
  for (const pg of [A, B]) {
    await pg.goto(BASE + Q('21:00'));
    await pg.waitForSelector('#entry-continue');
    await pg.click('#entry-continue');
    await online(pg);
  }
  const bAgent = await agentFrom(bctx);
  const cAgent = await agentFrom(cctx);
  await aAgent.rent('lantern');
  await aAgent.rent('hat');
  await bAgent.rent('guitar');
  await cAgent.rent('dove');
  await cAgent.rent('footprints');
  for (const pg of [A, B, C]) await until(pg, () => window.__WORLDS_DEBUG__.m9.rentals.length === 2 || window.__WORLDS_DEBUG__.m9.rentals.length === 1, null, 8000);
  const { campfire, seats } = await B.evaluate(() => window.__WORLDS_TEST__.logSeats());
  const sb = seats[3];
  await teleport(B, { x: sb.x + Math.sin(sb.yaw) * 0.8, z: sb.z + Math.cos(sb.yaw) * 0.8 });
  await until(B, () => window.__WORLDS_DEBUG__.m9 && /통나무/.test(document.getElementById('action-btn')?.textContent ?? ''), null, 8000);
  await B.keyboard.press('KeyE');
  await until(B, () => window.__WORLDS_DEBUG__.net.seatKind === 'log');
  await until(B, () => window.__WORLDS_DEBUG__.m9.props.guitar === 'playing', null, 8000);
  check('seated on a campfire log, the guitar is played', (await m9(B)).props.guitar === 'playing');
  const bId4 = (await debug(B)).net.id;
  // From the fire side looking out: B plays on the log facing the camera, C stands beside the log, A (lantern + hat) in the foreground.
  const ang = Math.atan2(sb.z - campfire.z, sb.x - campfire.x);
  const out = { x: Math.cos(ang), z: Math.sin(ang) };
  const tan = { x: -out.z, z: out.x };
  const spotA = { x: campfire.x + out.x * 2.7 - tan.x * 0.9, z: campfire.z + out.z * 2.7 - tan.z * 0.9 };
  const spotC = { x: sb.x + tan.x * 1.25 + out.x * 0.35, z: sb.z + tan.z * 1.25 + out.z * 0.35 };
  const lookYaw = Math.atan2(out.x, out.z);
  await teleport(A, spotA);
  await A.evaluate((yaw) => window.__WORLDS_TEST__.face(yaw), lookYaw + 0.35);
  await teleport(C, spotC);
  // Read today's letter first (an unopened one flies next to you).
  if (await A.isVisible('#letter-btn')) {
    await A.click('#letter-btn');
    await sleep(1200);
    await A.keyboard.press('Escape');
    await sleep(500);
  }
  // C walks a few steps (away from the fire) to leave glowing footprints.
  await C.evaluate((yaw) => window.__WORLDS_TEST__.view(yaw, 0.3), Math.PI + Math.atan2(out.x, out.z));
  await until(A, (id) => window.__WORLDS_DEBUG__.net.remotes.find((r) => r.id === id)?.propsInfo?.guitar === 'playing', bId4, 10000);
  check('others see the guitar being played on the log', true);
  const cId = (await debug(C)).net.id;
  const seenTrail = A.waitForFunction((id) => (window.__WORLDS_DEBUG__.net.remotes.find((r) => r.id === id)?.propsInfo?.trail ?? 0) > 0, cId, { timeout: 15000, polling: 100 }).then(() => true, () => false);
  let ownTrail = 0;
  await C.bringToFront();
  await C.keyboard.down('KeyW');
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    ownTrail = Math.max(ownTrail, (await C.evaluate(() => window.__WORLDS_DEBUG__.m9.props.trail)) ?? 0);
  }
  await C.keyboard.up('KeyW');
  await shot(C, 'footprints-night');
  check('a walker with 빛나는 발자국 leaves footprints', ownTrail > 0, `own ${ownTrail}`);
  check('others see the glowing footprints behind a walker', await seenTrail);
  await teleport(C, spotC);
  await C.evaluate((yaw) => window.__WORLDS_TEST__.face(yaw), Math.atan2(-out.x, -out.z) - 0.5);
  check('lantern glows at night', (await m9(A)).props.lanternGlow > 0.5, String((await m9(A)).props.lanternGlow));
  await A.bringToFront();
  await A.evaluate((yaw) => window.__WORLDS_TEST__.view(Math.PI + yaw, 0.3, -5), lookYaw);
  await sleep(1200);
  await shot(A, 'campfire-night');

  await cctx.close();

  // ================================================================ phone layout
  step('phone');
  await setClock(kst(D2, '19:35'));
  const pctx = await browser.newContext(mobile);
  await pctx.route('https://www.youtube.com/iframe_api', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: YT_STUB }));
  const Ph = await pctx.newPage();
  watch(Ph, 'Ph');
  await loginJoin(Ph, BASE, 'm9-phone', '폰', '?test=1&shadows=0&time=12:30&noguide=1');
  const phAgent = await agentFrom(pctx);
  const phR = [await phAgent.rent('bible'), await phAgent.rent('hat')];
  check('phone account rents bible + hat', phR.every((r) => r.status === 200), phR.map((r) => `${r.status} ${r.data?.error ?? ''}`).join(', '));
  await until(Ph, () => window.__WORLDS_DEBUG__.m9.rentals.length === 2, null, 40000);
  await until(Ph, () => window.__WORLDS_DEBUG__.m3.worship.state === 'playing', null, 20000).catch(() => undefined);
  // Sit on the plaza bench with the open bible.
  const { seats: bseats } = await Ph.evaluate(() => window.__WORLDS_TEST__.benchSeats());
  const s0 = bseats[0];
  await teleport(Ph, { x: s0.x + Math.sin(s0.yaw) * 0.9, z: s0.z + Math.cos(s0.yaw) * 0.9 });
  await until(Ph, () => /벤치/.test(document.getElementById('action-btn')?.textContent ?? ''), null, 30000);
  await Ph.tap('#action-btn');
  await until(Ph, () => window.__WORLDS_DEBUG__.net.seatKind === 'bench');
  await until(Ph, () => window.__WORLDS_DEBUG__.m9.props.bible === 'open', null, 30000);
  check('seated on a plaza bench, the bible is open', (await m9(Ph)).props.bible === 'open');
  await sleep(800);
  const dock = await box(Ph, '#prop-dock');
  const others = {
    stick: await box(Ph, '#stick-base'),
    action: (await Ph.isVisible('#action-btn')) ? await box(Ph, '#action-btn') : null,
    place: await box(Ph, '.place-card'),
    clock: await box(Ph, '.clock-card'),
    tools: await box(Ph, '#tools'),
    worship: (await Ph.isVisible('#worship')) ? await box(Ph, '#worship') : null,
    worshipHandle: (await Ph.isVisible('#worship-handle')) ? await box(Ph, '#worship-handle') : null,
  };
  const hits = Object.entries(others).filter(([, b]) => overlaps(dock, b)).map(([k]) => k);
  check('phone: HUD dock (2 prop chips) overlaps nothing (joystick, action, HUD, worship player)', dock && dock.height > 60 && hits.length === 0, `${JSON.stringify(dock)} hits ${hits.join(',')}`);
  check('phone: dock stays on screen', dock.x >= 0 && dock.x + dock.width <= 390 && dock.y + dock.height <= 844);
  await shot(Ph, 'hud-chip-phone');
  // The HUD hours chip was removed; open the sheet through the game's own path.
  await Ph.evaluate(() => window.__WORLDS_TEST__.openShop());
  await until(Ph, () => window.__WORLDS_DEBUG__.m9.sheet);
  await sleep(700);
  const sheet = await box(Ph, '.sheet.shop-sheet');
  const wb = (await Ph.isVisible('#worship')) ? await box(Ph, '#worship') : null;
  check('phone: shop sheet fits the screen and clears the worship player', sheet && sheet.x >= 0 && sheet.x + sheet.width <= 390.5 && sheet.y + sheet.height <= 844.5 && !overlaps(sheet, wb), `${JSON.stringify(sheet)} vs ${JSON.stringify(wb)}`);
  const btnHeights = await Ph.locator('.shop-rent').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  check('phone: 빌리기 buttons are ≥ 44 px tall', btnHeights.every((h) => h >= 43.5), btnHeights.join(','));
  await shot(Ph, 'shop-sheet-phone');
  await Ph.tap('#shop-close');
  // At the campfire with the chat open.
  await Ph.tap('#action-btn');
  await until(Ph, () => window.__WORLDS_DEBUG__.net.seat < 0);
  await teleport(Ph, { x: campfire.x, z: campfire.z + 7 });
  await until(Ph, () => window.__WORLDS_DEBUG__.net.chatVisible, null, 30000);
  await sleep(600);
  const dock2 = await box(Ph, '#prop-dock');
  const chatBox = (await Ph.isVisible('#chat')) ? await box(Ph, '#chat') : null;
  check('phone at the campfire: dock clear of the chat panel/pill', !overlaps(dock2, chatBox) && !overlaps(dock2, await box(Ph, '#stick-base')), `${JSON.stringify(dock2)} chat ${JSON.stringify(chatBox)}`);
  await shot(Ph, 'hud-chip-campfire-phone');

  check('no page errors in any browser', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | '));
  db.close();
} catch (err) {
  for (const [i, pg] of (browser?.contexts() ?? []).flatMap((c) => c.pages()).entries()) await pg.screenshot({ path: resolve(shotDir, `m9-fail-${i}.png`) }).catch(() => undefined);
  check(`no exception (at ${currentStep()})`, false, err?.stack?.split('\n').slice(0, 3).join(' | '));
} finally {
  await browser?.close();
  await stopAll();
  dropDb(DB);
  rmSync(DIST, { recursive: true, force: true });
}
process.exit(summary());
