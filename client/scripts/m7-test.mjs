// M7 end-to-end test: legal/compliance.
//  - /privacy and /terms: static pages served by the Node server (not the SPA), linked
//    from the entry screen, ⚙ settings and the guide; offline via the service worker
//  - build prints a loud warning while operator placeholders remain
//  - sign-up needs 만 14세 이상 + 약관 동의 (API and UI); terms_agreed_at recorded
//  - pre-M7 accounts get a one-time consent sheet; saving is blocked until they agree
//  - 내 데이터 내려받기: my data only
//  - 회원 탈퇴: everything gone (checked in the throwaway DB), live take-down for others,
//    group ownership handed over / empty group deleted, nickname reusable, old cookie dead
//  - backup pruning keeps BACKUP_KEEP
//  - YouTube worship player pauses while the page is hidden and resumes after
// Builds its own client (vite build into data/test/m7-dist) and serves it from the
// server (production-like headers). Port: TEST_SERVER_PORT (default 5186).
//   cd server && npm run build && cd ../client && node scripts/m7-test.mjs
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  check,
  clientDir,
  currentStep,
  debug,
  desktop,
  dropDb,
  freshDb,
  launch,
  loginJoin,
  mobile,
  of,
  rawClient,
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

const PORT = Number(process.env.TEST_SERVER_PORT ?? 5186);
const BASE = `http://127.0.0.1:${PORT}/`;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const DAY = '2026-11-08';
const Q = (extra = '') => `?test=1&shadows=0&time=14:00&date=${DAY}&noworship=1&noguide=1${extra}`;
const DB = freshDb('m7');
const DIST = resolve(serverDir, 'data/test/m7-dist');
const BACKUP_DIR = resolve(serverDir, 'data/test/m7-backup');
const Database = createRequire(resolve(serverDir, 'package.json'))('better-sqlite3');

/** A cookie-keeping HTTP client (one "device"). */
class Agent {
  constructor(headers = {}) {
    this.jar = new Map();
    this.headers = headers;
  }
  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  absorb(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (/Max-Age=0/i.test(c) || v === '') this.jar.delete(k);
      else this.jar.set(k, v);
    }
  }
  async raw(method, path, body, extra = {}) {
    const res = await fetch(path.startsWith('http') ? path : ORIGIN + path, {
      method,
      redirect: 'manual',
      headers: {
        ...this.headers,
        ...(this.jar.size ? { cookie: this.cookieHeader() } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...extra,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    this.absorb(res);
    return res;
  }
  async json(method, path, body, extra) {
    const res = await this.raw(method, path, body, extra);
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* none */
    }
    return { status: res.status, data, headers: res.headers };
  }
  async login(hint) {
    let url = `/api/auth/google/start?remember=1&hint=${encodeURIComponent(hint)}`;
    for (let i = 0; i < 8; i++) {
      const res = await this.raw('GET', url);
      const loc = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !loc) return url;
      url = new URL(loc, ORIGIN + '/').toString();
      if (!url.includes('/api/')) return url;
    }
    return url;
  }
}

async function account(hint, nickname) {
  const a = new Agent();
  await a.login(hint);
  const r = await a.json('POST', '/api/me/nickname', { nickname, agree: true });
  if (r.status !== 200) throw new Error(`nickname ${nickname}: ${JSON.stringify(r.data)}`);
  a.id = r.data.user.id;
  a.nickname = nickname;
  return a;
}

/** An Agent that shares a browser context's session cookie. */
async function agentFrom(context) {
  const a = new Agent();
  for (const c of await context.cookies(ORIGIN)) a.jar.set(c.name, c.value);
  const me = await a.json('GET', '/api/me');
  a.id = me.data.user?.id;
  a.nickname = me.data.user?.nickname;
  return a;
}

async function meditate(a, text) {
  const r = await a.json('POST', '/api/wordbook/meditations', { date: DAY, place: '골방', meditation: text, feeling: '', application: '' });
  return r;
}

/** Stub of the YouTube IFrame API: records calls, reports states like the real player. */
const YT_STUB = `
window.__ytCalls = [];
window.YT = { Player: function (el, opts) {
  var self = this;
  var state = -1;
  var fire = function (s) { state = s; if (opts.events && opts.events.onStateChange) opts.events.onStateChange({ data: s }); };
  this.playVideo = function () { window.__ytCalls.push('play'); fire(1); };
  this.pauseVideo = function () { window.__ytCalls.push('pause'); fire(2); };
  this.loadVideoById = function () { window.__ytCalls.push('load'); fire(1); };
  this.cueVideoById = function () { window.__ytCalls.push('cue'); fire(5); };
  this.seekTo = function () {};
  this.setVolume = function () {};
  this.mute = function () {};
  this.unMute = function () {};
  this.destroy = function () { window.__ytCalls.push('destroy'); };
  this.getVideoData = function () { return { video_id: opts.videoId }; };
  window.__ytPlayer = this;
  window.__ytState = function () { return state; };
  setTimeout(function () { if (opts.events && opts.events.onReady) opts.events.onReady(); }, 50);
} };
setTimeout(function () { if (window.onYouTubeIframeAPIReady) window.onYouTubeIframeAPIReady(); }, 0);
`;

const setVisibility = (page, state) =>
  page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);

