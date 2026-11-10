// M6 test: PWA (service worker, install UI, manifest) and Web Push (API, scheduler, prayers).
// The Node server serves the production build itself (SERVE_CLIENT=1), like live.
// Push delivery is mocked inside the server (WORLDS_PUSH_MOCK=1: real encryption,
// nothing leaves the process); VAPID keys are throwaway ones generated here.
// Ports: 5186 server (+ a second build served on the same port to simulate a deploy).
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/m6-test.mjs
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  check,
  clientDir,
  currentStep,
  desktop,
  dropDb,
  freshDb,
  join,
  launch,
  loginJoin,
  mobile,
  serverDir,
  shotDir,
  sleep,
  startServer,
  step,
  stop,
  stopAll,
  summary,
  until,
  waitHttp,
} from './lib/harness.mjs';

const PORT = 5186;
const BASE = `http://127.0.0.1:${PORT}/`;
const Q = '?test=1&shadows=0&time=14:00&noguide=1&noworship=1';
const DB = freshDb('m6');
const DIST_A = resolve(clientDir, 'dist');
const DIST_B = resolve(serverDir, 'data/test/m6-dist-b');
const webpush = createRequire(resolve(serverDir, 'package.json'))('web-push');
const VAPID = webpush.generateVAPIDKeys(); // throwaway, test only
const DAILY_TITLE = '🕊️ 오늘의 말씀이 도착했어요';
const PRAYER_TITLE = '🤲 누군가 당신의 묵상을 위해 기도하고 있어요';
const shot = (page, name) => page.screenshot({ path: resolve(shotDir, `m6-${name}.png`) });

const serverEnv = (dist) => ({
  WORLDS_AUTH_MOCK: '1',
  AUTH_RATE_LIMIT: '500',
  SERVE_CLIENT: '1',
  WORLDS_CLIENT_DIST: dist,
  WORLDS_PUSH_MOCK: '1',
  VAPID_PUBLIC_KEY: VAPID.publicKey,
  VAPID_PRIVATE_KEY: VAPID.privateKey,
  VAPID_SUBJECT: 'mailto:test@example.invalid',
});

/** Minimal cookie-keeping HTTP client (a "device"). */
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
    const r = await this.json('POST', '/api/me/nickname', { nickname, agree: true });
    this.id = r.data?.user?.id;
    this.nickname = nickname;
    return this;
  }
}

