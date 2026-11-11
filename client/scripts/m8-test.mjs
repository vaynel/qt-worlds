// M8 end-to-end test: 꾸미기 (appearance), 옷 그리기 (pixel outfits), 신고 and 관리.
//  - appearance: save, reload, another player sees colours + hair style live; bad values rejected
//  - painter: paint, drag, mirror, fill, undo/redo; save to a slot and wear it; another
//    player fetches and renders it (texture bytes checked); size/index validation
//  - reports: 3 distinct reporters hide a drawing for others (not the owner, who gets a
//    notice); duplicates don't count; guests can't report; strikes → upload ban
//  - admin: 404 for everyone else; an admin (WORLDS_ADMIN_EMAILS) restores and bans
//  - export includes appearance + drawings; 회원 탈퇴 removes all of it (tables scanned)
//  - phone 390×844: painter cells ≥ 16 px, sheet clear of the worship player
//  - 10 avatars with different drawings render; textures are disposed on leave
// Builds its own client into data/test/m8-dist and serves it from the server.
// Port: TEST_SERVER_PORT (default 5188).
//   cd server && npm run build && cd ../client && node scripts/m8-test.mjs
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
  mobile,
  rawClient,
  serverDir,
  shotDir,
  sleep,
  startServer,
  step,
  stopAll,
  summary,
  teleport,
  until,
  waitHttp,
} from './lib/harness.mjs';

const PORT = Number(process.env.TEST_SERVER_PORT ?? 5188);
const BASE = `http://127.0.0.1:${PORT}/`;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const DAY = '2026-11-08';
const Q = (extra = '') => `?test=1&shadows=0&time=13:00&date=${DAY}&noworship=1&noguide=1${extra}`;
const DB = freshDb('m8');
const DIST = resolve(serverDir, 'data/test/m8-dist');
const Database = createRequire(resolve(serverDir, 'package.json'))('better-sqlite3');
const P = await import(pathToFileURL(resolve(serverDir, 'dist/shared/protocol.js')).href);
const ADMIN_HINT = 'm8-admin';

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

// ---------------------------------------------------------------- pixels
const N = 16;
const draw = (fn) => Array.from({ length: N * N }, (_, i) => fn(i % N, Math.floor(i / N)) ?? '.').join('');
/** Same bytes Avatar.patternData writes, hashed like Avatar.patternInfo. */
function expectedChecksum(pixels, robe) {
  const out = new Uint8Array(N * N * 4);
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const ch = pixels[row * N + col];
      const idx = '0123456789abcdef'.indexOf(ch);
      const c = idx >= 0 ? P.OUTFIT_PALETTE[idx] : robe;
      const o = ((N - 1 - row) * N + col) * 4;
      out[o] = (c >> 16) & 255;
      out[o + 1] = (c >> 8) & 255;
      out[o + 2] = c & 255;
      out[o + 3] = 255;
    }
  }
  let h = 0;
  for (let i = 0; i < out.length; i++) h = (Math.imul(h, 31) + out[i]) >>> 0;
  return h;
}
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

const m8 = async (page) => (await debug(page)).m8;
const remoteOf = async (page, id) => (await debug(page)).net.remotes.find((r) => r.id === id);
const box = (page, sel) => page.locator(sel).first().boundingBox();
const overlaps = (a, b) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Click / drag cells on the painter grid like a person would. */
async function cellPoint(page, x, y) {
  await page.evaluate(() => document.getElementById('painter-grid').scrollIntoView({ block: 'center' }));
  const b = await box(page, '#painter-grid');
  const s = b.width / N;
  return { x: b.x + (x + 0.5) * s, y: b.y + (y + 0.5) * s };
}
async function clickCell(page, x, y) {
  const p = await cellPoint(page, x, y);
  await page.mouse.click(p.x, p.y);
}
async function dragCells(page, x0, y0, x1, y1) {
  const a = await cellPoint(page, x0, y0);
  const b = await cellPoint(page, x1, y1);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 3 });
  await page.mouse.up();
}
const custom = (page) => page.evaluate(() => window.__WORLDS_TEST__.customize());
const painted = async (page) => (await custom(page)).pixels;

