// P1-3 test: phone landscape (915×412, 844×390, 740×360; isMobile + hasTouch).
// For every size, every worship player state (작게 / 펼침 / 접기 / 골방) and the
// main sheets (말씀 오늘 · 지난 말씀, ⚙ menu, ⚙ → 꾸미기, 모임, 묵상하기, the
// library reader):
//   - the sheet's usable area is ≥ 55% of the width and ≥ 85% of the height;
//   - while the player is shown the video is fully on screen, ≥ 200×200, playing,
//     and nothing is drawn over it (elementFromPoint) nor does it touch the sheet;
//     접기 stays paused;
//   - the HUD tool row stays clear (neither the player nor the sheet covers it);
//   - with no sheet open, the HUD, joystick, action button, camera button, chat
//     panel / pill, prop dock, voice chip and the player overlap nothing;
//   - with the on-screen keyboard simulated (viewport ≈ 45% height) the focused
//     field is visible (meditation, a letter, the testimony form, the campfire
//     chat), and the video is either fully visible or paused (never cut off).
// Ports: TEST_CLIENT_PORT (5188) preview, TEST_SERVER_PORT (5189) server.
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/p13-test.mjs
// P13_TAG=before|after names the screenshots (docs/screenshots/p13-<tag>-*.png).
// P13_DEVICES=l915,l740 limits the devices.
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

const CLIENT_PORT = Number(process.env.TEST_CLIENT_PORT ?? 5188);
const SERVER_PORT = Number(process.env.TEST_SERVER_PORT ?? 5189);
const BASE = `http://127.0.0.1:${CLIENT_PORT}/`;
const DAY = '2026-11-08';
const Q = `?test=1&shadows=0&time=14:00&date=${DAY}&noguide=1`;
const DB = freshDb('p13');
const TAG = process.env.P13_TAG ?? 'after';
const CAMPFIRE = { x: 51, z: -6 };

const ALL_DEVICES = [
  ['l915', 915, 412],
  ['l844', 844, 390],
  ['l740', 740, 360],
];
const DEVICES = process.env.P13_DEVICES ? ALL_DEVICES.filter(([n]) => process.env.P13_DEVICES.split(',').includes(n)) : ALL_DEVICES;
const STATES = ['mini', 'open', 'folded'];
/** Screenshots: everything worth looking at on the widest phone, a few per other size. */
const SHOT = (dev, what) => dev === 'l915' || /^(world-mini|mini-book-today|mini-look|room-book-today|kb-meditate|.*blocked)$/.test(what);