/** A browser-like subscription: a real P-256 public key and a 16-byte auth secret. */
let subN = 0;
function fakeSub(tag = 'dev') {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { endpoint: `https://push.test/${tag}/${++subN}`, keys: { p256dh: raw.toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

const admin = new Agent();
const sent = async () => (await admin.json('GET', '/api/test/push/sent')).data.deliveries;
const resetSent = () => admin.json('POST', '/api/test/push/reset', {});
const setClock = (now) => admin.json('POST', '/api/test/push/clock', { now });
const tick = async () => (await admin.json('POST', '/api/test/push/tick', {})).data;
/** ms for a KST wall time. */
const kst = (date, hm) => Date.parse(`${date}T${hm}:00+09:00`);
const seoulToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());

function pngSize(buf) {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** Page stubs: Notification + PushManager (headless Chromium can't subscribe for real). */
const PUSH_STUB = () => {
  window.__perm = 'default';
  window.__sub = null;
  Object.defineProperty(Notification, 'permission', { get: () => window.__perm, configurable: true });
  Notification.requestPermission = async () => {
    window.__permAsked = (window.__permAsked ?? 0) + 1;
    if (window.__perm === 'default') window.__perm = window.__answer ?? 'granted';
    return window.__perm;
  };
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  PushManager.prototype.getSubscription = async function () {
    return window.__sub;
  };
  PushManager.prototype.subscribe = async function (opts) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const endpoint = `https://push.test/browser/${Math.random().toString(36).slice(2)}`;
    const json = { endpoint, expirationTime: null, keys: { p256dh: b64(raw), auth: b64(auth) } };
    window.__sub = {
      endpoint,
      options: { applicationServerKey: opts.applicationServerKey.buffer ?? opts.applicationServerKey, userVisibleOnly: true },
      toJSON: () => json,
      unsubscribe: async () => {
        window.__sub = null;
        return true;
      },
    };
    return window.__sub;
  };
};

/** A fake beforeinstallprompt (Chromium only fires the real one for real installability + engagement). */
const BIP_STUB = () => {
  addEventListener('load', () =>
    setTimeout(() => {
      const e = new Event('beforeinstallprompt', { cancelable: true });
      e.prompt = async () => {
        window.__bipPrompted = true;
      };
      e.userChoice = Promise.resolve({ outcome: 'dismissed' });
      dispatchEvent(e);
    }, 300),
  );
};

const STANDALONE_STUB = () => {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (q) => {
    if (/display-mode:\s*standalone/.test(q)) return { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false };
    return real(q);
  };
};

const openSettings = async (page) => {
  await page.click('#btn-settings');
  await page.waitForSelector('.settings-body');
};
const closeSettings = (page) => page.keyboard.press('Escape');

let browser;
let server;
try {
  // ---------------------------------------------------------------- builds
  step('second build');
  const swA = readFileSync(resolve(DIST_A, 'sw.js'), 'utf-8');
  rmSync(DIST_B, { recursive: true, force: true });
  execFileSync('node', ['node_modules/vite/bin/vite.js', 'build', '--outDir', DIST_B, '--emptyOutDir', '--logLevel', 'warn'], {
    cwd: clientDir,
    env: { ...process.env, WORLDS_BUILD_TAG: `m6b-${Date.now()}` },
  });
  const swB = readFileSync(resolve(DIST_B, 'sw.js'), 'utf-8');
  const version = (s) => /SW_VERSION = "([0-9a-f]+)"/.exec(s)?.[1];
  const precacheA = JSON.parse(/const PRECACHE = (\[[\s\S]*?\]);/.exec(swA)[1]);
  check('build writes sw.js with a version and a precache list (index.html + hashed assets)', version(swA) && precacheA.includes('/index.html') && precacheA.filter((p) => /^\/assets\/.+-[\w-]{8,}\.(js|css)$/.test(p)).length >= 2, `${version(swA)}, ${precacheA.length} files`);
  check('a changed build gets a new service worker version', version(swB) && version(swB) !== version(swA));

  server = startServer(PORT, DB, serverEnv(DIST_A));
  await waitHttp(`${BASE}health`);

  // ---------------------------------------------------------------- HTTP: sw.js, CSP, manifest
  step('http');
  const sw = await fetch(`${BASE}sw.js`);
  const swText = await sw.text();
  check('/sw.js: 200, no-cache, JavaScript, the real worker (not the SPA page)', sw.status === 200 && sw.headers.get('cache-control') === 'no-cache' && /javascript/.test(sw.headers.get('content-type')) && swText.startsWith('// generated') && swText.includes('SW_VERSION') && !swText.includes('id="world-canvas"'));
  const missing = await fetch(`${BASE}sw-old.js`);
  check('unknown .js paths are 404s, not index.html', missing.status === 404);
  const csp = (await fetch(BASE)).headers.get('content-security-policy') ?? '';
  check("CSP allows worker-src 'self' and manifest-src 'self'", csp.includes("worker-src 'self'") && csp.includes("manifest-src 'self'"));
  const manifest = await (await fetch(`${BASE}manifest.json`)).json();
  const icons = manifest.icons ?? [];
  const iconOk = [];
  for (const i of icons.filter((i) => i.type === 'image/png')) {
    const r = await fetch(new URL(i.src, BASE));
    const { w, h } = pngSize(Buffer.from(await r.arrayBuffer()));
    iconOk.push(r.status === 200 && `${w}x${h}` === i.sizes);
  }
  check(
    'manifest: id, scope, start_url, standalone, lang ko, orientation any, description',
    manifest.id === '/' && manifest.scope === '/' && manifest.start_url === '/' && manifest.display === 'standalone' && manifest.lang === 'ko' && manifest.orientation === 'any' && manifest.description && manifest.name && manifest.short_name,
  );
  check(
    'manifest icons: 192 + 512 "any" and a separate 512 maskable, all real PNGs of the stated size',
    icons.some((i) => i.sizes === '192x192') && icons.some((i) => i.sizes === '512x512' && i.purpose === 'any') && icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512') && iconOk.every(Boolean),
    `${iconOk.length} png icons`,
  );
  const cfg = await (await fetch(`${BASE}api/auth/config`)).json();
  check('auth config advertises push (VAPID configured)', cfg.push === true);

  // ---------------------------------------------------------------- push API
  step('push api');
  const guest = new Agent();
  const guestCalls = [
    await guest.json('GET', '/api/push/key'),
    await guest.json('POST', '/api/push/subscribe', { subscription: fakeSub() }),
    await guest.json('POST', '/api/push/unsubscribe', { endpoint: 'https://push.test/x' }),
    await guest.json('GET', '/api/push/prefs'),
    await guest.json('PUT', '/api/push/prefs', { daily: false }),
  ];
  check('push APIs reject guests (401 login_required)', guestCalls.every((r) => r.status === 401 && r.data.error === 'login_required'), guestCalls.map((r) => r.status).join(','));

  const m = await new Agent().login('m6-member', '알림받는이');
  const key = await m.json('GET', '/api/push/key');
  check('members get the VAPID public key', key.status === 200 && key.data.publicKey === VAPID.publicKey);
  const good = fakeSub('m');
  const bad = [
    { ...good, endpoint: 'http://push.test/plain' },
    { ...good, endpoint: 'https://evil.example.com/push' },
    { ...good, endpoint: 'https://127.0.0.1/push' },
    { ...good, endpoint: 'https://user:pw@push.test/x' },
    { ...good, keys: { ...good.keys, p256dh: 'AAAA' } },
    { ...good, keys: { ...good.keys, auth: 'short' } },
    { endpoint: good.endpoint },
    { ...good, endpoint: `https://push.test/${'x'.repeat(2100)}` },
  ];
  const badRes = [];
  for (const b of bad) badRes.push((await m.json('POST', '/api/push/subscribe', { subscription: b })).status);
  check('subscribe validates: https only, known push hosts, no credentials, key sizes, length', badRes.every((s) => s === 400), badRes.join(','));
  const sub1 = await m.json('POST', '/api/push/subscribe', { subscription: good });
  check('a valid subscription is accepted', sub1.status === 200 && sub1.data.subscriptions === 1);
  const prefs0 = await m.json('GET', '/api/push/prefs');
  check(
    'default prefs: daily word on at 06:00, prayer reactions on (and no group-chat kind)',
    prefs0.data.daily === true && prefs0.data.dailyTime === '06:00' && prefs0.data.prayer === true && !('groupChat' in prefs0.data),
    JSON.stringify(prefs0.data),
  );
  const put = await m.json('PUT', '/api/push/prefs', { daily: true, dailyTime: '07:30', prayer: false });
  const prefs1 = await m.json('GET', '/api/push/prefs');
  check('prefs persist (07:30, prayer off)', put.status === 200 && prefs1.data.dailyTime === '07:30' && prefs1.data.prayer === false);
  const badPrefs = [
    await m.json('PUT', '/api/push/prefs', { dailyTime: '07:15' }),
    await m.json('PUT', '/api/push/prefs', { dailyTime: '24:00' }),
    await m.json('PUT', '/api/push/prefs', { daily: 'yes' }),
  ];
  check('prefs validate (30-minute steps, booleans)', badPrefs.every((r) => r.status === 400));
  for (let i = 0; i < 12; i++) await m.json('POST', '/api/push/subscribe', { subscription: fakeSub('many') });
  const capped = await m.json('GET', '/api/push/prefs');
  check('at most 10 subscriptions per user (oldest dropped)', capped.data.subscriptions === 10, String(capped.data.subscriptions));
  const unsubAll = await m.json('POST', '/api/push/unsubscribe', { all: true });
  check('unsubscribe removes subscriptions', unsubAll.status === 200 && unsubAll.data.subscriptions === 0);
  const other = await new Agent().login('m6-other', '다른사람');
  const shared = fakeSub('shared');
  await m.json('POST', '/api/push/subscribe', { subscription: shared });
  await other.json('POST', '/api/push/subscribe', { subscription: shared });
  const moved = (await m.json('GET', '/api/push/prefs')).data.subscriptions === 0 && (await other.json('GET', '/api/push/prefs')).data.subscriptions === 1;
  const steal = await m.json('POST', '/api/push/unsubscribe', { endpoint: shared.endpoint });
  check("a device switching accounts moves its endpoint; others can't remove it", moved && steal.status === 200 && (await other.json('GET', '/api/push/prefs')).data.subscriptions === 1);
  await other.json('POST', '/api/push/unsubscribe', { all: true });

  // ---------------------------------------------------------------- daily scheduler (fake clock)
  step('scheduler');
  const day1 = '2026-11-10';
  const day2 = '2026-11-11';
  const early = await new Agent().login('m6-early', '아침사람');
  const late = await new Agent().login('m6-late', '늦은사람');
  const quiet = await new Agent().login('m6-quiet', '조용한사람');
  await early.json('POST', '/api/push/subscribe', { subscription: fakeSub('early') });
  await early.json('POST', '/api/push/subscribe', { subscription: fakeSub('early') }); // two devices
  await late.json('POST', '/api/push/subscribe', { subscription: fakeSub('late') });
  await late.json('PUT', '/api/push/prefs', { dailyTime: '21:00' });
  await quiet.json('POST', '/api/push/subscribe', { subscription: fakeSub('quiet') });
  await quiet.json('PUT', '/api/push/prefs', { daily: false });
  await resetSent();
  const at = async (date, hm) => {
    await setClock(kst(date, hm));
    return tick();
  };
  const dailyFor = (list, a) => list.filter((d) => d.userId === a.id && d.payload.kind === 'daily');
  await at(day1, '05:59');
  const before = dailyFor(await sent(), early).length;
  await at(day1, '06:00');
  const atSix = dailyFor(await sent(), early);
  await at(day1, '06:01');
  await at(day1, '06:30');
  await at(day1, '07:59');
  const after = dailyFor(await sent(), early);
  check('daily word: nothing before the chosen time (05:59)', before === 0);
  check('daily word: sent at 06:00 to every device of the user, once', atSix.length === 2 && after.length === 2, `${atSix.length} then ${after.length}`);
  const p = atSix[0]?.payload ?? {};
  check('daily payload: "🕊️ 오늘의 말씀이 도착했어요", "<ref> · <first ~40 chars>…", opens /', p.title === DAILY_TITLE && / · /.test(p.body) && [...p.body.split(' · ')[1]].length <= 41 && p.url === '/' && p.tag === 'daily-word', p.body);
  check('users who turned the daily word off get nothing', dailyFor(await sent(), quiet).length === 0);
  check('a 21:00 user gets nothing in the morning', dailyFor(await sent(), late).length === 0);
  await at(day1, '21:00');
  await at(day1, '21:10');
  check('the 21:00 user gets it at 21:00, once', dailyFor(await sent(), late).length === 1);
  await at(day2, '06:00');
  check('next day: sent again (once per day per user)', dailyFor(await sent(), early).length === 4);
  // Missed ticks (restart) still deliver within the grace window, not hours later.
  await at(day2, '21:45');
  const catchUp = dailyFor(await sent(), late).length;
  const day3 = '2026-11-12';
  await at(day3, '23:30');
  check('a missed 21:00 tick still delivers at 21:45; not at 23:30 (past the 2 h grace)', catchUp === 2 && dailyFor(await sent(), late).length === 2);

  // ---------------------------------------------------------------- 410 cleanup
  step('410');
  const doomed = fakeSub('gone');
  const gone = await new Agent().login('m6-gone', '떠난기기');
  await gone.json('POST', '/api/push/subscribe', { subscription: doomed });
  await gone.json('POST', '/api/push/subscribe', { subscription: fakeSub('alive') });
  await admin.json('POST', '/api/test/push/status', { endpoint: doomed.endpoint, status: 410 });
  await at(day3, '06:00');
  const goneSubs = (await gone.json('GET', '/api/push/prefs')).data.subscriptions;
  check('410 from the push service deletes that subscription (others kept)', goneSubs === 1 && (await sent()).some((d) => d.endpoint === doomed.endpoint && d.status === 410));

  // ---------------------------------------------------------------- prayer reactions
  step('prayer');
  await setClock(kst(day3, '12:00'));
  const owner = await new Agent().login('m6-owner', '등불주인');
  const prayA = await new Agent().login('m6-pray-a', '기도하는가');
  const prayB = await new Agent().login('m6-pray-b', '기도하는나');
  const prayC = await new Agent().login('m6-pray-c', '기도하는다');
  await owner.json('POST', '/api/push/subscribe', { subscription: fakeSub('owner') });
  await prayA.json('POST', '/api/push/subscribe', { subscription: fakeSub('praya') });
  const today = seoulToday();
  await owner.json('PUT', `/api/wordbook/pages/${today}`);
  const lantern = async (text, anonymous) => {
    const med = await owner.json('POST', '/api/wordbook/meditations', { date: today, place: '골방', meditation: text });
    return (await owner.json('POST', '/api/lanterns', { meditationId: med.data.id, visibility: 'public', anonymous })).data;
  };
  const named = await lantern('비밀스러운 묵상 문장 하나', false);
  const anon = await lantern('익명 묵상 문장 둘', true);
  await resetSent();
  await prayA.json('POST', `/api/lanterns/${named.id}/reactions`, { type: 'pray' });
  await sleep(150);
  const first = (await sent()).filter((d) => d.payload.kind === 'prayer');
  const firstText = JSON.stringify(first);
  check('기도하기 notifies the lantern author right away', first.length === 1 && first[0].userId === owner.id && first[0].payload.title === PRAYER_TITLE, String(first.length));
  check(
    'the prayer notification never reveals who prayed or which lantern (no nickname, id, ref or text)',
    first.length === 1 &&
      !JSON.stringify(first[0].payload).includes(prayA.nickname) &&
      !JSON.stringify(first[0].payload).includes(String(prayA.id)) &&
      !JSON.stringify(first[0].payload).includes(named.ref) &&
      !firstText.includes('비밀스러운') &&
      Object.keys(first[0].payload).sort().join() === 'body,kind,tag,title,url',
    first[0]?.payload.body,
  );
  // Toggle off/on (same person) is not a new prayer; others within 15 min are batched.
  await prayA.json('POST', `/api/lanterns/${named.id}/reactions`, { type: 'pray' });
  await prayA.json('POST', `/api/lanterns/${named.id}/reactions`, { type: 'pray' });
  await prayB.json('POST', `/api/lanterns/${named.id}/reactions`, { type: 'pray' });
  await prayC.json('POST', `/api/lanterns/${anon.id}/reactions`, { type: 'pray' });
  await owner.json('POST', `/api/lanterns/${named.id}/reactions`, { type: 'pray' }); // praying for my own: no notice
  await sleep(150);
  const throttled = (await sent()).filter((d) => d.payload.kind === 'prayer').length;
  await setClock(kst(day3, '12:10'));
  await tick();
  const still = (await sent()).filter((d) => d.payload.kind === 'prayer').length;
  await setClock(kst(day3, '12:15'));
  await tick();
  const batch = (await sent()).filter((d) => d.payload.kind === 'prayer');
  check('throttled: no second prayer notice within 15 minutes', throttled === 1 && still === 1);
  check(
    'batched: one notice after the window counting the 2 new prayers (toggle and self-prayer not counted)',
    batch.length === 2 && batch[1].payload.body.includes('2번') && batch[1].userId === owner.id,
    batch[1]?.payload.body,
  );
  const anonView = await prayC.json('GET', `/api/lanterns/${anon.id}`);
  check(
    'anonymous lanterns: the notice goes only to the author, carries no names, and the lantern stays anonymous to the one who prayed',
    batch.every((d) => d.userId === owner.id) &&
      !JSON.stringify(batch).includes(owner.nickname) &&
      !JSON.stringify(batch).includes(prayC.nickname) &&
      anonView.data.nickname !== owner.nickname &&
      (await sent()).every((d) => d.userId !== prayA.id && d.userId !== prayC.id),
  );
  await owner.json('PUT', '/api/push/prefs', { prayer: false });
  await setClock(kst(day3, '13:00'));
  await prayC.json('POST', `/api/lanterns/${named.id}/reactions`, { type: 'pray' });
  await sleep(150);
  await tick();
  check('prayer notices respect the opt-out', (await sent()).filter((d) => d.payload.kind === 'prayer').length === 2);
  await setClock(null);

  // ---------------------------------------------------------------- service worker in the browser
  step('service worker');
  browser = await launch();
  const swCtx = await browser.newContext(desktop);
  const S = await swCtx.newPage();
  await S.goto(BASE + '?test=1&noworship=1');
  await S.waitForSelector('#entry-signed-out:not([hidden])');
  await S.evaluate(() => navigator.serviceWorker.ready);
  check('the service worker registers and activates on the first visit (production build)', await S.evaluate(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.active));
  const responses = [];
  S.on('response', (r) => responses.push({ url: r.url(), sw: r.fromServiceWorker() }));
  await S.reload();
  await S.waitForSelector('#entry-signed-out:not([hidden])');
  await until(S, () => !!navigator.serviceWorker.controller, null, 15000);
  check('after a reload the service worker controls the page', await S.evaluate(() => !!navigator.serviceWorker.controller));
  const cached = await S.evaluate(async () => {
    const out = {};
    for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname);
    return out;
  });
  const cacheNames = Object.keys(cached);
  const entries = Object.values(cached).flat();
  check('precache holds index.html and every hashed asset of the build', cacheNames.length === 1 && cacheNames[0] === `qt-worlds-${version(swA)}` && precacheA.every((p) => entries.includes(p)), `${entries.length} entries`);
  await S.evaluate(async () => {
    await fetch('/api/me');
    await fetch('/api/auth/config');
    await fetch('/health');
  });
  await sleep(300);
  const cachedAfter = await S.evaluate(async () => (await Promise.all((await caches.keys()).map(async (k) => (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname)))).flat());
  check('/api, /ws and /health are never put in the cache', !cachedAfter.some((p) => /^\/(api|ws|health)/.test(p)));
  const assetFromSw = responses.filter((r) => /\/assets\//.test(r.url));
  const apiFromSw = responses.filter((r) => /\/api\//.test(r.url));
  check('on reload hashed assets come from the service worker; /api never does', assetFromSw.length > 0 && assetFromSw.every((r) => r.sw) && apiFromSw.length > 0 && apiFromSw.every((r) => !r.sw), `${assetFromSw.length} assets, ${apiFromSw.length} api`);

  step('offline');
  await stop(server);
  await S.reload();
  await S.waitForSelector('.entry-card', { timeout: 15000 });
  const apiOffline = await S.evaluate(() => fetch('/api/me').then((r) => `status ${r.status}`, () => 'rejected'));
  check('server down: a navigation still shows the cached app shell', await S.isVisible('.entry-title'));
  check('server down: /api is not answered from a cache', apiOffline === 'rejected', apiOffline);
  // Without a cached shell (e.g. evicted storage) the offline page appears instead.
  await S.evaluate(async () => {
    for (const k of await caches.keys()) await (await caches.open(k)).delete('/index.html');
  });
  await S.goto(BASE + 'some/where');
  await S.waitForSelector('#offline-page', { timeout: 15000 });
  const offlineText = await S.textContent('#offline-page');
  check('no cached shell: the offline page "연결이 끊겼어요 … 자동으로 이어져요" with a retry button', offlineText.includes('연결이 끊겼어요') && offlineText.includes('다시 연결되면 자동으로 이어져요') && (await S.isVisible('#offline-retry')));
  await shot(S, 'offline');
  const mobileOffline = await swCtx.newPage();
  await mobileOffline.setViewportSize({ width: 390, height: 844 });
  await mobileOffline.goto(BASE);
  await mobileOffline.waitForSelector('#offline-page');
  await shot(mobileOffline, 'offline-mobile');
  await mobileOffline.close();

  // ---------------------------------------------------------------- deploy a new build
  step('update');
  server = startServer(PORT, DB, serverEnv(DIST_B));
  await waitHttp(`${BASE}health`);
  // The offline page polls /health and reloads by itself.
  await S.waitForSelector('.entry-card', { timeout: 20000 });
  check('the offline page reconnects by itself when the server is back', true);
  await S.waitForSelector('#sw-update', { timeout: 30000 });
  const toast = await S.textContent('#sw-update');
  check('a new deploy shows the "새 버전이 있어요 [새로고침]" toast', toast.includes('새 버전이 있어요') && toast.includes('새로고침'));
  await shot(S, 'update-toast');
  await S.setViewportSize({ width: 390, height: 844 });
  await shot(S, 'update-toast-mobile');
  await S.setViewportSize(desktop.viewport);
  const nav = S.waitForNavigation({ timeout: 20000 });
  await S.click('#sw-update-reload');
  await nav;
  await S.waitForSelector('.entry-card');
  await until(S, () => !!navigator.serviceWorker.controller, null, 15000);
  const activeVersion = await S.evaluate(
    () =>
      new Promise((res) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => res(e.data.version);
        navigator.serviceWorker.controller.postMessage({ type: 'VERSION' }, [ch.port2]);
        setTimeout(() => res(null), 3000);
      }),
  );
  const keysAfter = await S.evaluate(() => caches.keys());
  check('tapping 새로고침 reloads once and the new service worker is in control', activeVersion === version(swB), `${activeVersion}`);
  check('old caches are deleted on activate', keysAfter.length === 1 && keysAfter[0] === `qt-worlds-${version(swB)}`, keysAfter.join(','));
  check('no toast after the update', !(await S.isVisible('#sw-update')));
  await swCtx.close();

  // ---------------------------------------------------------------- notifications UI (signed in)
  step('notify ui');
  const nCtx = await browser.newContext(desktop);
  await nCtx.addInitScript(PUSH_STUB);
  const N = await nCtx.newPage();
  await loginJoin(N, BASE, 'm6-ui', '알림화면', Q);
  await openSettings(N);
  await N.waitForSelector('#notify-enable');
  check('⚙ 설정 has a 🔔 알림 section with "알림 켜기"', (await N.textContent('#notify-settings')).includes('🔔 알림'));
  await N.click('#notify-enable');
  await N.waitForSelector('#notify-preprompt');
  const asked0 = await N.evaluate(() => window.__permAsked ?? 0);
  check('a friendly pre-prompt comes first (the browser has not asked yet)', asked0 === 0 && (await N.textContent('#notify-preprompt')).includes('허용'));
  await N.locator('#notify-settings').scrollIntoViewIfNeeded();
  await shot(N, 'notify-preprompt-desktop');
  await N.click('#notify-allow');
  await N.waitForSelector('#notify-daily', { timeout: 15000 });
  const server1 = await N.evaluate(() => fetch('/api/push/prefs').then((r) => r.json()));
  check('allow → permission asked once → subscribed on the server', (await N.evaluate(() => window.__permAsked)) === 1 && server1.subscriptions === 1);
  check('controls: daily word (06:00 default), prayer reactions; no group-chat toggle', (await N.inputValue('#notify-time')) === '06:00' && (await N.isChecked('#notify-daily')) && (await N.isChecked('#notify-prayer')) && (await N.locator('#notify-group').count()) === 0);
  await N.selectOption('#notify-time', '07:00');
  await until(N, () => document.querySelector('#notify-settings .groups-status')?.textContent === '저장했어요.');
  await N.uncheck('#notify-prayer');
  await sleep(500);
  await closeSettings(N);
  await openSettings(N);
  await N.waitForSelector('#notify-time');
  const persisted = (await N.inputValue('#notify-time')) === '07:00' && !(await N.isChecked('#notify-prayer'));
  const server2 = await N.evaluate(() => fetch('/api/push/prefs').then((r) => r.json()));
  check('time and toggles persist (server and UI after reopening)', persisted && server2.dailyTime === '07:00' && server2.prayer === false);
  await N.uncheck('#notify-daily');
  check('turning the daily word off disables the time picker', await N.isDisabled('#notify-time'));
  await N.check('#notify-daily');
  await N.check('#notify-prayer');
  await sleep(400);
  await N.locator('#notify-settings').scrollIntoViewIfNeeded();
  await shot(N, 'settings-notify-desktop');
  await N.setViewportSize({ width: 390, height: 844 });
  await sleep(400);
  await N.locator('#notify-settings').scrollIntoViewIfNeeded();
  await shot(N, 'settings-notify-phone');
  await N.setViewportSize(desktop.viewport);
  await N.click('#notify-off');
  await N.waitForSelector('#notify-enable');
  const server3 = await N.evaluate(() => fetch('/api/push/prefs').then((r) => r.json()));
  check('"알림 끄기" unsubscribes this device (server too)', server3.subscriptions === 0 && (await N.evaluate(() => window.__sub === null)));
  // Denied: device-specific help instead of the button.
  await N.evaluate(() => {
    window.__perm = 'default';
    window.__answer = 'denied';
  });
  await N.click('#notify-enable');
  await N.click('#notify-allow');
  await N.waitForSelector('#notify-denied');
  const deniedText = await N.textContent('#notify-denied');
  check('denied: device-specific help (PC Chrome steps here)', deniedText.includes('차단') && deniedText.includes('Chrome'));
  await N.locator('#notify-settings').scrollIntoViewIfNeeded();
  await shot(N, 'notify-denied-desktop');
  check('a regular desktop tab with no install event shows no install button', (await N.locator('#settings-install').count()) === 0);
  await closeSettings(N);
  await nCtx.close();

  // ---------------------------------------------------------------- install UI (guest, Chrome-like)
  step('install');
  const iCtx = await browser.newContext(desktop);
  await iCtx.addInitScript(BIP_STUB);
  const I = await iCtx.newPage();
  await join(I, BASE, '설치손님', '?test=1&shadows=0&time=14:00&noworship=1');
  await I.waitForSelector('.guide-skip', { timeout: 30000 });
  await I.click('.guide-skip');
  await I.waitForSelector('#install-offer', { timeout: 10000 });
  check('after the first-time guide, a gentle one-time "📲 앱으로 설치하기" card', (await I.textContent('#install-offer')).includes('앱으로 설치하기'));
  await shot(I, 'install-offer-desktop');
  await I.click('#install-offer-no');
  const offered = await I.evaluate(() => localStorage.getItem('worlds.install.offered'));
  await openSettings(I);
  await I.waitForSelector('#settings-install-btn');
  await I.locator('#settings-install').scrollIntoViewIfNeeded();
  await shot(I, 'install-button-desktop');
  await I.click('#settings-install-btn');
  await until(I, () => window.__bipPrompted === true, null, 5000);
  check('⚙ 설정 → "📲 앱으로 설치하기" opens the browser install prompt; the card is remembered (no nagging)', !!offered);
  check('guests see a login hint in 🔔 알림', (await I.textContent('#notify-settings')).includes('로그인'));
  await closeSettings(I);
  await iCtx.close();

  // Standalone (installed app): everything about installing is hidden.
  const aCtx = await browser.newContext(desktop);
  await aCtx.addInitScript(STANDALONE_STUB);
  await aCtx.addInitScript(BIP_STUB);
  const A = await aCtx.newPage();
  await join(A, BASE, '앱손님', Q);
  await sleep(800);
  await openSettings(A);
  const standaloneHidden = (await A.locator('#settings-install').count()) === 0;
  await closeSettings(A);
  check('install UI is hidden when running standalone (matchMedia display-mode override)', standaloneHidden && !(await A.isVisible('#install-offer')));
  await aCtx.close();

  // ---------------------------------------------------------------- iOS Safari
  step('ios');
  const iosUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const oCtx = await browser.newContext({ ...mobile, userAgent: iosUA });
  const O = await oCtx.newPage();
  await loginJoin(O, BASE, 'm6-ios', '아이폰', Q);
  await openSettings(O);
  await O.waitForSelector('#notify-ios-install');
  check('iOS (not installed): 🔔 알림 explains 홈 화면에 추가 (iOS 16.4+)', (await O.textContent('#notify-settings')).includes('홈 화면에 추가'));
  await O.locator('#notify-settings').scrollIntoViewIfNeeded();
  await shot(O, 'notify-ios-phone');
  await O.click('#settings-install-btn');
  await O.waitForSelector('#ios-install-guide');
  const iosText = await O.textContent('#ios-install-guide');
  check('iOS: "📲 앱으로 설치하기" shows the 공유 → 홈 화면에 추가 guide', iosText.includes('공유') && iosText.includes('홈 화면에 추가'));
  await shot(O, 'ios-install-guide');
  await oCtx.close();
} catch (err) {
  check(`no unexpected error (at: ${currentStep()})`, false, err.stack ?? String(err));
} finally {
  await browser?.close();
  await stopAll();
  dropDb(DB);
  rmSync(DIST_B, { recursive: true, force: true });
}
process.exit(summary());
