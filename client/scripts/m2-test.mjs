// M2 multiplayer end-to-end test.
// Starts its own server (port 5181) and client preview (port 5182), drives three
// headless browser contexts plus raw WebSocket clients, then shuts everything down.
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/m2-test.mjs
import { chromium } from '@playwright/test';
import { dropDb, freshDb } from './lib/harness.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
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

// Own ports so a live dev setup (5180/5181) is never touched.
const SERVER_PORT = Number(process.env.TEST_SERVER_PORT ?? 5183);
const CLIENT_PORT = Number(process.env.TEST_CLIENT_PORT ?? 5182);
const BASE = `http://127.0.0.1:${CLIENT_PORT}/`;
const WS_URL = `ws://127.0.0.1:${SERVER_PORT}/ws`;
const QUERY = '?test=1&shadows=0&time=14:00&noguide=1';

const GARDEN = { x: -52, z: -16 };
const mat = (i) => {
  const a = (i / 8) * Math.PI * 2;
  return { x: GARDEN.x + Math.cos(a) * 5.2, z: GARDEN.z + Math.sin(a) * 5.2 };
};
const CAMPFIRE = { x: 50, z: -12 };

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ processes

const children = [];
function start(name, cmd, args, cwd, env = {}) {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`[${name}!] ${d}`));
  children.push(child);
  return child;
}
async function waitHttp(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not yet */
    }
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${url}`);
}
// Throwaway DB; test mode lets ?test=1 clients and test raw clients teleport.
const DB = freshDb('m2');
const startServer = () =>
  start('server', 'node', ['dist/server/src/index.js'], serverDir, { PORT: String(SERVER_PORT), MAX_PLAYERS: '50', WORLDS_DB: DB, WORLDS_TEST_MODE: '1' });
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

// ------------------------------------------------------------------ helpers

const debug = (page) => page.evaluate(() => window.__WORLDS_DEBUG__);
async function until(page, fn, arg, ms = 30000) {
  await page.waitForFunction(fn, arg, { timeout: ms, polling: 250 });
}
async function join(page, nickname) {
  await page.goto(BASE + QUERY);
  await page.fill('#nickname', nickname);
  await page.click('#entry-submit');
  await until(page, () => window.__WORLDS_DEBUG__?.ready && window.__WORLDS_DEBUG__.net?.status === 'online', null, 60000);
}
const teleport = (page, p) => page.evaluate(({ x, z }) => window.__WORLDS_TEST__.teleport(x, z), p);

/** Minimal raw protocol client for abuse/validation checks. */
function rawClient(nickname) {
  return new Promise((resolveClient, reject) => {
    const ws = new WebSocket(WS_URL);
    const inbox = [];
    const c = { ws, inbox, closed: null, send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)) };
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('close', (code) => (c.closed = code));
    ws.on('error', reject);
    ws.on('open', () => {
      c.send({ t: 'hello', v: 1, nickname, test: true });
      setTimeout(() => resolveClient(c), 400);
    });
  });
}
const of = (c, t) => c.inbox.filter((m) => m.t === t);

// ------------------------------------------------------------------ run

let browser;
let server;
try {
  server = startServer();
  await waitHttp(`http://127.0.0.1:${SERVER_PORT}/health`);
  start('client', 'node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(CLIENT_PORT), '--host', '127.0.0.1'], clientDir, {
    WORLDS_SERVER: `http://127.0.0.1:${SERVER_PORT}`,
  });
  await waitHttp(BASE);

  browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const desktop = { viewport: { width: 1280, height: 720 } };
  const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const ctxA = await browser.newContext(desktop);
  const ctxB = await browser.newContext(desktop);
  const ctxC = await browser.newContext(mobile);
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  const C = await ctxC.newPage();
  const pageErrors = [];
  for (const [n, p] of [['A', A], ['B', B], ['C', C]]) {
    p.on('pageerror', (e) => pageErrors.push(`${n}: ${e}`));
    p.on('console', (m) => m.type() === 'error' && pageErrors.push(`${n} console: ${m.text()}`));
  }

  // --- entry screen validation
  await A.goto(BASE + QUERY);
  await A.click('#entry-submit');
  const emptyMsg = await A.textContent('#entry-status');
  check('entry rejects empty nickname', /1~12/.test(emptyMsg), emptyMsg);
  await A.fill('#nickname', '가나다라마바사아자차카타파');
  await A.click('#entry-submit');
  const longMsg = await A.textContent('#entry-status');
  check('entry rejects 13-char nickname', /1~12/.test(longMsg), longMsg);
  await A.fill('#nickname', '  은혜  ');
  await A.screenshot({ path: resolve(shotDir, 'm2-entry-desktop.png') });
  await C.goto(BASE + QUERY);
  await C.fill('#nickname', '은혜');
  await C.screenshot({ path: resolve(shotDir, 'm2-entry-mobile.png') });

  // --- presence + duplicate names
  await A.click('#entry-submit');
  await until(A, () => window.__WORLDS_DEBUG__?.net?.status === 'online', null, 60000);
  await join(B, '소망');
  await C.click('#entry-submit');
  await until(C, () => window.__WORLDS_DEBUG__?.net?.status === 'online', null, 60000);
  await until(A, () => window.__WORLDS_DEBUG__.net.remotes.filter((r) => r.visible).length === 2);
  const a0 = await debug(A);
  const names = a0.net.remotes.map((r) => r.name).sort();
  check('A sees B and C', a0.net.remotes.length === 2, names.join(', '));
  check('duplicate nickname shown distinctly', a0.net.name === '은혜' && names.includes('은혜 (2)'), `A=${a0.net.name}, others=${names}`);
  const idB = (await debug(B)).net.id;
  const idA = a0.net.id;

  // --- movement with real keyboard input
  const before = a0.net.remotes.find((r) => r.id === idB);
  await B.bringToFront();
  await B.keyboard.down('KeyW');
  await sleep(2500);
  await B.keyboard.up('KeyW');
  const bSelf = (await debug(B)).player;
  await until(A, ({ id, z }) => {
    const r = window.__WORLDS_DEBUG__.net.remotes.find((p) => p.id === id);
    return r && Math.abs(r.z - z) > 1;
  }, { id: idB, z: before.z });
  const after = (await debug(A)).net.remotes.find((r) => r.id === idB);
  check('A sees B walk (keyboard W)', Math.abs(after.z - before.z) > 1, `B self z=${bSelf.z}, A sees z ${before.z} -> ${after.z}`);

  // --- campfire chat
  await teleport(A, { x: CAMPFIRE.x - 2, z: CAMPFIRE.z + 6 });
  await teleport(B, { x: CAMPFIRE.x + 3, z: CAMPFIRE.z + 1 });
  await until(A, () => window.__WORLDS_DEBUG__.net.chatVisible);
  await until(B, () => window.__WORLDS_DEBUG__.net.chatVisible);
  check('chat panel hidden away from campfire (C at plaza)', !(await debug(C)).net.chatVisible);

  const far = await rawClient('멀리');
  far.send({ t: 'state', x: 0, y: 2.5, z: 8, yaw: 0, speed: 0 });
  await sleep(300);
  far.send({ t: 'chat', text: '여기서도 들리나요?' });
  await sleep(500);
  check('server refuses chat from outside the campfire', of(far, 'error').some((e) => e.code === 'not_near'));

  const hello = '안녕하세요 <b>모닥불</b> & <img src=x onerror=alert(1)>';
  await A.fill('#chat-input', hello);
  await A.press('#chat-input', 'Enter');
  await until(B, (t) => window.__WORLDS_DEBUG__.net.chatLog.some((l) => l.includes(t)), '모닥불');
  check('B (near fire) receives A chat', true);
  await sleep(1500);
  const cLog = (await debug(C)).net.chatLog;
  check('C (at plaza) does not receive campfire chat', cLog.length === 0, `C log=${cLog.length}`);
  check('raw far client does not receive campfire chat', of(far, 'chat').length === 0);
  const injected = await B.evaluate(() => document.querySelectorAll('#chat-log b, #chat-log img').length);
  const shown = await B.evaluate(() => document.querySelector('#chat-log li:last-child')?.textContent ?? '');
  check('chat text rendered as plain text (no HTML injection)', injected === 0 && shown.includes('<b>'), shown);

  // Raw client joins the fire: hears others, gets rate limited, long text capped.
  far.send({ t: 'state', x: CAMPFIRE.x, y: 3, z: CAMPFIRE.z + 3, yaw: 0, speed: 0 });
  await sleep(300);
  await B.fill('#chat-input', '반가워요');
  await B.press('#chat-input', 'Enter');
  await sleep(1500);
  check('raw client inside radius hears chat', of(far, 'chat').some((m) => m.text === '반가워요'));
  const echoedBefore = of(far, 'chat').filter((m) => m.name === far.inbox[0].name).length;
  for (let i = 0; i < 8; i++) far.send({ t: 'chat', text: `spam ${i}` });
  await sleep(800);
  const spamEcho = of(far, 'chat').filter((m) => m.text.startsWith('spam')).length;
  check('chat rate limit (8 sent quickly)', spamEcho <= 3 && of(far, 'error').some((e) => e.code === 'rate_limited'), `delivered=${spamEcho}, own before=${echoedBefore}`);
  await sleep(2200);
  far.send({ t: 'chat', text: '가'.repeat(400) });
  await sleep(500);
  const longEcho = of(far, 'chat').find((m) => m.text.startsWith('가가'));
  check('chat capped at 200 chars', longEcho && [...longEcho.text].length === 200, `len=${longEcho && [...longEcho.text].length}`);
  far.send('{"t":"state","x":"NaN","y":0}');
  far.send('not json');
  far.send({ t: 'sit', mat: 99 });
  await sleep(400);
  check('malformed messages rejected', of(far, 'error').some((e) => e.code === 'bad_message') && far.closed === null);
  far.send('x'.repeat(20000)); // above MAX_FRAME_BYTES (16 KB)
  await sleep(500);
  check('oversized frame closes the socket', far.closed !== null, `close code=${far.closed}`);

  const badNick = await rawClient('');
  await sleep(300);
  check('server rejects empty nickname', of(badNick, 'error').some((e) => e.code === 'bad_nickname') && badNick.closed !== null);
  const sneaky = await rawClient('   ');
  check('server rejects whitespace nickname', of(sneaky, 'error').some((e) => e.code === 'bad_nickname'));

  // Screens: A sees B's bubble; mobile C joins the fire to show the panel.
  await sleep(800);
  await A.fill('#chat-input', '오늘 말씀 함께 나눠요');
  await A.press('#chat-input', 'Enter');
  await until(A, () => window.__WORLDS_DEBUG__.net.chatLog.length >= 3);
  await B.fill('#chat-input', '좋아요, 모닥불 곁으로 오세요');
  await B.press('#chat-input', 'Enter');
  await sleep(1500);
  await A.screenshot({ path: resolve(shotDir, 'm2-campfire-chat-desktop.png') });
  await teleport(C, { x: CAMPFIRE.x + 1, z: CAMPFIRE.z + 7 });
  await until(C, () => window.__WORLDS_DEBUG__.net.chatVisible);
  await C.fill('#chat-input', '저도 왔어요');
  await C.press('#chat-input', 'Enter');
  await until(B, () => window.__WORLDS_DEBUG__.net.chatLog.some((l) => l.includes('저도 왔어요')));
  await sleep(1200);
  await C.screenshot({ path: resolve(shotDir, 'm2-campfire-chat-mobile.png') });
  check('mobile C chats once inside the circle', true);

  // --- prayer mats
  const m0 = mat(0);
  await teleport(A, { x: m0.x + 0.6, z: m0.z });
  await until(A, () => !document.getElementById('action-btn').hidden);
  const label = await A.textContent('#action-btn');
  await A.bringToFront();
  await A.keyboard.press('KeyE');
  await until(B, (id) => window.__WORLDS_DEBUG__.net.mats[0] === id, idA);
  await until(B, (id) => window.__WORLDS_DEBUG__.net.remotes.find((r) => r.id === id)?.seat === 0, idA);
  check('A sits with E; B sees mat 0 taken and A seated', true, `button="${label}"`);
  const thief = await rawClient('자리욕심');
  thief.send({ t: 'state', x: m0.x, y: 3, z: m0.z, yaw: 0, speed: 0 });
  await sleep(300);
  thief.send({ t: 'sit', mat: 0 });
  await sleep(500);
  check('second person cannot take an occupied mat', of(thief, 'error').some((e) => e.code === 'mat_taken'));
  thief.ws.close();

  const m1 = mat(1);
  await teleport(B, { x: m1.x, z: m1.z + 0.5 });
  await until(B, () => !document.getElementById('action-btn').hidden);
  await B.click('#action-btn');
  await until(A, (id) => window.__WORLDS_DEBUG__.net.mats[1] === id, idB);
  check('B sits via the on-screen button; A sees it', true);
  // Mobile: stand next to free mat 2, facing the two seated players.
  const m2 = mat(2);
  await teleport(C, { x: m2.x + 0.4, z: m2.z + 0.9 });
  await until(C, () => !document.getElementById('action-btn').hidden);
  await sleep(2500);
  await C.screenshot({ path: resolve(shotDir, 'm2-prayer-garden-mobile.png') });
  check('mobile shows the sit button next to a free mat', (await C.textContent('#action-btn')) === '자리에 앉기');
  await teleport(C, { x: GARDEN.x + 1, z: GARDEN.z + 15 });
  await sleep(1500);

  // B stands up by walking; A's mat stays.
  await B.bringToFront();
  await B.keyboard.down('KeyS');
  await sleep(800);
  await B.keyboard.up('KeyS');
  await until(A, () => window.__WORLDS_DEBUG__.net.mats[1] === null);
  check('moving stands up and frees the mat', true);

  // Viewer screenshot of A praying (from B, standing nearby).
  await teleport(B, { x: m0.x + 2.5, z: m0.z + 4 });
  await sleep(2500);
  await B.screenshot({ path: resolve(shotDir, 'm2-prayer-garden-desktop.png') });

  await A.bringToFront();
  await A.keyboard.press('KeyE');
  await until(B, () => window.__WORLDS_DEBUG__.net.mats[0] === null);
  check('A stands with E; mat freed for B', true);
  await A.keyboard.press('KeyE');
  await until(B, (id) => window.__WORLDS_DEBUG__.net.mats[0] === id, idA);

  // --- disconnect cleanup
  await ctxA.close();
  await until(B, (id) => !window.__WORLDS_DEBUG__.net.remotes.some((r) => r.id === id) && window.__WORLDS_DEBUG__.net.mats[0] === null, idA);
  check('closing A removes A and frees its mat', true);

  // --- reconnect after a server restart
  await stop(server);
  await until(B, () => window.__WORLDS_DEBUG__.net.status === 'reconnecting', null, 20000);
  const statusText = await B.textContent('#net-status');
  check('B notices the outage', true, statusText);
  server = startServer();
  await waitHttp(`http://127.0.0.1:${SERVER_PORT}/health`);
  await until(B, () => window.__WORLDS_DEBUG__.net.status === 'online', null, 30000);
  await until(C, () => window.__WORLDS_DEBUG__.net.status === 'online', null, 30000);
  await until(B, () => window.__WORLDS_DEBUG__.net.remotes.length === 1 && window.__WORLDS_DEBUG__.net.remotes[0].visible, null, 30000);
  check('B and C reconnect and see each other again', true, (await debug(B)).net.remotes.map((r) => r.name).join(','));

  // Expected noise: failed socket handshakes during the outage.
  const unexpected = pageErrors.filter((e) => !/WebSocket connection to .* failed/.test(e));
  check('no unexpected page errors', unexpected.length === 0, unexpected.slice(0, 3).join(' | ') || `${pageErrors.length} expected ws errors during outage`);
} catch (err) {
  check('test run completed', false, String(err).split('\n')[0]);
} finally {
  await browser?.close();
  for (const c of children) await stop(c);
  dropDb(DB);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
