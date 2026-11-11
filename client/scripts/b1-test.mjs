// B1 test: 골방 + a sheet open → the worship player stays fully on screen.
// For phones (360×740, 390×844, 412×915), iPad Air portrait and desktop, in every
// 골방 player state (작게 / 보통 / 크게 / mini) and with every sheet (말씀 책 tabs,
// ⚙ menu + a sub-page, 모임, 묵상하기): the video is entirely inside the viewport
// and ≥ 200×200, overlaps neither the sheet, the HUD tool row nor the place card,
// the sheet title is visible (nothing drawn over it), the 골방 size control is
// hidden, the player keeps playing (touch: YouTube stub; desktop: real autoplay),
// and closing the sheet restores the chosen room size / state. Also: 접기 + sheet
// stays paused, one iframe at most.
// Ports: TEST_CLIENT_PORT (5184) preview, TEST_SERVER_PORT (5185) server.
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/b1-test.mjs
// B1_TAG=before|after names the screenshots (docs/screenshots/b1-<tag>-*.png).
// B1_DEVICES=p360,desktop limits the devices.
import { resolve } from 'node:path';
import {
  check,
  currentStep,
  debug,
  dropDb,
  freshDb,
  launch,
  loginJoin,
  openBook,
  openSettings,
  shotDir,
  sleep,
  startPreview,
  startServer,
  step,
  stopAll,
  summary,
  teleport,
  until,
  waitHttp,
} from './lib/harness.mjs';
import { overlaps } from './lib/tablet.mjs';

const CLIENT_PORT = Number(process.env.TEST_CLIENT_PORT ?? 5184);
const SERVER_PORT = Number(process.env.TEST_SERVER_PORT ?? 5185);
const BASE = `http://127.0.0.1:${CLIENT_PORT}/`;
const DAY = '2026-11-08';
const Q = `?test=1&shadows=0&time=14:00&date=${DAY}&noguide=1`;
const DB = freshDb('b1');
const TAG = process.env.B1_TAG ?? 'after';

const ALL_DEVICES = [
  ['p360', 360, 740, 'phone'],
  ['p390', 390, 844, 'phone'],
  ['p412', 412, 915, 'phone'],
  ['ipad-air', 820, 1180, 'tablet'],
  ['desktop', 1280, 720, 'desktop'],
];
const DEVICES = process.env.B1_DEVICES ? ALL_DEVICES.filter(([n]) => process.env.B1_DEVICES.split(',').includes(n)) : ALL_DEVICES;
const STATES = ['s', 'm', 'l', 'mini'];

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

const modalIs = (p, name, ms = 15000) => until(p, (n) => window.__WORLDS_DEBUG__.m3.modal === n, name, ms);
const SHEETS = [
  ['book-today', '나의 말씀 책', (p) => openBook(p, 'today')],
  ['book-mine', '나의 말씀 책', (p) => openBook(p, 'mine')],
  ['book-saved', '나의 말씀 책', (p) => openBook(p, 'saved')],
  ['settings', '설정', (p) => openSettings(p)],
  ['settings-sound', '설정', (p) => openSettings(p, 'sound')],
  ['groups', '모임', (p) => p.click('#btn-groups')],
  ['meditate', '묵상하기', (p) => p.click('#closet-meditate')],
];

/** Everything the player must stay clear of, plus the player itself. */
function probe(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      if (!el) return null;
      const s = getComputedStyle(el);
      if (el.hidden || s.display === 'none' || s.visibility === 'hidden') return null;
      // 접기 keeps the (paused) iframe at opacity 0: not on screen.
      for (let e = el; e; e = e.parentElement) if (Number(getComputedStyle(e).opacity) === 0) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    };
    const q = (s) => vis(document.querySelector(s));
    const title = document.querySelector('.overlay .book-title, .overlay .med-top');
    const t = vis(title);
    let titleOnTop = false;
    if (t) {
      const hit = document.elementFromPoint(t.x + Math.min(t.width / 2, 40), t.y + t.height / 2);
      titleOnTop = !!hit && (title === hit || title.contains(hit));
    }
    const w = document.getElementById('worship');
    return {
      vw: innerWidth,
      vh: innerHeight,
      card: q('#worship'),
      frame: q('#worship .worship-frame'),
      sizes: q('#worship .worship-roomsize'),
      handle: q('#worship-handle'),
      sheet: q('.overlay .sheet'),
      title: t,
      titleOnTop,
      tools: q('#tools'),
      place: q('.place-card'),
      cls: w.className,
    };
  });
}

