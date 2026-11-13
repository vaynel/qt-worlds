// M3.1 test: persistent worship player (dock / 골방 / close+reopen / one instance),
// settings panel (bus gains + persistence), and phone layout (no overlap).
// Starts its own server (5183) and client preview (5182); stops both at the end.
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/m31-test.mjs
import { chromium } from '@playwright/test';
import { dropDb, freshDb, loginJoin } from './lib/harness.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, '..');
const serverDir = resolve(here, '../../server');
const shotDir = resolve(here, '../../docs/screenshots');
mkdirSync(shotDir, { recursive: true });
const WebSocket = createRequire(resolve(serverDir, 'package.json'))('ws');

const SERVER_PORT = Number(process.env.TEST_SERVER_PORT ?? 5183);
const PROD_PORT = Number(process.env.TEST_PROD_PORT ?? 5184);
const CLIENT_PORT = Number(process.env.TEST_CLIENT_PORT ?? 5182);
const BASE = `http://127.0.0.1:${CLIENT_PORT}/`;
const DB = freshDb('m31');
const DB2 = freshDb('m31-prod');
const DAY = '2026-11-08';
const OTHER_DAY = '2026-12-25';
const Q = (extra = '') => `?test=1&shadows=0&time=14:00&date=${DAY}&noguide=1${extra}`;

const GARDEN = { x: -52, z: -16 };
const mat = (i) => {
  const a = (i / 8) * Math.PI * 2;
  return { x: GARDEN.x + Math.cos(a) * 5.2, z: GARDEN.z + Math.sin(a) * 5.2 };
};