let browser;
try {
  // ---------------------------------------------------------------- build
  step('build');
  rmSync(DIST, { recursive: true, force: true });
  const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', DIST, '--emptyOutDir'], {
    cwd: clientDir,
    encoding: 'utf-8',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  const buildOut = `${build.stdout}\n${build.stderr}`;
  check('client build succeeds', build.status === 0, build.status === 0 ? '' : buildOut.slice(-400));
  // Operator details are filled in (src/config/legal.ts), so the placeholder
  // warning must be gone; it reappears only if a field is reset to a placeholder.
  check('build has no LEGAL PLACEHOLDERS warning (operator details filled in)', !/WARNING: LEGAL PLACEHOLDERS/.test(buildOut));
  check('build emits privacy.html and terms.html', existsSync(resolve(DIST, 'privacy.html')) && existsSync(resolve(DIST, 'terms.html')));
  const sw = readFileSync(resolve(DIST, 'sw.js'), 'utf-8');
  const precache = JSON.parse(/const PRECACHE = (\[[\s\S]*?\]);/.exec(sw)[1]);
  check('service worker precaches /privacy.html and /terms.html', precache.includes('/privacy.html') && precache.includes('/terms.html'));

  const serverEnv = {
    WORLDS_AUTH_MOCK: '1',
    SERVE_CLIENT: '1',
    WORLDS_CLIENT_DIST: DIST,
    MAX_CONN_PER_IP: '40',
    AUTH_RATE_LIMIT: '200',
    NEW_ACCOUNTS_PER_HOUR: '500',
    EXPORT_RATE_LIMIT: '8',
  };
  let server = startServer(PORT, DB, serverEnv);
  await waitHttp(`${ORIGIN}/health`);
  const db = new Database(DB);

  // ---------------------------------------------------------------- static pages
  step('pages');
  for (const [path, must] of [
    ['/privacy', ['개인정보처리방침', '처리하는 개인정보 항목', '보유 기간과 파기', '제3자 제공', '처리 위탁과 국외 이전', '이용자의 권리와 행사 방법', '만 14세 미만 아동', '쿠키와 기기 저장소', '안전성 확보 조치', '개인정보 보호책임자', 'Cloudflare', 'youtube.com/t/terms', 'policies.google.com/privacy', '14일', '모닥불 이야기', '녹음하거나 저장하지 않아요']],
    ['/terms', ['이용약관', '비영리', '만 14세 이상', '금지 행위', '사칭', '모임장', '찬양 영상', 'YouTube', '개역한글판', '서비스의 변경과 중단', '책임의 한계', '익명 등불']],
  ]) {
    const res = await fetch(ORIGIN + path);
    const html = await res.text();
    const missing = must.filter((m) => !html.includes(m));
    check(`${path}: 200 HTML with the key sections`, res.status === 200 && /text\/html/.test(res.headers.get('content-type')) && missing.length === 0, missing.join(', '));
    check(`${path}: its own page, not the SPA fallback`, !html.includes('id="world-canvas"') && html.includes(`id="legal-${path.slice(1)}"`));
    check(`${path}: security headers (CSP, no-cache)`, /default-src 'self'/.test(res.headers.get('content-security-policy') ?? '') && res.headers.get('cache-control') === 'no-cache');
    check(`${path}: link back to the world, no scripts`, html.includes('href="/" id="legal-back"') && !/<script/i.test(html));
  }
  check('/privacy.html also serves the page', (await fetch(`${ORIGIN}/privacy.html`)).status === 200);
  const privacyHtml = await (await fetch(`${ORIGIN}/privacy`)).text();
  check('pages show the real operator details, no placeholders', !privacyHtml.includes('입력 필요') && privacyHtml.includes('QT 월드 운영팀'));
  check('an unknown extensionless path still gets the SPA', (await (await fetch(`${ORIGIN}/somewhere`)).text()).includes('id="world-canvas"'));

  browser = await launch();

  // Privacy page on a phone (360 px wide: no horizontal page scroll).
  {
    const ctx = await browser.newContext({ ...mobile, viewport: { width: 360, height: 760 } });
    const P = await ctx.newPage();
    await P.goto(`${ORIGIN}/privacy`);
    const overflow = await P.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('privacy page fits a 360 px phone (no horizontal scroll)', overflow <= 0, `overflow ${overflow}px`);
    await P.screenshot({ path: resolve(shotDir, 'm7-privacy-phone.png') });
    await P.evaluate(() => document.getElementById('p5').scrollIntoView());
    await P.screenshot({ path: resolve(shotDir, 'm7-privacy-phone-transfer.png') });
    await P.goto(`${ORIGIN}/terms`);
    const overflowT = await P.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('terms page fits a 360 px phone', overflowT <= 0, `overflow ${overflowT}px`);
    await P.click('#legal-back');
    await P.waitForSelector('#entry');
    check('"돌아가기" returns to the world', new URL(P.url()).pathname === '/');
    await ctx.close();
  }

  // ---------------------------------------------------------------- entry screen links
  step('entry links');
  const G = await (await browser.newContext(mobile)).newPage();
  await G.goto(BASE + Q());
  await G.waitForSelector('#entry-signed-out:not([hidden])');
  const entryLinks = await G.evaluate(() =>
    [...document.querySelectorAll('#entry-legal a')].map((a) => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), visible: a.getBoundingClientRect().height > 0 })),
  );
  check(
    'entry screen footer links 이용약관 and 개인정보처리방침 (new tab)',
    entryLinks.length === 2 && entryLinks.some((l) => l.href === '/privacy') && entryLinks.some((l) => l.href === '/terms') && entryLinks.every((l) => l.target === '_blank' && l.visible),
    JSON.stringify(entryLinks),
  );
  check('guests see "둘러보기도 이용약관을 따릅니다" with a link', (await G.isVisible('#entry-guest-terms')) && (await G.textContent('#entry-guest-terms')).includes('둘러보기도') && (await G.getAttribute('#entry-guest-terms a', 'href')) === '/terms');
  await G.screenshot({ path: resolve(shotDir, 'm7-entry-phone.png') });

  // Guest settings: the legal links are there too.
  await G.fill('#nickname', '손님');
  await G.click('#entry-submit');
  await until(G, () => window.__WORLDS_DEBUG__?.ready && window.__WORLDS_DEBUG__.net?.status === 'online', null, 60000);
  await G.click('#btn-settings');
  await G.waitForSelector('#settings-privacy');
  check(
    '⚙ settings (guest) link 개인정보처리방침 · 이용약관',
    (await G.getAttribute('#settings-privacy', 'href')) === '/privacy' && (await G.getAttribute('#settings-terms', 'href')) === '/terms',
  );
  check('guests have no export/탈퇴 buttons', !(await G.isVisible('#settings-export')) && !(await G.isVisible('#settings-delete')));
  await G.context().close();

  // ---------------------------------------------------------------- sign-up consent (API)
  step('consent api');
  const n1 = new Agent();
  await n1.login('m7-newbie');
  const noAgree = await n1.json('POST', '/api/me/nickname', { nickname: '새싹' });
  check('API: finishing sign-up without consent is refused (400 consent_required)', noAgree.status === 400 && noAgree.data?.error === 'consent_required', JSON.stringify(noAgree.data));
  const stillNew = await n1.json('GET', '/api/me');
  check('…and the nickname is not set', stillNew.data.needsNickname === true && stillNew.data.user.nickname === null);
  const falseAgree = await n1.json('POST', '/api/me/nickname', { nickname: '새싹', agree: 'yes' });
  check('API: agree must be exactly true', falseAgree.status === 400);
  const withAgree = await n1.json('POST', '/api/me/nickname', { nickname: '새싹', agree: true });
  const row1 = db.prepare('SELECT terms_agreed_at, terms_version FROM users WHERE id = ?').get(withAgree.data?.user?.id);
  check('API: with consent sign-up completes and terms_agreed_at/terms_version are recorded', withAgree.status === 200 && row1?.terms_agreed_at > 0 && /^\d{4}-\d{2}-\d{2}$/.test(row1?.terms_version ?? ''), JSON.stringify(row1));
  check('/api/me reports no consent needed after signing up', (await n1.json('GET', '/api/me')).data.needsConsent === false);
  const rename = await n1.json('POST', '/api/me/nickname', { nickname: '새싹2' });
  check('changing the nickname later needs no new checkbox', rename.status === 200);

  // ---------------------------------------------------------------- sign-up consent (UI)
  step('consent ui');
  const uctx = await browser.newContext(mobile);
  const U = await uctx.newPage();
  await U.goto(`${BASE}api/auth/google/start?remember=1&hint=m7-ui`);
  await U.goto(BASE + Q());
  await U.waitForSelector('#entry-nick:not([hidden])');
  const agreeLinks = await U.evaluate(() => [...document.querySelectorAll('#entry-nick .entry-consent a')].map((a) => `${a.getAttribute('href')}|${a.getAttribute('target')}`));
  check('닉네임 정하기 has the 만 14세 + 약관 checkbox with both links (new tab)', agreeLinks.includes('/terms|_blank') && agreeLinks.includes('/privacy|_blank') && (await U.textContent('#entry-nick .entry-consent')).includes('만 14세 이상'));
  await U.fill('#account-nickname', '체크손');
  await U.click('#nick-submit');
  await U.waitForSelector('#entry-status:has-text("동의")');
  const uiRefused = await agentFrom(uctx);
  check('UI: submitting without the checkbox is refused (no account nickname yet)', (await uiRefused.json('GET', '/api/me')).data.needsNickname === true, await U.textContent('#entry-status'));
  await U.screenshot({ path: resolve(shotDir, 'm7-consent-checkbox.png') });
  await U.check('#nick-agree');
  await U.click('#nick-submit');
  await until(U, () => window.__WORLDS_DEBUG__?.net?.status === 'online', null, 60000);
  const uiAgent = await agentFrom(uctx);
  const uiRow = db.prepare('SELECT nickname, terms_agreed_at FROM users WHERE id = ?').get(uiAgent.id);
  check('UI: with the checkbox the account is created and consent recorded', uiRow?.nickname === '체크손' && uiRow?.terms_agreed_at > 0);
  check('UI: no consent sheet for a fresh sign-up', !(await U.isVisible('#consent-accept')));
  await uctx.close();

  // ---------------------------------------------------------------- pre-M7 accounts
  step('existing users');
  const old = await account('m7-old', '옛친구');
  check('before the reset, saving works', (await meditate(old, '전에 쓴 묵상')).status === 201);
  db.prepare('UPDATE users SET terms_agreed_at = NULL, terms_version = NULL WHERE id = ?').run(old.id);
  check('/api/me says needsConsent for an account without consent', (await old.json('GET', '/api/me')).data.needsConsent === true);
  const blocked = await meditate(old, '동의 전 묵상');
  check('saving is blocked until agreeing (403 needs_consent, gentle message)', blocked.status === 403 && blocked.data?.error === 'needs_consent' && /동의/.test(blocked.data?.message), JSON.stringify(blocked.data));
  check('reading still works (word book)', (await old.json('GET', '/api/wordbook')).status === 200);
  check('creating a group is blocked too', (await old.json('POST', '/api/groups', { name: '옛모임' })).status === 403);
  check('내 데이터 내려받기 works without consent', (await old.json('GET', '/api/me/export')).status === 200);

  // UI: the sheet appears once.
  const octx = await browser.newContext(desktop);
  const O = await octx.newPage();
  await O.goto(`${BASE}api/auth/google/start?remember=1&hint=m7-old`);
  await O.goto(BASE + Q());
  await O.waitForSelector('#entry-signed-in:not([hidden])');
  await O.click('#entry-continue');
  await until(O, () => window.__WORLDS_DEBUG__?.net?.status === 'online', null, 60000);
  await O.waitForSelector('#consent-accept', { timeout: 15000 });
  check('pre-M7 account: the consent sheet appears after entering', await O.isVisible('#consent-accept'));
  await until(O, () => document.getElementById('loading').hidden || document.getElementById('loading').classList.contains('done'), null, 20000).catch(() => undefined);
  await sleep(1500);
  await O.screenshot({ path: resolve(shotDir, 'm7-consent-sheet.png') });
  await O.click('#consent-later');
  await O.reload();
  await O.waitForSelector('#entry-signed-in:not([hidden])');
  await O.click('#entry-continue');
  await until(O, () => window.__WORLDS_DEBUG__?.net?.status === 'online', null, 60000);
  await sleep(2500);
  check('…only once per visit ("나중에" then reload: not shown again)', !(await O.isVisible('#consent-accept')));
  check('still blocked after "나중에"', (await meditate(old, '아직')).status === 403);
  await O.click('#btn-word');
  const wordOk = await O.waitForSelector('#book-today .word-body', { timeout: 15000 }).then(() => true).catch(() => false);
  check('browsing still works before agreeing (말씀 → 오늘 opens)', wordOk);
  await O.keyboard.press('Escape');
  await until(O, () => !document.querySelector('#book-today'), null, 5000).catch(() => undefined);
  await O.click('#btn-settings');
  await O.waitForSelector('#settings-nav-account .settings-item-flag');
  await O.click('#settings-nav-account');
  await O.waitForSelector('#settings-consent');
  await O.click('#settings-consent');
  await O.waitForSelector('#consent-accept');
  await O.click('#consent-accept');
  await O.waitForSelector('.consent-sheet .entry-consent.missing');
  check('consent sheet: the checkbox is required', (await old.json('GET', '/api/me')).data.needsConsent === true);
  await O.check('#consent-agree');
  await O.click('#consent-accept');
  await until(O, () => !document.querySelector('#consent-accept'), null, 10000);
  check('after agreeing in ⚙ 설정, consent is recorded', (await old.json('GET', '/api/me')).data.needsConsent === false);
  check('…and saving works again', (await meditate(old, '동의 후 묵상')).status === 201);
  await octx.close();

  // ---------------------------------------------------------------- export + deletion setup
  step('setup');
  // D (to be deleted) signs up in a browser; E and F are other accounts.
  const dctx = await browser.newContext(mobile);
  const D = await dctx.newPage();
  await loginJoin(D, BASE, 'm7-dora', '도라', Q());
  const d = await agentFrom(dctx);
  const e = await account('m7-eli', '엘리');
  const f = await account('m7-fay', '페이');

  const dMed = (await meditate(d, '도라의 공개 묵상')).data;
  const dMed2 = (await meditate(d, '도라의 모임 묵상')).data;
  const dSecret = (await meditate(d, '도라만 아는 묵상')).data;
  const g1 = (await d.json('POST', '/api/groups', { name: '도라모임' })).data;
  const g2 = (await d.json('POST', '/api/groups', { name: '혼자모임' })).data;
  await sleep(30);
  check('E joins 도라모임 first', (await e.json('POST', '/api/groups/join', { code: g1.code })).status === 200);
  await sleep(30);
  check('F joins later', (await f.json('POST', '/api/groups/join', { code: g1.code })).status === 200);
  const L1 = (await d.json('POST', '/api/lanterns', { meditationId: dMed.id, visibility: 'public' })).data;
  const L2 = (await d.json('POST', '/api/lanterns', { meditationId: dMed2.id, visibility: 'group', groupId: g1.id })).data;
  const eMed = (await meditate(e, '엘리의 등불 묵상')).data;
  const eSecret = (await meditate(e, '엘리만 아는 비밀 묵상')).data;
  const LE = (await e.json('POST', '/api/lanterns', { meditationId: eMed.id, visibility: 'public' })).data;
  await e.json('POST', `/api/lanterns/${L1.id}/reactions`, { type: 'amen' });
  await e.json('POST', `/api/lanterns/${L1.id}/reactions`, { type: 'record' });
  await d.json('POST', `/api/lanterns/${LE.id}/reactions`, { type: 'pray' });
  await d.json('POST', `/api/lanterns/${LE.id}/reactions`, { type: 'record' });
  await d.json('POST', `/api/groups/${g1.id}/messages`, { text: '도라의 채팅 메시지' });
  await e.json('POST', `/api/groups/${g1.id}/messages`, { text: '엘리의 채팅 메시지' });
  await d.json('POST', `/api/groups/${g1.id}/read`, { lastId: 0 });
  // A push subscription for D (rows only; delivery is covered by m6).
  db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, 'https://fcm.googleapis.com/fcm/send/m7-dora', 'k', 'a', 'Mozilla/5.0 test', ?)").run(d.id, Date.now());
  db.prepare('INSERT INTO push_prefs (user_id, updated_at) VALUES (?, ?)').run(d.id, Date.now());
  check(
    'setup: D has a public + a group lantern, E reacted to and saved D\'s lantern, D prayed for E\'s',
    L1?.id && L2?.id && LE?.counts?.pray === 0 && (await e.json('GET', `/api/lanterns/${LE.id}`)).data.counts.pray === 1,
  );

  // ---------------------------------------------------------------- export
  step('export');
  const ex = await d.json('GET', '/api/me/export');
  const exText = JSON.stringify(ex.data);
  check('export: 200 JSON as an attachment', ex.status === 200 && /attachment; filename="qt-world-my-data-\d{8}\.json"/.test(ex.headers.get('content-disposition') ?? ''));
  check(
    'export holds my profile, meditations, word book, lanterns, saved lanterns, groups, my chat',
    ex.data.account.nickname === '도라' &&
      ex.data.account.email === 'mock-m7-dora@example.test' &&
      ex.data.account.termsAgreedAt &&
      ex.data.wordBook.some((p) => p.meditations.some((m) => m.meditation === '도라만 아는 묵상')) &&
      ex.data.lanterns.length === 2 &&
      ex.data.savedLanterns.some((s) => s.lanternId === LE.id) &&
      ex.data.groups.length === 2 &&
      ex.data.groupMessages.some((m) => m.text === '도라의 채팅 메시지') &&
      ex.data.myReactions.length === 2 &&
      ex.data.notifications.devices.length === 1,
  );
  check(
    'export holds nobody else\'s private data (E\'s secret meditation, E\'s chat, E\'s email)',
    !exText.includes('엘리만 아는 비밀 묵상') && !exText.includes('엘리의 채팅 메시지') && !exText.includes('mock-m7-eli') && !exText.includes('fcm.googleapis.com/fcm/send/m7-dora'),
  );
  const eEx = JSON.stringify((await e.json('GET', '/api/me/export')).data);
  check('E\'s export doesn\'t contain D\'s private meditation', !eEx.includes('도라만 아는 묵상') && !eEx.includes('도라의 채팅 메시지'));
  check('export needs a session', (await new Agent().json('GET', '/api/me/export')).status === 401);

  // UI: ⚙ 설정 → 계정
  await D.click('#btn-settings');
  await D.click('#settings-nav-account');
  await D.waitForSelector('#settings-export');
  await D.evaluate(() => document.getElementById('settings-account').scrollIntoView({ block: 'end' }));
  await sleep(1200);
  await D.screenshot({ path: resolve(shotDir, 'm7-settings-account.png') });
  check('⚙ 설정 계정 has 내 데이터 내려받기, 회원 탈퇴 and the legal links', (await D.isVisible('#settings-export')) && (await D.isVisible('#settings-delete')) && (await D.getAttribute('#settings-privacy', 'href')) === '/privacy');
  const [download] = await Promise.all([D.waitForEvent('download', { timeout: 15000 }), D.click('#settings-export')]);
  const dlPath = await download.path();
  const dl = JSON.parse(readFileSync(dlPath, 'utf-8'));
  check('UI: "내 데이터 내려받기" downloads my JSON', /\.json$/.test(download.suggestedFilename()) && dl.account?.nickname === '도라', download.suggestedFilename());

  // ---------------------------------------------------------------- deletion
  step('delete');
  // E watches live (world socket) and sits in the voice room of 도라모임 with D.
  const wsE = await rawClient(WS, { nickname: 'x', test: true }, { cookie: e.cookieHeader() });
  const wsD = await rawClient(WS, { nickname: 'x', test: true }, { cookie: d.cookieHeader() });
  wsE.send({ t: 'voiceJoin', groupId: g1.id });
  await sleep(200);
  wsD.send({ t: 'voiceJoin', groupId: g1.id });
  await sleep(500);
  check('setup: D and E are in the voice room', of(wsD, 'voiceRoom').length === 1 && of(wsE, 'voicePeer').some((m) => m.joined));

  const evil = await d.json('POST', '/api/me/delete', { nickname: '도라' }, { origin: 'http://evil.example' });
  check('탈퇴 from another Origin is refused', evil.status === 403);
  check('탈퇴 without a session is refused', (await new Agent().json('POST', '/api/me/delete', { nickname: '도라' })).status === 401);
  const wrong = await d.json('POST', '/api/me/delete', { nickname: '도라아' });
  check('탈퇴 with the wrong nickname is refused', wrong.status === 400 && wrong.data?.error === 'confirm_mismatch');
  check('…and nothing was deleted', !!db.prepare('SELECT 1 FROM users WHERE id = ?').get(d.id));

  // The 탈퇴 sheet (UI).
  await D.click('#settings-delete');
  await D.waitForSelector('#delete-confirm');
  check('탈퇴 sheet: button disabled until the nickname is typed', await D.isDisabled('#delete-account'));
  await D.fill('#delete-confirm', '도라');
  check('…enabled once it matches', !(await D.isDisabled('#delete-account')));
  await sleep(1200);
  await D.screenshot({ path: resolve(shotDir, 'm7-delete-sheet.png') });
  const before = { cookie: d.cookieHeader() };
  await D.click('#delete-account');
  await D.waitForSelector('#entry-status:has-text("탈퇴가 끝났어요")', { timeout: 20000 });
  check(
    'after 탈퇴: back on the entry screen, signed out, with a goodbye',
    (await D.isVisible('#entry-signed-out')) && !(await D.isVisible('#entry-signed-in')) && !D.url().includes('deleted'),
    D.url(),
  );
  await sleep(500);

  const count = (sql, ...a) => db.prepare(sql).get(...a).n;
  const left = {
    users: count('SELECT COUNT(*) n FROM users WHERE id = ?', d.id),
    sessions: count('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', d.id),
    pages: count('SELECT COUNT(*) n FROM wordbook_pages WHERE user_id = ?', d.id),
    meditations: count('SELECT COUNT(*) n FROM meditations WHERE user_id = ?', d.id),
    lanterns: count('SELECT COUNT(*) n FROM lanterns WHERE user_id = ? OR id IN (?, ?)', d.id, L1.id, L2.id),
    reactions: count('SELECT COUNT(*) n FROM reactions WHERE user_id = ? OR lantern_id IN (?, ?)', d.id, L1.id, L2.id),
    saved: count('SELECT COUNT(*) n FROM saved_lanterns WHERE user_id = ? OR lantern_id IN (?, ?)', d.id, L1.id, L2.id),
    members: count('SELECT COUNT(*) n FROM group_members WHERE user_id = ?', d.id),
    reads: count('SELECT COUNT(*) n FROM group_reads WHERE user_id = ?', d.id),
    messages: count("SELECT COUNT(*) n FROM group_messages WHERE user_id = ? OR (kind = 'system' AND text LIKE '도라님이 %')", d.id),
    push: count('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id = ?', d.id),
    prefs: count('SELECT COUNT(*) n FROM push_prefs WHERE user_id = ?', d.id),
    groupsOwned: count('SELECT COUNT(*) n FROM groups WHERE owner_id = ?', d.id),
  };
  check('DB: no row of D is left in any table', Object.values(left).every((n) => n === 0), JSON.stringify(left));
  // Nothing personal anywhere: scan every text column of every table.
  const needles = ['도라', 'mock-m7-dora'];
  const hits = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) {
      for (const [col, v] of Object.entries(row)) if (typeof v === 'string' && needles.some((n) => v.includes(n))) hits.push(`${name}.${col}: ${v.slice(0, 40)}`);
    }
  }
  const okHits = hits.filter((h) => !h.startsWith('groups.name: 도라모임') && !/엘리님이 모임장/.test(h));
  check('DB: D\'s nickname/email appear nowhere (except the group name E now owns)', okHits.length === 0, okHits.join(' | '));
  const g1row = db.prepare('SELECT owner_id FROM groups WHERE id = ?').get(g1.id);
  check('group with members: ownership goes to the longest-standing member (E, not F)', g1row?.owner_id === e.id, JSON.stringify(g1row));
  check('group with nobody left is deleted', !db.prepare('SELECT 1 FROM groups WHERE id = ?').get(g2.id));
  const eGroups = (await e.json('GET', '/api/groups')).data.groups;
  check('E now sees herself as 모임장', eGroups.find((g) => g.id === g1.id)?.owner === true);
  check('E\'s 기록하기 copy of D\'s lantern is gone', !(await e.json('GET', '/api/wordbook')).data.saved.some((s) => s.lanternId === L1.id));
  const gone = of(wsE, 'lanternGone').map((m) => m.id);
  check('live: E sees both of D\'s lanterns disappear (public + group)', gone.includes(L1.id) && gone.includes(L2.id), JSON.stringify(gone));
  check('E\'s lantern list no longer has D\'s lanterns', !(await e.json('GET', '/api/lanterns')).data.lanterns.some((l) => l.id === L1.id || l.id === L2.id));
  const leNow = (await e.json('GET', `/api/lanterns/${LE.id}`)).data;
  const liveLE = of(wsE, 'lantern').filter((m) => m.lantern.id === LE.id).pop();
  check('reaction counts drop (D\'s 🤲 on E\'s lantern), also live', leNow.counts.pray === 0 && leNow.counts.record === 0 && liveLE?.lantern.counts.pray === 0, JSON.stringify(leNow.counts));
  check('voice: D left the room for E, D\'s socket was closed (4005)', of(wsE, 'voicePeerLeft').length >= 1 && wsD.closed === 4005, `closed=${wsD.closed}`);
  const sys = (await e.json('GET', `/api/groups/${g1.id}/messages`)).data.messages;
  check('E\'s group chat keeps E\'s message, drops D\'s, and notes the new 모임장', sys.some((m) => m.text === '엘리의 채팅 메시지') && !sys.some((m) => m.text.includes('도라')) && sys.some((m) => m.kind === 'system' && m.text.includes('엘리님이 모임장')));
  const oldCookie = new Agent();
  oldCookie.jar = new Map(before.cookie.split('; ').map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
  check('the old session cookie is rejected', (await oldCookie.json('GET', '/api/me')).data.user === null && (await meditate(oldCookie, 'x')).status === 401);
  const reuse = await account('m7-newdora', '도라');
  check('the nickname is available again', reuse.nickname === '도라');
  const reLogin = new Agent();
  await reLogin.login('m7-dora');
  check('logging in with the same Google account again starts fresh (nickname step)', (await reLogin.json('GET', '/api/me')).data.needsNickname === true);
  wsE.ws.close();

  // Rate limit on export (EXPORT_RATE_LIMIT=8 per user and per IP per hour in this run).
  let limited = false;
  for (let i = 0; i < 10 && !limited; i++) limited = (await f.json('GET', '/api/me/export')).status === 429;
  check('export is rate-limited', limited);

  // ---------------------------------------------------------------- sweep / retention rows
  step('sweep');
  // Rows the hourly 파기 sweep must remove (it also runs at server start): an
  // unfinished sign-up two days old, a lantern 내린 two days ago, one 9 days old;
  // and ones it must keep: a lantern 내린 an hour ago, a fresh unfinished sign-up.
  const now = Date.now();
  const H = 3_600_000;
  db.prepare("INSERT INTO users (google_sub, email, created_at) VALUES ('mock-m7-abandoned', 'x@example.test', ?)").run(now - 48 * H);
  db.prepare("INSERT INTO users (google_sub, email, created_at) VALUES ('mock-m7-fresh', 'y@example.test', ?)").run(now - H);
  const lan = db.prepare(
    `INSERT INTO lanterns (user_id, slot, date, ref, verse, translation, meditation, feeling, application, created_at, removed_at)
     VALUES (?, 90, '${DAY}', 'r', 'v', 't', ?, '', '', ?, ?)`,
  );
  lan.run(e.id, 'sweep-removed-old', now - 50 * H, now - 48 * H);
  lan.run(e.id, 'sweep-expired', now - 9 * 24 * H, null);
  lan.run(e.id, 'sweep-removed-recent', now - 2 * H, now - H);
  await stop(server);
  server = startServer(PORT, DB, serverEnv);
  await waitHttp(`${ORIGIN}/health`);
  const has = (sql, v) => !!db.prepare(sql).get(v);
  check(
    'sweep: unfinished sign-ups (1 day) and old lantern copies (내린: 1 day, expired: 7+1 days) are deleted; recent ones kept',
    !has('SELECT 1 FROM users WHERE google_sub = ?', 'mock-m7-abandoned') &&
      has('SELECT 1 FROM users WHERE google_sub = ?', 'mock-m7-fresh') &&
      !has('SELECT 1 FROM lanterns WHERE meditation = ?', 'sweep-removed-old') &&
      !has('SELECT 1 FROM lanterns WHERE meditation = ?', 'sweep-expired') &&
      has('SELECT 1 FROM lanterns WHERE meditation = ?', 'sweep-removed-recent') &&
      has('SELECT 1 FROM lanterns WHERE id = ?', LE.id),
  );

  // ---------------------------------------------------------------- backup pruning
  step('backup');
  rmSync(BACKUP_DIR, { recursive: true, force: true });
  mkdirSync(resolve(BACKUP_DIR, 'backups'), { recursive: true });
  const bdb = resolve(BACKUP_DIR, 'worlds.db');
  new Database(bdb).exec('CREATE TABLE t (x); INSERT INTO t VALUES (1);');
  for (let i = 1; i <= 6; i++) writeFileSync(resolve(BACKUP_DIR, 'backups', `worlds-2026010${i}-030000.db`), 'old');
  writeFileSync(resolve(BACKUP_DIR, 'backups', 'keep-me.txt'), 'not a backup');
  const run = (env) => spawnSync(process.execPath, ['scripts/backup.mjs'], { cwd: serverDir, encoding: 'utf-8', env: { ...process.env, WORLDS_DB: bdb, ...env } });
  const r1 = run({ BACKUP_KEEP: '3' });
  const after1 = readdirSync(resolve(BACKUP_DIR, 'backups')).sort();
  const dbs1 = after1.filter((n) => /^worlds-\d{8}-\d{6}\.db$/.test(n));
  check(
    'backup: BACKUP_KEEP=3 keeps the 3 newest (incl. the new one), deletes older, leaves other files',
    r1.status === 0 && dbs1.length === 3 && !dbs1.includes('worlds-20260101-030000.db') && dbs1.includes('worlds-20260106-030000.db') && dbs1.some((n) => !n.startsWith('worlds-202601')) && after1.includes('keep-me.txt'),
    `${r1.stdout.trim().split('\n').pop()} ${dbs1.join(',')}`,
  );
  for (let i = 10; i <= 29; i++) writeFileSync(resolve(BACKUP_DIR, 'backups', `worlds-202512${i}-030000.db`), 'old');
  const r2 = run({ BACKUP_KEEP: undefined });
  const dbs2 = readdirSync(resolve(BACKUP_DIR, 'backups')).filter((n) => /^worlds-\d{8}-\d{6}\.db$/.test(n));
  check('backup: default keeps 14', r2.status === 0 && dbs2.length === 14, `${dbs2.length}`);
  rmSync(BACKUP_DIR, { recursive: true, force: true });

  // ---------------------------------------------------------------- YouTube: no background play
  step('youtube');
  const yctx = await browser.newContext(desktop);
  await yctx.route('https://www.youtube.com/iframe_api', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: YT_STUB }));
  const Y = await yctx.newPage();
  await Y.goto(`${BASE}?test=1&shadows=0&time=14:00&date=${DAY}&noguide=1`);
  await Y.waitForSelector('#entry-signed-out:not([hidden])');
  await Y.fill('#nickname', '찬양듣기');
  await Y.click('#entry-submit');
  await until(Y, () => window.__WORLDS_DEBUG__?.ready && window.__WORLDS_DEBUG__.net?.status === 'online', null, 60000);
  const w = async () => (await debug(Y)).m3.worship;
  await until(Y, () => window.__WORLDS_DEBUG__.m3.worship.state === 'playing', null, 20000);
  const w0 = await w();
  check('worship player (stubbed YouTube API) is playing and on screen', w0.state === 'playing' && w0.effective !== 'folded', `${w0.state}/${w0.effective}`);
  // __WORLDS_DEBUG__ is republished every few frames: wait for it rather than sleeping.
  const waitW = (fn, ms = 15000) =>
    until(Y, fn, null, ms)
      .then(() => true)
      .catch(() => false);
  await setVisibility(Y, 'hidden');
  await waitW(() => window.__WORLDS_DEBUG__.m3.worship.state !== 'playing');
  const w1 = await w();
  check('page hidden → player paused (no background playback)', w1.state === 'paused' && w1.pausedForBackground && (await Y.evaluate(() => window.__ytCalls.slice(-1)[0])) === 'pause', JSON.stringify({ s: w1.state, p: w1.pausedForBackground }));
  await setVisibility(Y, 'visible');
  await waitW(() => window.__WORLDS_DEBUG__.m3.worship.state === 'playing');
  const w2 = await w();
  check('visible again → resumes, because it was playing before', w2.state === 'playing' && !w2.pausedForBackground && !w2.playedWhileHidden, w2.state);
  // Paused by the user, then hidden and back: stays paused.
  await Y.evaluate(() => window.__ytPlayer.pauseVideo());
  await waitW(() => window.__WORLDS_DEBUG__.m3.worship.state === 'paused');
  const callsBefore = await Y.evaluate(() => window.__ytCalls.length);
  await setVisibility(Y, 'hidden');
  await setVisibility(Y, 'visible');
  await sleep(1500);
  check('if it was paused before hiding, it stays paused on return', (await w()).state === 'paused' && (await Y.evaluate((n) => window.__ytCalls.slice(n).includes('play'), callsBefore)) === false);
  // pagehide also pauses.
  await Y.evaluate(() => window.__ytPlayer.playVideo());
  await waitW(() => window.__WORLDS_DEBUG__.m3.worship.state === 'playing');
  await Y.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await waitW(() => window.__WORLDS_DEBUG__.m3.worship.state === 'paused');
  check('pagehide pauses too', (await w()).state === 'paused');
  // A late autoplay while hidden is stopped at once.
  await setVisibility(Y, 'hidden');
  await Y.evaluate(() => window.__ytPlayer.playVideo());
  await waitW(() => window.__WORLDS_DEBUG__.m3.worship.playedWhileHidden === true);
  const w3 = await w();
  check('defensive: playback that starts while hidden is paused immediately', w3.state === 'paused' && w3.playedWhileHidden && (await Y.evaluate(() => window.__ytCalls.slice(-1)[0])) === 'pause');
  await setVisibility(Y, 'visible');
  await waitW(() => window.__WORLDS_DEBUG__.m3.worship.state === 'playing');
  check('…and resumes when visible', (await w()).state === 'playing');
  // window blur alone (second desktop window) does not stop the music.
  await Y.evaluate(() => window.dispatchEvent(new Event('blur')));
  await sleep(1500);
  check('window blur alone does not pause (desktop multi-window)', (await w()).state === 'playing');
  check('still exactly one player, never played while folded', (await w()).playedWhileFolded === false);
  await yctx.close();

  // ---------------------------------------------------------------- offline (service worker)
  step('offline');
  const sctx = await browser.newContext(desktop);
  const S = await sctx.newPage();
  await S.goto(BASE + Q());
  await S.evaluate(() => navigator.serviceWorker.ready);
  await S.reload();
  await until(S, () => !!navigator.serviceWorker.controller, null, 15000);
  await sctx.setOffline(true);
  await S.goto(`${ORIGIN}/privacy`).catch(() => undefined);
  const offPrivacy = await S.textContent('h1').catch(() => '');
  await S.goto(`${ORIGIN}/terms`).catch(() => undefined);
  const offTerms = await S.textContent('h1').catch(() => '');
  check('offline: /privacy and /terms open from the service worker cache', offPrivacy.includes('개인정보처리방침') && offTerms.includes('이용약관'), `${offPrivacy} / ${offTerms}`);
  await S.goto(BASE).catch(() => undefined);
  check('offline: / still opens the app shell', await S.evaluate(() => !!document.getElementById('world-canvas')).catch(() => false));
  await sctx.close();

  db.close();
} catch (err) {
  check(`no exception (at ${currentStep()})`, false, err?.stack?.split('\n').slice(0, 3).join(' | '));
} finally {
  await browser?.close();
  await stopAll();
  dropDb(DB);
  rmSync(DIST, { recursive: true, force: true });
}
process.exit(summary());
