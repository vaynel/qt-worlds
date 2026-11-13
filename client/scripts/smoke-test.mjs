// Smoke test: the fast tier (target < 4 min on the N100). Run before every commit.
// One server in production-like mode (SERVE_CLIENT: the built client, /api and /ws
// on one port, CSP headers) with mock login and a throwaway DB, two browsers:
//   A = phone (390×844, touch), B = desktop (1280×720).
// Covers: /health, /api/me, CSP, brotli/gzip; login + consent; the world renders;
// the HUD's four buttons; the phone worship facade (nothing from YouTube until a
// tap) and the desktop player; 말씀 → a meditation saves → a lantern is shared;
// campfire chat both ways; the 📬 badge via /letters/unread (no inbox download);
// a library bookcase list; the ⚙ menu pages; render-on-demand under a phone sheet.
// Waits are predicates (until/waitFor…), never fixed sleeps.
//   cd client && npm run build && (cd ../server && npm run build) && npm run test:smoke
// Port: TEST_SERVER_PORT (default 5188). VERBOSE=1 prints steps and server logs.
import { existsSync, readFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import {
  check,
  clientDir,
  currentStep,
  debug,
  dropDb,
  freshDb,
  launch,
  loginJoin,
  openBook,
  openSettings,
  serverDir,
  startServer,
  step,
  stopAll,
  summary,
  teleport,
  until,
  waitHttp,
} from './lib/harness.mjs';

const t0 = Date.now();
const PORT = Number(process.env.TEST_SERVER_PORT ?? 5188);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/`;
const Q = '?test=1&shadows=0&time=14:00&noguide=1';
const DB = freshDb('smoke');
const DIST = resolve(clientDir, 'dist');
for (const f of [resolve(DIST, 'index.html'), resolve(serverDir, 'dist/server/src/index.js')]) {
  if (!existsSync(f)) {
    console.error(`missing ${f}: build first (cd client && npm run build; cd ../server && npm run build)`);
    process.exit(1);
  }
}
const VAPID = createRequire(resolve(serverDir, 'package.json'))('web-push').generateVAPIDKeys(); // throwaway: shows ⚙ 알림
const P = await import(pathToFileURL(resolve(serverDir, 'dist/shared/protocol.js')).href);

// Desktop gets a YouTube stub (no network; reports PLAYING like the real player).
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
  this.getPlayerState = function () { return 1; };
  this.getVideoData = function () { return { video_id: opts.videoId }; };
  setTimeout(function () { if (opts.events && opts.events.onReady) opts.events.onReady(); }, 50);
} };
setTimeout(function () { if (window.onYouTubeIframeAPIReady) window.onYouTubeIframeAPIReady(); }, 0);
`;
const stubYouTube = (ctx) => ctx.route('https://www.youtube.com/iframe_api', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: YT_STUB }));

const modalIs = (p, name, ms = 15000) => until(p, (n) => window.__WORLDS_DEBUG__.m3.modal === n, name, ms);
const worship = async (p) => (await debug(p)).m3.worship;
/** GET with the body exactly as sent (fetch would decode br/gzip for us). */
const raw = (path, enc) =>
  new Promise((resolveRaw, reject) => {
    const req = httpGet(`${ORIGIN}${path}`, { headers: enc ? { 'accept-encoding': enc } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolveRaw({ status: res.statusCode, headers: { get: (k) => res.headers[k.toLowerCase()] ?? null }, body: Buffer.concat(chunks) }),
      );
    });
    req.on('error', reject);
  });

