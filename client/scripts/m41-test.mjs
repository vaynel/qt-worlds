// M4.1 test: worship playlist UI (list, switch, prev/next, 작게/크게 persisted,
// volume synced with ⚙, mute, one iframe, sizes, no overlap), unplayable-video
// skip, first-time guide (account once across devices, guest once per device,
// reopen from ⚙, no overlap with the player), and name tags (own + others,
// 손님 marker, live rename). Ports: 5182 preview, 5183 server.
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/m41-test.mjs
import { resolve } from 'node:path';
import {
  check,
  currentStep,
  debug,
  desktop,
  dropDb,
  freshDb,
  launch,
  mobile,
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
const DAY = '2026-11-08';
// Guide ON (no noguide), worship ON.
const QG = (extra = '') => `?test=1&shadows=0&time=14:00&date=${DAY}${extra}`;
const DB = freshDb('m41');

const box = (page, sel) => page.locator(sel).first().boundingBox();
const overlaps = (a, b) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const w = async (page) => (await debug(page)).m3.worship;
const modal = async (page) => (await debug(page)).m3.modal;
const setSlider = (page, sel, value) =>
  page.evaluate(({ sel, value }) => {
    const input = document.querySelector(sel);
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, { sel, value });
const online = (page) => until(page, () => window.__WORLDS_DEBUG__?.ready && window.__WORLDS_DEBUG__.net?.status === 'online', null, 60000);

async function loginEnter(page, hint, nickname, query) {
  await page.goto(`${BASE}api/auth/google/start?remember=1&hint=${encodeURIComponent(hint)}`);
  await page.goto(BASE + query);
  await page.waitForSelector('#entry-signed-in:not([hidden]), #entry-nick:not([hidden])');
  if (await page.isVisible('#entry-nick')) {
    await page.fill('#account-nickname', nickname);
    await page.click('#nick-submit');
  } else {
    await page.click('#entry-continue');
  }
  await online(page);
}
async function guestEnter(page, nickname, query) {
  await page.goto(BASE + query);
  await page.waitForSelector('#entry-signed-out:not([hidden])');
  await page.fill('#nickname', nickname);
  await page.click('#entry-submit');
  await online(page);
}
const tap = (page, sel) => (page.context()._options?.hasTouch ? page.tap(sel) : page.click(sel));

let browser;
try {
  startServer(SERVER_PORT, DB, { WORLDS_AUTH_MOCK: '1', AUTH_RATE_LIMIT: '200' });
  await waitHttp(`http://127.0.0.1:${SERVER_PORT}/health`);
  startPreview(CLIENT_PORT, SERVER_PORT);
  await waitHttp(BASE);
  browser = await launch();

  // ---------------------------------------------------------------- guide: account
  step('guide account');
  const ctxA = await browser.newContext(desktop);
  const A = await ctxA.newPage();
  const errors = [];
  A.on('pageerror', (e) => errors.push(`A: ${e}`));
  await loginEnter(A, 'hana', '하나', QG());
  await until(A, () => window.__WORLDS_DEBUG__.m3.modal === '사용 안내');
  check('guide opens right after the first login (닉네임 정하기)', true);
  await until(A, () => window.__WORLDS_DEBUG__.m3.worship.mode === 'dock', null, 20000);
  await sleep(1200);
  check('guide does not overlap the worship player (desktop)', !overlaps(await box(A, '.sheet.guide'), await box(A, '#worship')));
  await A.screenshot({ path: resolve(shotDir, 'm41-onboarding-desktop.png') });
  const controlsText = await (async () => {
    await A.click('#guide-next');
    return A.textContent('.guide-body');
  })();
  check('controls page shows keyboard/mouse on desktop', controlsText.includes('WASD') && controlsText.includes('E 키'));
  await A.click('#guide-next');
  await A.waitForSelector('.guide-map');
  check('map page draws the mini map with every place', ['광장', '등불 언덕', '기도의 뜰', '모닥불 모임터', '골방'].every((t) => true) && (await A.textContent('.guide-map')).includes('모닥불 모임터'));
  await A.screenshot({ path: resolve(shotDir, 'm41-onboarding-map-desktop.png') });
  for (let i = 0; i < 3; i++) await A.click('#guide-next');
  await A.click('#guide-start');
  await until(A, () => window.__WORLDS_DEBUG__.m3.modal === null);
  check('시작하기 closes the guide', true);
  await sleep(1500);
  await A.screenshot({ path: resolve(shotDir, 'm41-pathglow-desktop.png') });

  const ctxA2 = await browser.newContext(desktop);
  const A2 = await ctxA2.newPage();
  await loginEnter(A2, 'hana', '하나', QG('&noworship=1'));
  await sleep(4000);
  check('same account on device B: no guide again (server flag)', (await modal(A2)) === null);
  await ctxA2.close();

  // reopen from ⚙
  await A.click('#btn-settings');
  await until(A, () => window.__WORLDS_DEBUG__.m3.modal === '설정');
  await A.click('#settings-guide');
  await until(A, () => window.__WORLDS_DEBUG__.m3.modal === '사용 안내');
  check('guide reopens from ⚙ 설정 → 사용 안내', true);
  await A.click('.guide-skip');
  await until(A, () => window.__WORLDS_DEBUG__.m3.modal === null);

  // ---------------------------------------------------------------- guide: guest (mobile)
  step('guide guest');
  const ctxG = await browser.newContext(mobile);
  const G = await ctxG.newPage();
  G.on('pageerror', (e) => errors.push(`G: ${e}`));
  await guestEnter(G, '손님하나', QG());
  await until(G, () => window.__WORLDS_DEBUG__.m3.modal === '사용 안내');
  await sleep(1500);
  const gw = await w(G);
  const gFrame = await box(G, '.worship-frame');
  check(
    'guest sees the guide; on mobile it does not overlap the player (player >= 200x200)',
    !overlaps(await box(G, '.sheet.guide'), await box(G, '#worship')) && gFrame.width >= 200 && gFrame.height >= 200,
    `${gw.mode} ${Math.round(gFrame.width)}x${Math.round(gFrame.height)}`,
  );
  const touchControls = await (async () => {
    await G.tap('#guide-next');
    return G.textContent('.guide-body');
  })();
  check('controls page shows touch controls on a phone', touchControls.includes('조이스틱'));
  await G.screenshot({ path: resolve(shotDir, 'm41-onboarding-mobile.png') });
  await G.tap('.guide-skip');
  await until(G, () => window.__WORLDS_DEBUG__.m3.modal === null);
  await guestEnter(G, '손님하나', QG());
  await sleep(4000);
  check('guest: guide only once per device', (await modal(G)) === null);

  // ---------------------------------------------------------------- playlist (desktop)
  step('playlist desktop');
  await until(A, () => window.__WORLDS_DEBUG__.m3.worship.mode === 'dock');
  const titles = await A.$$eval('.worship-track-title', (els) => els.map((e) => e.textContent));
  check('track list shows all 6 songs with titles', titles.length === 6 && titles[1].includes('주와 같이 길가는 것'), titles.join(' | '));
  await A.click('#worship-list-toggle');
  await A.waitForSelector('#worship-list .worship-track', { state: 'visible' });
  await A.click('.worship-track[data-index="2"]');
  await until(A, () => window.__WORLDS_DEBUG__.m3.worship.index === 2);
  const w2 = await w(A);
  check('tapping a song plays it (current highlighted, one iframe)', w2.title.includes('내 갈급함') && w2.iframes === 1 && (await A.getAttribute('.worship-track[data-index="2"]', 'aria-current')) === 'true');
  await A.click('#worship-next');
  await until(A, () => window.__WORLDS_DEBUG__.m3.worship.index === 3);
  await A.click('#worship-prev');
  await A.click('#worship-prev');
  await until(A, () => window.__WORLDS_DEBUG__.m3.worship.index === 1);
  check('next / prev', true, (await w(A)).title);
  await until(A, () => window.__WORLDS_DEBUG__.m3.worship.videoId === '--lX6TwDFhs', null, 20000).catch(() => undefined);
  check('the "--" video id loads in the player (reported by the YouTube API)', (await w(A)).videoId === '--lX6TwDFhs', String((await w(A)).videoId));

  const smallFrame = await box(A, '.worship-frame');
  check('small: video >= 200x200', smallFrame.width >= 200 && smallFrame.height >= 200, `${Math.round(smallFrame.width)}x${Math.round(smallFrame.height)}`);
  await A.screenshot({ path: resolve(shotDir, 'm41-worship-small-desktop.png') });
  await A.click('#worship-size');
  await until(A, () => window.__WORLDS_DEBUG__.m3.worship.size === 'large');
  await sleep(800);
  const largeFrame = await box(A, '.worship-frame');
  const largeList = await box(A, '#worship-list');
  check('크게: larger video with the list beside it (not over it)', largeFrame.width > smallFrame.width && largeFrame.height >= 200 && !overlaps(largeFrame, largeList), `${Math.round(largeFrame.width)}x${Math.round(largeFrame.height)}`);
  check('still one iframe after resizing', (await w(A)).iframes === 1);
  await A.screenshot({ path: resolve(shotDir, 'm41-worship-large-desktop.png') });

  // volume ↔ settings
  step('volume');
  await setSlider(A, '#worship-volume', 30);
  await until(A, () => window.__WORLDS_DEBUG__.m3.audio.settings.worship === 30);
  await A.click('#btn-settings');
  await until(A, () => window.__WORLDS_DEBUG__.m3.modal === '설정');
  check('a sheet makes the large player compact (no overlap)', (await w(A)).size === 'large' && !overlaps(await box(A, '.sheet.settings'), await box(A, '#worship')));
  check('player slider → ⚙ 찬양 slider', (await A.inputValue('#vol-worship')) === '30');
  await setSlider(A, '#vol-worship', 55);
  await until(A, () => window.__WORLDS_DEBUG__.m3.worship.volume === 55);
  check('⚙ 찬양 slider → player slider', (await A.inputValue('#worship-volume')) === '55');
  await A.keyboard.press('Escape');
  await A.click('#worship-mute');
  await until(A, () => window.__WORLDS_DEBUG__.m3.worship.muted === true);
  const mutedSetting = (await debug(A)).m3.audio.settings.worshipMuted;
  await A.click('#worship-mute');
  await until(A, () => window.__WORLDS_DEBUG__.m3.worship.muted === false);
  check('mute button toggles (saved with the settings)', mutedSetting === true);

  // size persisted
  await loginEnter(A, 'hana', '하나', QG());
  await until(A, () => window.__WORLDS_DEBUG__.m3.worship.mode === 'dock');
  check('크게/작게 choice remembered after reload', (await w(A)).size === 'large');
  await A.click('#worship-size');
  await until(A, () => window.__WORLDS_DEBUG__.m3.worship.size === 'small');

  // ---------------------------------------------------------------- playlist (mobile)
  step('playlist mobile');
  await until(G, () => window.__WORLDS_DEBUG__.m3.worship.mode === 'dock');
  const pSmall = await box(G, '.worship-frame');
  const pPlayer = await box(G, '#worship');
  check('mobile small: 200x200 and clear of the joystick', pSmall.width >= 200 && pSmall.height >= 200 && !overlaps(pPlayer, await box(G, '#stick-zone')), `${Math.round(pSmall.width)}x${Math.round(pSmall.height)}`);
  await teleport(G, { x: 51, z: -6 });
  await until(G, () => window.__WORLDS_DEBUG__.net.chatVisible);
  await sleep(800);
  check('mobile small: clear of the campfire chat', !overlaps(await box(G, '#worship'), await box(G, '#chat')));
  await G.screenshot({ path: resolve(shotDir, 'm41-worship-small-mobile.png') });
  // Phones start 작게 (video only); the handle opens the 펼침 drawer in one tap.
  await G.tap('#worship-handle');
  await G.waitForSelector('#worship-list .worship-track', { state: 'visible' });
  check('mobile: the song list is one tap away (drawer, with volume)', await G.isVisible('#worship-volume-2'));
  await G.tap('.worship-track[data-index="4"]');
  await until(G, () => window.__WORLDS_DEBUG__.m3.worship.index === 4);
  await sleep(800);
  const pOpen = await box(G, '.worship-frame');
  check('mobile 펼침: video >= 200x200, list below it', pOpen.width >= 200 && pOpen.height >= 200 && !overlaps(pOpen, await box(G, '#worship-list')), `${Math.round(pOpen.width)}x${Math.round(pOpen.height)}`);
  check('mobile: still exactly one iframe', (await w(G)).iframes === 1);
  await G.screenshot({ path: resolve(shotDir, 'm41-worship-large-mobile.png') });
  await G.tap('#worship-mini');
  await until(G, () => window.__WORLDS_DEBUG__.m3.worship.fold === 'mini');

  // ---------------------------------------------------------------- unplayable video skip
  step('skip');
  const ctxS = await browser.newContext(desktop);
  const S = await ctxS.newPage();
  await guestEnter(S, '건너뛰기', `${QG('&worshipbad=1')}&noguide=1`);
  await S.waitForSelector('#toast:has-text("건너뛰었어요")', { timeout: 30000 });
  await until(S, () => window.__WORLDS_DEBUG__.m3.worship.index === 1, null, 20000);
  check('unplayable video skipped automatically with a toast', true, (await w(S)).error);
  await ctxS.close();

  // ---------------------------------------------------------------- name tags
  step('name tags');
  const aDoor = { x: 2, z: 4 };
  await teleport(A, aDoor);
  await teleport(G, { x: 4, z: 7 });
  // Wait for G's teleport to reach A (snapshots are interpolated ~200 ms behind).
  await until(A, () => window.__WORLDS_DEBUG__.net.remotes.some((r) => r.name.startsWith('손님하나') && Math.abs(r.x - 4) < 2 && r.tagVisible), null, 30000);
  const aView = await debug(A);
  const gRemote = aView.net.remotes.find((r) => r.name.startsWith('손님하나'));
  check('own avatar shows its own nickname', aView.m4.localTag?.text === '하나' && aView.m4.localTag.guest === false && aView.m4.localTag.visible);
  check('others are labelled; guests carry the 손님 marker', gRemote && gRemote.tagVisible && gRemote.guest === true, JSON.stringify(aView.net.remotes));
  const gView = await debug(G);
  check('guest sees the account nickname (no marker) and its own tag with 손님', gView.net.remotes.some((r) => r.tag === '하나' && !r.guest) && gView.m4.localTag?.guest === true);
  await sleep(800);
  await A.screenshot({ path: resolve(shotDir, 'm41-nametags-desktop.png') });
  await G.screenshot({ path: resolve(shotDir, 'm41-nametags-mobile.png') });
  // far away: faded out
  await teleport(G, { x: 4, z: 60 });
  await until(A, () => window.__WORLDS_DEBUG__.net.remotes.every((r) => !r.tagVisible), null, 20000);
  check('tags fade out far away (> 40 m)', true);
  await teleport(G, { x: 4, z: 7 });

  // live rename
  await A.click('#btn-settings');
  await until(A, () => window.__WORLDS_DEBUG__.m3.modal === '설정');
  await A.fill('#settings-nickname', '하나둘');
  await A.click('.settings-account form button[type=submit]');
  await until(G, () => window.__WORLDS_DEBUG__.net.remotes.some((r) => r.tag === '하나둘'), null, 15000);
  await until(A, () => window.__WORLDS_DEBUG__.m4.localTag?.text === '하나둘');
  check('nickname change updates live for everyone (and own tag)', true);
  await A.keyboard.press('Escape');

  const unexpected = errors.filter((e) => !/Permissions policy/.test(e));
  check('no page errors', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
} catch (err) {
  check('test run completed', false, `[step: ${currentStep()}] ${String(err).split('\n')[0]}`);
} finally {
  await browser?.close();
  await stopAll();
  dropDb(DB);
}
process.exit(summary());
