// Shared helpers for the end-to-end scripts: processes, browsers, waits, entry flows.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const clientDir = resolve(here, '../..');
export const serverDir = resolve(here, '../../../server');
export const shotDir = resolve(here, '../../../docs/screenshots');
mkdirSync(shotDir, { recursive: true });
export const WebSocket = createRequire(resolve(serverDir, 'package.json'))('ws');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const results = [];
let stepName = 'setup';
export const step = (n) => {
  stepName = n;
  if (process.env.VERBOSE) console.log(`-- ${n}`);
};
export const currentStep = () => stepName;
export function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
export function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  return failed.length ? 1 : 0;
}

const children = [];
export function start(name, cmd, args, cwd, env = {}) {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', (d) => {
    const t = String(d);
    if (!/proxy (socket )?error|EPIPE|ECONNRESET|ECONNREFUSED|^\s+at /m.test(t)) process.stdout.write(`[${name}!] ${t}`);
  });
  children.push(child);
  return child;
}
export async function waitHttp(url, ms = 30000) {
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
export function stop(child) {
  return new Promise((r) => {
    if (child.exitCode !== null || child.signalCode) return r();
    child.once('exit', () => r());
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 3000);
  });
}
export async function stopAll() {
  for (const c of children) await stop(c);
}

/** A fresh, throwaway SQLite file for one test run (never the dev database). */
export function freshDb(name) {
  const dir = resolve(serverDir, 'data/test');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${name}.db`);
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  return path;
}
export function dropDb(path) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
}

/** Game server for tests: own DB, test mode, optional mock login. */
export function startServer(port, db, extra = {}) {
  return start(`server:${port}`, 'node', ['dist/server/src/index.js'], serverDir, {
    PORT: String(port),
    WORLDS_DB: db,
    WORLDS_TEST_MODE: '1',
    QUIET: '1',
    ...extra,
  });
}
export function startPreview(clientPort, serverPort) {
  return start('client', 'node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(clientPort), '--host', '127.0.0.1'], clientDir, {
    WORLDS_SERVER: `http://127.0.0.1:${serverPort}`,
  });
}

export function findChromium() {
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
export const launch = (extraArgs = []) =>
  chromium.launch({
    executablePath: findChromium(),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...extraArgs],
  });

export const desktop = { viewport: { width: 1280, height: 720 } };
export const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

export const debug = (page) => page.evaluate(() => window.__WORLDS_DEBUG__);
export const until = (page, fn, arg, ms = 30000) => page.waitForFunction(fn, arg, { timeout: ms, polling: 250 });
export const teleport = (page, p) => page.evaluate(({ x, z }) => window.__WORLDS_TEST__.teleport(x, z), p);
const online = (page) => until(page, () => window.__WORLDS_DEBUG__?.ready && window.__WORLDS_DEBUG__.net?.status === 'online', null, 60000);

/** Enter as a guest, or continue as the signed-in account if this browser has a session. */
export async function join(page, base, nickname, query) {
  await page.goto(base + query);
  await page.waitForSelector('#entry-signed-out:not([hidden]), #entry-signed-in:not([hidden]), #entry-nick:not([hidden])');
  if (await page.isVisible('#entry-continue')) {
    await page.click('#entry-continue');
  } else {
    await page.fill('#nickname', nickname);
    await page.click('#entry-submit');
  }
  await online(page);
}

/** Sign in through the mock OIDC provider (full redirect flow), set a nickname if asked, enter. */
export async function loginJoin(page, base, hint, nickname, query) {
  await page.goto(`${base}api/auth/google/start?remember=1&hint=${encodeURIComponent(hint)}`);
  await page.goto(base + query);
  await page.waitForSelector('#entry-signed-in:not([hidden]), #entry-nick:not([hidden])');
  if (await page.isVisible('#entry-nick')) {
    await page.fill('#account-nickname', nickname);
    await page.check('#nick-agree'); // M7: 만 14세 이상 + 약관 동의
    await page.click('#nick-submit');
  } else {
    await page.click('#entry-continue');
  }
  await online(page);
}

/** Minimal raw protocol client. */
export function rawClient(url, hello, headers = {}) {
  return new Promise((resolveClient, reject) => {
    const ws = new WebSocket(url, { headers });
    const inbox = [];
    const c = { ws, inbox, closed: null, send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)) };
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('close', (code) => (c.closed = code));
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.on('error', (e) => reject(e));
    ws.on('open', () => {
      if (hello) c.send({ t: 'hello', v: 1, ...hello });
      setTimeout(() => resolveClient(c), 400);
    });
  });
}
export const of = (c, t) => c.inbox.filter((m) => m.t === t);
