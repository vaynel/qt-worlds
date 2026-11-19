// 🏮 내 등불 반응 test: 🤲 기도하기 / 🙏 아멘 / 📌 기록하기 notify the lantern's author.
// Mock push (WORLDS_PUSH_MOCK=1, fake clock via /api/test/push/clock), a raw WS
// client for the online/hidden case and one browser for the visible toast and
// the live lantern counts.
// Port: TEST_SERVER_PORT (5199; the server serves the built client).
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/rx-test.mjs
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { check, clientDir, desktop, dropDb, freshDb, launch, loginJoin, of, rawClient, serverDir, sleep, startServer, step, stopAll, summary, until, waitHttp } from './lib/harness.mjs';

const PORT = Number(process.env.TEST_SERVER_PORT ?? 5199);
const BASE = `http://127.0.0.1:${PORT}/`;
const Q = '?test=1&shadows=0&time=14:00&noguide=1';
const DB = freshDb('rx');
const webpush = createRequire(resolve(serverDir, 'package.json'))('web-push');
const VAPID = webpush.generateVAPIDKeys(); // throwaway, test only
const PRAYER_TITLE = '🤲 누군가 당신의 묵상을 위해 기도하고 있어요';
const AMEN_TITLE = '🙏 누군가 당신의 묵상에 아멘했어요';
const RECORD_TITLE = '📌 누군가 당신의 묵상을 마음에 담아 두었어요';
const LANTERN_TITLE = '🏮 당신의 묵상이 누군가에게 닿았어요';

