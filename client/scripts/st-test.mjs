// 운영자 통계 (/admin) end-to-end:
//  - seeded accounts across fake days → the retention, cohort and first-day funnel numbers;
//  - guests and a non-admin account get a plain 404 on /admin (+ its files) and every stats API;
//  - an admin sees every section; a cross-site caller is refused the same way;
//  - deep scan: no seeded meditation/title/letter text, nickname, email or id key in any stats JSON;
//  - guest sessions and the device mix are counted without identifiers;
//  - 내 데이터 내려받기 includes active_days, 회원 탈퇴 removes them;
//  - the in-game ⚙ → 🛠️ 관리 link; the page at phone 390 and desktop 1280 without overflow (+ screenshots).
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { check, clientDir, currentStep, desktop, dropDb, freshDb, join, launch, loginJoin, serverDir, shotDir, sleep, startServer, step, stop, stopAll, summary, until, waitHttp } from './lib/harness.mjs';

const PORT = Number(process.env.TEST_SERVER_PORT ?? 5199);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/`;
const DB = freshDb('st');
const Database = createRequire(resolve(serverDir, 'package.json'))('better-sqlite3');
const ADMIN_HINT = 'stadmin';
const ADMIN_EMAIL = `mock-${ADMIN_HINT}@example.test`;
const DAY_MS = 86_400_000;
const kst = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const NOW = Date.now();
const TODAY = kst(NOW);
/** KST noon, n days ago. */
const noonAgo = (n) => Date.parse(`${kst(NOW - n * DAY_MS)}T03:00:00Z`);
const dayAgo = (n) => kst(NOW - n * DAY_MS);

const SECRETS = ['SECRET-MEDITATION-7341', '비밀묵상글귀', 'SECRET-TITLE-9921', 'SECRET-LETTER-5512', 'SECRET-REPLY-6620', 'LIVE-SECRET-8080', 'SECRET-CHAT-4411'];
const NICKS = ['시드하늘', '시드바다', '시드들꽃', '시드새벽', '시드노을', '시드구름', '통계관리', '통계사용자', '통계손님'];

const env = {
  WORLDS_AUTH_MOCK: '1',
  SERVE_CLIENT: '1',
  WORLDS_ADMIN_EMAILS: ADMIN_EMAIL,
  WORLDS_STATS_SAMPLE_MS: '1000',
  MAX_CONN_PER_IP: '60',
  AUTH_RATE_LIMIT: '300',
  QUIET: '1',
};

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
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, data, text, headers: res.headers };
  }
  async login(hint) {
    let url = `/api/auth/google/start?remember=1&hint=${encodeURIComponent(hint)}`;
    for (let i = 0; i < 8; i++) {
      const res = await this.raw('GET', url);
      const loc = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !loc) return url;
      url = new URL(loc, BASE).toString();
      if (!url.includes('/api/')) return url;
    }
    return url;
  }
}

async function account(hint, nickname) {
  const a = new Agent();
  await a.login(hint);
  const r = await a.json('POST', '/api/me/nickname', { nickname, agree: true });
  if (r.status !== 200) throw new Error(`nickname ${nickname}: ${r.text}`);
  a.id = r.data.user.id;
  a.nickname = nickname;
  return a;
}

/** Every key anywhere in a JSON value. */
function keysOf(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (out.add(k), keysOf(x, out));
  return out;
}

/** Seeds accounts and content directly in the DB (the server is stopped). */
function seed() {
  const db = new Database(DB);
  db.pragma('foreign_keys = ON');
  const addUser = (i, signupMs, active, m = {}) => {
    const nick = NICKS[i];
    const id = Number(
      db
        .prepare(
          `INSERT INTO users (google_sub, email, email_verified, nickname, nickname_key, created_at, terms_agreed_at, terms_version,
             first_entry_at, first_letter_at, first_meditation_at, first_lantern_at) VALUES (?, ?, 1, ?, ?, ?, ?, 'seed', ?, ?, ?, ?)`,
        )
        .run(`seed${i}`, `seed${i}@example.test`, nick, nick, signupMs, signupMs, m.entry ?? null, m.letter ?? null, m.med ?? null, m.lantern ?? null).lastInsertRowid,
    );
    const signup = kst(signupMs);
    for (const n of active) db.prepare('INSERT OR IGNORE INTO active_days (user_id, kst_date) VALUES (?, ?)').run(id, kst(Date.parse(`${signup}T03:00:00Z`) + n * DAY_MS));
    return id;
  };
  const h = 3600_000;
  // A, B: signed up 40 days ago (outside the 30-day funnel window). A also today.
  const a = addUser(0, noonAgo(40), [0, 1, 7, 30, 40]);
  addUser(1, noonAgo(40), [0, 1]);
  // C: 10 days ago, every first-day step within 24 h; back on day 7.
  const c = addUser(2, noonAgo(10), [0, 7], { entry: noonAgo(10) + h, letter: noonAgo(10) + 2 * h, med: noonAgo(10) + 3 * h, lantern: noonAgo(10) + 4 * h });
  // D: 3 days ago, back on day 1; meditation only after 30 h (so the funnel stops at the letter).
  addUser(3, noonAgo(3), [0, 1], { entry: noonAgo(3) + h, letter: noonAgo(3) + 2 * h, med: noonAgo(3) + 30 * h });
  // E: signed up an hour ago (pending in the funnel, no retention day yet).
  addUser(4, NOW - h, [0], { entry: NOW - h + 60_000 });
  // F: 5 days ago, never came back, nothing done.
  addUser(5, noonAgo(5), [0]);

  // Content with recognisable text: none of it may ever appear in a stats response.
  db.prepare("INSERT INTO meditations (user_id, date, place, meditation, feeling, application, created_at, updated_at) VALUES (?, ?, '골방', ?, ?, '', ?, ?)").run(
    c,
    dayAgo(10),
    SECRETS[0],
    SECRETS[1],
    noonAgo(10),
    noonAgo(10),
  );
  const sid = Number(
    db
      .prepare(
        "INSERT INTO stories (user_id, kind, shelf, title, parts, visibility, kst_date, created_at, updated_at) VALUES (?, 'testimony', 'testimony', ?, ?, 'public', ?, ?, ?)",
      )
      .run(a, SECRETS[2], JSON.stringify([SECRETS[2]]), dayAgo(2), noonAgo(2), noonAgo(2)).lastInsertRowid,
  );
  const lid = Number(db.prepare('INSERT INTO story_letters (story_id, user_id, text, created_at) VALUES (?, ?, ?, ?)').run(sid, c, SECRETS[3], noonAgo(1)).lastInsertRowid);
  db.prepare('INSERT INTO story_letters (story_id, parent_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)').run(sid, lid, a, SECRETS[4], noonAgo(1));
  // A reported letter waiting for review (관리 대기).
  db.prepare("INSERT INTO letter_reports (letter_id, reporter_id, reason, created_at) VALUES (?, ?, 'spam', ?)").run(lid, a, noonAgo(1));
  // An old concurrency peak.
  db.prepare('INSERT INTO concurrency (kst_date, hour, samples, total, peak) VALUES (?, 21, 12, 60, 9)').run(dayAgo(6));
  // Collection "began" 20 days ago; older counters stand for best-effort backfills.
  db.prepare("UPDATE stats_meta SET value = ? WHERE key = 'collect_start'").run(dayAgo(20));
  // Realistic-looking aggregate history (yesterday and before) for the charts and screenshots.
  const wave = (d, base, amp) => Math.max(0, Math.round(base + amp * Math.sin(d / 3.1) + ((d * 7) % 5) - 2));
  const put = db.prepare('INSERT INTO daily_counts (kst_date, key, n) VALUES (?, ?, ?) ON CONFLICT (kst_date, key) DO UPDATE SET n = excluded.n');
  const keys = { meditation: [6, 3], lantern_public: [3, 2], lantern_group: [2, 1], lantern_anon: [1, 1], testimony: [1, 1], diary: [2, 1], letter: [2, 2], reply: [1, 1], chat_campfire: [14, 8], chat_group: [9, 5], react_pray: [8, 4], react_empathy: [10, 5], emote: [12, 6], voice_campfire: [2, 2], voice_group: [1, 1], rental: [3, 2], session_guest: [5, 3] };
  for (let d = 1; d <= 60; d++) {
    for (const [k, [base, amp]] of Object.entries(keys)) put.run(dayAgo(d), k, wave(d, base, amp));
    const phone = wave(d, 9, 3);
    const desk = wave(d + 2, 4, 2);
    const tablet = wave(d + 5, 1, 1);
    put.run(dayAgo(d), 'device_phone', phone);
    put.run(dayAgo(d), 'device_desktop', desk);
    put.run(dayAgo(d), 'device_tablet', tablet);
    put.run(dayAgo(d), 'pwa_standalone', Math.round(phone / 3));
    put.run(dayAgo(d), 'pwa_browser', phone + desk + tablet - Math.round(phone / 3));
    put.run(dayAgo(d), 'session_total', phone + desk + tablet);
  }
  const conc = db.prepare('INSERT OR IGNORE INTO concurrency (kst_date, hour, samples, total, peak) VALUES (?, ?, 12, ?, ?)');
  for (let d = 1; d <= 21; d++) {
    for (let hr = 5; hr < 24; hr++) {
      const evening = hr >= 20 && hr <= 22 ? 3 : hr >= 6 && hr <= 7 ? 2 : 0;
      const avg = Math.max(0, Math.round(((d + hr) % 3) / 2 + evening + (d % 7 === 0 ? 1 : 0)));
      conc.run(dayAgo(d), hr, avg * 12, Math.min(6, avg + 1));
    }
  }
  db.close();
}

let browser;
let server;
try {
  step('migrate');
  server = startServer(PORT, DB, env);
  await waitHttp(`${ORIGIN}/health`);
  await stop(server);
  step('seed');
  seed();
  server = startServer(PORT, DB, env);
  await waitHttp(`${ORIGIN}/health`);
  const adminAsset = readdirSync(resolve(clientDir, 'dist/admin/assets')).find((f) => f.endsWith('.js'));

  // ------------------------------------------------------------------ 404 for everyone else
  step('404');
  const targets = ['/admin', '/admin/', '/admin.html', `/admin/assets/${adminAsset}`, '/admin/assets/../index.html', '/api/admin/stats', '/api/admin/stats?fresh=1', '/api/admin/stats/system'];
  const guest = new Agent();
  const user = await account('stuser', NICKS[7]);
  for (const [who, agent] of [
    ['guest', guest],
    ['non-admin', user],
  ]) {
    const res = await Promise.all(targets.map((t) => agent.json('GET', t)));
    check(
      `${who}: 404 on /admin, its files and every stats API (no dashboard markup, never cached)`,
      res.every((r) => r.status === 404 && !r.text.includes('운영 통계') && !r.text.includes('collectStart')) &&
        res.slice(0, 5).every((r) => /no-store/.test(r.headers.get('cache-control') ?? '')),
      res.map((r) => r.status).join(','),
    );
  }

  // ------------------------------------------------------------------ admin
  step('admin');
  const admin = await account(ADMIN_HINT, NICKS[6]);
  const page = await admin.json('GET', '/admin');
  check('admin: /admin serves the dashboard shell (private, no-store, CSP self-only, noindex)', page.status === 200 && page.text.includes('QT 월드 운영 통계') && /no-store/.test(page.headers.get('cache-control') ?? '') && /script-src 'self'/.test(page.headers.get('content-security-policy') ?? '') && page.headers.get('x-robots-tag') === 'noindex');
  const asset = await admin.raw('GET', `/admin/assets/${adminAsset}`);
  check('admin: the dashboard script loads (private, no-store)', asset.status === 200 && /no-store/.test(asset.headers.get('cache-control') ?? ''));
  const cross = await admin.json('GET', '/api/admin/stats', undefined, { origin: 'http://evil.example' });
  const crossPage = await admin.json('GET', '/admin', undefined, { 'sec-fetch-site': 'cross-site' });
  check('admin from another site: 404 as well (API and page)', cross.status === 404 && crossPage.status === 404, `${cross.status} ${crossPage.status}`);

  // Live activity: a meditation, guest and signed-in sessions on two device classes.
  step('live');
  const med = await user.json('POST', '/api/wordbook/meditations', { date: TODAY, place: '골방', meditation: SECRETS[5], feeling: '', application: '' });
  const lantern = await user.json('POST', '/api/lanterns', { meditationId: med.data?.id, visibility: 'public', anonymous: true });
  check('setup: a live meditation was saved and shared as an anonymous lantern', med.status === 201 && lantern.status === 201, `${med.status} ${lantern.status} ${lantern.text.slice(0, 80)}`);
  browser = await launch();
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const guestPage = await phoneCtx.newPage();
  await join(guestPage, BASE, NICKS[8], '?test=1&shadows=0&noguide=1');
  const deskCtx = await browser.newContext({ ...desktop });
  const adminPage = await deskCtx.newPage();
  await loginJoin(adminPage, BASE, ADMIN_HINT, NICKS[6], '?test=1&shadows=0&noguide=1');
  // Campfire chat isn't stored anywhere; only the count. Wait for at least two 1 s concurrency samples.
  await sleep(2500);

  // ⚙ → 🛠️ 관리 → 📊 운영 통계 link (admins only).
  await until(adminPage, () => window.__WORLDS_DEBUG__.m8?.admin === true, null, 15000);
  await adminPage.click('#btn-settings');
  await adminPage.click('#settings-nav-admin');
  await adminPage.waitForSelector('#settings-admin-stats');
  const href = await adminPage.getAttribute('#settings-admin-stats', 'href');
  check('in-game ⚙ → 🛠️ 관리 shows the 📊 운영 통계 link to /admin', href === '/admin');

  const s = (await admin.json('GET', '/api/admin/stats?fresh=1')).data;
  const sys = (await admin.json('GET', '/api/admin/stats/system')).data;
  check('admin: every section is in the stats response', s && ['visits', 'retention', 'funnel', 'activity', 'together', 'devices', 'pending'].every((k) => k in s) && s.days.length === 90 && s.days.at(-1) === TODAY);
  check('admin: system status (uptime, DB size, backups, weather) without secrets', sys && sys.uptimeS >= 0 && sys.dbBytes > 0 && 'backups' in sys && 'weather' in sys && !/KEY|TOKEN|SECRET|VAPID/i.test(JSON.stringify(sys)));

  // ------------------------------------------------------------------ numbers
  step('numbers');
  const at = (arr, daysAgo) => arr[arr.length - 1 - daysAgo];
  check('DAU on the A/B sign-up day = 2, and their next day = 2', at(s.visits.dau, 40) === 2 && at(s.visits.dau, 39) === 2, `${at(s.visits.dau, 40)} ${at(s.visits.dau, 39)}`);
  check('DAU today counts A plus the live accounts (>= 3)', at(s.visits.dau, 0) >= 3, String(at(s.visits.dau, 0)));
  check('MAU ≥ WAU ≥ DAU today', at(s.visits.mau, 0) >= at(s.visits.wau, 0) && at(s.visits.wau, 0) >= at(s.visits.dau, 0));
  check('sign-ups per day: 2 on day -40, 1 on day -10', at(s.visits.signups, 40) === 2 && at(s.visits.signups, 10) === 1);
  const o = s.retention.overall;
  check('overall D1 (last 30 days): C, D, F eligible, only D back → 1/3', o.d1.eligible === 3 && o.d1.active === 1, JSON.stringify(o.d1));
  check('overall D7: C eligible and back → 1/1', o.d7.eligible === 1 && o.d7.active === 1, JSON.stringify(o.d7));
  check('overall D30: nobody eligible yet → 데이터 수집 중', o.d30.eligible === 0, JSON.stringify(o.d30));
  const mondayOf = (d) => {
    const dow = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
    return kst(Date.parse(`${d}T00:00:00Z`) - dow * DAY_MS + 12 * 3600_000 - 9 * 3600_000);
  };
  const abRow = s.retention.cohorts.find((r) => r.week === mondayOf(dayAgo(40)));
  check(
    'cohort of the A/B week: D1 2/2, D7 1/2, D30 1/2, all marked estimated (before collection)',
    abRow && abRow.size === 2 && abRow.d1.active === 2 && abRow.d1.eligible === 2 && abRow.d7.active === 1 && abRow.d30.active === 1 && abRow.d30.eligible === 2 && abRow.d1.estimated,
    JSON.stringify(abRow),
  );
  const thisWeek = s.retention.cohorts[0];
  check('this week’s cohort: D30 is 데이터 수집 중', thisWeek.week === mondayOf(TODAY) && thisWeek.d30.eligible === 0);
  const f = s.funnel.steps.map((x) => x.n);
  check('first-day funnel (C, D, F): 3 → 2 → 2 → 1 → 1, recent sign-ups pending', f.join(',') === '3,2,2,1,1' && s.funnel.pending >= 1, `${f.join(',')} pending ${s.funnel.pending}`);
  check(
    'activity: today’s live meditation and anonymous lantern are counted (counters only), history kept',
    at(s.activity.meditation, 0) === 1 && at(s.activity.lantern_anon, 0) === 1 && at(s.activity.lantern_public, 0) === 0 && at(s.activity.meditation, 5) > 0,
    `${at(s.activity.meditation, 0)} ${at(s.activity.lantern_anon, 0)}`,
  );
  check('guest session counted (no identifiers), sessions ≥ 2', at(s.visits.guestSessions, 0) >= 1 && at(s.visits.sessions, 0) >= 2, `${at(s.visits.guestSessions, 0)} / ${at(s.visits.sessions, 0)}`);
  check('device mix: a phone and a desktop session; PWA counted as browser', s.devices.mix.phone >= 1 && s.devices.mix.desktop >= 1 && s.devices.pwa.browser >= 2, JSON.stringify(s.devices));
  const wd = (new Date(`${TODAY}T00:00:00Z`).getUTCDay() + 6) % 7;
  const hour = new Date(Date.now() + 9 * 3600_000).getUTCHours();
  check('concurrency sampled into today’s weekday × hour (max ≥ 2)', (s.together.max[wd][hour] ?? 0) >= 2 && s.together.peak.players === 9, `${s.together.max[wd][hour]} peak ${s.together.peak.players}`);
  check('관리 대기: the reported letter is pending', s.pending.letters === 1, JSON.stringify(s.pending));
  {
    const db = new Database(DB, { readonly: true });
    const keys = db.prepare('SELECT DISTINCT key FROM daily_counts').all().map((r) => r.key);
    const cols = db.prepare('PRAGMA table_info(daily_counts)').all().map((r) => r.name).join(',');
    db.close();
    check('daily_counts holds only (date, key, n) with known aggregate keys', cols === 'kst_date,key,n' && keys.every((k) => /^(session_(total|guest)|device_(phone|tablet|desktop)|pwa_(standalone|browser)|[a-z_]+)$/.test(k) && k.length < 24), keys.join(','));
  }

  // ------------------------------------------------------------------ privacy deep scan
  step('privacy');
  const bodies = [
    (await admin.json('GET', '/api/admin/stats?fresh=1')).text,
    (await admin.json('GET', '/api/admin/stats')).text,
    (await admin.json('GET', '/api/admin/stats/system')).text,
  ];
  const needles = [...SECRETS, ...NICKS, 'example.test', '@', ...[0, 1, 2, 3, 4, 5].map((i) => `seed${i}`)];
  const leaks = needles.filter((n) => bodies.some((b) => b.includes(n)));
  check('deep scan: no seeded text, title, letter, nickname or email in any stats response', leaks.length === 0, leaks.join(','));
  const keys = new Set(bodies.flatMap((b) => [...keysOf(JSON.parse(b))]));
  const bad = [...keys].filter((k) => /^(id|ids|userId|user_id|email|nickname|name|text|title|ip|account)$/i.test(k));
  check('deep scan: no id / user / email / nickname / text / ip keys anywhere', bad.length === 0, bad.join(','));

  // ------------------------------------------------------------------ export and 탈퇴
  step('account');
  const exp = await user.json('GET', '/api/me/export');
  check('내 데이터 내려받기 includes the active days (today) and first-time milestones', exp.data?.usageStats?.activeDays?.includes(TODAY) && !!exp.data.usageStats.firstTimes.meditationSaved && !!exp.data.usageStats.firstTimes.lanternShared, JSON.stringify(exp.data?.usageStats));
  const del = await user.json('POST', '/api/me/delete', { nickname: NICKS[7] });
  {
    const db = new Database(DB, { readonly: true });
    const left = db.prepare('SELECT COUNT(*) n FROM active_days WHERE user_id = ?').get(user.id).n;
    db.close();
    check('회원 탈퇴 removes that account’s active days', del.status === 200 && left === 0, `${del.status} left ${left}`);
  }

  // ------------------------------------------------------------------ the page
  step('page');
  const cookies = [...admin.jar].map(([name, value]) => ({ name, value, url: ORIGIN }));
  const shots = [];
  for (const [label, opts] of [
    ['desktop', { viewport: { width: 1280, height: 900 } }],
    ['phone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
    ['dark', { viewport: { width: 1280, height: 900 }, colorScheme: 'dark' }],
  ]) {
    const ctx = await browser.newContext(opts);
    await ctx.addCookies(cookies);
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const requests = [];
    p.on('request', (r) => requests.push(r.url()));
    await p.goto(`${ORIGIN}/admin`);
    await p.waitForSelector('#st-cohort', { timeout: 20000 });
    const info = await p.evaluate(() => ({
      sections: ['st-visits', 'st-retention', 'st-funnel', 'st-activity', 'st-together', 'st-devices', 'st-pending'].filter((id) => document.getElementById(id)).length,
      svgs: document.querySelectorAll('#admin svg').length,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      wide: [...document.querySelectorAll('#admin *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('details')).length,
      cohortFits: (() => {
        const w = document.querySelector('#st-cohort').closest('.st-table-wrap');
        return w.scrollWidth <= w.clientWidth + 1;
      })(),
      metrics: document.querySelectorAll('#st-activity [data-metric]').length,
      collecting: document.body.textContent.includes('데이터 수집 중'),
    }));
    check(
      `${label}: every section renders with SVG charts, no horizontal overflow, no errors, nothing from another origin`,
      info.sections === 7 && info.svgs >= 18 && info.overflow <= 0 && info.wide === 0 && info.cohortFits && info.metrics === 14 && info.collecting && errors.length === 0 && requests.every((u) => u.startsWith(ORIGIN)),
      JSON.stringify({ ...info, errors: errors.slice(0, 2) }),
    );
    if (label === 'desktop') {
      // Hover: a crosshair tooltip on the visits chart; range toggle re-renders.
      const box = await p.locator('#st-visits .st-card.is-wide svg').boundingBox();
      await p.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
      const tipText = await p.textContent('#st-tip');
      check('hover shows a tooltip with DAU, WAU and MAU', /DAU/.test(tipText) && /MAU/.test(tipText), tipText);
      await p.mouse.move(0, 0);
      await p.screenshot({ path: resolve(shotDir, 'st-desktop-overview.png') });
      await p.locator('#st-retention').screenshot({ path: resolve(shotDir, 'st-retention-cohort.png') });
      await p.locator('#st-funnel').screenshot({ path: resolve(shotDir, 'st-funnel.png') });
      await p.click('.st-filter button[data-value="90"]');
      await p.locator('#st-activity').screenshot({ path: resolve(shotDir, 'st-activity.png') });
      await p.locator('#st-together').screenshot({ path: resolve(shotDir, 'st-together-devices.png') });
      check('range toggle (90일) re-renders the charts', (await p.locator('.st-filter button[data-value="90"]').getAttribute('aria-pressed')) === 'true');
      shots.push('st-desktop-overview', 'st-retention-cohort', 'st-funnel', 'st-activity', 'st-together-devices');
    } else if (label === 'phone') {
      await p.screenshot({ path: resolve(shotDir, 'st-phone.png') });
      for (const [id, name] of [
        ['st-retention', 'st-phone-retention'],
        ['st-funnel', 'st-phone-funnel'],
        ['st-together', 'st-phone-together'],
      ]) {
        await p.evaluate((x) => {
          const bar = document.querySelector('.st-filter').getBoundingClientRect().height;
          const top = document.getElementById(x).getBoundingClientRect().top + window.scrollY - bar - 8;
          window.scrollTo(0, top);
        }, id);
        await p.screenshot({ path: resolve(shotDir, `${name}.png`) });
        shots.push(name);
      }
      shots.push('st-phone');
    } else {
      await p.screenshot({ path: resolve(shotDir, 'st-desktop-dark.png'), fullPage: false });
      shots.push('st-desktop-dark');
    }
    await ctx.close();
  }
  console.log(`screenshots: ${shots.map((x) => `docs/screenshots/${x}.png`).join(', ')}`);
} catch (err) {
  check(`no exception (step: ${currentStep()})`, false, err.stack ?? String(err));
} finally {
  await browser?.close().catch(() => undefined);
  await stopAll();
  dropDb(DB);
}
process.exit(summary());