let browser;
try {
  // ------------------------------------------------------------------ server + HTTP
  step('server');
  startServer(PORT, DB, {
    WORLDS_AUTH_MOCK: '1',
    SERVE_CLIENT: '1',
    WORLDS_CLIENT_DIST: DIST,
    MAX_CONN_PER_IP: '60',
    AUTH_RATE_LIMIT: '300',
    WORLDS_PUSH_MOCK: '1',
    VAPID_PUBLIC_KEY: VAPID.publicKey,
    VAPID_PRIVATE_KEY: VAPID.privateKey,
    VAPID_SUBJECT: 'mailto:test@example.invalid',
  });
  await waitHttp(`${BASE}health`);
  browser = await launch();

  step('http');
  const health = await raw('/health');
  check('/health answers 200', health.status === 200);
  const me = JSON.parse((await raw('/api/me')).body.toString());
  check('/api/me answers (guest: user null)', me.user === null, JSON.stringify(me).slice(0, 80));
  const html = await raw('/', 'gzip, deflate, br');
  const csp = html.headers.get('content-security-policy') ?? '';
  check('HTML has the CSP header (self + YouTube frame + i.ytimg.com images)', /default-src 'self'/.test(csp) && /youtube-nocookie/.test(csp) && /i\.ytimg\.com/.test(csp), csp.slice(0, 60));
  const indexHtml = readFileSync(resolve(DIST, 'index.html'), 'utf8');
  const js = indexHtml.match(/\/assets\/[^"']+\.js/)?.[0];
  const css = indexHtml.match(/\/assets\/[^"']+\.css/)?.[0];
  // Brotli copies are made in the background at startup: wait until they're served.
  const end = Date.now() + 30000;
  let br = await raw(js, 'gzip, deflate, br');
  while (br.headers.get('content-encoding') !== 'br' && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 250));
    br = await raw(js, 'gzip, deflate, br');
  }
  const brBody = br.body;
  const gz = await raw(js, 'gzip, deflate');
  const gzBody = gz.body;
  const plain = readFileSync(resolve(DIST, `.${js}`));
  check(
    'JS: brotli when accepted, gzip fallback, both decode to the file; Vary + immutable',
    br.headers.get('content-encoding') === 'br' &&
      gz.headers.get('content-encoding') === 'gzip' &&
      brotliDecompressSync(brBody).equals(plain) &&
      gunzipSync(gzBody).equals(plain) &&
      br.headers.get('vary') === 'accept-encoding' &&
      /immutable/.test(br.headers.get('cache-control') ?? ''),
    `raw ${plain.length} B, gzip ${gzBody.length} B, br ${brBody.length} B`,
  );
  const cssBr = await raw(css, 'br');
  check('CSS and HTML are served brotli too', cssBr.headers.get('content-encoding') === 'br' && html.headers.get('content-encoding') === 'br');

  // ------------------------------------------------------------------ browsers
  step('login');
  const ctxA = await browser.newContext({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await stubYouTube(ctxB);
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  const errors = [];
  const ytRequests = [];
  const inboxRequests = [];
  for (const [n, p] of [['A', A], ['B', B]]) p.on('pageerror', (e) => errors.push(`${n}: ${String(e).split('\n')[0]}`));
  A.on('request', (r) => {
    const u = r.url();
    if (/youtube\.com|youtube-nocookie\.com|googlevideo\.com/.test(u)) ytRequests.push(u);
    if (u.includes('/api/library/letters/inbox')) inboxRequests.push(u);
  });
  // Both sign up through the mock provider (nickname + 만 14세/약관 consent) at once.
  await Promise.all([loginJoin(A, BASE, 'smoke-anna', '스모크안나', Q), loginJoin(B, BASE, 'smoke-ben', '스모크벤', Q)]);
  const accounts = await Promise.all([A, B].map((p) => p.evaluate(async () => (await (await fetch('/api/me')).json()).user)));
  check('login + consent: both signed in with their nicknames', accounts[0]?.nickname === '스모크안나' && accounts[1]?.nickname === '스모크벤', accounts.map((a) => a?.nickname).join(','));

  step('world');
  for (const [n, p] of [['phone', A], ['desktop', B]]) {
    await until(p, () => window.__WORLDS_DEBUG__.renderer.calls > 20);
    const d = await debug(p);
    const tools = await p.$$eval('#tools > *', (els) => els.filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.id));
    check(`${n}: the world renders (${d.renderer.calls} draw calls, ${d.chunks} chunks)`, d.ready && d.renderer.calls > 20 && d.chunks > 0);
    check(`${n}: HUD has 말씀 · 모임 · 찬양 · ⚙`, tools.join(',') === 'btn-word,btn-groups,btn-worship,btn-settings', tools.join(','));
  }
  // ⚙ → 🎨 화면 품질: default 선명 (1.5 on a DPR-2 phone); 보통 → 1.25; 절약 → 1.
  check('phone pixel ratio default 선명 = 1.5 (DPR 2 device)', (await debug(A)).renderer.pixelRatio === 1.5, String((await debug(A)).renderer.pixelRatio));
  await A.evaluate(() => { localStorage.setItem('worlds.graphics.quality', 'normal'); window.dispatchEvent(new CustomEvent('worlds:graphics')); });
  await until(A, () => window.__WORLDS_DEBUG__.renderer.pixelRatio === 1.25, null, 10000).catch(() => undefined);
  check('화면 품질 보통 → 1.25, applied live', (await debug(A)).renderer.pixelRatio === 1.25, String((await debug(A)).renderer.pixelRatio));
  await A.evaluate(() => { localStorage.setItem('worlds.graphics.quality', 'sharp'); window.dispatchEvent(new CustomEvent('worlds:graphics')); });
  check('desktop pixel ratio unchanged (1 here)', (await debug(B)).renderer.pixelRatio === 1, String((await debug(B)).renderer.pixelRatio));

  step('worship');
  await until(A, () => window.__WORLDS_DEBUG__.m3.worship.facade === true, null, 10000);
  const wa = await worship(A);
  check('phone: worship facade (title + ▶ 찬양 듣기), no iframe, nothing requested from YouTube', wa.lazy && wa.facade && wa.iframes === 0 && (await A.isVisible('#worship-facade-play')) && ytRequests.length === 0, ytRequests.slice(0, 2).join(' '));
  const facadeBox = await A.locator('#worship .worship-frame').boundingBox();
  check('phone: the facade holds the player spot (≥200×200)', facadeBox && facadeBox.width >= 199.5 && facadeBox.height >= 199.5, JSON.stringify(facadeBox));
  await until(B, () => window.__WORLDS_DEBUG__.m3.worship.state === 'playing', null, 20000);
  const wb = await worship(B);
  check('desktop: the player is created on entry and plays (no facade)', !wb.lazy && !wb.facade && wb.state === 'playing', `${wb.state} facade=${wb.facade}`);
  await stubYouTube(ctxA);
  await A.tap('#worship-facade-play');
  await until(A, () => window.__WORLDS_DEBUG__.m3.worship.state === 'playing', null, 15000);
  check('phone: ▶ 찬양 듣기 creates the one player and it plays', !(await worship(A)).facade && (await worship(A)).iframes <= 1);

  step('letters badge');
  const unread = await A.evaluate(async () => {
    const r = await fetch('/api/library/letters/unread');
    return { status: r.status, body: await r.json() };
  });
  check('📬 /api/library/letters/unread answers { unread }; sign-in never downloaded the inbox', unread.status === 200 && unread.body.unread === 0 && inboxRequests.length === 0, `${JSON.stringify(unread)} inbox requests ${inboxRequests.length}`);

  step('word book');
  await openBook(A, 'today');
  await until(A, () => window.__WORLDS_DEBUG__.renderer.sheetCovers === true, null, 5000).catch(() => undefined);
  const covered = await debug(A);
  check('phone: the book sheet covers the world → render on demand', covered.renderer.sheetCovers === true);
  await A.tap('#today-meditate');
  await modalIs(A, '묵상하기');
  await A.tap('.med-foot .primary');
  await A.fill('#med-meditation', '스모크 테스트 묵상');
  await A.tap('.med-foot .primary');
  await A.fill('#med-feeling', '감사해요');
  await A.tap('.med-foot .primary');
  await A.fill('#med-application', '한 사람에게 인사하기');
  await A.tap('.med-save');
  await modalIs(A, '나의 말씀 책');
  await until(A, () => document.querySelector('#today-status')?.classList.contains('done'), null, 10000);
  check('말씀 → 묵상하기 saves (✓ on [오늘])', (await A.textContent('#today-status')).includes('✓'));
  await A.tap('#today-share');
  await A.waitForSelector('#share-submit');
  await A.tap('#share-submit');
  await until(A, () => document.querySelector('#today-share')?.textContent.includes('밝혔어요'), null, 10000);
  const lid = await A.evaluate(async () => (await (await fetch('/api/wordbook')).json()).pages.flatMap((p) => p.meditations).find((m) => m.lanternId)?.lanternId);
  await until(B, (id) => window.__WORLDS_DEBUG__.m4.lanterns.some((l) => l.id === id), lid, 10000).catch(() => undefined);
  check('🏮 등불로 나누기 lights a lantern, and the other player sees it live', !!lid && (await debug(B)).m4.lanterns.some((l) => l.id === lid), String(lid));
  await A.keyboard.press('Escape');
  await modalIs(A, null);
  await until(A, () => window.__WORLDS_DEBUG__.renderer.sheetCovers === false, null, 5000).catch(() => undefined);
  check('closing the sheet restores the full render rate', (await debug(A)).renderer.sheetCovers === false);

  step('campfire chat');
  await teleport(A, { x: P.CAMPFIRE.x - 2, z: P.CAMPFIRE.z + 6 });
  await teleport(B, { x: P.CAMPFIRE.x + 3, z: P.CAMPFIRE.z + 1 });
  await Promise.all([A, B].map((p) => until(p, () => window.__WORLDS_DEBUG__.net.chatVisible, null, 15000)));
  await B.fill('#chat-input', '모닥불 곁에서 안녕하세요');
  await B.press('#chat-input', 'Enter');
  await until(A, (t) => window.__WORLDS_DEBUG__.net.chatLog.some((l) => l.includes(t)), '모닥불 곁에서', 10000);
  await A.fill('#chat-input', '반가워요');
  await A.press('#chat-input', 'Enter');
  await until(B, (t) => window.__WORLDS_DEBUG__.net.chatLog.some((l) => l.includes(t)), '반가워요', 10000);
  check('campfire chat both ways (desktop → phone → desktop)', true);

  step('library');
  const door = await B.evaluate(() => window.__WORLDS_TEST__.libraryDoor());
  await teleport(B, door);
  await until(B, () => document.getElementById('action-btn').textContent.includes('도서관'), null, 10000);
  await B.keyboard.press('KeyE');
  await until(B, () => window.__WORLDS_DEBUG__.la.inLibrary === true, null, 15000);
  const lib = await B.evaluate(() => window.__WORLDS_TEST__.library());
  await teleport(B, lib.fronts.testimony);
  await until(B, () => /하나님 이야기 책장 보기/.test(document.getElementById('action-btn').textContent), null, 10000);
  await B.keyboard.press('KeyE');
  await until(B, () => window.__WORLDS_DEBUG__.la.view.page === 'shelf' && window.__WORLDS_DEBUG__.la.view.list === 'testimony', null, 15000);
  check('library: enter, the 🙏 bookcase list opens', (await debug(B)).la.space === 'library');
  await B.keyboard.press('Escape');
  await modalIs(B, null);

  step('settings');
  await openSettings(A);
  await until(A, () => window.__WORLDS_DEBUG__.m10.settingsPage === 'menu');
  const pages = [
    ['sound', '#vol-master'],
    ['notify', '#notify-settings'],
    ['account', '#settings-nickname'],
    ['look', '.sheet.look'],
  ];
  const opened = [];
  for (const [id, sel] of pages) {
    if (id === 'look') {
      await A.tap('#settings-nav-look');
      await modalIs(A, '꾸미기').catch(() => undefined);
      if (await A.isVisible(sel)) opened.push(id);
      await A.keyboard.press('Escape');
      await modalIs(A, null);
      continue;
    }
    await A.tap(`#settings-nav-${id}`);
    await until(A, (n) => window.__WORLDS_DEBUG__.m10.settingsPage === n, id, 10000);
    if (await A.isVisible(sel)) opened.push(id);
    await A.tap('#settings-back');
    await until(A, () => window.__WORLDS_DEBUG__.m10.settingsPage === 'menu');
  }
  check('⚙ menu: 소리 · 알림 · 계정 pages open and go back; 꾸미기 opens', opened.join(',') === 'sound,notify,account,look', opened.join(','));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check(`smoke run completed (at ${currentStep()})`, false, String(err?.stack ?? err).split('\n').slice(0, 3).join(' | '));
} finally {
  await browser?.close();
  await stopAll();
  dropDb(DB);
}
console.log(`smoke runtime ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(summary());