const YT_STUB = `
window.YT = { Player: function (el, opts) {
  var state = -1;
  var fire = function (s) { state = s; if (opts.events && opts.events.onStateChange) opts.events.onStateChange({ data: s }); };
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
const pageErrors = [];
const watch = (page, name) => {
  page.on('pageerror', (e) => pageErrors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource|youtube|ERR_|WebGL|GPU stall|swiftshader/i.test(m.text())) pageErrors.push(`${name}: ${m.text()}`);
  });
};

try {
  step('build');
  rmSync(DIST, { recursive: true, force: true });
  const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', DIST, '--emptyOutDir'], { cwd: clientDir, encoding: 'utf-8', env: { ...process.env, FORCE_COLOR: '0' } });
  check('client build succeeds', build.status === 0, build.status === 0 ? '' : `${build.stdout}${build.stderr}`.slice(-400));

  startServer(PORT, DB, {
    WORLDS_AUTH_MOCK: '1',
    SERVE_CLIENT: '1',
    WORLDS_CLIENT_DIST: DIST,
    MAX_CONN_PER_IP: '60',
    AUTH_RATE_LIMIT: '400',
    NEW_ACCOUNTS_PER_HOUR: '500',
    OUTFIT_RATE_LIMIT: '200',
    WORLDS_ADMIN_EMAILS: ` MOCK-${ADMIN_HINT}@example.test , someone@else.test`,
  });
  await waitHttp(`${ORIGIN}/health`);
  const db = new Database(DB);
  browser = await launch();

  // ---------------------------------------------------------------- API validation
  step('api validation');
  const guest = new Agent();
  check('guest: GET /api/me/look → 401', (await guest.json('GET', '/api/me/look')).status === 401);
  check('guest: PUT /api/me/look → 401', (await guest.json('PUT', '/api/me/look', { appearance: P.DEFAULT_APPEARANCE })).status === 401);
  const v = await account('m8-val', '검사');
  const fresh = await v.json('GET', '/api/me/look');
  check('new account: no saved appearance, nothing worn, 3 empty slots', fresh.status === 200 && fresh.data.appearance === null && fresh.data.worn === null && fresh.data.slots.length === 3 && fresh.data.slots.every((s) => s === null));
  const badLooks = [
    { r: 16, s: 0, k: 0, h: 0, y: 0 },
    { r: 0, s: 12, k: 0, h: 0, y: 0 },
    { r: 0, s: 0, k: 6, h: 0, y: 0 },
    { r: 0, s: 0, k: 0, h: 8, y: 0 },
    { r: 0, s: 0, k: 0, h: 0, y: 5 },
    { r: -1, s: 0, k: 0, h: 0, y: 0 },
    { r: 1.5, s: 0, k: 0, h: 0, y: 0 },
    { r: '1', s: 0, k: 0, h: 0, y: 0 },
    { r: 0, s: 0, k: 0, h: 0 },
    { r: 0, s: 0, k: 0, h: 0, y: 0, color: '#ff0000' },
    'pink',
    null,
  ];
  const badStatuses = [];
  for (const appearance of badLooks) badStatuses.push((await v.json('PUT', '/api/me/look', { appearance, worn: null })).status);
  check('API rejects out-of-palette / malformed appearance (400 each)', badStatuses.every((s) => s === 400), badStatuses.join(','));
  check('API rejects wearing a bad slot (5) or an empty slot', (await v.json('PUT', '/api/me/look', { appearance: P.DEFAULT_APPEARANCE, worn: 5 })).status === 400 && (await v.json('PUT', '/api/me/look', { appearance: P.DEFAULT_APPEARANCE, worn: 1 })).data?.error === 'empty_slot');
  const good = draw((x, y) => ((x + y) % 4 === 0 ? 'a' : undefined));
  const badPixels = [
    good.slice(1),
    `${good}0`,
    good.replace('a', 'g'),
    good.replace('a', 'A'),
    good.replace('.', ' '),
    '.'.repeat(256),
    good.split(''),
    12345,
    `<img src=x onerror=alert(1)>${'.'.repeat(228)}`,
  ];
  const pixStatuses = [];
  for (const pixels of badPixels) pixStatuses.push((await v.json('PUT', '/api/me/outfits/0', { pixels })).status);
  check('API rejects wrong size, indices ≥ 16, other chars, empty or non-string drawings (400 each)', pixStatuses.every((s) => s === 400), pixStatuses.join(','));
  check('API: slot 3 (only 0–2) → 404', (await v.json('PUT', '/api/me/outfits/3', { pixels: good })).status === 404);
  const saved0 = await v.json('PUT', '/api/me/outfits/0', { pixels: good });
  check('API: a valid 16×16 drawing is stored with a content hash', saved0.status === 200 && saved0.data.slots[0]?.pixels === good && /^[0-9a-f]{16}$/.test(saved0.data.slots[0]?.hash));
  const row = db.prepare('SELECT length(pixels) n, pixels FROM outfits WHERE user_id = ?').get(v.id);
  check('DB keeps the drawing as 256 palette-index characters (no image file)', row?.n === 256 && /^[0-9a-f.]+$/.test(row.pixels));

  // ---------------------------------------------------------------- appearance (UI)
  step('appearance');
  const actx = await browser.newContext(desktop);
  const A = await actx.newPage();
  watch(A, 'A');
  await loginJoin(A, BASE, 'm8-anna', '안나', Q());
  const bctx = await browser.newContext(desktop);
  const B = await bctx.newPage();
  watch(B, 'B');
  await loginJoin(B, BASE, 'm8-ben', '벤', Q());
  const aId = (await debug(A)).net.id;
  const bId = (await debug(B)).net.id;
  await teleport(A, { x: -0.9, z: 3.2 });
  await teleport(B, { x: 0, z: 9 });
  await A.evaluate(() => window.__WORLDS_TEST__.face(0));
  await until(B, (id) => window.__WORLDS_DEBUG__.net.remotes.some((r) => r.id === id && r.visible), aId);
  const before = await remoteOf(B, aId);
  check('before customizing: others see the hashed default colours (not saved)', before.look.saved === false && before.look.hairStyle === 'short');
  check('own avatar starts with the default look', (await m8(A)).avatar.robe === '#f1e4c8' && (await m8(A)).avatar.hairStyle === 'short');

  await A.click('#btn-look');
  await until(A, () => window.__WORLDS_TEST__.customize().open);
  await A.waitForSelector('#look-preview');
  await A.click('.swatch[data-key="r"][data-index="10"]');
  await A.click('.swatch[data-key="s"][data-index="2"]');
  await A.click('.swatch[data-key="k"][data-index="3"]');
  await A.click('.swatch[data-key="h"][data-index="6"]');
  await A.click('#look-tab-hair');
  await A.click('#hair-tied');
  await until(A, () => window.__WORLDS_TEST__.customize().previewStyle === 'tied');
  check('live 3D preview follows the choices (hair style)', (await custom(A)).previewStyle === 'tied');
  await A.screenshot({ path: resolve(shotDir, 'm8-customize-desktop.png') });
  await A.click('#look-save');
  await A.waitForSelector('.look-status:has-text("저장했어요")');
  const wantRobe = hex(P.ROBE_COLORS[10]);
  await until(A, (r) => window.__WORLDS_DEBUG__.m8.avatar.robe === r, wantRobe);
  check('saved: own avatar wears the new robe colour and hair style', (await m8(A)).avatar.hairStyle === 'tied');
  await until(B, ([id, r]) => window.__WORLDS_DEBUG__.net.remotes.find((x) => x.id === id)?.look.robe === r, [aId, wantRobe], 10000);
  const live = await remoteOf(B, aId);
  check(
    'another player sees the colours and hair style live',
    live.look.saved && live.look.robe === wantRobe && live.look.scarf === hex(P.SCARF_COLORS[2]) && live.look.skin === hex(P.SKIN_COLORS[3]) && live.look.hair === hex(P.HAIR_COLORS[6]) && live.look.hairStyle === 'tied',
    JSON.stringify(live.look),
  );
  await A.click('.look-close');
  await A.reload();
  await A.waitForSelector('#entry-signed-in:not([hidden])');
  await A.click('#entry-continue');
  await until(A, () => window.__WORLDS_DEBUG__?.ready && window.__WORLDS_DEBUG__.net?.status === 'online', null, 60000);
  check('after reload the look is still applied (saved per account)', (await m8(A)).avatar.robe === wantRobe && (await m8(A)).avatar.hairStyle === 'tied');
  const aId2 = (await debug(A)).net.id;
  await until(B, (id) => window.__WORLDS_DEBUG__.net.remotes.some((r) => r.id === id), aId2);
  check('…and others see it when you join again', (await remoteOf(B, aId2)).look.hairStyle === 'tied');
  await teleport(A, { x: -0.9, z: 3.2 });
  await A.evaluate(() => window.__WORLDS_TEST__.face(0));

  // ---------------------------------------------------------------- painter
  step('painter');
  await A.evaluate(() => window.__WORLDS_TEST__.openCustomize('draw'));
  await until(A, () => window.__WORLDS_TEST__.customize().open && window.__WORLDS_TEST__.customize().tab === 'draw');
  await A.click('#slot-0');
  await A.waitForSelector('#painter-grid');
  await sleep(300);
  await A.click('.painter-palette .swatch[data-index="2"]');
  await clickCell(A, 3, 2);
  check('칠하기: a click paints one cell with the chosen colour', (await painted(A))[2 * N + 3] === '2');
  await dragCells(A, 1, 5, 6, 5);
  const p1 = await painted(A);
  check('drag paints every cell along the way', [1, 2, 3, 4, 5, 6].every((x) => p1[5 * N + x] === '2'), p1.slice(5 * N, 6 * N));
  await A.click('#paint-mirror');
  await A.click('.painter-palette .swatch[data-index="8"]');
  await clickCell(A, 2, 10);
  const p2 = await painted(A);
  check('좌우대칭: painting (2,10) also paints (13,10)', p2[10 * N + 2] === '8' && p2[10 * N + 13] === '8');
  await A.click('#paint-fill');
  await A.click('.painter-palette .swatch[data-index="4"]');
  await clickCell(A, 8, 14);
  const p3 = await painted(A);
  const yellow = [...p3].filter((c) => c === '4').length;
  check('채우기: flood fill covers the empty region', yellow > 150, `${yellow} cells`);
  await A.click('#paint-undo');
  const p4 = await painted(A);
  check('되돌리기 undoes the fill', [...p4].filter((c) => c === '4').length === 0 && p4 === p2);
  await A.click('#paint-redo');
  check('다시 redoes it', (await painted(A)) === p3);
  await A.click('#paint-undo');
  await A.click('#paint-erase');
  await clickCell(A, 3, 2);
  check('지우기 makes a cell transparent again', (await painted(A))[2 * N + 3] === '.');
  await A.click('#paint-clear');
  check('전체 지우기 empties the grid (and can be undone)', (await painted(A)) === '.'.repeat(256));
  await A.click('#paint-undo');
  check('…undo brings the drawing back', (await painted(A)) !== '.'.repeat(256));
  await A.click('#paint-clear');
  // A small cross with a warm hem, drawn with the mirror on (like a person would).
  await A.click('#paint-pen');
  await A.click('.painter-palette .swatch[data-index="15"]');
  await dragCells(A, 7, 2, 7, 12);
  await dragCells(A, 4, 5, 7, 5);
  await A.click('.painter-palette .swatch[data-index="2"]');
  await dragCells(A, 0, 14, 7, 14);
  await A.click('.painter-palette .swatch[data-index="1"]');
  await dragCells(A, 0, 15, 7, 15);
  await A.click('.painter-palette .swatch[data-index="9"]');
  await clickCell(A, 3, 9);
  await clickCell(A, 2, 10);
  await clickCell(A, 3, 11);
  const drawing = await painted(A);
  const hist = (await custom(A)).history;
  check('undo history is kept (≤ 30 steps)', hist.undo > 0 && hist.undo <= 30, JSON.stringify(hist));
  await until(A, (px) => window.__WORLDS_TEST__.customize().previewPattern === px, drawing);
  check('live preview: the drawing is on the 3D robe while painting', (await custom(A)).previewPattern === drawing);
  await A.screenshot({ path: resolve(shotDir, 'm8-painter-desktop.png') });
  await A.click('#look-save');
  await A.waitForSelector('.look-status:has-text("저장했어요")');
  const aAgent = await agentFrom(actx);
  const mineA = (await aAgent.json('GET', '/api/me/look')).data;
  check('saved into slot 1 and worn', mineA.worn === 0 && mineA.slots[0]?.pixels === drawing);
  const outfit1 = mineA.slots[0].id;
  await until(B, ([id, o]) => window.__WORLDS_DEBUG__.net.remotes.find((x) => x.id === id)?.look.pattern?.pixels === o, [aId2, drawing], 10000);
  const seen = await remoteOf(B, aId2);
  check('another player fetched the drawing (outfit id/hash in PlayerInfo) and renders it', seen.look.outfitId === outfit1 && seen.look.pattern.pixels === drawing);
  check('the robe texture bytes match the drawing over the robe colour (NearestFilter)', seen.look.pattern.checksum === expectedChecksum(drawing, P.ROBE_COLORS[10]) && seen.look.pattern.filter === 'nearest', `${seen.look.pattern.checksum}`);
  check('own avatar wears it too', (await m8(A)).avatar.pattern?.pixels === drawing);
  await A.click('.look-close');

  // ---------------------------------------------------------------- reports
  step('reports');
  // Guests can't report: API and UI.
  check('guest: report API → 401', (await guest.json('POST', `/api/outfits/${outfit1}/report`, { reason: 'other' })).status === 401);
  const gctx = await browser.newContext(desktop);
  const G = await gctx.newPage();
  watch(G, 'G');
  await G.goto(BASE + Q());
  await G.waitForSelector('#entry-signed-out:not([hidden])');
  await G.fill('#nickname', '나그네');
  await G.click('#entry-submit');
  await until(G, () => window.__WORLDS_DEBUG__?.ready && window.__WORLDS_DEBUG__.net?.status === 'online', null, 60000);
  await until(G, (id) => window.__WORLDS_DEBUG__.net.remotes.find((r) => r.id === id)?.look.pattern, aId2, 15000);
  await G.click('#net-status');
  await G.waitForSelector('#players-list .report-btn');
  await G.click('#players-list .report-btn');
  await until(G, () => window.__WORLDS_DEBUG__.m3.modal === '로그인 안내');
  check('guest: 🚩 opens the login prompt instead of reporting', (await debug(G)).m3.modal === '로그인 안내');

  // B taps A's avatar in the world → card → 🚩 옷 신고.
  await B.evaluate(() => window.__WORLDS_TEST__.view(0, 0.18, -2));
  await sleep(600);
  const pt = await B.evaluate((id) => window.__WORLDS_TEST__.remoteScreen(id), aId2);
  await B.mouse.click(pt.x, pt.y);
  await until(B, () => window.__WORLDS_DEBUG__.m8.report === true, null, 5000).catch(() => undefined);
  check('tapping another avatar opens their card with 🚩 옷 신고', await B.isVisible('.report-sheet .report-btn'), JSON.stringify(pt));
  await B.click('.report-sheet .report-btn');
  await B.click('#report-reason-inappropriate');
  await B.click('#report-send');
  await B.waitForSelector('.report-sheet .groups-status:has-text("신고를 받았어요")');
  check('B reported (reason chip 부적절한 그림)', db.prepare('SELECT reason FROM outfit_reports WHERE outfit_id = ?').get(outfit1)?.reason === 'inappropriate');
  await B.click('.report-close');
  const bAgent = await agentFrom(bctx);
  const dup = await bAgent.json('POST', `/api/outfits/${outfit1}/report`, { reason: 'other' });
  const count1 = db.prepare('SELECT COUNT(*) n FROM outfit_reports WHERE outfit_id = ?').get(outfit1).n;
  check('duplicate report by the same person is not counted', dup.status === 200 && dup.data.duplicate === true && count1 === 1);
  check('own drawing cannot be reported', (await aAgent.json('POST', `/api/outfits/${outfit1}/report`, { reason: 'other' })).status === 400);
  check('bad reason → 400', (await bAgent.json('POST', `/api/outfits/${outfit1}/report`, { reason: 'boring' })).status === 400);
  const c = await account('m8-cora', '코라');
  const d = await account('m8-dan', '단');
  const e = await account('m8-eve', '이브');
  await c.json('POST', `/api/outfits/${outfit1}/report`, { reason: 'hate' });
  check('2 reporters: still visible', !db.prepare('SELECT hidden_at FROM outfits WHERE id = ?').get(outfit1).hidden_at);
  await d.json('POST', `/api/outfits/${outfit1}/report`, { reason: 'other' });
  check('3 distinct reporters: hidden', !!db.prepare('SELECT hidden_at FROM outfits WHERE id = ?').get(outfit1).hidden_at);
  await until(B, (id) => window.__WORLDS_DEBUG__.net.remotes.find((x) => x.id === id)?.look.pattern === null, aId2, 10000);
  const hiddenView = await remoteOf(B, aId2);
  check('others now see the plain robe (live), colours kept', hiddenView.look.pattern === null && hiddenView.look.outfitId === null && hiddenView.look.robe === wantRobe);
  check('hidden drawing is not served to others', (await bAgent.json('GET', `/api/outfits?ids=${outfit1}`)).data.outfits.length === 0 && (await guest.json('GET', `/api/outfits?ids=${outfit1}`)).data.outfits.length === 0);
  check('…but is to its owner', (await aAgent.json('GET', `/api/outfits?ids=${outfit1}`)).data.outfits.length === 1);
  await until(A, () => window.__WORLDS_DEBUG__.m8.notice, null, 10000);
  check('owner still sees it on their own avatar, with the notice', (await m8(A)).avatar.pattern?.pixels === drawing && (await A.textContent('#outfit-notice')).includes('신고가 쌓여 옷 그림이 숨겨졌어요'));
  check('notice links to the terms (new tab)', (await A.getAttribute('#outfit-notice a', 'href')) === '/terms#t7' && (await A.getAttribute('#outfit-notice a', 'target')) === '_blank');
  await A.screenshot({ path: resolve(shotDir, 'm8-hidden-notice.png') });
  check('strike counted', (await aAgent.json('GET', '/api/me/look')).data.strikes === 1);
  check('re-uploading the identical hidden drawing is refused (409)', (await aAgent.json('PUT', '/api/me/outfits/2', { pixels: drawing })).status === 409);

  // Owner edits → new hash → visible again.
  await A.click('#outfit-notice .primary');
  await until(A, () => window.__WORLDS_TEST__.customize().open && window.__WORLDS_TEST__.customize().tab === 'draw');
  await A.waitForSelector('#painter-grid');
  await sleep(300);
  check('the sheet tells the owner it is hidden', (await A.textContent('.sheet.look')).includes('숨겨졌어요'));
  await A.click('.painter-palette .swatch[data-index="2"]');
  await clickCell(A, 7, 1);
  const drawing2 = await painted(A);
  await A.click('#look-save');
  await A.waitForSelector('.look-status:has-text("저장했어요")');
  await A.click('.look-close');
  const mineA2 = (await aAgent.json('GET', '/api/me/look')).data;
  check('editing makes a new drawing (new id + hash), worn again', mineA2.slots[0].id !== outfit1 && mineA2.slots[0].hash !== mineA.slots[0].hash && mineA2.worn === 0 && !mineA2.slots[0].hidden);
  await until(B, ([id, px]) => window.__WORLDS_DEBUG__.net.remotes.find((x) => x.id === id)?.look.pattern?.pixels === px, [aId2, drawing2], 10000);
  check('others see the edited drawing again', (await remoteOf(B, aId2)).look.pattern.pixels === drawing2);
  await until(A, () => !window.__WORLDS_DEBUG__.m8.notice, null, 5000);
  check('the notice goes away', !(await m8(A)).notice);
  check('the hidden original is kept (slotless) for review', !!db.prepare('SELECT 1 FROM outfits WHERE id = ? AND slot IS NULL AND hidden_at IS NOT NULL').get(outfit1));

  // Strikes → upload ban (via the API: two more hidden drawings).
  const hideOnce = async (n) => {
    const px = draw((x, y) => (x === n || y === n ? 'c' : undefined));
    const r = await aAgent.json('PUT', '/api/me/outfits/1', { pixels: px });
    await aAgent.json('PUT', '/api/me/look', { appearance: { r: 10, s: 2, k: 3, h: 6, y: 3 }, worn: 1 });
    const oid = r.data.slots[1].id;
    for (const who of [c, d, e]) await who.json('POST', `/api/outfits/${oid}/report`, { reason: 'inappropriate' });
    return oid;
  };
  const o2 = await hideOnce(3);
  const s2 = (await aAgent.json('GET', '/api/me/look')).data;
  check('second hidden drawing: 2 strikes, still allowed to upload', s2.strikes === 2 && s2.banUntil === null);
  const o3 = await hideOnce(5);
  const s3 = (await aAgent.json('GET', '/api/me/look')).data;
  const days = (s3.banUntil - Date.now()) / 86_400_000;
  check('third hidden drawing: uploads paused for 7 days', s3.strikes === 3 && days > 6.9 && days <= 7.01, `strikes ${s3.strikes}, ${days.toFixed(2)} days`);
  const banned = await aAgent.json('PUT', '/api/me/outfits/2', { pixels: draw((x) => (x === 1 ? '3' : undefined)) });
  check('banned: new drawings are refused (403 outfit_banned) with a date', banned.status === 403 && banned.data.error === 'outfit_banned' && /까지/.test(banned.data.message), banned.data?.message);
  check('banned: colours can still change', (await aAgent.json('PUT', '/api/me/look', { appearance: { r: 10, s: 2, k: 3, h: 6, y: 3 }, worn: 0 })).status === 200);

  // ---------------------------------------------------------------- admin
  step('admin');
  for (const [who, agent] of [
    ['guest', guest],
    ['B (signed in, not admin)', bAgent],
  ]) {
    const l = await agent.json('GET', '/api/admin/outfits');
    const a = await agent.json('POST', `/api/admin/outfits/${o3}`, { action: 'restore' });
    check(`${who}: admin endpoints answer 404`, l.status === 404 && a.status === 404, `${l.status}/${a.status}`);
  }
  check('/api/me does not mark a non-admin', !(await bAgent.json('GET', '/api/me')).data.admin);
  check('restore by a non-admin did nothing', !!db.prepare('SELECT hidden_at FROM outfits WHERE id = ?').get(o3).hidden_at);
  const adctx = await browser.newContext(desktop);
  const AD = await adctx.newPage();
  watch(AD, 'admin');
  await loginJoin(AD, BASE, ADMIN_HINT, '관리자', Q());
  const admin = await agentFrom(adctx);
  check('/api/me marks the admin (verified email in WORLDS_ADMIN_EMAILS, case-insensitive)', (await admin.json('GET', '/api/me')).data.admin === true);
  const list = (await admin.json('GET', '/api/admin/outfits')).data.outfits;
  const item = list.find((o) => o.id === o3);
  check('admin list: reported/hidden drawings with pixels, owner nickname, reporter count and reasons', list.length >= 3 && item?.owner.nickname === '안나' && item.reporters === 3 && item.reasons.inappropriate === 3 && item.hidden && item.pixels.length === 256, JSON.stringify(item ?? list[0]).slice(0, 200));
  await AD.click('#btn-settings');
  await AD.waitForSelector('#settings-admin');
  await AD.click('#settings-admin');
  await AD.waitForSelector('#admin-list .admin-item');
  check('admin sheet lists them in the app', (await AD.locator('#admin-list .admin-item').count()) >= 3);
  await sleep(900); // fade-in of the sheet
  await AD.screenshot({ path: resolve(shotDir, 'm8-admin-list.png') });
  // 숨김 유지 from the UI on the first drawing (outfit1, already hidden).
  await AD.click(`#admin-list .admin-item[data-id="${outfit1}"] .admin-hide`);
  await until(AD, () => document.querySelector('.admin-sheet .groups-status')?.textContent.includes('유지'), null, 5000);
  check('숨김 유지 records the review and keeps it hidden', db.prepare('SELECT review, hidden_at FROM outfits WHERE id = ?').get(outfit1).review === 'kept');
  // A is wearing o3 (slot 1)? A now wears slot 0 (edited). Put o3 back on to see the restore live.
  await aAgent.json('PUT', '/api/me/look', { appearance: { r: 10, s: 2, k: 3, h: 6, y: 3 }, worn: 1 });
  await until(B, (id) => window.__WORLDS_DEBUG__.net.remotes.find((x) => x.id === id)?.look.pattern === null, aId2, 10000);
  const restore = await admin.json('POST', `/api/admin/outfits/${o3}`, { action: 'restore' });
  check('admin 복구: visible again', restore.status === 200 && !db.prepare('SELECT hidden_at FROM outfits WHERE id = ?').get(o3).hidden_at);
  await until(B, ([id, o]) => window.__WORLDS_DEBUG__.net.remotes.find((x) => x.id === id)?.look.outfitId === o, [aId2, o3], 10000);
  check('…live for others, and one strike is taken back', !!(await remoteOf(B, aId2)).look.pattern && (await aAgent.json('GET', '/api/me/look')).data.strikes === 2);
  await e.json('POST', `/api/outfits/${o3}/report`, { reason: 'other' });
  check('a restored drawing is not auto-hidden again by more reports', !db.prepare('SELECT hidden_at FROM outfits WHERE id = ?').get(o3).hidden_at);
  const ban = await admin.json('POST', `/api/admin/outfits/${o2}`, { action: 'ban', days: 2 });
  const banUntil = (await aAgent.json('GET', '/api/me/look')).data.banUntil;
  check('admin 그림 금지 2일 sets the ban', ban.status === 200 && Math.abs((banUntil - Date.now()) / 86_400_000 - 2) < 0.01);
  check('admin: bad action / days → 400', (await admin.json('POST', `/api/admin/outfits/${o2}`, { action: 'nuke' })).status === 400 && (await admin.json('POST', `/api/admin/outfits/${o2}`, { action: 'ban', days: 0 })).status === 400);
  await adctx.close();
  const settingsB = await (async () => {
    await B.click('#btn-settings');
    await B.waitForSelector('#settings-look-btn');
    const has = await B.isVisible('#settings-admin');
    await B.click('.sheet.settings .ghost');
    return has;
  })();
  check('non-admins have no admin button in ⚙', settingsB === false);

  // ---------------------------------------------------------------- export
  step('export');
  const ex = (await aAgent.json('GET', '/api/me/export')).data;
  check(
    'export includes appearance, drawings (pixels, hidden state) and strikes',
    ex.appearance?.appearance?.r === 10 && ex.appearance.appearance.y === 3 && ex.appearance.outfits.length >= 3 && ex.appearance.outfits.some((o) => o.pixels === drawing2) && ex.appearance.outfits.some((o) => o.hiddenAt) && ex.appearance.outfitStrikes === 2,
    JSON.stringify(ex.appearance ?? null).slice(0, 160),
  );
  const exC = (await c.json('GET', '/api/me/export')).data;
  check("a reporter's export lists their own reports (not the drawing's owner)", exC.appearance.outfitReportsMade.length >= 3 && !JSON.stringify(exC).includes('안나'));

  // ---------------------------------------------------------------- phone
  step('phone');
  const mctx = await browser.newContext(mobile);
  await mctx.route('https://www.youtube.com/iframe_api', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: YT_STUB }));
  const M = await mctx.newPage();
  watch(M, 'M');
  await loginJoin(M, BASE, 'm8-mia', '미아', `?test=1&shadows=0&time=13:00&date=${DAY}&noguide=1`);
  await until(M, () => window.__WORLDS_DEBUG__.m3.worship.state === 'playing', null, 20000).catch(() => undefined);
  await M.tap('#btn-look');
  await until(M, () => window.__WORLDS_TEST__.customize().open);
  await sleep(800);
  const worshipOn = await M.evaluate(() => document.body.classList.contains('worship-on'));
  const wbox = await box(M, '#worship');
  const sbox = await box(M, '.sheet.look');
  check('phone: worship player stays visible (≥ 200 px tall) above the sheet', worshipOn && wbox && wbox.height >= 200, JSON.stringify(wbox));
  check('phone: 꾸미기 sheet does not overlap the worship player', !overlaps(sbox, wbox), `player ${JSON.stringify(wbox)} sheet ${JSON.stringify(sbox)}`);
  check('phone: at most one YouTube iframe', (await M.locator('iframe').count()) <= 1);
  await M.screenshot({ path: resolve(shotDir, 'm8-customize-phone.png') });
  for (let i = 0; i < 3 && (await custom(M)).tab !== 'draw'; i++) {
    await M.tap('#look-tab-draw');
    await sleep(500);
  }
  for (let i = 0; i < 3 && (await custom(M)).slot !== 0; i++) {
    await M.tap('#slot-0');
    await sleep(500);
  }
  await M.waitForSelector('#painter-grid');
  await sleep(400);
  const cell = (await custom(M)).cell;
  const gbox = await box(M, '#painter-grid');
  check('phone: painter cells are at least 16 px', cell >= 16 && gbox.width >= 16 * N, `cell ${cell}px, grid ${Math.round(gbox.width)}px`);
  check('phone: the grid takes touches (touch-action: none, no pinch/scroll)', (await M.evaluate(() => getComputedStyle(document.getElementById('painter-grid')).touchAction)) === 'none');
  // A heart: outline by tapping with the mirror on, then fill the inside.
  await M.tap('#paint-mirror');
  await M.tap('.painter-palette .swatch[data-index="2"]');
  for (const [x, y] of [
    [5, 4],
    [6, 4],
    [4, 5],
    [7, 5],
    [3, 6],
    [3, 7],
    [4, 8],
    [5, 9],
    [6, 10],
    [7, 11],
  ]) {
    const p = await cellPoint(M, x, y);
    await M.touchscreen.tap(p.x, p.y);
  }
  await M.tap('#paint-fill');
  await M.tap('.painter-palette .swatch[data-index="10"]');
  const fp = await cellPoint(M, 6, 7);
  await M.touchscreen.tap(fp.x, fp.y);
  const mp = await painted(M);
  const pink = [...mp].filter((ch) => ch === 'a').length;
  check('phone: tapping paints (mirrored) and fills', mp[4 * N + 5] === '2' && mp[4 * N + 10] === '2' && pink >= 20 && pink < 60, `${pink} filled`);
  const sbox2 = await box(M, '.sheet.look');
  check('phone: painter sheet still clear of the worship player', !overlaps(sbox2, await box(M, '#worship')));
  await M.evaluate(() => document.querySelector('.painter-palette').scrollIntoView({ block: 'end' }));
  await sleep(300);
  await M.screenshot({ path: resolve(shotDir, 'm8-painter-phone.png') });
  await mctx.close();

  // ---------------------------------------------------------------- crowd: 10 drawn robes
  step('crowd');
  await G.context().close();
  const baseTex = (await m8(B)).liveTextures;
  const reqBefore = (await m8(B)).outfitRequests;
  const crowd = [];
  const ground = (await debug(B)).player.y;
  const patterns = [
    (x, y) => ((x + y) % 2 === 0 ? '2' : undefined),
    (x, y) => (y % 3 === 0 ? '8' : undefined),
    (x, y) => (Math.abs(x - 7.5) + Math.abs(y - 7.5) < 6 ? 'a' : undefined),
    (x) => (x % 4 < 2 ? '6' : undefined),
    (x, y) => (y > 10 ? '0' : y < 3 ? 'f' : undefined),
    (x, y) => ((x * y) % 5 === 0 ? '3' : undefined),
    (x, y) => (Math.hypot(x - 7.5, y - 6) < 4 ? '4' : undefined),
    (x, y) => (x === y || x === 15 - y ? '9' : undefined),
    (x, y) => (y % 4 === 1 ? 'b' : y % 4 === 3 ? 'c' : undefined),
    (x, y) => (x > 3 && x < 12 && y > 3 && y < 12 ? (x + y) % 2 ? '5' : '1' : undefined),
  ];
  for (let i = 0; i < 10; i++) {
    const ag = await account(`m8-crowd${i}`, `무리${i}`);
    const px = draw(patterns[i]);
    await ag.json('PUT', '/api/me/outfits/0', { pixels: px });
    await ag.json('PUT', '/api/me/look', { appearance: { r: (i * 3 + 1) % 16, s: i % 12, k: i % 6, h: (i * 3) % 8, y: i % 5 }, worn: 0 });
    const ws = await rawClient(WS, { nickname: 'x', test: true }, { cookie: ag.cookieHeader() });
    // An arc in front of B, facing B.
    const a = -0.9 + (i / 9) * 1.8;
    const x = Math.sin(a) * 5.2;
    const z = 9 - Math.cos(a) * 5.2;
    ws.send({ t: 'state', x, y: ground, z, yaw: Math.atan2(0 - x, 9 - z), speed: 0 });
    crowd.push({ ws, px });
  }
  await until(B, () => window.__WORLDS_DEBUG__.net.remotes.filter((r) => r.look.pattern).length >= 11, null, 20000).catch(() => undefined);
  const after = await debug(B);
  const drawn = after.net.remotes.filter((r) => r.look.pattern);
  check('10 avatars with different drawings render (plus A)', drawn.length >= 11 && crowd.every((cw) => drawn.some((r) => r.look.pattern.pixels === cw.px)), `${drawn.length} drawn`);
  check('one texture per drawn avatar', after.m8.liveTextures === baseTex + 10, `${baseTex} → ${after.m8.liveTextures}`);
  check('each drawing is fetched once (one request per join at most)', after.m8.outfitRequests - reqBefore <= 10, `${after.m8.outfitRequests - reqBefore} requests`);
  // Joining a full room: every drawing arrives in the welcome and is fetched in one batch.
  await B.reload();
  await B.waitForSelector('#entry-signed-in:not([hidden])');
  await B.click('#entry-continue');
  await until(B, () => window.__WORLDS_DEBUG__?.ready && window.__WORLDS_DEBUG__.net?.status === 'online', null, 60000);
  await until(B, () => window.__WORLDS_DEBUG__.net.remotes.filter((r) => r.look.pattern).length >= 11, null, 20000).catch(() => undefined);
  const rejoin = await debug(B);
  check('joining a room with 11 drawn robes fetches them in one batched request', rejoin.net.remotes.filter((r) => r.look.pattern).length >= 11 && rejoin.m8.outfitRequests === 1, `${rejoin.m8.outfitRequests} requests`);
  await teleport(B, { x: 0, z: 9 });
  check('hair styles vary in the crowd', new Set(after.net.remotes.map((r) => r.look.hairStyle)).size >= 4);
  // Two looks side by side in the plaza by day.
  await teleport(A, { x: 1.7, z: 6.3 });
  await A.evaluate(() => window.__WORLDS_TEST__.face(-0.45));
  await B.evaluate(() => window.__WORLDS_TEST__.view(0.42, 0.12, -3));
  await sleep(1500);
  await B.screenshot({ path: resolve(shotDir, 'm8-plaza-day.png') });
  await B.evaluate(() => window.__WORLDS_TEST__.view(0.5, 0.1, -6));
  await sleep(800);
  await B.screenshot({ path: resolve(shotDir, 'm8-plaza-closeup.png') });
  for (const cw of crowd) cw.ws.ws.close();
  await until(B, () => window.__WORLDS_DEBUG__.m8.liveTextures === 1, null, 10000).catch(() => undefined);
  check('textures are disposed when they leave (only A\'s remains)', (await m8(B)).liveTextures === 1, `${(await m8(B)).liveTextures}`);

  // ---------------------------------------------------------------- deletion
  step('deletion');
  const aOutfits = db.prepare('SELECT id FROM outfits WHERE user_id = ?').all(aAgent.id).map((r) => r.id);
  const del = await aAgent.json('POST', '/api/me/delete', { nickname: '안나' });
  check('회원 탈퇴 succeeds', del.status === 200);
  const inList = (ids) => (ids.length ? ids.join(',') : '0');
  const left = {
    user: db.prepare('SELECT COUNT(*) n FROM users WHERE id = ?').get(aAgent.id).n,
    outfits: db.prepare('SELECT COUNT(*) n FROM outfits WHERE user_id = ?').get(aAgent.id).n,
    reportsAbout: db.prepare(`SELECT COUNT(*) n FROM outfit_reports WHERE outfit_id IN (${inList(aOutfits)})`).get().n,
  };
  check("deletion removes the appearance, all drawings and the reports about them", Object.values(left).every((n) => n === 0) && aOutfits.length >= 3, JSON.stringify(left));
  const cReports = db.prepare('SELECT COUNT(*) n FROM outfit_reports WHERE reporter_id = ?').get(c.id).n;
  await c.json('PUT', '/api/me/outfits/0', { pixels: draw((x) => (x === 2 ? '1' : undefined)) });
  await v.json('POST', `/api/outfits/${db.prepare('SELECT id FROM outfits WHERE user_id = ?').get(c.id).id}/report`, { reason: 'other' });
  await c.json('POST', '/api/me/delete', { nickname: '코라' });
  const cLeft = {
    reportsBy: db.prepare('SELECT COUNT(*) n FROM outfit_reports WHERE reporter_id = ?').get(c.id).n,
    outfits: db.prepare('SELECT COUNT(*) n FROM outfits WHERE user_id = ?').get(c.id).n,
    reportsAbout: db.prepare('SELECT COUNT(*) n FROM outfit_reports r LEFT JOIN outfits o ON o.id = r.outfit_id WHERE o.id IS NULL').get().n,
  };
  check("a reporter's deletion removes the reports they made and the ones about them", cReports === 0 || Object.values(cLeft).every((n) => n === 0), JSON.stringify(cLeft));
  const needles = ['안나', 'mock-m8-anna', '코라', 'mock-m8-cora'];
  const hits = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    for (const r of db.prepare(`SELECT * FROM "${name}"`).all()) for (const [col, val] of Object.entries(r)) if (typeof val === 'string' && needles.some((n) => val.includes(n))) hits.push(`${name}.${col}`);
  }
  check('table scan: no trace of the deleted accounts', hits.length === 0, hits.join(', '));
  check('their drawings are no longer served', (await bAgent.json('GET', `/api/outfits?ids=${inList(aOutfits)}`)).data.outfits.length === 0);

  check('no page errors in any browser', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | '));
  db.close();
} catch (err) {
  for (const [i, pg] of (browser?.contexts() ?? []).flatMap((c) => c.pages()).entries()) await pg.screenshot({ path: resolve(shotDir, `m8-fail-${i}.png`) }).catch(() => undefined);
  check(`no exception (at ${currentStep()})`, false, err?.stack?.split('\n').slice(0, 3).join(' | '));
} finally {
  await browser?.close();
  await stopAll();
  dropDb(DB);
  rmSync(DIST, { recursive: true, force: true });
}
process.exit(summary());