const results = [];
let stepName = 'setup';
const step = (n) => {
  stepName = n;
  if (process.env.VERBOSE) console.log(`-- ${n}`);
};
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
function start(name, cmd, args, cwd, env = {}) {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', (d) => {
    const t = String(d);
    if (!/proxy (socket )?error|EPIPE|ECONNRESET|at /.test(t)) process.stdout.write(`[${name}!] ${t}`);
  });
  children.push(child);
  return child;
}
async function waitHttp(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      /* not yet */
    }
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${url}`);
}
function stop(child) {
  return new Promise((r) => {
    if (child.exitCode !== null) return r();
    child.once('exit', () => r());
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 3000);
  });
}
function findChromium() {
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    /* fall through */
  }
  const cache = resolve(homedir(), '.cache/ms-playwright');
  for (const b of readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
    const exe = resolve(cache, b, 'chrome-linux64/chrome');
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

const debug = (page) => page.evaluate(() => window.__WORLDS_DEBUG__);
const until = (page, fn, arg, ms = 30000) => page.waitForFunction(fn, arg, { timeout: ms, polling: 250 });
async function join(page, nickname, query = Q()) {
  await page.goto(BASE + query);
  await page.waitForSelector('#entry-signed-out:not([hidden]), #entry-signed-in:not([hidden])');
  if (await page.isVisible('#entry-continue')) {
    await page.click('#entry-continue');
  } else {
    await page.fill('#nickname', nickname);
    await page.click('#entry-submit');
  }
  await until(page, () => window.__WORLDS_DEBUG__?.ready && window.__WORLDS_DEBUG__.net?.status === 'online', null, 60000);
}
const teleport = (page, p) => page.evaluate(({ x, z }) => window.__WORLDS_TEST__.teleport(x, z), p);
const modalName = (page) => page.evaluate(() => window.__WORLDS_DEBUG__?.m3?.modal ?? null);

function rawHello(port, testDate) {
  return new Promise((resolveHello, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, nickname: 'raw', ...(testDate ? { testDate } : {}) })));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === 'welcome') {
        ws.close();
        resolveHello(m);
      }
    });
    setTimeout(() => reject(new Error('no welcome')), 5000);
  });
}
const seoulToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function meditate(page, texts) {
  await until(page, () => window.__WORLDS_DEBUG__.m3.modal === '묵상하기');
  await page.click('.med-foot .primary'); // 말씀 -> 묵상
  await page.fill('#med-meditation', texts[0]);
  await page.click('.med-foot .primary');
  await page.fill('#med-feeling', texts[1]);
  await page.click('.med-foot .primary');
  await page.fill('#med-application', texts[2]);
}


const box = (page, sel) => page.locator(sel).first().boundingBox();
const overlaps = (a, b) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const worshipState = async (page) => (await debug(page)).m3.worship;
const audioState = async (page) => (await debug(page)).m3.audio;
const setSlider = (page, id, value) =>
  page.evaluate(({ id, value }) => {
    const input = document.getElementById(id);
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, { id, value });

/** Wait up to `ms` for playback; report what the browser actually did. */
async function playbackOutcome(page, ms = 20000) {
  try {
    await until(page, () => {
      const w = window.__WORLDS_DEBUG__?.m3?.worship;
      return w && (w.state === 'playing' || w.promptVisible || w.error || w.facade);
    }, null, ms);
  } catch {
    /* fall through: report the state as-is */
  }
  return worshipState(page);
}

let browser;
try {
  start('server', 'node', ['dist/server/src/index.js'], serverDir, { PORT: String(SERVER_PORT), WORLDS_ALLOW_TEST_DATES: '1', WORLDS_DB: DB, QUIET: '1' });
  await waitHttp(`http://127.0.0.1:${SERVER_PORT}/health`);
  start('client', 'node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(CLIENT_PORT), '--host', '127.0.0.1'], clientDir, {
    WORLDS_SERVER: `http://127.0.0.1:${SERVER_PORT}`,
  });
  await waitHttp(BASE);

  // No --autoplay-policy flag: let Chromium apply its normal user-gesture rules.
  browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const desktop = { viewport: { width: 1280, height: 720 } };
  const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const ctxD = await browser.newContext(desktop);
  const ctxP = await browser.newContext(mobile);
  const D = await ctxD.newPage();
  const P = await ctxP.newPage();
  const pageErrors = [];
  for (const [n, p] of [['D', D], ['P', P]]) {
    p.on('pageerror', (e) => pageErrors.push(`${n}: ${e}`));
    p.on('console', (m) => m.type() === 'error' && pageErrors.push(`${n} console: ${m.text()}`));
  }

  // ---- desktop: player docks after 입장
  step('desktop dock');
  await join(D, '은혜');
  await until(D, () => window.__WORLDS_DEBUG__.m3.worship.mode === 'dock');
  const dOut = await playbackOutcome(D);
  const dFrame = await box(D, '.worship-frame');
  check('desktop: mini player docked after entry, >= 200x200', dFrame.width >= 200 && dFrame.height >= 200, `${Math.round(dFrame.width)}x${Math.round(dFrame.height)}`);
  check('desktop: exactly one YouTube iframe', dOut.iframes === 1, `iframes=${dOut.iframes}`);
  console.log(`INFO  desktop autoplay outcome after the 입장 click: state=${dOut.state} prompt=${dOut.promptVisible} error=${dOut.error}`);
  const audio0 = await audioState(D);
  check('default ambience is low (35% -> 0.175, x0.3 while worship plays)', audio0.settings.ambience === 35 && (audio0.targets.ambience === 0.175 || audio0.targets.ambience === 0.053), JSON.stringify(audio0.targets));
  await sleep(1500);
  await D.screenshot({ path: resolve(shotDir, 'm31-dock-desktop.png') });

  // ---- settings: sliders drive bus gains, persist across reload
  step('settings');
  await D.click('#btn-settings');
  await until(D, () => window.__WORLDS_DEBUG__.m3.modal === '설정');
  await D.click('#settings-nav-sound');
  await setSlider(D, 'vol-ambience', 10);
  await setSlider(D, 'vol-ui', 20);
  await setSlider(D, 'vol-master', 50);
  await setSlider(D, 'vol-worship', 40);
  await until(D, () => window.__WORLDS_DEBUG__.m3.audio.settings.worship === 40, null, 10000);
  const a1 = await audioState(D);
  const duck = a1.ducked ? 0.3 : 1;
  const expect = { master: 0.45, ambience: Math.round(0.05 * duck * 1000) / 1000, ui: 0.12 };
  check(
    'sliders set the bus gains',
    a1.targets.master === expect.master && a1.targets.ambience === expect.ambience && a1.targets.ui === expect.ui,
    `targets=${JSON.stringify(a1.targets)} expected=${JSON.stringify(expect)}`,
  );
  await sleep(1500);
  const a1b = await audioState(D);
  if (a1b.gains) {
    const near = (x, y) => Math.abs(x - y) < 0.02;
    check('live AudioParam gains follow the sliders', near(a1b.gains.master, a1b.targets.master) && near(a1b.gains.ambience, a1b.targets.ambience) && near(a1b.gains.ui, a1b.targets.ui), JSON.stringify(a1b.gains));
  } else {
    check('audio context running in headless browser', false, 'no AudioContext yet');
  }
  await D.screenshot({ path: resolve(shotDir, 'm31-settings-desktop.png') });
  const setBox = await box(D, '.sheet.settings');
  check('desktop: settings sheet does not cover the player', !overlaps(setBox, await box(D, '#worship')));
  await D.keyboard.press('Escape');
  await join(D, '은혜');
  const a2 = await audioState(D);
  await D.click('#btn-settings');
  await until(D, () => window.__WORLDS_DEBUG__.m3.modal === '설정');
  await D.click('#settings-nav-sound');
  const sliderVal = await D.inputValue('#vol-ambience');
  check('settings persist across a reload', a2.settings.ambience === 10 && a2.settings.master === 50 && a2.settings.worship === 40 && sliderVal === '10', JSON.stringify(a2.settings));
  await D.keyboard.press('Escape');

  // ---- close / reopen (remembered)
  step('close reopen');
  await until(D, () => window.__WORLDS_DEBUG__.m3.worship.mode === 'dock');
  await D.click('.worship-close');
  await until(D, () => window.__WORLDS_DEBUG__.m3.worship.mode === 'hidden');
  const closed = await worshipState(D);
  check('closing removes the player (music stops)', closed.iframes === 0 && closed.userClosed, JSON.stringify(closed));
  await join(D, '은혜');
  await sleep(3000);
  const afterReload = await worshipState(D);
  check('closed choice remembered after reload', afterReload.mode === 'hidden' && afterReload.iframes === 0);
  await D.click('#btn-worship');
  await until(D, () => window.__WORLDS_DEBUG__.m3.worship.mode === 'dock' && window.__WORLDS_DEBUG__.m3.worship.iframes === 1);
  const reopened = await playbackOutcome(D);
  check('HUD 찬양 reopens the player', reopened.mode === 'dock' && !reopened.userClosed);
  console.log(`INFO  desktop outcome after the HUD 찬양 click: state=${reopened.state} prompt=${reopened.promptVisible}`);

  // ---- 골방: same single instance moves onto the room layout
  step('closet');
  const door = await D.evaluate(() => window.__WORLDS_TEST__.closetDoor());
  await teleport(D, door);
  await until(D, () => document.getElementById('action-btn').textContent.includes('골방'));
  await D.keyboard.press('KeyE');
  await until(D, () => window.__WORLDS_DEBUG__.m3.closet === true && window.__WORLDS_DEBUG__.m3.worship.mode === 'room');
  await sleep(1200);
  const room = await worshipState(D);
  const rFrame = await box(D, '.worship-frame');
  check('골방 reuses the one player (single iframe, room layout)', room.iframes === 1 && rFrame.width >= 200 && rFrame.height >= 200, `iframes=${room.iframes} ${Math.round(rFrame.width)}x${Math.round(rFrame.height)}`);
  await D.screenshot({ path: resolve(shotDir, 'm31-closet-desktop.png') });
  await D.click('#closet-exit');
  await until(D, () => window.__WORLDS_DEBUG__.m3.closet === false && window.__WORLDS_DEBUG__.m3.worship.mode === 'dock');
  check('leaving the 골방 docks the same player again', (await worshipState(D)).iframes === 1);

  // ---- phone
  step('mobile dock');
  await join(P, '평안');
  await until(P, () => window.__WORLDS_DEBUG__.m3.worship.mode === 'dock');
  const pOut = await playbackOutcome(P);
  console.log(`INFO  mobile (Chromium touch emulation) autoplay outcome: state=${pOut.state} prompt=${pOut.promptVisible} error=${pOut.error}`);
  await sleep(800);
  const pFrame = await box(P, '.worship-frame');
  const pPlayer = await box(P, '#worship');
  check('mobile: player >= 200x200', pFrame.width >= 200 && pFrame.height >= 200, `${Math.round(pFrame.width)}x${Math.round(pFrame.height)}`);
  check('mobile: player does not cover the joystick zone', !overlaps(pPlayer, await box(P, '#stick-zone')) && !overlaps(pPlayer, await box(P, '#stick-base')));
  await P.screenshot({ path: resolve(shotDir, 'm31-dock-mobile.png') });

  step('mobile chat');
  await teleport(P, { x: 51, z: -6 });
  await until(P, () => window.__WORLDS_DEBUG__.net.chatVisible);
  await sleep(800);
  check('mobile: player does not cover the campfire chat', !overlaps(await box(P, '#worship'), await box(P, '#chat')));
  await P.screenshot({ path: resolve(shotDir, 'm31-campfire-mobile.png') });

  step('mobile meditation');
  const m5 = mat(5);
  await teleport(P, { x: m5.x + 0.3, z: m5.z + 0.3 });
  await until(P, () => !document.getElementById('action-btn').hidden);
  await P.tap('#action-btn');
  await until(P, () => !document.getElementById('meditate-btn').hidden);
  await P.tap('#meditate-btn');
  await until(P, () => window.__WORLDS_DEBUG__.m3.modal === '묵상하기');
  await P.click('.med-foot .primary');
  await P.fill('#med-meditation', '함께 있어 감사해요');
  await sleep(800);
  const sheet = await box(P, '.sheet.meditation');
  const top = await box(P, '#worship');
  check('mobile: meditation sheet and player do not overlap', !overlaps(sheet, top) && top.height >= 200, `player y=${Math.round(top.y)}..${Math.round(top.y + top.height)}, sheet y=${Math.round(sheet.y)}`);
  await P.screenshot({ path: resolve(shotDir, 'm31-meditation-mobile.png') });
  await P.tap('.med-close');

  step('mobile settings');
  await P.tap('#btn-settings');
  await until(P, () => window.__WORLDS_DEBUG__.m3.modal === '설정');
  await sleep(600);
  check('mobile: settings sheet and player do not overlap', !overlaps(await box(P, '.sheet.settings'), await box(P, '#worship')));
  await P.screenshot({ path: resolve(shotDir, 'm31-settings-mobile.png') });
  await P.tap('.sheet.settings .ghost');

  step('placeholder');
  const ctxE = await browser.newContext(desktop);
  const E = await ctxE.newPage();
  await join(E, '빈목록', Q('&noworship=1'));
  await sleep(1500);
  check('empty list: no player is started on entry', (await worshipState(E)).mode === 'hidden');
  const eDoor = await E.evaluate(() => window.__WORLDS_TEST__.closetDoor());
  await teleport(E, eDoor);
  await until(E, () => document.getElementById('action-btn').textContent.includes('골방'));
  await E.keyboard.press('KeyE');
  await until(E, () => window.__WORLDS_DEBUG__.m3.worship.mode === 'room');
  check('empty list: 골방 shows the placeholder', (await worshipState(E)).placeholder && (await E.textContent('#worship')).includes('찬양 영상을 준비하고 있어요'));
  await ctxE.close();

  const unexpected = pageErrors.filter((e) => !/WebSocket connection to .* failed|Permissions policy violation/.test(e));
  check('no unexpected page errors', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
} catch (err) {
  check('test run completed', false, `[step: ${stepName}] ${String(err).split('\n')[0]}`);
} finally {
  await browser?.close();
  for (const c of children) await stop(c);
  dropDb(DB);
  dropDb(DB2);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
