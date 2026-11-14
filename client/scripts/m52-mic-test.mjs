// M5.2 mic test: ask at most once per page session, check permission first,
// 🎤 calls the browser prompt directly; device help only after a refusal; listen-only never asks.
// Ports: 5182 preview, 5183 server.
import { resolve } from 'node:path';
import {
  check,
  currentStep,
  desktop,
  dropDb,
  freshDb,
  launch,
  loginJoin,
  shotDir,
  sleep,
  startPreview,
  startServer,
  step,
  stopAll,
  summary,
  until,
  waitHttp,
} from './lib/harness.mjs';

const BASE = 'http://127.0.0.1:5182/';
const Q = '?test=1&shadows=0&time=14:00&noguide=1';
const DB = freshDb('m52-mic');

/** Count getUserMedia calls and fake navigator.permissions for 'microphone'. */
async function contextWith(browser, state) {
  const ctx = await browser.newContext(desktop);
  await ctx.addInitScript((st) => {
    window.__gum = 0;
    const md = navigator.mediaDevices;
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = (c) => {
      window.__gum++;
      if (st === 'denied') return Promise.reject(new DOMException('denied', 'NotAllowedError'));
      return orig(c);
    };
    const q = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (d) => (d && d.name === 'microphone' ? Promise.resolve({ state: st }) : q(d));
  }, state);
  return ctx;
}
const gum = (p) => p.evaluate(() => window.__gum);
const voice = (p) => p.evaluate(() => window.__WORLDS_DEBUG__.m4.voice);
async function setup(p, hint, nick) {
  await loginJoin(p, BASE, hint, nick, Q);
  const g = await p.evaluate(async () => (await (await fetch('/api/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '마이크' }) })).json()).id);
  await p.evaluate((id) => window.__WORLDS_TEST__.voiceJoin(id), g);
  await until(p, () => window.__WORLDS_DEBUG__.m4.voice?.state === 'in', null, 20000);
  return g;
}

let browser;
try {
  startServer(5183, DB, { WORLDS_AUTH_MOCK: '1', AUTH_RATE_LIMIT: '200' });
  await waitHttp('http://127.0.0.1:5183/health');
  startPreview(5182, 5183);
  await waitHttp(BASE);
  browser = await launch(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']);

  step('granted');
  const G = await (await contextWith(browser, 'granted')).newPage();
  const g = await setup(G, 'mic-granted', '허용됨');
  await sleep(800);
  check('joining (listen-only) makes 0 getUserMedia calls', (await gum(G)) === 0);
  await G.click('#voice-mic');
  await until(G, () => window.__WORLDS_DEBUG__.m4.voice.muted === false);
  check('granted: 🎤 unmutes straight away (no extra UI)', (await G.evaluate(() => window.__WORLDS_DEBUG__.m3.modal)) === null && (await gum(G)) === 1);
  for (let i = 0; i < 3; i++) {
    await G.click('#voice-mic');
    await until(G, () => window.__WORLDS_DEBUG__.m4.voice.muted === true);
    await G.click('#voice-mic');
    await until(G, () => window.__WORLDS_DEBUG__.m4.voice.muted === false);
  }
  check('3 mute/unmute cycles: still exactly 1 getUserMedia call', (await gum(G)) === 1);
  await G.evaluate(() => window.__WORLDS_TEST__.voiceLeave());
  await until(G, () => window.__WORLDS_DEBUG__.m4.voice.state === 'idle');
  const kept = await voice(G);
  await G.evaluate((id) => window.__WORLDS_TEST__.voiceJoin(id), g);
  await until(G, () => window.__WORLDS_DEBUG__.m4.voice.state === 'in');
  await G.click('#voice-mic');
  await until(G, () => window.__WORLDS_DEBUG__.m4.voice.muted === false);
  check('leave + rejoin + unmute: the kept mic is reused (still 1 call)', kept.micTracks[0] === 'live' && !kept.micEnabled && (await gum(G)) === 1);
  await G.evaluate(() => window.__WORLDS_TEST__.dropSocket());
  await until(G, () => window.__WORLDS_DEBUG__.net.status === 'online' && window.__WORLDS_DEBUG__.m4.voice.state === 'in', null, 30000);
  await until(G, () => window.__WORLDS_DEBUG__.m4.voice.muted === false, null, 10000);
  check('WS reconnect: rejoins and restores "unmuted" without asking again (still 1 call)', (await gum(G)) === 1);

  step('prompt');
  const P = await (await contextWith(browser, 'prompt')).newPage();
  await setup(P, 'mic-prompt', '물어봄');
  await P.click('#voice-mic');
  await until(P, () => window.__WORLDS_DEBUG__.m4.voice.muted === false);
  check('prompt state: 🎤 goes straight to the browser prompt (no pre-prompt), 1 request, unmuted', (await gum(P)) === 1 && !(await P.isVisible('#mic-allow')));

  step('denied');
  const D = await (await contextWith(browser, 'denied')).newPage();
  await setup(D, 'mic-denied', '거부됨');
  await D.click('#voice-mic');
  await until(D, () => window.__WORLDS_DEBUG__.m3.modal === '마이크');
  const help = await D.textContent('.mic-sheet');
  check('denied: browser refused → device-specific help with 다시 시도', (await D.isVisible('#mic-retry')) && help.includes('PC (Chrome · Edge)') && (await gum(D)) === 1, help.slice(0, 80));
  await D.screenshot({ path: resolve(shotDir, 'm52-mic-denied-desktop.png') });
  await D.keyboard.press('Escape');
  check('still in the room, listening, muted', (await voice(D)).state === 'in' && (await voice(D)).muted);
} catch (err) {
  check('test run completed', false, `[step: ${currentStep()}] ${String(err).split('\n')[0]}`);
} finally {
  await browser?.close();
  await stopAll();
  dropDb(DB);
}
process.exit(summary());