/** 작게 plays a short slide-in whenever it (re)appears: measure after it. */
const settled = (page) =>
  page.evaluate(() => Promise.all(document.getElementById('worship').getAnimations({ subtree: true }).map((an) => an.finished.catch(() => undefined))));
const inside = (r, vw, vh) => !!r && r.x >= -0.5 && r.y >= -0.5 && r.x + r.width <= vw + 0.5 && r.y + r.height <= vh + 0.5;
const fmt = (r) => (r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` : 'none');

let browser;
try {
  startServer(SERVER_PORT, DB, { WORLDS_AUTH_MOCK: '1', AUTH_RATE_LIMIT: '300', MAX_CONN_PER_IP: '60' });
  await waitHttp(`http://127.0.0.1:${SERVER_PORT}/health`);
  startPreview(CLIENT_PORT, SERVER_PORT);
  await waitHttp(BASE);
  browser = await launch(['--autoplay-policy=no-user-gesture-required']);

  for (const [name, w, h, kind] of DEVICES) {
    step(name);
    const touch = kind !== 'desktop';
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, screen: { width: w, height: h }, deviceScaleFactor: 1, isMobile: touch, hasTouch: touch });
    // Touch browsers here don't autoplay real YouTube: a stub reports PLAYING like the real player would.
    if (touch) await ctx.route('https://www.youtube.com/iframe_api', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: YT_STUB }));
    const p = await ctx.newPage();
    const tap = (sel) => (touch ? p.tap(sel) : p.click(sel));
    await loginJoin(p, BASE, `b1-${name}`, `비원${name}`.slice(0, 12), Q);
    const door = await p.evaluate(() => window.__WORLDS_TEST__.closetDoor());
    await teleport(p, door);
    await until(p, () => document.getElementById('action-btn').textContent.includes('골방'));
    await p.keyboard.press('KeyE');
    await until(p, () => window.__WORLDS_DEBUG__.m3.closet === true && window.__WORLDS_DEBUG__.m3.worship.mode === 'room', null, 20000);
    await until(p, () => window.__WORLDS_DEBUG__.m3.worship.state === 'playing', null, 30000).catch(() => undefined);
    check(`${name}: player playing in the 골방 before the sheets`, (await debug(p)).m3.worship.state === 'playing', (await debug(p)).m3.worship.state);

    let playingAll = true;
    let playingMiss = [];
    for (const state of STATES) {
      // Set the room state: 작게/보통/크게 (펼침) or mini (작게 = video only).
      if ((await debug(p)).m3.worship.effective !== 'open') {
        await tap('#worship-handle');
        await until(p, () => window.__WORLDS_DEBUG__.m3.worship.effective === 'open');
      }
      await tap(`#worship-room-${state === 'mini' ? 'm' : state}`);
      if (state === 'mini') {
        await tap('#worship-mini');
        await until(p, () => window.__WORLDS_DEBUG__.m3.worship.effective === 'mini');
      }
      await sleep(400);
      await settled(p);
      const before = await probe(p);
      const roomCls = `room-${state === 'mini' ? 'm' : state}`;
      for (const [sheet, modalName, open] of SHEETS) {
        const label = `${name} ${state} ${sheet}`;
        try {
          await open(p);
          await modalIs(p, modalName);
        } catch (err) {
          // Before the fix the misplaced player can cover the sheet's own buttons.
          check(`${label}: sheet opens and its tabs/buttons are tappable`, false, String(err).split('\n')[0]);
          await p.screenshot({ path: resolve(shotDir, `b1-${TAG}-${name}-${state}-${sheet}-blocked.png`) });
          await p.keyboard.press('Escape');
          await modalIs(p, null).catch(() => undefined);
          await sleep(300);
          continue;
        }
        await sleep(450);
        const r = await probe(p);
        const ws = (await debug(p)).m3.worship;
        const problems = [];
        if (!inside(r.frame, r.vw, r.vh)) problems.push(`frame off-screen ${fmt(r.frame)}`);
        if (!r.frame || r.frame.width < 199.5 || r.frame.height < 199.5) problems.push(`frame < 200x200 ${fmt(r.frame)}`);
        if (!inside(r.card, r.vw, r.vh)) problems.push(`card off-screen ${fmt(r.card)}`);
        for (const k of ['sheet', 'tools', 'place']) if (overlaps(r.card, r[k])) problems.push(`card overlaps ${k} ${fmt(r[k])}`);
        if (r.sizes) problems.push(`size control shown ${fmt(r.sizes)}`);
        if (!r.title || !inside(r.title, r.vw, r.vh) || !r.titleOnTop) problems.push(`title hidden ${fmt(r.title)} onTop=${r.titleOnTop}`);
        check(`${label}: video on screen ≥200×200, clear of sheet/HUD/place card, title visible`, problems.length === 0, problems.join('; ') || `frame ${fmt(r.frame)} sheet ${fmt(r.sheet)}`);
        if (ws.state !== 'playing') {
          playingAll = false;
          playingMiss.push(`${state}/${sheet}:${ws.state}`);
        }
        if (sheet === 'book-today' || (state === 'l' && sheet !== 'book-mine') || (state === 'mini' && sheet === 'meditate')) {
          await p.screenshot({ path: resolve(shotDir, `b1-${TAG}-${name}-${state}-${sheet}.png`) });
        }
        await p.keyboard.press('Escape');
        await modalIs(p, null);
        await sleep(350);
        await settled(p);
        const a = await probe(p);
        const aw = (await debug(p)).m3.worship;
        const restored =
          a.cls.includes(roomCls) &&
          !a.cls.includes('room-sheet') &&
          aw.effective === (state === 'mini' ? 'mini' : 'open') &&
          !!a.frame &&
          Math.abs(a.frame.width - before.frame.width) < 1 &&
          Math.abs(a.frame.height - before.frame.height) < 1 &&
          Math.abs(a.card.x - before.card.x) < 1 &&
          (state === 'mini' || !!a.sizes);
        check(`${label}: closing restores the room ${state === 'mini' ? 'mini state' : `size ${state}`}`, restored, `${a.cls} frame ${fmt(a.frame)} vs ${fmt(before.frame)}`);
      }
    }
    check(`${name}: player kept playing with every sheet open`, playingAll, playingMiss.join(' ') || 'ok');

    // 접기 + a sheet: stays paused, nothing shown, the tab comes back after.
    if ((await debug(p)).m3.worship.effective !== 'open') {
      await tap('#worship-handle');
      await until(p, () => window.__WORLDS_DEBUG__.m3.worship.effective === 'open');
    }
    await tap('#worship-fold');
    await until(p, () => window.__WORLDS_DEBUG__.m3.worship.effective === 'folded');
    await openBook(p, 'today');
    await sleep(400);
    const fw = (await debug(p)).m3.worship;
    const fr = await probe(p);
    check(`${name}: 접기 + sheet: paused, no player or tab on screen`, fw.state !== 'playing' && !fw.playedWhileFolded && !fw.tabVisible && !fr.frame, `${fw.state} tab=${fw.tabVisible} frame ${fmt(fr.frame)}`);
    await p.keyboard.press('Escape');
    await modalIs(p, null);
    check(`${name}: 접기 tab back after the sheet closes`, (await debug(p)).m3.worship.tabVisible);
    await tap('#worship-tab');
    await until(p, () => window.__WORLDS_DEBUG__.m3.worship.effective === 'open');
    const iframes = (await debug(p)).m3.worship.iframes;
    check(`${name}: at most one YouTube iframe`, iframes <= 1, String(iframes));
    await ctx.close();
  }
} catch (err) {
  check('test run completed', false, `[step: ${currentStep()}] ${String(err).split('\n')[0]}`);
} finally {
  await browser?.close();
  await stopAll();
  dropDb(DB);
}
process.exit(summary());
