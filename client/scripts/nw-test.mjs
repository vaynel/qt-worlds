// NW test: the layout without the worship player (removed 2026-11-14 at the owner's
// request; replaces b1). At phone portrait 360/390/412, phone landscape 740/844/915,
// tablet portrait/landscape and desktop:
//   - the HUD is exactly [말씀] [모임] [⚙];
//   - in the world and at the campfire (chat open, then folded to its pill) no two
//     floating controls overlap (HUD, place card, clock, joystick, action, 📷, 😊,
//     letter/meditate buttons, chat, voice chip, prop dock, place prompt, hint) and all
//     stay on screen;
//   - a sheet (말씀 책 오늘, ⚙ → 소리, 모임) is on screen with its title visible;
//     ⚙ → 소리 has 전체 · 환경음 · 효과음 · 음성 and no 찬양;
//   - the 골방: header, 묵상하기, 밖으로 나가기 on screen and clear of the HUD and each
//     other; a sheet in the 골방 keeps its title visible and the room buttons return;
//   - no iframe, and nothing is ever requested from YouTube / ytimg.
// Screenshots: docs/screenshots/nw-*.png.
// Ports: TEST_CLIENT_PORT (5184) preview, TEST_SERVER_PORT (5185) server.
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/nw-test.mjs
// NW_DEVICES=p390,l844 limits the devices.
import { resolve } from 'node:path';
import {
  check,
  currentStep,
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
const Q = '?test=1&shadows=0&time=14:00&date=2026-11-08&noguide=1';
const DB = freshDb('nw');

// [name, width, height, kind]
const ALL_DEVICES = [
  ['p360', 360, 740, 'phone'],
  ['p390', 390, 844, 'phone'],
  ['p412', 412, 915, 'phone'],
  ['l740', 740, 360, 'land'],
  ['l844', 844, 390, 'land'],
  ['l915', 915, 412, 'land'],
  ['tab-port', 820, 1180, 'tablet'],
  ['tab-land', 1180, 820, 'tablet'],
  ['desktop', 1280, 720, 'desktop'],
];
const DEVICES = process.env.NW_DEVICES ? ALL_DEVICES.filter(([n]) => process.env.NW_DEVICES.split(',').includes(n)) : ALL_DEVICES;
/** Named screenshots (the rest are not kept). */
const SHOTS = {
  'p390 world': 'nw-hud-phone',
  'l844 world': 'nw-hud-phone-landscape',
  'tab-port world': 'nw-hud-tablet',
  'desktop world': 'nw-hud-desktop',
  'p390 campfire': 'nw-campfire-chat-phone',
  'l844 campfire': 'nw-campfire-chat-phone-landscape',
  'p390 book-today': 'nw-sheet-phone',
  'l844 book-today': 'nw-sheet-phone-landscape',
  'desktop book-today': 'nw-sheet-desktop',
  'p390 room': 'nw-closet-phone',
  'l844 room': 'nw-closet-phone-landscape',
  'desktop room': 'nw-closet-desktop',
  'p390 room-book-today': 'nw-closet-sheet-phone',
};
const FLOATING = ['tools', 'place', 'clock', 'joystick', 'action', 'camera', 'emote', 'letter', 'meditateBtn', 'chat', 'pill', 'voice', 'dock', 'prompt', 'hint'];

const modalIs = (p, name, ms = 12000) => until(p, (n) => window.__WORLDS_DEBUG__.m3.modal === n, name, ms);
/** The newest sheet has finished fading in. */
const sheetIn = (p) =>
  until(p, () => {
    const o = [...document.querySelectorAll('.overlay')].pop();
    return !!o && o.classList.contains('shown') && getComputedStyle(o).opacity === '1';
  }, null, 8000).catch(() => undefined);
const inside = (r, vw, vh) => !!r && r.x >= -0.5 && r.y >= -0.5 && r.x + r.width <= vw + 0.5 && r.y + r.height <= vh + 0.5;
const fmt = (r) => (r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` : 'none');

/** Boxes of everything on screen; the voice chip and prop dock are shown where they would be. */
function probe(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      if (!el) return null;
      for (let e = el; e; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (e.hidden || s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return null;
      }
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    };
    const q = (s) => vis(document.querySelector(s));
    const voice = document.getElementById('voice-chip');
    const dock = document.getElementById('prop-dock');
    const was = [voice?.hidden, dock?.hidden];
    if (voice) voice.hidden = false;
    if (dock) dock.hidden = false;
    const overlay = [...document.querySelectorAll('.overlay')].pop();
    const title = overlay?.querySelector('.book-title, .med-top, .settings-title, h2');
    const t = vis(title);
    let titleOnTop = false;
    if (t) {
      const hit = document.elementFromPoint(Math.min(innerWidth - 1, t.x + Math.min(t.width / 2, 30)), Math.min(innerHeight - 1, t.y + t.height / 2));
      titleOnTop = !!hit && (title === hit || title.contains(hit) || hit.contains(title));
    }
    const chatEl = document.getElementById('chat');
    const out = {
      vw: innerWidth,
      vh: innerHeight,
      tools: q('#tools'),
      toolIds: [...document.querySelectorAll('#tools > *')].map((e) => e.id).join(','),
      place: q('.place-card'),
      clock: q('.clock-card'),
      joystick: q('#stick-base'),
      action: q('#action-btn'),
      camera: q('#camera-btn'),
      emote: q('#emote-btn'),
      letter: q('#letter-btn'),
      meditateBtn: q('#meditate-btn'),
      chat: chatEl && !chatEl.classList.contains('folded') ? vis(chatEl) : null,
      pill: q('#chat-pill'),
      voice: vis(voice),
      dock: dock && dock.children.length ? vis(dock) : null,
      prompt: q('#prompt'),
      hint: q('.hint'),
      sheet: overlay ? vis(overlay.querySelector('.sheet')) : null,
      title: t,
      titleOnTop,
      closetHead: q('.closet-head'),
      closetMeditate: q('#closet-meditate'),
      closetExit: q('#closet-exit'),
      iframes: document.querySelectorAll('iframe').length,
      worshipDom: !!document.querySelector('#worship, #btn-worship, [class^="worship"]'),
      cls: document.body.className,
    };
    if (voice) voice.hidden = was[0];
    if (dock) dock.hidden = was[1];
    return out;
  });
}
function floatingProblems(r) {
  const out = [];
  for (let i = 0; i < FLOATING.length; i++)
    for (let j = i + 1; j < FLOATING.length; j++) if (overlaps(r[FLOATING[i]], r[FLOATING[j]])) out.push(`${FLOATING[i]}×${FLOATING[j]}`);
  for (const k of FLOATING) if (r[k] && !inside(r[k], r.vw, r.vh)) out.push(`${k} off-screen ${fmt(r[k])}`);
  return out;
}

let browser;
try {
  startServer(SERVER_PORT, DB, { WORLDS_AUTH_MOCK: '1', AUTH_RATE_LIMIT: '300', MAX_CONN_PER_IP: '60' });
  await waitHttp(`http://127.0.0.1:${SERVER_PORT}/health`);
  startPreview(CLIENT_PORT, SERVER_PORT);
  await waitHttp(BASE);
  browser = await launch();

  for (const [dev, w, h, kind] of DEVICES) {
    step(dev);
    const touch = kind !== 'desktop';
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, screen: { width: w, height: h }, deviceScaleFactor: 1, isMobile: touch, hasTouch: touch });
    const p = await ctx.newPage();
    p.setDefaultTimeout(12000);
    const yt = [];
    p.on('request', (r) => /youtube|ytimg|googlevideo/.test(r.url()) && yt.push(r.url()));
    p.on('pageerror', (e) => check(`${dev}: no page error`, false, String(e).split('\n')[0]));
    const shot = async (what) => {
      const name = SHOTS[`${dev} ${what}`];
      if (name) await p.screenshot({ path: resolve(shotDir, `${name}.png`) });
    };
    await loginJoin(p, BASE, `nw-${dev}`, `없음${dev}`.slice(0, 12), Q);
    await sleep(800);

    // ---------------------------------------------------------------- world
    let r = await probe(p);
    const layoutOk = { phone: !/phone-land|tablet/.test(r.cls) && /touch/.test(r.cls), land: /phone-land/.test(r.cls), tablet: /tablet/.test(r.cls), desktop: !/touch/.test(r.cls) }[kind];
    check(`${dev}: ${kind} layout`, layoutOk, r.cls);
    check(`${dev}: HUD is exactly 3 buttons: 말씀 · 모임 · ⚙`, r.toolIds === 'btn-word,btn-groups,btn-settings', r.toolIds);
    let bad = floatingProblems(r);
    check(`${dev} world: no overlaps, everything on screen`, bad.length === 0, bad.join(' ') || 'ok');
    await shot('world');

    // ---------------------------------------------------------------- campfire: chat open + log seat prompt
    const logs = await p.evaluate(() => window.__WORLDS_TEST__.logSeats());
    const s0 = logs.seats[0];
    await teleport(p, { x: s0.x + (s0.x - logs.campfire.x) * 0.25, z: s0.z + (s0.z - logs.campfire.z) * 0.25 });
    await until(p, () => window.__WORLDS_DEBUG__.net.chatVisible, null, 15000).catch(() => undefined);
    await sleep(900);
    r = await probe(p);
    bad = floatingProblems(r);
    check(`${dev} campfire (chat open, action shown): no overlaps, everything on screen`, !!r.chat && bad.length === 0, bad.join(' ') || `chat ${fmt(r.chat)} action ${fmt(r.action)}`);
    await shot('campfire');
    if (await p.isVisible('#chat-fold')) {
      await p.evaluate(() => document.getElementById('chat-fold').click());
      await sleep(500);
      r = await probe(p);
      bad = floatingProblems(r);
      check(`${dev} campfire (chat folded to its pill): no overlaps`, !!r.pill && bad.length === 0, bad.join(' ') || `pill ${fmt(r.pill)}`);
      await p.evaluate(() => document.getElementById('chat-pill').click());
      await sleep(300);
    }

    // ---------------------------------------------------------------- sheets
    const SHEETS = [
      ['book-today', () => openBook(p, 'today')],
      ['sound', async () => (await openSettings(p, 'sound'), p.waitForSelector('#vol-master'))],
      ['groups', async () => (await p.click('#btn-groups'), modalIs(p, '모임'))],
    ];
    for (const [sheet, open] of SHEETS) {
      await open();
      await sheetIn(p);
      await sleep(300);
      r = await probe(p);
      const probs = [];
      if (!r.sheet || !inside(r.sheet, r.vw, r.vh)) probs.push(`sheet off-screen ${fmt(r.sheet)}`);
      if (!r.titleOnTop) probs.push(`title covered ${fmt(r.title)}`);
      check(`${dev} ${sheet}: sheet on screen, title visible`, probs.length === 0, probs.join('; ') || fmt(r.sheet));
      if (sheet === 'sound') {
        const sliders = await p.$$eval('.sheet.settings input[type=range]', (els) => els.map((e) => e.id).join(','));
        check(`${dev} ⚙ → 소리: 전체 · 환경음 · 효과음 · 음성, no 찬양`, sliders === 'vol-master,vol-ambience,vol-ui,vol-voice' && !(await p.textContent('.sheet.settings')).includes('찬양'), sliders);
      }
      await shot(sheet);
      await p.keyboard.press('Escape');
      await modalIs(p, null).catch(() => undefined);
      await sleep(300);
    }

    // ---------------------------------------------------------------- 골방
    const door = await p.evaluate(() => window.__WORLDS_TEST__.closetDoor());
    await teleport(p, door);
    await until(p, () => document.getElementById('action-btn').textContent.includes('골방'));
    await p.evaluate(() => document.getElementById('action-btn').click());
    await until(p, () => window.__WORLDS_DEBUG__.m3.closet === true, null, 20000);
    await sleep(1000);
    r = await probe(p);
    const room = [];
    for (const k of ['closetHead', 'closetMeditate', 'closetExit']) {
      if (!r[k] || !inside(r[k], r.vw, r.vh)) room.push(`${k} off-screen ${fmt(r[k])}`);
      for (const o of ['tools', 'place', 'clock']) if (overlaps(r[k], r[o])) room.push(`${k}×${o}`);
    }
    for (const [a, b] of [['closetHead', 'closetMeditate'], ['closetHead', 'closetExit'], ['closetMeditate', 'closetExit']]) if (overlaps(r[a], r[b])) room.push(`${a}×${b}`);
    check(`${dev} 골방: header, 묵상하기, 밖으로 나가기 on screen, clear of the HUD and each other`, room.length === 0, room.join('; ') || `${fmt(r.closetHead)} | ${fmt(r.closetMeditate)} ${fmt(r.closetExit)}`);
    check(`${dev} 골방: HUD still 말씀 · 모임 · ⚙, no video`, r.toolIds === 'btn-word,btn-groups,btn-settings' && r.iframes === 0);
    await shot('room');
    await openBook(p, 'today');
    await sheetIn(p);
    await sleep(300);
    r = await probe(p);
    check(`${dev} 골방 + 말씀 책: sheet on screen, title visible`, !!r.sheet && inside(r.sheet, r.vw, r.vh) && r.titleOnTop, `${fmt(r.sheet)} title ${fmt(r.title)}`);
    await shot('room-book-today');
    await p.keyboard.press('Escape');
    await modalIs(p, null).catch(() => undefined);
    await sleep(400);
    check(`${dev} 골방: room buttons back after the sheet`, (await p.isVisible('#closet-meditate')) && (await p.isVisible('#closet-exit')));

    // ---------------------------------------------------------------- no YouTube
    r = await probe(p);
    check(`${dev}: no iframe, no worship DOM, nothing requested from YouTube`, r.iframes === 0 && !r.worshipDom && yt.length === 0, yt.slice(0, 2).join(' '));
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
