// M4.2 test: foldable worship player (펼침 / 작게 / 접기).
//  - 작게: video >= 200x200; handle overlaps nothing (video, joystick, chat, HUD) at 390x844 and 360x740
//  - 접기: the API reports PAUSED, never PLAYING while folded; expanding resumes
//  - states persist across reloads; a sheet in each state overlaps nothing
// Ports: 5182 preview, 5183 server.
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/m42-test.mjs
import { resolve } from 'node:path';
import {
  check,
  currentStep,
  debug,
  desktop,
  dropDb,
  freshDb,
  launch,
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

const CLIENT_PORT = 5182;
const SERVER_PORT = 5183;
const BASE = `http://127.0.0.1:${CLIENT_PORT}/`;
const Q = '?test=1&shadows=0&time=14:00&noguide=1';
const DB = freshDb('m42');
const phone = (w, h) => ({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

const box = (page, sel) => page.locator(sel).first().boundingBox();
const overlaps = (a, b) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const w = async (page) => (await debug(page)).m3.worship;
const online = (page) => until(page, () => window.__WORLDS_DEBUG__?.ready && window.__WORLDS_DEBUG__.net?.status === 'online', null, 60000);
async function enter(page, nickname) {
  await page.goto(BASE + Q);
  await page.waitForSelector('#entry-signed-out:not([hidden])');
  await page.fill('#nickname', nickname);
  await page.click('#entry-submit');
  await online(page);
  await until(page, () => ['dock'].includes(window.__WORLDS_DEBUG__.m3.worship.mode), null, 20000);
}
/** Swipe across the handle with real touch events (CDP), as a finger would. */
async function swipe(page, dx) {
  const h = await box(page, '#worship-handle');
  const x = h.x + h.width / 2;
  const y = h.y + h.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, px) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y, id: 1 }] });
  await touch('touchStart', x);
  for (let i = 1; i <= 6; i++) await touch('touchMove', x + (dx * i) / 6);
  await touch('touchEnd', x + dx);
  await cdp.detach();
}

async function miniLayoutChecks(page, label) {
  const frame = await box(page, '.worship-frame');
  const handle = await box(page, '#worship-handle');
  const hud = [await box(page, '.place-card'), await box(page, '.clock-card'), await box(page, '#tools')];
  check(`${label}: 작게 video >= 200x200`, frame.width >= 200 && frame.height >= 200, `${Math.round(frame.width)}x${Math.round(frame.height)}`);
  check(
    `${label}: handle clear of the video, joystick and HUD`,
    handle && !overlaps(handle, frame) && !overlaps(handle, await box(page, '#stick-zone')) && hud.every((b) => !overlaps(handle, b)) && !overlaps(frame, await box(page, '#stick-zone')),
    JSON.stringify({ handle, frame }),
  );
  await teleport(page, { x: 51, z: -6 });
  await until(page, () => window.__WORLDS_DEBUG__.net.chatVisible);
  await sleep(600);
  const chat = await box(page, '#chat');
  check(
    `${label}: with the campfire chat open, the chat reflows clear of the video, handle and joystick`,
    !overlaps(chat, frame) && !overlaps(chat, handle) && !overlaps(chat, await box(page, '#stick-zone')),
    JSON.stringify({ chat }),
  );
}