class Agent {
  constructor() {
    this.jar = new Map();
  }
  cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async raw(method, path, body) {
    const res = await fetch(BASE + path.replace(/^\//, ''), {
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
      const res = await this.raw('GET', url.replace(BASE, ''));
      const loc = res.headers.get('location');
      if (!loc || !loc.includes('/api/')) break;
      url = new URL(loc, url).toString();
    }
    const r = await this.json('POST', '/api/me/nickname', { nickname, agree: true });
    this.id = r.data?.user?.id;
    this.nickname = nickname;
    return this;
  }
  react(lantern, type) {
    return this.json('POST', `/api/lanterns/${lantern.id}/reactions`, { type });
  }
}

function fakeSub(tag) {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { endpoint: `https://push.test/${tag}/${randomBytes(4).toString('hex')}`, keys: { p256dh: raw.toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

const ctl = new Agent();
const sent = async () => (await ctl.json('GET', '/api/test/push/sent')).data.deliveries;
const setClock = (now) => ctl.json('POST', '/api/test/push/clock', { now });
const tick = async () => (await ctl.json('POST', '/api/test/push/tick', {})).data;
const seoulToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const MIN = 60_000;
const T0 = Date.parse(`${seoulToday()}T12:00:00+09:00`);
const at = (min) => setClock(T0 + min * MIN);
/** Reactions answer before the async push is done: give it a moment. */
const settle = () => sleep(200);

let browser;
try {
  startServer(PORT, DB, {
    WORLDS_AUTH_MOCK: '1',
    AUTH_RATE_LIMIT: '500',
    SERVE_CLIENT: '1',
    WORLDS_CLIENT_DIST: resolve(clientDir, 'dist'),
    WORLDS_PUSH_MOCK: '1',
    VAPID_PUBLIC_KEY: VAPID.publicKey,
    VAPID_PRIVATE_KEY: VAPID.privateKey,
    VAPID_SUBJECT: 'mailto:test@example.invalid',
  });
  await waitHttp(`${BASE}health`);

  step('setup');
  const owner = await new Agent().login('rx-owner', '등불주인');
  const people = [];
  for (const [i, n] of ['가나', '다라', '마바', '사아', '자차', '카타'].entries()) people.push(await new Agent().login(`rx-p${i}`, `반응${n}`));
  const [a, b, c, d, e, f] = people;
  await owner.json('POST', '/api/push/subscribe', { subscription: fakeSub('owner') });
  await a.json('POST', '/api/push/subscribe', { subscription: fakeSub('a') });
  const today = seoulToday();
  await owner.json('PUT', `/api/wordbook/pages/${today}`);
  const lantern = async (text, anonymous) => {
    const med = await owner.json('POST', '/api/wordbook/meditations', { date: today, place: '골방', meditation: text });
    return (await owner.json('POST', '/api/lanterns', { meditationId: med.data.id, visibility: 'public', anonymous })).data;
  };
  const named = await lantern('은밀한 묵상 문장 하나', false);
  const anon = await lantern('익명 묵상 문장 둘', true);
  check('two lanterns (one anonymous)', named?.id > 0 && anon?.id > 0);
  const prefs0 = (await owner.json('GET', '/api/push/prefs')).data;
  check('prefs: 기도하기 / 아멘 / 기록하기 all default on', prefs0.prayer === true && prefs0.amen === true && prefs0.record === true);
  const leaks = (list) => {
    const text = JSON.stringify(list.map((x) => x.payload));
    const bad = [owner.nickname, ...people.map((p) => p.nickname), '은밀한', '익명 묵상', named.ref, ...people.map((p) => `"${p.id}"`), `/${named.id}`, `/${anon.id}`, `=${named.id}`, `=${anon.id}`];
    return bad.filter((s) => s && text.includes(s));
  };

  step('아멘 and 기록 each send');
  await at(0);
  await a.react(named, 'amen');
  await settle();
  let all = await sent();
  check('🙏 아멘 notifies the author right away', all.length === 1 && all[0].userId === owner.id && all[0].payload.kind === 'amen' && all[0].payload.title === AMEN_TITLE, JSON.stringify(all.map((x) => x.payload.title)));
  await at(16);
  await b.react(anon, 'record');
  await settle();
  all = await sent();
  check('📌 기록하기 on an anonymous lantern notifies the author', all.length === 2 && all[1].userId === owner.id && all[1].payload.kind === 'record' && all[1].payload.title === RECORD_TITLE);
  const saved = await b.json('GET', `/api/lanterns/${anon.id}`);
  check('the anonymous lantern stays anonymous to the one who recorded it', saved.data && saved.data.nickname !== owner.nickname);

  step('mixed burst');
  await at(32);
  await c.react(named, 'amen'); // window open: sent at once
  await b.react(named, 'pray');
  await c.react(named, 'record');
  await a.react(anon, 'record');
  await d.react(anon, 'amen');
  await c.react(named, 'amen'); // toggle off …
  await c.react(named, 'amen'); // … and on: not counted again
  await owner.react(named, 'amen'); // my own lantern: never
  await owner.react(anon, 'pray');
  await settle();
  const burst = (await sent()).slice(2);
  check('a burst sends exactly one push at once', burst.length === 1 && burst[0].payload.title === AMEN_TITLE, String(burst.length));
  await at(40);
  await tick();
  check('a second burst inside 15 minutes is held', (await sent()).length === 3);
  await at(47);
  await tick();
  all = await sent();
  const merged = all[3];
  check(
    'after the window: one combined push (toggle and own reactions not counted)',
    all.length === 4 && merged.payload.kind === 'lantern' && merged.payload.title === LANTERN_TITLE && merged.payload.body === '🤲 기도 1 · 🙏 아멘 1 · 📌 기록 2',
    merged?.payload.body,
  );
  check('every push went to the author only', all.every((x) => x.userId === owner.id));
  check('payloads carry no nickname, id or lantern text', leaks(all).length === 0 && all.every((x) => Object.keys(x.payload).sort().join() === 'body,kind,tag,title,url' && x.payload.url === '/'), leaks(all).join());
  await at(80);
  await tick();
  check('nothing pending: no further push', (await sent()).length === 4);

  step('prefs per kind');
  await owner.json('PUT', '/api/push/prefs', { amen: false });
  await at(100);
  await e.react(named, 'amen');
  await settle();
  check('아멘 off: no push', (await sent()).length === 4);
  await e.react(named, 'record');
  await settle();
  all = await sent();
  check('기록 still on: pushed', all.length === 5 && all[4].payload.kind === 'record');
  await owner.json('PUT', '/api/push/prefs', { record: false, prayer: false });
  await at(120);
  await f.react(named, 'record');
  await f.react(named, 'pray');
  await f.react(anon, 'amen');
  await settle();
  await at(140);
  await tick();
  check('all three off: nothing at all', (await sent()).length === 5);
  const prefs1 = (await owner.json('GET', '/api/push/prefs')).data;
  check('prefs persist per kind', prefs1.prayer === false && prefs1.amen === false && prefs1.record === false);
  const exp = (await owner.json('GET', '/api/me/export')).data;
  const expPrefs = JSON.stringify(exp ?? {});
  check('the export includes the 아멘 / 기록 prefs', /"amen":false/.test(expPrefs) && /"record":false/.test(expPrefs));
  await owner.json('PUT', '/api/push/prefs', { record: true, prayer: true, amen: true });

  step('online toast');
  const ws = await rawClient(`ws://127.0.0.1:${PORT}/ws`, { nickname: owner.nickname }, { cookie: owner.cookie(), origin: BASE.slice(0, -1) });
  await sleep(300);
  check('owner connected over WS', of(ws, 'welcome').length === 1);
  await at(200);
  await a.react(named, 'pray');
  await settle();
  const notices = of(ws, 'lanternNotice');
  all = await sent();
  check('online, page not visible: a toast and a push', notices.length === 1 && notices[0].text === PRAYER_TITLE && all.length === 6 && all[5].payload.kind === 'prayer', JSON.stringify(notices));
  ws.send({ t: 'visible', visible: true });
  await sleep(150);
  await at(220);
  await b.react(anon, 'amen');
  await settle();
  check('a visible page: the toast only, no push', of(ws, 'lanternNotice').length === 2 && of(ws, 'lanternNotice')[1].text === AMEN_TITLE && (await sent()).length === 6);
  check('toasts carry no names', !JSON.stringify(of(ws, 'lanternNotice')).match(/반응|등불주인|은밀한/));
  ws.ws.close();

  step('browser toast and live counts');
  browser = await launch();
  const page = await (await browser.newContext(desktop)).newPage();
  await loginJoin(page, BASE, 'rx-owner', owner.nickname, Q);
  await sleep(500);
  await at(240);
  await d.react(named, 'record');
  await until(page, () => !document.getElementById('toast')?.hidden && document.getElementById('toast')?.textContent?.includes('📌'), null, 15000);
  check('the in-app toast shows the fixed text', (await page.textContent('#toast')) === RECORD_TITLE);
  check('visible browser: no push for it', (await sent()).length === 6);
  const id = named.id;
  await until(page, (lid) => window.__WORLDS_DEBUG__.m4.lanterns?.find((l) => l.id === lid)?.counts?.record >= 1, id, 15000);
  const before = (await page.evaluate((lid) => window.__WORLDS_DEBUG__.m4.lanterns.find((l) => l.id === lid).counts, id)).amen;
  await f.react(named, 'amen'); // window held: no toast yet, but the count moves live
  await until(page, ([lid, n]) => window.__WORLDS_DEBUG__.m4.lanterns.find((l) => l.id === lid).counts.amen === n + 1, [id, before], 15000);
  check('lantern counts update live', true);
  await page.evaluate(() => document.getElementById('toast').hidden = true);
  await at(256);
  await tick();
  await until(page, () => !document.getElementById('toast')?.hidden, null, 15000);
  check('the held reaction arrives as a toast after the window', (await page.textContent('#toast')) === AMEN_TITLE && (await sent()).length === 6);
  await setClock(null);
} catch (err) {
  check(`unexpected error: ${err.message}`, false);
  console.error(err);
} finally {
  await browser?.close().catch(() => {});
  await stopAll();
  dropDb(DB);
}
process.exit(summary());