const YT_STUB = `
window.YT = { Player: function (el, opts) {
  var st = -1;
  var fire = function (s) { st = s; if (opts.events && opts.events.onStateChange) opts.events.onStateChange({ data: s }); };
  this.playVideo = function () { fire(1); };
  this.pauseVideo = function () { fire(2); };
  this.loadVideoById = function () { fire(1); };
  this.cueVideoById = function () { fire(5); };
  this.getPlayerState = function () { return st; };
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

const modalIs = (p, name, ms = 12000) => until(p, (n) => window.__WORLDS_DEBUG__.m3.modal === n, name, ms);
const sheetShown = (p, sel, ms = 12000) => p.waitForSelector(`.overlay.shown ${sel}`, { timeout: ms });

let storyId = null;
const SHEETS = [
  ['book-today', (p) => openBook(p, 'today')],
  ['book-mine', (p) => openBook(p, 'mine')],
  ['settings', async (p) => (await openSettings(p), sheetShown(p, '.sheet.settings'))],
  ['look', async (p) => (await openSettings(p, 'look'), sheetShown(p, '.sheet.look'))],
  ['groups', async (p) => (await p.click('#btn-groups'), modalIs(p, '모임'))],
  ['meditate', async (p) => (await openBook(p, 'today'), await p.click('#today-meditate'), sheetShown(p, '.sheet.meditation'))],
  ['reader', async (p) => (await p.evaluate((id) => window.__WORLDS_TEST__.libraryOpen('story', id), storyId), sheetShown(p, '#lib-story'))],
];

/** Everything on screen that matters for the layout. */
function probe(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      if (!el) return null;
      const s = getComputedStyle(el);
      if (el.hidden || s.display === 'none' || s.visibility === 'hidden') return null;
      for (let e = el; e; e = e.parentElement) if (Number(getComputedStyle(e).opacity) === 0 || getComputedStyle(e).visibility === 'hidden') return null;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    };
    const q = (s) => vis(document.querySelector(s));
    const vv = window.visualViewport;
    const vw = innerWidth;
    const vh = vv ? vv.height : innerHeight;
    const frameEl = document.querySelector('#worship .worship-frame');
    const frame = vis(frameEl);
    // Nothing drawn over the video: sample its centre and four inset corners.
    let frameClear = false;
    if (frame) {
      const w = document.getElementById('worship');
      const pts = [
        [0.5, 0.5],
        [0.08, 0.08],
        [0.92, 0.08],
        [0.08, 0.92],
        [0.92, 0.92],
      ];
      frameClear = pts.every(([fx, fy]) => {
        const x = frame.x + frame.width * fx;
        const y = frame.y + frame.height * fy;
        if (x < 0 || y < 0 || x >= vw || y >= vh) return false;
        const hit = document.elementFromPoint(x, y);
        return !!hit && w.contains(hit);
      });
    }
    const overlay = [...document.querySelectorAll('.overlay')].pop();
    const sheet = overlay ? vis(overlay.querySelector('.sheet')) : null;
    const title = overlay?.querySelector('.book-title, .med-top, .settings-title, h2');
    const t = vis(title);
    let titleOnTop = false;
    if (t) {
      const hit = document.elementFromPoint(Math.min(vw - 1, t.x + Math.min(t.width / 2, 30)), Math.min(vh - 1, t.y + t.height / 2));
      titleOnTop = !!hit && (title === hit || title.contains(hit) || hit.contains(title));
    }
    const a = document.activeElement;
    const focused = a && a.matches?.('input, textarea') ? vis(a) : null;
    const chatEl = document.getElementById('chat');
    return {
      vw,
      vh,
      card: q('#worship'),
      frame,
      frameClear,
      handle: q('#worship-handle'),
      tab: q('#worship-tab'),
      sheet,
      title: t,
      titleOnTop,
      tools: q('#tools'),
      place: q('.place-card'),
      clock: q('.clock-card'),
      joystick: q('#stick-base'),
      action: q('#action-btn'),
      camera: q('#camera-btn'),
      chat: chatEl && !chatEl.classList.contains('folded') ? vis(chatEl) : null,
      pill: q('#chat-pill'),
      voice: q('#voice-chip'),
      dock: q('.prop-dock'),
      letter: q('#letter-btn'),
      meditateBtn: q('#meditate-btn'),
      closetHead: q('.closet-head'),
      closetActions: q('.closet-actions'),
      focused,
      focusedId: a?.id || a?.className || null,
      cls: document.body.className,
    };
  });
}

const settled = (page) =>
  page.evaluate(() => Promise.all(document.getElementById('worship').getAnimations({ subtree: true }).map((an) => an.finished.catch(() => undefined))));
const inside = (r, vw, vh) => !!r && r.x >= -0.5 && r.y >= -0.5 && r.x + r.width <= vw + 0.5 && r.y + r.height <= vh + 0.5;
const fmt = (r) => (r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` : 'none');
/** Part of r inside the viewport. */
const clip = (r, vw, vh) => {
  if (!r) return { width: 0, height: 0 };
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  return { width: Math.max(0, Math.min(vw, r.x + r.width) - x0), height: Math.max(0, Math.min(vh, r.y + r.height) - y0) };
};
const shot = (p, dev, what) => (SHOT(dev, what) ? p.screenshot({ path: resolve(shotDir, `p13-${TAG}-${dev}-${what}.png`) }) : undefined);

