// Smoke test: the fast tier (target < 4 min on the N100). Run before every commit.
// One server in production-like mode (SERVE_CLIENT: the built client, /api and /ws
// on one port, CSP headers) with mock login and a throwaway DB, two browsers:
//   A = phone (390×844, touch), B = desktop (1280×720).
// Covers: /health, /api/me, CSP, brotli/gzip; login + consent; the world renders;
// the HUD's three buttons; nothing ever loads from YouTube (worship was removed
// 2026-11-14); 말씀 → a meditation saves → a lantern is shared;
// campfire chat both ways; 😊 표현 and the 🎙️ campfire voice button; the 📬 badge via /letters/unread (no inbox download);
// a library bookcase list; the ⚙ menu pages; render-on-demand under a phone sheet; 서울 날씨 in welcome and on the HUD.
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

const modalIs = (p, name, ms = 15000) => until(p, (n) => window.__WORLDS_DEBUG__.m3.modal === n, name, ms);
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
  check('HTML has the CSP header (self only; no YouTube, no third-party frames or images)', /default-src 'self'/.test(csp) && /script-src 'self';/.test(csp) && !/youtube|ytimg|frame-src/i.test(csp), csp);
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
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  const errors = [];
  const ytRequests = [];
  const inboxRequests = [];
  for (const [n, p] of [['A', A], ['B', B]]) p.on('pageerror', (e) => errors.push(`${n}: ${String(e).split('\n')[0]}`));
  for (const p of [A, B])
    p.on('request', (r) => {
      const u = r.url();
      if (/youtube|ytimg|googlevideo/.test(u)) ytRequests.push(u);
      if (p === A && u.includes('/api/library/letters/inbox')) inboxRequests.push(u);
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
    check(`${n}: HUD has exactly 말씀 · 모임 · ⚙`, tools.join(',') === 'btn-word,btn-groups,btn-settings', tools.join(','));
  }
  // 서울 날씨: welcome carries it (test servers never call MET Norway), a test override goes out live, the clock card shows it.
  {
    const wA = await A.evaluate(() => window.__WORLDS_DEBUG__.wx);
    check('welcome carries 서울 날씨 (no reading yet: clear, stale → 서울 낮)', wA?.kind === 'clear' && wA.stale === true && wA.hud.startsWith('서울'), JSON.stringify(wA?.hud));
    await fetch(`${BASE}api/test/weather`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'rain', tempC: 12 }) });
    for (const p of [A, B]) await until(p, () => window.__WORLDS_DEBUG__.wx.hud === '서울 비 · 12°C' && window.__WORLDS_DEBUG__.wx.counts.rain > 0, null, 10000).catch(() => undefined);
    const wB = await B.evaluate(() => window.__WORLDS_DEBUG__.wx);
    check('live weather: both clocks read 서울 비 · 12°C and rain falls', (await A.evaluate(() => window.__WORLDS_DEBUG__.wx.hud)) === '서울 비 · 12°C' && wB.hud === '서울 비 · 12°C' && wB.counts.rain > 0, wB.hud);
    await fetch(`${BASE}api/test/weather`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reset: true }) });
  }
  // ⚙ → 🎨 화면 품질: default 선명 (1.5 on a DPR-2 phone); 보통 → 1.25; 절약 → 1.
  check('phone pixel ratio default 선명 = 1.5 (DPR 2 device)', (await debug(A)).renderer.pixelRatio === 1.5, String((await debug(A)).renderer.pixelRatio));
  await A.evaluate(() => { localStorage.setItem('worlds.graphics.quality', 'normal'); window.dispatchEvent(new CustomEvent('worlds:graphics')); });
  await until(A, () => window.__WORLDS_DEBUG__.renderer.pixelRatio === 1.25, null, 10000).catch(() => undefined);
  check('화면 품질 보통 → 1.25, applied live', (await debug(A)).renderer.pixelRatio === 1.25, String((await debug(A)).renderer.pixelRatio));
  await A.evaluate(() => { localStorage.setItem('worlds.graphics.quality', 'sharp'); window.dispatchEvent(new CustomEvent('worlds:graphics')); });
  check('desktop pixel ratio unchanged (1 here)', (await debug(B)).renderer.pixelRatio === 1, String((await debug(B)).renderer.pixelRatio));

  step('no youtube');
  for (const [n, p] of [['phone', A], ['desktop', B]]) {
    const dom = await p.evaluate(() => ({
      worship: !!document.querySelector('#worship, #btn-worship, [id^="worship"]'),
      frames: [...document.querySelectorAll('iframe')].map((f) => f.src),
      scripts: [...document.scripts].map((x) => x.src).filter((x) => x && !x.startsWith(location.origin)),
    }));
    check(`${n}: no worship player, no iframe, no third-party script`, !dom.worship && dom.frames.length === 0 && dom.scripts.length === 0, JSON.stringify(dom));
  }
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

  step('emote + campfire voice');
  // (the 😊 button, like 📸, steps aside while typing)
  await A.evaluate(() => document.activeElement?.blur());
  await B.evaluate(() => document.activeElement?.blur());
  check('😊 표현 button shown (phone + desktop)', (await A.isVisible('#emote-btn')) && (await B.isVisible('#emote-btn')));
  const aConn = (await debug(A)).net.id;
  await A.tap('#emote-btn');
  await until(A, () => window.__WORLDS_DEBUG__.m4.emoteOpen === true, null, 5000);
  await A.tap('#emote-grid .emote-item[data-e="3"]');
  await until(B, (id) => window.__WORLDS_DEBUG__.net.emoteLog.some((e) => e.id === id && e.e === 3), aConn, 10000);
  check('표현: phone taps 😊 → 반가워요, the desktop player sees it', true);
  check('🔥 "🎙️ 모닥불 음성 참여" in the campfire chat header', (await B.textContent('#campfire-voice-btn')).includes('모닥불 음성 참여'));
  // This server has no TURN: campfire voice stays off (never direct P2P between strangers).
  await B.click('#campfire-voice-btn');
  await until(B, () => document.getElementById('toast').textContent.includes('준비 중'), null, 10000);
  check('campfire voice without TURN: refused with a message, voice stays idle', (await debug(B)).m4.voice.state === 'idle');

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

  check('nothing was ever requested from YouTube (iframe, API script, thumbnails)', ytRequests.length === 0, ytRequests.slice(0, 2).join(' '));
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
