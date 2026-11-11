// M5.1 test: anonymous public lanterns (익명으로 나누기).
// Ports: 5182 preview, 5183 server.
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/m51-test.mjs
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  check,
  currentStep,
  debug,
  desktop,
  dropDb,
  freshDb,
  launch,
  loginJoin,
  openBook,
  of,
  rawClient,
  serverDir,
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
const WS = `ws://127.0.0.1:${CLIENT_PORT}/ws`;
const Q = '?test=1&shadows=0&time=14:00&noguide=1&noworship=1';
const DAY = '2026-11-08';
const AUTHOR = '숨은작가';
const DB = freshDb('m51');
const Database = createRequire(resolve(serverDir, 'package.json'))('better-sqlite3');

class Agent {
  constructor() {
    this.jar = new Map();
  }
  cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async raw(method, path, body) {
    const res = await fetch(path.startsWith('http') ? path : BASE + path.replace(/^\//, ''), {
      method,
      redirect: 'manual',
      headers: { ...(this.jar.size ? { cookie: this.cookie() } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const v = pair.slice(i + 1);
      if (v) this.jar.set(pair.slice(0, i), v);
      else this.jar.delete(pair.slice(0, i));
    }
    return res;
  }
  async json(method, path, body) {
    const res = await this.raw(method, path, body);
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* none */
    }
    return { status: res.status, data };
  }
  async login(hint, nickname) {
    let url = `${BASE}api/auth/google/start?hint=${hint}&remember=1`;
    for (let i = 0; i < 6; i++) {
      const res = await this.raw('GET', url);
      const loc = res.headers.get('location');
      if (!loc || !loc.includes('/api/')) break;
      url = new URL(loc, url).toString();
    }
    await this.json('POST', '/api/me/nickname', { nickname, agree: true });
    this.me = (await this.json('GET', '/api/me')).data.user;
    return this;
  }
}

/**
 * Deep-scan any JSON for author-identifying data: the author's nickname, or
 * any user/author/owner id field (lantern data must carry none of these).
 */
function leaks(value, author, path = '$') {
  const found = [];
  if (typeof value === 'string') {
    if (value.includes(author.nickname)) found.push(`${path}: nickname`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => found.push(...leaks(v, author, `${path}[${i}]`)));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (/user|author|owner|sub|email/i.test(k)) found.push(`${path}.${k}: author-like key`);
      if (k === 'mine' && v === true) found.push(`${path}.mine: true`);
      found.push(...leaks(v, author, `${path}.${k}`));
    }
  }
  return found;
}

let browser;
const raws = [];
try {
  startServer(SERVER_PORT, DB, { WORLDS_AUTH_MOCK: '1', AUTH_RATE_LIMIT: '200' });
  await waitHttp(`http://127.0.0.1:${SERVER_PORT}/health`);
  startPreview(CLIENT_PORT, SERVER_PORT);
  await waitHttp(BASE);

  step('accounts');
  const author = await new Agent().login('anon-author', AUTHOR);
  const viewer = await new Agent().login('viewer', '보는이');
  await author.json('POST', '/api/groups', { name: '작은 모임' });
  const wsViewer = await rawClient(WS, { nickname: 'x', test: true }, { cookie: viewer.cookie() });
  const wsGuest = await rawClient(WS, { nickname: '손님', test: true });
  raws.push(wsViewer, wsGuest);

  // ---------------------------------------------------------------- share dialog (UI)
  step('share dialog');
  browser = await launch();
  const ctxA = await browser.newContext(desktop);
  const A = await ctxA.newPage();
  await A.goto(`${BASE}api/auth/google/start?remember=1&hint=anon-author`);
  await loginJoin(A, BASE, 'anon-author', AUTHOR, Q);
  await A.evaluate(async (day) => {
    await fetch('/api/wordbook/meditations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date: day, place: '골방', meditation: '익명으로 나누는 묵상', feeling: '평안', application: '' }) });
  }, DAY);
  await openBook(A, 'mine');
  // M10: opening 말씀 also files today's (real-date) word, so page back to DAY.
  await A.waitForSelector('.book-page');
  for (let i = 0; i < 10 && !(await A.$('.note-share')); i++) {
    if (await A.isDisabled('.book-nav button:last-child')) break;
    await A.click('.book-nav button:last-child');
  }
  await A.waitForSelector('.note-share');
  await A.click('.note-share');
  await A.waitForSelector('#share-anon');
  const visiblePublic = await A.isVisible('#share-anon');
  await A.check('#share-group');
  const hiddenGroup = !(await A.isVisible('#share-anon'));
  await A.check('#share-public');
  const backPublic = await A.isVisible('#share-anon');
  check('"익명으로 나누기" appears only for 공개 (hidden for 비공개 모임)', visiblePublic && hiddenGroup && backPublic);
  await A.check('#share-anon');
  await A.screenshot({ path: resolve(shotDir, 'm51-share-dialog-desktop.png') });
  await A.click('#share-submit');
  await A.waitForSelector('.note-unshare');
  await A.keyboard.press('Escape');

  // ---------------------------------------------------------------- what others receive
  step('others');
  await sleep(1000);
  const list = await viewer.json('GET', '/api/lanterns');
  const anonL = list.data.lanterns.find((l) => l.anonymous);
  const detail = await viewer.json('GET', `/api/lanterns/${anonL.id}`);
  const guestDetail = await new Agent().json('GET', `/api/lanterns/${anonL.id}`);
  check('others see "익명의 성도" (list, detail, guest)', anonL.nickname === '익명의 성도' && detail.data.nickname === '익명의 성도' && guestDetail.data.nickname === '익명의 성도' && !detail.data.mine);
  const react = await viewer.json('POST', `/api/lanterns/${anonL.id}/reactions`, { type: 'pray' });
  await viewer.json('POST', `/api/lanterns/${anonL.id}/reactions`, { type: 'amen' });
  await sleep(800);
  const pushes = [...wsViewer.inbox, ...wsGuest.inbox].filter((m) => m.t === 'lantern' || m.t === 'lanterns');
  const reactionPush = pushes.some((m) => m.t === 'lantern' && m.lantern.id === anonL.id && m.lantern.counts.pray === 1);
  const scanned = { list: list.data, detail: detail.data, guestDetail: guestDetail.data, react: react.data, pushes };
  const found = leaks(scanned, { nickname: AUTHOR });
  check(
    'deep scan: no author nickname or id/author fields in list, detail, WS new-lantern and reaction pushes',
    found.length === 0 && reactionPush && pushes.some((m) => m.t === 'lantern' && m.lantern.id === anonL.id),
    found.slice(0, 5).join(' | ') || `${pushes.length} pushes scanned`,
  );
  check('lantern data carries no user id at all', !JSON.stringify(scanned).includes(`"userId"`) && !JSON.stringify(scanned).includes(`"user_id"`));

  // 기록하기 snapshot
  step('record');
  await viewer.json('POST', `/api/lanterns/${anonL.id}/reactions`, { type: 'record' });
  const saved = (await viewer.json('GET', '/api/wordbook')).data.saved;
  const db = new Database(DB, { readonly: true });
  const rows = db.prepare('SELECT snapshot_json FROM saved_lanterns').all();
  db.close();
  check(
    '기록하기 snapshot is anonymous (API and stored JSON have no author nickname)',
    saved[0].nickname === '익명의 성도' && !JSON.stringify(saved).includes(AUTHOR) && rows.every((r) => !r.snapshot_json.includes(AUTHOR)),
    JSON.stringify(saved[0]).slice(0, 120),
  );

  // ---------------------------------------------------------------- author view
  step('author');
  const own = await author.json('GET', `/api/lanterns/${anonL.id}`);
  check('the author still sees it as theirs, with the prayer count', own.data.mine === true && own.data.anonymous === true && own.data.counts.pray === 1);
  await until(A, (id) => window.__WORLDS_DEBUG__.m4.lanterns.some((l) => l.id === id), anonL.id);
  const spot = (await debug(A)).m4.lanterns.find((l) => l.id === anonL.id);
  await teleport(A, { x: spot.x + 1.2, z: spot.z + 1.2 });
  await until(A, () => document.getElementById('action-btn').textContent.includes('등불'));
  await A.keyboard.press('KeyE');
  await until(A, () => window.__WORLDS_DEBUG__.m3.modal === '등불');
  const authorCard = await A.textContent('.lantern-card');
  check('author card: "내 등불 · 익명으로 나눴어요" with 등불 내리기', authorCard.includes('내 등불 · 익명으로 나눴어요') && (await A.isVisible('#lantern-remove')));
  await A.screenshot({ path: resolve(shotDir, 'm51-author-card-desktop.png') });
  await A.keyboard.press('Escape');

  // viewer in the world: name tag + card
  step('viewer world');
  const ctxV = await browser.newContext(desktop);
  const V = await ctxV.newPage();
  await loginJoin(V, BASE, 'viewer', '보는이', Q);
  await until(V, (id) => window.__WORLDS_DEBUG__.m4.lanterns.some((l) => l.id === id), anonL.id);
  const vSpot = (await debug(V)).m4.lanterns.find((l) => l.id === anonL.id);
  check('in the world the tag reads "익명의 등불"', vSpot.label === '익명의 등불' && vSpot.nickname === '익명의 성도');
  await teleport(V, { x: vSpot.x + 1.2, z: vSpot.z + 1.2 });
  await until(V, (id) => window.__WORLDS_DEBUG__.m4.nearLantern === id, anonL.id);
  await sleep(1200);
  await V.screenshot({ path: resolve(shotDir, 'm51-lantern-tag-desktop.png') });
  await V.keyboard.press('KeyE');
  await until(V, () => window.__WORLDS_DEBUG__.m3.modal === '등불');
  const vCard = await V.textContent('.lantern-card');
  check('viewer card says 익명의 등불 and never the author name', vCard.includes('익명의 등불') && !vCard.includes(AUTHOR) && !(await V.isVisible('#lantern-remove')));
  await V.screenshot({ path: resolve(shotDir, 'm51-lantern-card-anon-desktop.png') });
  await V.keyboard.press('Escape');
  const vDom = await V.evaluate(() => document.body.innerText + JSON.stringify(window.__WORLDS_DEBUG__.m4.lanterns));
  check('the viewer page holds no author name anywhere (DOM text + lantern data)', !vDom.includes(AUTHOR));

  // ---------------------------------------------------------------- non-anonymous unchanged
  step('named');
  const m2 = await author.json('POST', '/api/wordbook/meditations', { date: DAY, place: '골방', meditation: '이름으로 나누는 묵상' });
  const named = await author.json('POST', '/api/lanterns', { meditationId: m2.data.id, visibility: 'public' });
  const namedView = await viewer.json('GET', `/api/lanterns/${named.data.id}`);
  check('non-anonymous public lanterns are unchanged (author name shown)', namedView.data.nickname === AUTHOR && namedView.data.anonymous === false);
  const groupAnon = await author.json('POST', '/api/lanterns', {
    meditationId: (await author.json('POST', '/api/wordbook/meditations', { date: DAY, place: '골방', meditation: '모임용' })).data.id,
    visibility: 'group',
    groupId: (await author.json('GET', '/api/groups')).data.groups[0].id,
    anonymous: true,
  });
  check('anonymous is ignored for 비공개 (group) lanterns', groupAnon.status === 201 && groupAnon.data.anonymous === false);

  // take it down
  const down = await author.json('DELETE', `/api/lanterns/${anonL.id}`);
  await sleep(600);
  check('the author can take the anonymous lantern down; others are told', down.status === 200 && wsViewer.inbox.some((m) => m.t === 'lanternGone' && m.id === anonL.id));
} catch (err) {
  check('test run completed', false, `[step: ${currentStep()}] ${String(err).split('\n')[0]}`);
} finally {
  for (const r of raws) r.ws.close();
  await browser?.close();
  await stopAll();
  dropDb(DB);
}
process.exit(summary());