/** The video rule: shown → fully on screen, ≥ 200×200, nothing over it; otherwise not playing. */
function videoProblems(r, ws, { mustShow }) {
  const out = [];
  if (r.frame) {
    if (!inside(r.frame, r.vw, r.vh)) out.push(`video off-screen ${fmt(r.frame)} in ${r.vw}x${Math.round(r.vh)}`);
    if (r.frame.width < 199.5 || r.frame.height < 199.5) out.push(`video < 200x200 ${fmt(r.frame)}`);
    if (!r.frameClear) out.push('something drawn over the video');
    if (ws.state !== 'playing') out.push(`not playing (${ws.state})`);
  } else {
    if (mustShow) out.push('video not shown');
    if (ws.state === 'playing') out.push('playing while not shown');
  }
  if (ws.iframes > 1) out.push(`${ws.iframes} iframes`);
  return out;
}

/** Floating world UI with no sheet open: no pair may overlap. */
const FLOATING = ['card', 'tab', 'tools', 'place', 'clock', 'joystick', 'action', 'camera', 'chat', 'pill', 'voice', 'dock', 'letter', 'meditateBtn'];
function floatingOverlaps(r) {
  const hits = [];
  for (let i = 0; i < FLOATING.length; i++)
    for (let j = i + 1; j < FLOATING.length; j++) {
      const a = FLOATING[i];
      const b = FLOATING[j];
      if (overlaps(r[a], r[b])) hits.push(`${a}×${b}`);
    }
  // The 작게 pull-handle sits beside the video: it must not cover the other controls either.
  for (const k of FLOATING) if (k !== 'card' && overlaps(r.handle, r[k])) hits.push(`handle×${k}`);
  return hits;
}

async function setFold(p, fold) {
  await p.evaluate((f) => window.__WORLDS_TEST__.worshipFold(f), fold);
  await until(p, (f) => window.__WORLDS_DEBUG__.m3.worship.effective === f || window.__WORLDS_DEBUG__.m3.worship.fold === f, fold, 8000).catch(() => undefined);
  await sleep(500);
  await settled(p);
}
async function closeSheet(p) {
  await p.keyboard.press('Escape');
  await modalIs(p, null, 8000).catch(() => undefined);
  await sleep(300);
}

/** Simulated keyboard: shrink the viewport to ~45% (Android resizes the layout viewport too). */
async function withKeyboard(p, w, h, focus, label, dev, name) {
  await focus();
  await sleep(300);
  const kbH = Math.round(h * 0.45);
  await p.setViewportSize({ width: w, height: kbH });
  await sleep(1100);
  const r = await probe(p);
  const ws = (await debug(p)).m3.worship;
  const fieldOk = !!r.focused && r.focused.y >= -0.5 && r.focused.y + Math.min(r.focused.height, 40) <= r.vh + 0.5 && r.focused.x >= -0.5 && r.focused.x + 20 <= r.vw;
  check(`${label}: with the keyboard the focused field is visible`, fieldOk, `focused ${r.focusedId} ${fmt(r.focused)} / ${r.vw}x${Math.round(r.vh)}`);
  const vp = videoProblems(r, ws, { mustShow: false });
  check(`${label}: with the keyboard the video is fully visible or paused`, vp.length === 0, vp.join('; ') || (r.frame ? `video ${fmt(r.frame)}` : `paused (${ws.state})`));
  await shot(p, dev, name);
  await p.evaluate(() => document.activeElement?.blur?.());
  await p.setViewportSize({ width: w, height: h });
  await sleep(900);
  const back = (await debug(p)).m3.worship;
  return back;
}