let browser;
try {
  startServer(SERVER_PORT, DB);
  await waitHttp(`http://127.0.0.1:${SERVER_PORT}/health`);
  startPreview(CLIENT_PORT, SERVER_PORT);
  await waitHttp(BASE);
  browser = await launch();

  // ---------------------------------------------------------------- phone 390x844
  step('phone 390');
  const ctxM = await browser.newContext(phone(390, 844));
  const M = await ctxM.newPage();
  await enter(M, '작게');
  check('phone default after entry is 작게', (await w(M)).fold === 'mini' && (await w(M)).effective === 'mini');
  await sleep(1500);
  await M.screenshot({ path: resolve(shotDir, 'm42-mobile-mini.png') });
  await miniLayoutChecks(M, '390x844');
  await M.screenshot({ path: resolve(shotDir, 'm42-mobile-mini-campfire.png') });
  await teleport(M, { x: 0, z: 8 });

  // sheet in 작게
  await M.tap('#btn-settings');
  await until(M, () => window.__WORLDS_DEBUG__.m3.modal === '설정');
  await sleep(500);
  check('sheet while 작게: no overlap (player compact, not paused)', !overlaps(await box(M, '.sheet.settings'), await box(M, '#worship')) && (await w(M)).fold === 'mini');
  await M.tap('.sheet.settings .ghost');
  await until(M, () => window.__WORLDS_DEBUG__.m3.modal === null);

  // tap handle → 펼침
  await M.tap('#worship-handle');
  await until(M, () => window.__WORLDS_DEBUG__.m3.worship.effective === 'open');
  await sleep(700);
  const yt = await M.getAttribute('#worship-yt', 'href');
  check('펼침: list drawer + "🎧 YouTube에서 듣기" link to the current song', (await M.isVisible('#worship-list')) && /^https:\/\/music\.youtube\.com\/watch\?v=/.test(yt), yt);
  await M.screenshot({ path: resolve(shotDir, 'm42-mobile-open.png') });
  await M.tap('#btn-book');
  await until(M, () => window.__WORLDS_DEBUG__.m3.modal === '나의 말씀 책');
  await sleep(500);
  check('sheet while 펼침: no overlap', !overlaps(await box(M, '.sheet.book'), await box(M, '#worship')));
  await M.tap('.book-top .ghost');
  await until(M, () => window.__WORLDS_DEBUG__.m3.modal === null);

  // back to 작게, then swipe right → 접기
  step('phone 390: to mini');
  await M.tap('#worship-mini');
  await until(M, () => window.__WORLDS_DEBUG__.m3.worship.effective === 'mini').catch(async (e) => {
    console.log('DEBUG', JSON.stringify(await w(M)), JSON.stringify(await box(M, '#worship-mini')));
    throw e;
  });
  step('phone 390: swipe fold');
  await sleep(500);
  await swipe(M, 60);
  await until(M, () => window.__WORLDS_DEBUG__.m3.worship.effective === 'folded').catch(async (e) => {
    console.log('DEBUG', JSON.stringify(await w(M)), JSON.stringify(await box(M, '#worship-handle')));
    throw e;
  });
  await sleep(2500);
  const mf = await w(M);
  check('swipe right on the handle → 접기 (tab shown, not playing)', mf.tabVisible && mf.state !== 'playing' && !mf.playedWhileFolded, JSON.stringify({ state: mf.state }));
  await M.screenshot({ path: resolve(shotDir, 'm42-mobile-folded.png') });
  await M.tap('#btn-word');
  await until(M, () => window.__WORLDS_DEBUG__.m3.modal === '오늘의 말씀');
  await sleep(500);
  check('sheet while 접기: tab hidden, nothing overlaps, still not playing', !(await w(M)).tabVisible && (await w(M)).state !== 'playing');
  await M.keyboard.press('Escape');

  // persisted across reload (folded)
  await enter(M, '작게');
  await sleep(3000);
  const mr = await w(M);
  check('접기 persists across reload (tab, never playing)', mr.fold === 'folded' && mr.tabVisible && mr.state !== 'playing' && !mr.playedWhileFolded, JSON.stringify({ fold: mr.fold, state: mr.state }));
  await M.tap('#worship-tab');
  await until(M, () => window.__WORLDS_DEBUG__.m3.worship.effective === 'mini');
  check('tapping the tab expands (phone → 작게)', true);
  await sleep(500);
  await swipe(M, -60);
  await until(M, () => window.__WORLDS_DEBUG__.m3.worship.effective === 'open');
  check('swipe left on the handle → 펼침', true);
  await M.tap('#worship-mini');
  await ctxM.close();

  // ---------------------------------------------------------------- phone 360x740
  step('phone 360');
  const ctxS = await browser.newContext(phone(360, 740));
  const S = await ctxS.newPage();
  await enter(S, '작은화면');
  await sleep(1200);
  await miniLayoutChecks(S, '360x740');
  await S.screenshot({ path: resolve(shotDir, 'm42-mobile360-mini-campfire.png') });
  await ctxS.close();

  // ---------------------------------------------------------------- desktop: pause / resume
  step('desktop');
  const ctxD = await browser.newContext(desktop);
  const D = await ctxD.newPage();
  await enter(D, '데스크');
  check('desktop default stays 펼침', (await w(D)).fold === 'open');
  try {
    await until(D, () => window.__WORLDS_DEBUG__.m3.worship.state === 'playing', null, 25000);
  } catch {
    /* reported below */
  }
  const before = await w(D);
  await D.screenshot({ path: resolve(shotDir, 'm42-desktop-open.png') });
  await D.click('#worship-fold');
  await until(D, () => window.__WORLDS_DEBUG__.m3.worship.effective === 'folded');
  let pausedSeen = false;
  let playingSeen = false;
  for (let i = 0; i < 12; i++) {
    const s = (await w(D)).state;
    if (s === 'paused') pausedSeen = true;
    if (s === 'playing') playingSeen = true;
    await sleep(400);
  }
  const df = await w(D);
  check(
    '접기 pauses: the API reports PAUSED and never PLAYING while folded',
    before.state === 'playing' && pausedSeen && !playingSeen && !df.playedWhileFolded,
    JSON.stringify({ before: before.state, after: df.state }),
  );
  await D.screenshot({ path: resolve(shotDir, 'm42-desktop-folded.png') });
  await D.click('#btn-settings');
  await until(D, () => window.__WORLDS_DEBUG__.m3.modal === '설정');
  check('desktop: sheet while 접기 keeps it paused', (await w(D)).state !== 'playing');
  await D.keyboard.press('Escape');
  await D.click('#worship-tab');
  await until(D, () => window.__WORLDS_DEBUG__.m3.worship.state === 'playing', null, 15000).catch(() => undefined);
  check('tapping the tab expands and resumes playing', (await w(D)).effective === 'open' && (await w(D)).state === 'playing', (await w(D)).state);

  await D.click('#worship-mini');
  await until(D, () => window.__WORLDS_DEBUG__.m3.worship.effective === 'mini');
  await sleep(800);
  const dFrame = await box(D, '.worship-frame');
  const dHandle = await box(D, '#worship-handle');
  check('desktop 작게: video-only >= 200x200, handle beside it', dFrame.width >= 200 && dFrame.height >= 200 && !overlaps(dHandle, dFrame), `${Math.round(dFrame.width)}x${Math.round(dFrame.height)}`);
  await D.screenshot({ path: resolve(shotDir, 'm42-desktop-mini.png') });
  await D.click('#btn-book');
  await until(D, () => window.__WORLDS_DEBUG__.m3.modal === '나의 말씀 책');
  await sleep(400);
  check('desktop: sheet while 작게 overlaps nothing', !overlaps(await box(D, '.sheet.book'), await box(D, '#worship')));
  await D.keyboard.press('Escape');
  await enter(D, '데스크');
  check('작게 persists across reload (desktop)', (await w(D)).fold === 'mini');
  check('single iframe throughout', (await w(D)).iframes === 1);
  await ctxD.close();
} catch (err) {
  check('test run completed', false, `[step: ${currentStep()}] ${String(err).split('\n')[0]}`);
} finally {
  await browser?.close();
  await stopAll();
  dropDb(DB);
}
process.exit(summary());
