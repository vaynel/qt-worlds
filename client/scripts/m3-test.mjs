// M3 end-to-end test: today's word, letter, word book, meditation, 골방, worship placeholder.
// Starts its own server (5183, test dates allowed) + a second server without the
// test flag (5184), and a client preview (5182). Shuts everything down at the end.
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/m3-test.mjs
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
const DB = freshDb('m3');
const DB2 = freshDb('m3-prod');
const DAY = '2026-11-08';
const OTHER_DAY = '2026-12-25';
// noworship=1: the worship player has its own test (m31); without three
// software-decoded videos the CPU-rendered headless run stays fast enough.
const Q = (extra = '') => `?test=1&shadows=0&time=14:00&date=${DAY}&noworship=1&noguide=1${extra}`;

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

let browser;
try {
  start('server', 'node', ['dist/server/src/index.js'], serverDir, { PORT: String(SERVER_PORT), WORLDS_ALLOW_TEST_DATES: '1', WORLDS_AUTH_MOCK: '1', WORLDS_DB: DB, QUIET: '1' });
  start('prod', 'node', ['dist/server/src/index.js'], serverDir, { PORT: String(PROD_PORT), WORLDS_DB: DB2, QUIET: '1' });
  await waitHttp(`http://127.0.0.1:${SERVER_PORT}/health`);
  await waitHttp(`http://127.0.0.1:${PROD_PORT}/health`);
  start('client', 'node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(CLIENT_PORT), '--host', '127.0.0.1'], clientDir, {
    WORLDS_SERVER: `http://127.0.0.1:${SERVER_PORT}`,
  });
  await waitHttp(BASE);

  // ---- data + determinism at the protocol level
  const day1 = await rawHello(SERVER_PORT, DAY);
  const day1b = await rawHello(SERVER_PORT, DAY);
  const day2 = await rawHello(SERVER_PORT, OTHER_DAY);
  check('same date -> same verse (raw clients)', day1.word.ref === day1b.word.ref, day1.word.ref);
  check('different date -> different verse', day1.word.ref !== day2.word.ref, `${DAY}: ${day1.word.ref} / ${OTHER_DAY}: ${day2.word.ref}`);
  check(
    'passage has dimmed context and attribution',
    day1.word.before.length <= 2 && day1.word.after.length <= 2 && day1.word.before.length + day1.word.after.length > 0 && day1.word.translation === '개역한글판',
    `before=${day1.word.before.length} after=${day1.word.after.length} ${day1.word.translation}`,
  );
  const prod = await rawHello(PROD_PORT, OTHER_DAY);
  check('production server ignores the test date override', prod.word.date === seoulToday(), `asked ${OTHER_DAY}, got ${prod.word.date}`);
  const dist = readdirSync(resolve(clientDir, 'dist/assets')).map((f) => readFileSync(resolve(clientDir, 'dist/assets', f), 'utf-8')).join('');
  check('client bundle does not contain the Bible text', !dist.includes('태초에 하나님이 천지를') && !dist.includes('여호와는 나의 목자시니'));

  browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
  const desktop = { viewport: { width: 1280, height: 720 } };
  const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const ctxA = await browser.newContext(desktop);
  const ctxB = await browser.newContext(desktop);
  const ctxM = await browser.newContext(mobile);
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  const M = await ctxM.newPage();
  const pageErrors = [];
  for (const [n, p] of [['A', A], ['B', B], ['M', M]]) {
    p.on('pageerror', (e) => pageErrors.push(`${n}: ${e}`));
    p.on('console', (m) => m.type() === 'error' && pageErrors.push(`${n} console: ${m.text()}`));
  }

  // ---- same verse in two browsers
  await loginJoin(A, BASE, 'alice', '은혜', Q());
  await join(B, '소망');
  await until(A, () => window.__WORLDS_DEBUG__.m3.word);
  await until(B, () => window.__WORLDS_DEBUG__.m3.word);
  const wa = (await debug(A)).m3.word;
  const wb = (await debug(B)).m3.word;
  check('two browsers get the same verse for the same date', wa.ref === wb.ref && wa.ref === day1.word.ref, wa.ref);

  // ---- letter flies in, is clicked in 3D, unfolds
  await until(A, () => ['flying', 'waiting'].includes(window.__WORLDS_DEBUG__.m3.letter));
  await sleep(1800);
  await A.screenshot({ path: resolve(shotDir, 'm3-letter-flying-desktop.png') });
  await until(A, () => window.__WORLDS_DEBUG__.m3.letter === 'waiting', null, 40000);
  check('letter arrives and waits (open button visible)', await A.isVisible('#letter-btn'));
  await sleep(600);
  await A.screenshot({ path: resolve(shotDir, 'm3-letter-waiting-desktop.png') });
  const pos = await A.evaluate(() => window.__WORLDS_TEST__.letterScreen());
  await A.mouse.click(pos.x, pos.y);
  await until(A, () => window.__WORLDS_DEBUG__.m3.modal === '오늘의 말씀');
  check('clicking the 3D letter opens it', true, `clicked at ${Math.round(pos.x)},${Math.round(pos.y)}`);
  await sleep(2600); // let the unfold animation finish
  await A.screenshot({ path: resolve(shotDir, 'm3-word-page-desktop.png') });
  const pageText = await A.textContent('.word-page');
  const ctxLines = await A.locator('.word-body .ctx').count();
  check('page shows verse, ref, dimmed context, 개역한글판', pageText.includes(wa.text.slice(0, 10)) && pageText.includes(wa.ref) && pageText.includes('개역한글판') && ctxLines > 0, `ctx lines=${ctxLines}`);
  await A.click('.word-actions button:last-child');
  await until(A, () => window.__WORLDS_DEBUG__.m3.modal === null);

  step('same day');
  // Same day again (reload, same browser storage): no letter.
  await join(A, '은혜');
  await until(A, () => window.__WORLDS_DEBUG__.m3.word);
  await sleep(4000);
  const again = (await debug(A)).m3.letter;
  check('letter does not reappear the same day', again === 'opened' && !(await A.isVisible('#letter-btn')), `letter=${again}`);
  await A.click('#btn-word');
  await until(A, () => window.__WORLDS_DEBUG__.m3.modal === '오늘의 말씀');
  check('HUD 오늘의 말씀 reopens the word', true);
  await A.keyboard.press('Escape');
  await until(A, () => window.__WORLDS_DEBUG__.m3.modal === null);

  step('B word');
  // B ignores its letter by opening via the HUD button (it disappears).
  await B.click('#btn-word');
  await until(B, () => window.__WORLDS_DEBUG__.m3.modal === '오늘의 말씀');
  await B.keyboard.press('Escape');

  step('closet');
  // ---- 골방: enter, others hidden, worship placeholder, meditation
  const door = await A.evaluate(() => window.__WORLDS_TEST__.closetDoor());
  await teleport(A, door);
  await teleport(B, { x: door.x + 3, z: door.z + 3 });
  await until(B, () => window.__WORLDS_DEBUG__.net.remotes.some((r) => r.visible));
  await until(A, () => window.__WORLDS_DEBUG__.net.remotes.some((r) => r.visible));
  await until(A, () => document.getElementById('action-btn').textContent.includes('골방'));
  const label = await A.textContent('#action-btn');
  await A.bringToFront();
  await A.keyboard.press('KeyE');
  await until(A, () => window.__WORLDS_DEBUG__.m3.closet === true);
  check('E at the door enters the 골방', true, `button="${label}"`);
  await until(B, () => window.__WORLDS_DEBUG__.net.remotes.every((r) => !r.visible));
  const bView = (await debug(B)).net.remotes;
  check('others no longer see the player who entered the 골방', bView.length === 1 && bView[0].inside && !bView[0].visible);
  await sleep(1200);
  const aIn = (await debug(A)).m3;
  check('inside the 골방 no other players are drawn', aIn.renderedRemotes === 0);
  check('the worship player moves onto the 골방 layout', aIn.worship.mode === 'room' && aIn.worship.iframes <= 1, JSON.stringify(aIn.worship));
  const frame = await A.locator('.worship-frame').boundingBox();
  check('worship screen is at least 200x200', frame.width >= 200 && frame.height >= 200, `${Math.round(frame.width)}x${Math.round(frame.height)}`);
  await A.screenshot({ path: resolve(shotDir, 'm3-closet-desktop.png') });

  await A.click('#closet-meditate');
  await meditate(A, ['사랑하사 라는 단어가 마음에 머물러요.', '감사한 마음이 들어요.', '오늘 가족에게 먼저 고맙다고 말하기']);
  await A.screenshot({ path: resolve(shotDir, 'm3-meditation-desktop.png') });
  await A.click('.med-save');
  await until(A, () => window.__WORLDS_DEBUG__.m3.lastSaved === '골방');
  check('meditation in 골방 saved', true);
  await A.click('#btn-book');
  await until(A, () => window.__WORLDS_DEBUG__.m3.modal === '나의 말씀 책');
  const bookA = await A.textContent('.book');
  check('word book shows the 골방 meditation', bookA.includes('골방에서') && bookA.includes('가족에게 먼저') && bookA.includes(wa.ref));
  await A.screenshot({ path: resolve(shotDir, 'm3-word-book-desktop.png') });
  await A.keyboard.press('Escape');
  await A.click('#closet-exit');
  await until(A, () => window.__WORLDS_DEBUG__.m3.closet === false);
  await until(B, () => window.__WORLDS_DEBUG__.net.remotes.some((r) => r.visible));
  check('leaving the 골방 makes the player visible again', true);

  step('mobile');
  // ---- mobile: letter via button, meditation on a mat, 골방 layout
  await loginJoin(M, BASE, 'mina', '평안', Q());
  await until(M, () => window.__WORLDS_DEBUG__.m3.letter === 'waiting', null, 90000);
  await M.tap('#letter-btn');
  await until(M, () => window.__WORLDS_DEBUG__.m3.modal === '오늘의 말씀');
  await sleep(2600);
  await M.screenshot({ path: resolve(shotDir, 'm3-word-page-mobile.png') });
  await M.tap('.word-actions button:last-child');
  await until(M, () => window.__WORLDS_DEBUG__.m3.modal === null);

  const m3pos = mat(3);
  await teleport(M, { x: m3pos.x + 0.4, z: m3pos.z + 0.4 });
  await until(M, () => !document.getElementById('action-btn').hidden);
  await M.tap('#action-btn');
  await until(M, () => window.__WORLDS_DEBUG__.net.seat === 3);
  await until(M, () => !document.getElementById('meditate-btn').hidden);
  await sleep(1200);
  await M.screenshot({ path: resolve(shotDir, 'm3-prayer-mat-mobile.png') });
  await M.tap('#meditate-btn');
  await meditate(M, ['목자 되신 주님', '평안해요', '오늘 하루 조급해하지 않기']);
  await M.screenshot({ path: resolve(shotDir, 'm3-meditation-mobile.png') });
  await M.tap('.med-save');
  await until(M, () => window.__WORLDS_DEBUG__.m3.lastSaved === '기도의 뜰');
  await M.tap('#btn-book');
  await until(M, () => window.__WORLDS_DEBUG__.m3.modal === '나의 말씀 책');
  const bookM = await M.textContent('.book');
  check('meditation on a 기도의 뜰 mat saved to the word book', bookM.includes('기도의 뜰에서') && bookM.includes('조급해하지 않기'));
  await M.screenshot({ path: resolve(shotDir, 'm3-word-book-mobile.png') });
  await M.tap('.book-top button');
  await until(M, () => window.__WORLDS_DEBUG__.m3.modal === null);
  await M.tap('#action-btn'); // stand up
  await until(M, () => window.__WORLDS_DEBUG__.net.seat === -1);
  await teleport(M, door);
  await until(M, () => document.getElementById('action-btn').textContent === '골방에 들어가기');
  await M.tap('#action-btn');
  await until(M, () => window.__WORLDS_DEBUG__.m3.closet === true);
  await sleep(1500);
  await M.screenshot({ path: resolve(shotDir, 'm3-closet-mobile.png') });
  const mFrame = await M.locator('.worship-frame').boundingBox();
  check('mobile 골방 worship screen >= 200x200', mFrame.width >= 200 && mFrame.height >= 200, `${Math.round(mFrame.width)}x${Math.round(mFrame.height)}`);

  step('same-day edit');
  // ---- M5.3: one QT per day: 묵상하기 in the 골방 opens today's mat meditation for editing
  await M.tap('#closet-meditate');
  await until(M, () => window.__WORLDS_DEBUG__.m3.modal === '묵상하기');
  await until(M, () => !!document.querySelector('.med-done'), null, 15000);
  const doneText = await M.textContent('.med-done');
  check('골방 묵상하기 shows the ✓ bar for today’s mat meditation', doneText.includes('오늘 기도의 뜰에서 묵상했어요') && (await M.isVisible('.med-new')), doneText);
  await M.tap('.med-foot .primary'); // 말씀 -> 묵상
  check('the saved meditation is prefilled', (await M.inputValue('#med-meditation')) === '목자 되신 주님');
  await M.tap('.med-foot .primary');
  await M.tap('.med-foot .primary');
  check('prefilled application too', (await M.inputValue('#med-application')) === '오늘 하루 조급해하지 않기');
  await M.fill('#med-application', '오늘 하루 조급해하지 않고 기다리기');
  check('save button reads 고친 묵상 담기 while editing', (await M.textContent('.med-save')).includes('고친 묵상 담기'));
  await M.tap('.med-save');
  await until(M, () => window.__WORLDS_DEBUG__.m3.lastSaved === '골방');
  const bookAfterEdit = await M.evaluate(async () => (await (await fetch('/api/wordbook')).json()).pages);
  const todayMeds = (pages) => pages.flatMap((pg) => pg.meditations ?? []);
  const medsEdit = todayMeds(bookAfterEdit);
  check('editing updates the one entry (no second entry)', medsEdit.length === 1 && medsEdit[0].application === '오늘 하루 조급해하지 않고 기다리기', `${medsEdit.length} entries`);
  // [새 묵상 쓰기] still adds a second entry.
  await M.tap('#closet-meditate');
  await until(M, () => !!document.querySelector('.med-new'), null, 15000);
  await M.tap('.med-new');
  await until(M, () => !document.querySelector('.med-done'));
  check('새 묵상 쓰기 starts blank', (await M.inputValue('#med-meditation')) === '');
  await M.fill('#med-meditation', '두 번째 묵상');
  await M.tap('.med-foot .primary');
  await M.fill('#med-feeling', '감사');
  await M.tap('.med-foot .primary');
  await M.fill('#med-application', '저녁에 다시 기도하기');
  check('new entry uses 말씀 책에 담기', (await M.textContent('.med-save')).includes('말씀 책에 담기'));
  await M.tap('.med-save');
  await until(M, () => window.__WORLDS_DEBUG__.m3.modal === null);
  const medsNew = todayMeds(await M.evaluate(async () => (await (await fetch('/api/wordbook')).json()).pages));
  check('새 묵상 쓰기 adds a second entry', medsNew.length === 2 && medsNew.some((m) => m.meditation === '두 번째 묵상'), `${medsNew.length} entries`);

  step('audio');
  // ---- audio: running after gestures, mute toggles
  const audioBefore = (await debug(A)).m3.audio;
  await A.click('#btn-settings');
  await until(A, () => window.__WORLDS_DEBUG__.m3.modal === '설정');
  await A.click('#vol-muted');
  await until(A, (m) => window.__WORLDS_DEBUG__.m3.audio.muted !== m, audioBefore.muted, 15000).catch(() => undefined);
  const audioAfter = (await debug(A)).m3.audio;
  const soundLabel = await A.isChecked('#vol-muted');
  await A.keyboard.press('Escape');
  check('ambient audio running after a gesture; mute toggles', audioBefore.running && audioAfter.muted !== audioBefore.muted, JSON.stringify({ before: audioBefore, afterMuted: audioAfter.muted, label: soundLabel }));

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