let browser;
try {
  startServer(SERVER_PORT, DB, { WORLDS_AUTH_MOCK: '1', AUTH_RATE_LIMIT: '300', MAX_CONN_PER_IP: '60' });
  await waitHttp(`http://127.0.0.1:${SERVER_PORT}/health`);
  startPreview(CLIENT_PORT, SERVER_PORT);
  await waitHttp(BASE);
  browser = await launch();

  // A book by someone else, so the reader has a letter box to type into.
  {
    const actx = await browser.newContext();
    const rq = actx.request;
    await rq.get(`${BASE}api/auth/google/start?remember=1&hint=p13-author`);
    await rq.post(`${BASE}api/me/nickname`, { data: { nickname: '글쓴이삼', agree: true } });
    const res = await rq.post(`${BASE}api/library/stories`, {
      data: {
        title: '가로 화면에서 읽는 이야기',
        parts: ['몹시 힘든 한 해였어요. 일도 사람도 다 떠났어요.', '새벽에 시편을 읽다가 울었어요.', '이제는 매일 아침 감사로 시작해요.'],
        shelf: 'thanks',
        visibility: 'public',
      },
    });
    storyId = (await res.json()).id;
    check('setup: a public story to read', Number.isInteger(storyId), String(storyId));
    await actx.close();
  }

  for (const [dev, w, h] of DEVICES) {
    step(dev);
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, screen: { width: w, height: h }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await ctx.route('https://www.youtube.com/iframe_api', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: YT_STUB }));
    const p = await ctx.newPage();
    p.setDefaultTimeout(12000);
    p.on('pageerror', (e) => check(`${dev}: no page error`, false, String(e).split('\n')[0]));
    await loginJoin(p, BASE, `p13-${dev}`, `가로${dev}`.slice(0, 12), Q);
    await until(p, () => window.__WORLDS_DEBUG__.m3.worship.state === 'playing', null, 30000).catch(() => undefined);
    check(`${dev}: landscape phone layout (body.phone-land, not a tablet)`, await p.evaluate(() => document.body.classList.contains('phone-land') && !document.body.classList.contains('tablet')));

    // ------------------------------------------------ the world, no sheet
    await teleport(p, CAMPFIRE);
    await until(p, () => window.__WORLDS_DEBUG__.net.chatVisible, null, 15000).catch(() => undefined);
    await sleep(1200);
    for (const st of STATES) {
      await setFold(p, st);
      const r = await probe(p);
      const ws = (await debug(p)).m3.worship;
      const hits = floatingOverlaps(r);
      check(`${dev} world ${st}: HUD, joystick, action, camera, chat, player overlap nothing`, hits.length === 0, hits.join(' ') || `card ${fmt(r.card)} action ${fmt(r.action)} camera ${fmt(r.camera)} chat ${fmt(r.chat)}`);
      const vp = videoProblems(r, ws, { mustShow: st !== 'folded' });
      check(`${dev} world ${st}: video rule`, vp.length === 0, vp.join('; ') || fmt(r.frame));
      const offscreen = ['card', 'tab', 'action', 'camera', 'chat', 'pill', 'joystick'].filter((k) => r[k] && !inside(r[k], r.vw, r.vh));
      check(`${dev} world ${st}: controls inside the screen`, offscreen.length === 0, offscreen.map((k) => `${k} ${fmt(r[k])}`).join(' ') || 'ok');
      await shot(p, dev, `world-${st}`);
    }
    // The campfire chat folded to its pill.
    if (await p.isVisible('#chat-fold')) {
      await setFold(p, 'mini');
      await p.tap('#chat-fold');
      await sleep(500);
      const r = await probe(p);
      const hits = floatingOverlaps(r);
      check(`${dev} world mini + chat pill: nothing overlaps`, !!r.pill && hits.length === 0, hits.join(' ') || `pill ${fmt(r.pill)}`);
      await shot(p, dev, 'world-chat-pill');
      // (A DOM click: before the fix the pill sat under the joystick zone.)
      await p.evaluate(() => document.getElementById('chat-pill').click());
      await sleep(400);
    }

    // ------------------------------------------------ sheets × player states
    for (const st of STATES) {
      await setFold(p, st);
      for (const [sheet, open] of SHEETS) {
        const label = `${dev} ${st} ${sheet}`;
        try {
          await open(p);
        } catch (err) {
          check(`${label}: sheet opens`, false, String(err).split('\n')[0]);
          await shot(p, dev, `${st}-${sheet}-blocked`);
          await closeSheet(p);
          continue;
        }
        await sleep(600);
        await settled(p);
        const r = await probe(p);
        const ws = (await debug(p)).m3.worship;
        const area = clip(r.sheet, r.vw, r.vh);
        check(
          `${label}: sheet ≥55% wide and ≥85% tall`,
          area.width >= 0.55 * r.vw - 0.5 && area.height >= 0.85 * r.vh - 0.5,
          `${Math.round(area.width)}x${Math.round(area.height)} of ${r.vw}x${Math.round(r.vh)} (${Math.round((100 * area.width) / r.vw)}% × ${Math.round((100 * area.height) / r.vh)}%)`,
        );
        const vp = videoProblems(r, ws, { mustShow: st !== 'folded' });
        if (overlaps(r.card, r.sheet)) vp.push(`player overlaps the sheet ${fmt(r.card)} / ${fmt(r.sheet)}`);
        check(`${label}: video rule (on screen ≥200×200, clear, playing / 접기 paused)`, vp.length === 0, vp.join('; ') || (r.frame ? fmt(r.frame) : `paused ${ws.state}`));
        const hud = [];
        if (!r.tools) hud.push('tool row hidden');
        if (overlaps(r.card, r.tools) || overlaps(r.card, r.clock)) hud.push(`player over the HUD ${fmt(r.card)}`);
        if (overlaps(r.sheet, r.tools)) hud.push(`sheet over the tool row ${fmt(r.sheet)} / ${fmt(r.tools)}`);
        if (!r.titleOnTop) hud.push(`sheet title covered ${fmt(r.title)}`);
        check(`${label}: nothing overlaps the HUD tool row; sheet title visible`, hud.length === 0, hud.join('; ') || 'ok');
        await shot(p, dev, `${st}-${sheet}`);
        await closeSheet(p);
      }
      const after = (await debug(p)).m3.worship;
      check(`${dev} ${st}: closing the sheets restores the player state`, after.effective === st, after.effective);
    }

    // ------------------------------------------------ keyboard (player 작게)
    try {
    await setFold(p, 'mini');
    await openBook(p, 'today');
    await p.click('#today-meditate');
    await sheetShown(p, '.sheet.meditation');
    await p.tap('.med-foot .primary'); // step 1 (the word) has no field yet
    await sheetShown(p, '.med-input');
    await withKeyboard(p, w, h, () => p.tap('.med-input'), `${dev} keyboard meditation`, dev, 'kb-meditate');
    await closeSheet(p);
    await p.evaluate((id) => window.__WORLDS_TEST__.libraryOpen('story', id), storyId);
    await sheetShown(p, '#lib-letter-text');
    await withKeyboard(p, w, h, () => p.tap('#lib-letter-text'), `${dev} keyboard letter`, dev, 'kb-letter');
    await closeSheet(p);
    await p.evaluate(() => window.__WORLDS_TEST__.libraryOpen('write'));
    await sheetShown(p, '#lib-part-0');
    await withKeyboard(p, w, h, () => p.tap('#lib-part-0'), `${dev} keyboard testimony form`, dev, 'kb-testimony');
    await closeSheet(p);
    if (await p.isVisible('#chat-input')) {
      const back = await withKeyboard(p, w, h, () => p.tap('#chat-input'), `${dev} keyboard chat`, dev, 'kb-chat');
      check(`${dev}: after the keyboard closes the player is back (작게, playing)`, back.effective === 'mini' && back.state === 'playing', `${back.effective} ${back.state}`);
    } else check(`${dev} keyboard chat: chat input shown at the campfire`, false);
    const ws = (await debug(p)).m3.worship;
    check(`${dev}: never played while folded or hidden; one iframe at most`, !ws.playedWhileFolded && !ws.playedWhileHidden && ws.iframes <= 1, JSON.stringify({ f: ws.playedWhileFolded, h: ws.playedWhileHidden, i: ws.iframes }));
    } catch (err) {
      check(`${dev} keyboard phase completed`, false, String(err).split('\n')[0]);
      await shot(p, dev, 'kb-blocked');
      await p.setViewportSize({ width: w, height: h });
      await closeSheet(p);
    }

    // ------------------------------------------------ 골방 (room, B1 room-sheet)
    try {
    const door = await p.evaluate(() => window.__WORLDS_TEST__.closetDoor());
    await teleport(p, door);
    await until(p, () => document.getElementById('action-btn').textContent.includes('골방'));
    await p.tap('#action-btn');
    await until(p, () => window.__WORLDS_DEBUG__.m3.closet === true && window.__WORLDS_DEBUG__.m3.worship.mode === 'room', null, 20000);
    await sleep(800);
    for (const rs of ['m', 'mini']) {
      if ((await debug(p)).m3.worship.effective !== 'open') {
        await p.tap('#worship-handle');
        await until(p, () => window.__WORLDS_DEBUG__.m3.worship.effective === 'open');
      }
      await p.tap('#worship-room-m');
      if (rs === 'mini') {
        await p.tap('#worship-mini');
        await until(p, () => window.__WORLDS_DEBUG__.m3.worship.effective === 'mini');
      }
      await sleep(500);
      await settled(p);
      const r = await probe(p);
      const ws2 = (await debug(p)).m3.worship;
      const vp = videoProblems(r, ws2, { mustShow: true });
      for (const k of ['tools', 'place', 'clock', 'closetHead', 'closetActions']) if (overlaps(r.card, r[k]) || overlaps(r.handle, r[k])) vp.push(`player over ${k} ${fmt(r[k])}`);
      if (overlaps(r.closetHead, r.closetActions)) vp.push('closet header over its buttons');
      check(`${dev} room ${rs}: video on screen ≥200×200, clear of the HUD and the room buttons`, vp.length === 0, vp.join('; ') || fmt(r.frame));
      await shot(p, dev, `room-${rs}`);
    }
    // Back to 보통 for the sheets.
    await p.tap('#worship-handle');
    await until(p, () => window.__WORLDS_DEBUG__.m3.worship.effective === 'open');
    const ROOM_SHEETS = [
      ['book-today', (q) => openBook(q, 'today')],
      ['look', async (q) => (await openSettings(q, 'look'), sheetShown(q, '.sheet.look'))],
      ['groups', async (q) => (await q.click('#btn-groups'), modalIs(q, '모임'))],
      ['meditate', async (q) => (await q.click('#closet-meditate'), sheetShown(q, '.sheet.meditation'))],
      ['reader', async (q) => (await q.evaluate((id) => window.__WORLDS_TEST__.libraryOpen('story', id), storyId), sheetShown(q, '#lib-story'))],
    ];
    for (const [sheet, open] of ROOM_SHEETS) {
      const label = `${dev} room ${sheet}`;
      try {
        await open(p);
      } catch (err) {
        check(`${label}: sheet opens`, false, String(err).split('\n')[0]);
        await closeSheet(p);
        continue;
      }
      await sleep(600);
      await settled(p);
      const r = await probe(p);
      const ws2 = (await debug(p)).m3.worship;
      const area = clip(r.sheet, r.vw, r.vh);
      check(`${label}: sheet ≥55% wide and ≥85% tall`, area.width >= 0.55 * r.vw - 0.5 && area.height >= 0.85 * r.vh - 0.5, `${Math.round(area.width)}x${Math.round(area.height)} of ${r.vw}x${Math.round(r.vh)}`);
      const vp = videoProblems(r, ws2, { mustShow: true });
      if (overlaps(r.card, r.sheet)) vp.push(`player overlaps the sheet`);
      if (!r.cls.includes('worship-room-sheet')) vp.push('not in the room-sheet state');
      if (overlaps(r.card, r.tools) || overlaps(r.sheet, r.tools)) vp.push('HUD tool row covered');
      if (!r.titleOnTop) vp.push('sheet title covered');
      check(`${label}: room-sheet video rule, HUD clear, title visible`, vp.length === 0, vp.join('; ') || fmt(r.frame));
      if (sheet === 'meditate') {
        await p.tap('.med-foot .primary');
        await sheetShown(p, '.med-input');
        await withKeyboard(p, w, h, () => p.tap('.med-input'), `${dev} room keyboard meditation`, dev, 'kb-room-meditate');
      }
      await shot(p, dev, `room-${sheet}`);
      await closeSheet(p);
    }
    const back = (await debug(p)).m3.worship;
    check(`${dev} room: closing the sheets restores 펼침 보통, still playing`, back.effective === 'open' && back.roomSize === 'm' && back.state === 'playing', `${back.effective} ${back.roomSize} ${back.state}`);
    } catch (err) {
      check(`${dev} room phase completed`, false, String(err).split('\n')[0]);
      await shot(p, dev, 'room-blocked');
    }
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
