// L-A test: 이야기 도서관 (shared interior, desks, the two bookcases), 발자취, 📸 photos,
// 🙏 testimonies, 📔 the template diary, 공감/책갈피/readers, reports + admin,
// the personal-info warning, export/deletion (incl. photo files), and the
// worship player inside the library with sheets open.
// One server serves the built client (SERVE_CLIENT). Port: TEST_SERVER_PORT (5194).
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/la-test.mjs
// LA_ONLY=api,day,library,layout,yt,account runs a subset (some phases need earlier ones).
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  check,
  currentStep,
  debug,
  dropDb,
  freshDb,
  launch,
  loginJoin,
  of,
  rawClient,
  serverDir,
  shotDir,
  sleep,
  startServer,
  step,
  stopAll,
  summary,
  teleport,
  until,
  waitHttp,
} from './lib/harness.mjs';
import { overlaps } from './lib/tablet.mjs';

const PORT = Number(process.env.TEST_SERVER_PORT ?? 5194);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const Q = (time = '14:00') => `?test=1&shadows=0&time=${time}&noguide=1`;
const DB = freshDb('la');
const SHOTS = resolve(serverDir, 'data/test/la-shots');
const Database = createRequire(resolve(serverDir, 'package.json'))('better-sqlite3');
const P = await import(pathToFileURL(resolve(serverDir, 'dist/shared/protocol.js')).href);
const ONLY = (process.env.LA_ONLY ?? '').split(',').filter(Boolean);
const run = (phase) => ONLY.length === 0 || ONLY.includes(phase);
const TODAY = P.kstDateOf(Date.now());
const NICK = { a: '가람', b: '나래', c: '다솜', d: '라온', r1: '마루', r2: '바다', admin: '관리자' };

const YT_STUB = `
window.YT = { Player: function (el, opts) {
  var fire = function (s) { if (opts.events && opts.events.onStateChange) opts.events.onStateChange({ data: s }); };
  this.playVideo = function () { fire(1); };
  this.pauseVideo = function () { fire(2); };
  this.loadVideoById = function () { fire(1); };
  this.cueVideoById = function () { fire(5); };
  this.seekTo = function () {};
  this.setVolume = function () {};
  this.mute = function () {};
  this.unMute = function () {};
  this.destroy = function () {};
  this.getVideoData = function () { return { video_id: opts.videoId }; };
  var f = document.createElement('iframe'); f.src = 'https://www.youtube-nocookie.com/embed/' + opts.videoId; f.style.width = '100%'; f.style.height = '100%'; f.style.border = '0'; el.replaceWith(f);
  setTimeout(function () { if (opts.events && opts.events.onReady) opts.events.onReady(); }, 50);
} };
setTimeout(function () { if (window.onYouTubeIframeAPIReady) window.onYouTubeIframeAPIReady(); }, 0);
`;

class Agent {
  constructor() {
    this.jar = new Map();
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
  async raw(method, path, body, type) {
    const binary = body instanceof Uint8Array || body instanceof Buffer;
    const res = await fetch(path.startsWith('http') ? path : ORIGIN + path, {
      method,
      redirect: 'manual',
      headers: {
        ...(this.jar.size ? { cookie: this.cookieHeader() } : {}),
        ...(body !== undefined ? { 'content-type': type ?? 'application/json' } : {}),
      },
      body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
    });
    this.absorb(res);
    return res;
  }
  async json(method, path, body, type) {
    const res = await this.raw(method, path, body, type);
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* none */
    }
    return { status: res.status, data, text };
  }
  async login(hint) {
    let url = `/api/auth/google/start?remember=1&hint=${encodeURIComponent(hint)}`;
    for (let i = 0; i < 8; i++) {
      const res = await this.raw('GET', url);
      const loc = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !loc) return;
      url = new URL(loc, ORIGIN + '/').toString();
      if (!url.includes('/api/')) return;
    }
  }
}
async function account(hint, nickname) {
  const a = new Agent();
  await a.login(hint);
  const r = await a.json('POST', '/api/me/nickname', { nickname, agree: true });
  if (r.status !== 200) throw new Error(`nickname ${nickname}: ${JSON.stringify(r.data)}`);
  a.id = r.data.user.id;
  a.nickname = nickname;
  a.hint = hint;
  return a;
}
/** Browser context signed in as an existing account (same mock hint → same account). */
async function contextFor(browser, agent, opts = {}) {
  const ctx = await browser.newContext({ deviceScaleFactor: 1, ...opts });
  await ctx.addCookies([...agent.jar].map(([name, value]) => ({ name, value, url: ORIGIN })));
  await ctx.route('https://www.youtube.com/iframe_api', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: YT_STUB }));
  return ctx;
}
async function enterWorld(page, query) {
  await page.goto(BASE + query);
  await page.waitForSelector('#entry-signed-in:not([hidden]), #entry-signed-out:not([hidden])');
  if (await page.isVisible('#entry-continue')) await page.click('#entry-continue');
  else {
    await page.fill('#nickname', `손님${Math.floor(Math.random() * 90 + 10)}`);
    await page.click('#entry-submit');
  }
  await until(page, () => window.__WORLDS_DEBUG__?.ready && window.__WORLDS_DEBUG__.net?.status === 'online', null, Number(process.env.TEST_ONLINE_MS ?? 150000));
}
const la = async (page) => (await debug(page)).la;
const modalIs = (p, name, ms = 15000) => until(p, (n) => window.__WORLDS_DEBUG__.m3.modal === n, name, ms);
const db = () => new Database(DB, { readonly: true });
const count = (sql, ...args) => {
  const d = db();
  try {
    return d.prepare(sql).get(...args).n;
  } finally {
    d.close();
  }
};

/** Probe for the worship player vs sheets/HUD (from b1-test). */
function probe(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      if (!el) return null;
      const s = getComputedStyle(el);
      if (el.hidden || s.display === 'none' || s.visibility === 'hidden') return null;
      for (let e = el; e; e = e.parentElement) if (Number(getComputedStyle(e).opacity) === 0) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    };
    const q = (s) => vis(document.querySelector(s));
    const title = document.querySelector('.overlay .book-title');
    const t = vis(title);
    let titleOnTop = false;
    if (t) {
      const hit = document.elementFromPoint(t.x + Math.min(t.width / 2, 40), t.y + t.height / 2);
      titleOnTop = !!hit && (title === hit || title.contains(hit));
    }
    // Nothing drawn over the video: the topmost element at its centre and corners belongs to the player.
    const f = q('#worship .worship-frame');
    const w = document.getElementById('worship');
    const covered = [];
    if (f) {
      for (const [x, y] of [[0.5, 0.5], [0.08, 0.08], [0.92, 0.08], [0.08, 0.92], [0.92, 0.92]]) {
        const hit = document.elementFromPoint(f.x + f.width * x, f.y + f.height * y);
        if (!hit || !w.contains(hit)) covered.push(`${x},${y}:${hit ? hit.id || hit.className : 'none'}`);
      }
    }
    return { vw: innerWidth, vh: innerHeight, card: q('#worship'), frame: f, sheet: q('.overlay .sheet'), title: t, titleOnTop, covered };
  });
}
const inside = (r, vw, vh) => !!r && r.x >= -0.5 && r.y >= -0.5 && r.x + r.width <= vw + 0.5 && r.y + r.height <= vh + 0.5;
const fmt = (r) => (r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` : 'none');

/** A WebP whose VP8X header claims 2000×2000 (valid magic, too large). */
function bigWebp() {
  const b = Buffer.alloc(200);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(192, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(1999, 24, 3);
  b.writeUIntLE(1999, 27, 3);
  return b;
}

let browser;
const shotPath = (name) => resolve(shotDir, `la-${name}.png`);
/** Screenshots of the two-bookcase library (docs/screenshots/lib2-*). */
const lib2Path = (name) => resolve(shotDir, `lib2-${name}.png`);
try {
  rmSync(SHOTS, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  startServer(PORT, DB, {
    WORLDS_AUTH_MOCK: '1',
    SERVE_CLIENT: '1',
    WORLDS_SHOTS_DIR: SHOTS,
    WORLDS_FOOTPRINT_TICK_MS: '1000',
    MAX_CONN_PER_IP: '80',
    AUTH_RATE_LIMIT: '400',
    NEW_ACCOUNTS_PER_HOUR: '500',
    IP_RATE_LIMIT: '5000',
    WORLDS_ADMIN_EMAILS: 'MOCK-la-admin@example.test',
  });
  await waitHttp(`${ORIGIN}/health`);

  step('accounts');
  const A = await account('la-a', NICK.a);
  const B = await account('la-b', NICK.b);
  const C = await account('la-c', NICK.c);
  const D = await account('la-d', NICK.d);
  const R1 = await account('la-r1', NICK.r1);
  const R2 = await account('la-r2', NICK.r2);
  const ADM = await account('la-admin', NICK.admin);
  const guest = new Agent();
  const g = (await A.json('POST', '/api/groups', { name: '새벽 모임' })).data;
  await B.json('POST', '/api/groups/join', { code: g.code });
  check('setup: A made a group, B joined', !!g.id && (await B.json('GET', '/api/groups')).data.groups.some((x) => x.id === g.id));

  // ================================================================ API: testimonies
  const T = {};
  if (run('api') || run('day') || run('account') || run('library')) {
    step('testimony api');
    // No shelf (topic) any more: two bookcases, testimonies all go to 🙏 하나님 이야기.
    const base = { title: '광야에서 들은 소리', parts: ['몹시 힘든 한 해였어요. 일도 사람도 다 떠났어요.', '새벽에 시편을 읽다가 울었어요.', '이제는 매일 아침 감사로 시작해요.'] };
    check('guest cannot write (401)', (await guest.json('POST', '/api/library/stories', { ...base, visibility: 'public' })).status === 401);
    const bad = [
      [{ ...base, parts: ['짧', '', ''], visibility: 'public' }, 400, 'too short'],
      [{ ...base, parts: ['가'.repeat(1500), '나'.repeat(1501), ''], visibility: 'public' }, 400, '> 3000 chars'],
      [{ ...base, parts: ['a', 'b'], visibility: 'public' }, 400, 'two parts'],
      [{ ...base, ref: '요한복음 99:1', visibility: 'public' }, 400, 'bad Bible reference'],
      [{ ...base, visibility: 'group', groupId: 999999 }, 403, 'not a member'],
      [{ ...base, visibility: 'friends' }, 400, 'bad visibility'],
    ];
    for (const [body, status, label] of bad) {
      const r = await A.json('POST', '/api/library/stories', body);
      check(`testimony rejected: ${label} (${status})`, r.status === status, `${r.status} ${r.data?.error}`);
    }
    const pub = await A.json('POST', '/api/library/stories', { ...base, ref: '  요한복음   3:16 ', visibility: 'public' });
    T.pub = pub.data.id;
    check('public testimony: ref normalised and verse text from the Bible file', pub.status === 201 && pub.data.ref === '요한복음 3:16' && /하나님이 세상을/.test(pub.data.verse ?? ''), `${pub.status} ${pub.data?.ref} ${pub.data?.verse?.slice(0, 20)}`);
    // An older client still sends a topic: accepted, and ignored.
    T.group = (await A.json('POST', '/api/library/stories', { ...base, title: '모임 이야기', shelf: 'answer', visibility: 'group', groupId: g.id })).data.id;
    T.anon = (await A.json('POST', '/api/library/stories', { ...base, title: '익명으로 쓰는 감사', visibility: 'anonymous' })).data.id;
    T.priv = (await A.json('POST', '/api/library/stories', { ...base, title: '나만 보는 기도', visibility: 'private' })).data.id;
    check('each visibility published (no shelf needed)', [T.pub, T.group, T.anon, T.priv].every(Number.isInteger), JSON.stringify(T));
    check("new testimonies carry no topic (stored as 'story', also when an old client sends one)", count("SELECT COUNT(*) n FROM stories WHERE kind = 'testimony' AND shelf = 'story'") === 4);
    check('book JSON has no shelf/topic field', !('shelf' in pub.data) && !('shelf' in (await A.json('GET', `/api/library/stories/${T.group}`)).data));

    const see = async (agent, id) => (await agent.json('GET', `/api/library/stories/${id}`)).status;
    check('guest: public 200, group 404, anonymous 200, private 404', (await see(guest, T.pub)) === 200 && (await see(guest, T.group)) === 404 && (await see(guest, T.anon)) === 200 && (await see(guest, T.priv)) === 404);
    check('member B sees the group book', (await see(B, T.group)) === 200);
    check('non-member C: group 404, private 404', (await see(C, T.group)) === 404 && (await see(C, T.priv)) === 404);
    check('author A sees all four', (await Promise.all([T.pub, T.group, T.anon, T.priv].map((id) => see(A, id)))).every((s) => s === 200));
    const shelfC = await C.json('GET', '/api/library/shelves/testimony');
    check('🙏 bookcase list (C): public + anonymous, no group or private book', shelfC.status === 200 && shelfC.data.items.some((i) => i.id === T.pub) && shelfC.data.items.some((i) => i.id === T.anon) && !shelfC.data.items.some((i) => i.id === T.group || i.id === T.priv));
    const shelfB = await B.json('GET', '/api/library/shelves/testimony');
    check('🙏 bookcase list (B): group book listed with its group', shelfB.data.items.some((i) => i.id === T.group && i.group === '새벽 모임'));
    const shelfA = (await A.json('GET', '/api/library/shelves/testimony')).data.items.map((i) => i.id);
    check('🙏 bookcase list: every visible testimony, newest first', JSON.stringify(shelfA) === JSON.stringify([T.priv, T.anon, T.group, T.pub]), JSON.stringify(shelfA));
    check('📔 bookcase list: diaries only (none yet)', (await A.json('GET', '/api/library/shelves/diary')).data.items.length === 0);
    check('old topic shelves and 오늘/이번 주 lists are gone (404)', (await A.json('GET', '/api/library/shelves/answer')).status === 404 && (await A.json('GET', '/api/library/today')).status === 404 && (await A.json('GET', '/api/library/popular')).status === 404);
    const countsC = (await C.json('GET', '/api/library/shelves')).data.shelves;
    const countsA = (await A.json('GET', '/api/library/shelves')).data.shelves;
    check('bookcase counts: exactly 🙏 testimony + 📔 diary, following visibility (C 2, A 4)', JSON.stringify(Object.keys(countsA).sort()) === '["diary","testimony"]' && countsC.testimony === 2 && countsA.testimony === 4 && countsA.diary === 0, `${JSON.stringify(countsC)} / ${JSON.stringify(countsA)}`);

    // Anonymous deep scan: nothing that could identify A reaches anyone else.
    // No account ids anywhere; and wherever the anonymous book appears (detail or any list), not A's nickname.
    const idLeak = (text) => /"user_?[iI]d"\s*:/.test(text) || text.includes('"authorId"') || text.includes('"groupId":' + g.id) || text.includes('la-a');
    const anonItems = (data) => (data?.items ?? (data?.id === T.anon ? [data] : [])).filter((i) => i.id === T.anon);
    const scans = [];
    let seenAnon = 0;
    for (const [who, agent] of [['guest', guest], ['C', C], ['B', B]]) {
      for (const path of [`/api/library/stories/${T.anon}`, '/api/library/shelves/testimony', '/api/library/shelves/testimony?page=0', '/api/library/shelves']) {
        const r = await agent.json('GET', path);
        if (idLeak(r.text)) scans.push(`${who} ${path} (id)`);
        for (const it of anonItems(r.data)) {
          seenAnon++;
          if (JSON.stringify(it).includes(NICK.a)) scans.push(`${who} ${path} (nickname)`);
        }
      }
    }
    check('deep scan saw the anonymous book in details and lists', seenAnon >= 9, `${seenAnon}`);
    check('anonymous book: no author nickname or id in any response to others (deep scan)', scans.length === 0, scans.join(', '));
    const anonA = (await A.json('GET', `/api/library/stories/${T.anon}`)).data;
    check('…but its author sees their own name and "mine"', anonA.author === NICK.a && anonA.mine === true);
    const anonC = (await C.json('GET', `/api/library/stories/${T.anon}`)).data;
    check('others see 익명의 성도', anonC.author === P.ANONYMOUS_NAME && anonC.mine === false);

    // Edit and delete. A book from before the two bookcases keeps its old topic in the DB.
    {
      const w = new Database(DB);
      w.prepare("UPDATE stories SET shelf = 'wilderness' WHERE id = ?").run(T.pub);
      w.close();
    }
    const edit = await A.json('PUT', `/api/library/stories/${T.pub}`, { ...base, title: '광야에서 들은 세미한 소리', visibility: 'public' });
    check('author edits a testimony', edit.status === 200 && edit.data.title === '광야에서 들은 세미한 소리');
    const legacy = db();
    const kept = legacy.prepare('SELECT shelf FROM stories WHERE id = ?').get(T.pub).shelf;
    legacy.close();
    check('an old book keeps its topic in the DB after editing, and still lists in 🙏', kept === 'wilderness' && (await C.json('GET', '/api/library/shelves/testimony')).data.items.some((i) => i.id === T.pub), kept);
    check('others cannot edit (404)', (await B.json('PUT', `/api/library/stories/${T.pub}`, { ...base, visibility: 'public' })).status === 404);
    check('others cannot delete (404)', (await B.json('DELETE', `/api/library/stories/${T.priv}`)).status === 404);
    check('author deletes', (await A.json('DELETE', `/api/library/stories/${T.priv}`)).status === 200 && (await see(A, T.priv)) === 404);

    // Personal-info warning.
    const phone = await A.json('POST', '/api/library/stories', { ...base, title: '연락 주세요', parts: ['제 번호는 010-1234-5678 이에요', '메일 test@example.com', '감사해요'], visibility: 'public' });
    check('personal info → 409 personal_info (phone, email)', phone.status === 409 && phone.data.error === 'personal_info' && /전화번호/.test(phone.data.message) && /이메일/.test(phone.data.message), phone.data?.message);
    const rrn = await A.json('POST', '/api/library/stories', { ...base, parts: ['주민번호 900101-1234567', '', '감사해요 정말로요'], visibility: 'private' });
    check('resident number pattern → 409', rrn.status === 409 && /주민등록번호/.test(rrn.data.message));
    const anyway = await A.json('POST', '/api/library/stories', { ...base, title: '그래도 올리기', parts: ['제 번호는 010-1234-5678 이에요', '', '감사해요 정말로요'], visibility: 'private', confirmPersonal: true });
    check('그래도 올리기 publishes', anyway.status === 201);
    // 5 a day (deleted ones still count): pub, group, anon, priv, anyway = 5.
    const sixth = await A.json('POST', '/api/library/stories', { ...base, title: '여섯째', visibility: 'private' });
    check('stories: 5 per day (6th → 429, deleted ones still count)', sixth.status === 429, `${sixth.status}`);

    // Draft autosave (one per user).
    const d1 = await C.json('PUT', '/api/library/draft', { draft: { title: '쓰다 만', parts: ['처음', '', ''], ref: '', step: 1 } });
    await C.json('PUT', '/api/library/draft', { draft: { title: '쓰다 만 이야기', parts: ['처음 만난 날', '', ''], shelf: 'first', ref: '', step: 1 } });
    const d2 = await C.json('GET', '/api/library/draft');
    check('draft: saved server-side, one per user (latest wins), no shelf kept', d1.status === 200 && d2.data.draft.title === '쓰다 만 이야기' && !('shelf' in d2.data.draft) && count('SELECT COUNT(*) n FROM story_drafts WHERE user_id = ?', C.id) === 1);

    // 공감, 책갈피, readers.
    const r1 = await B.json('POST', `/api/library/stories/${T.pub}/reactions`, { type: 'grace' });
    const r2 = await B.json('POST', `/api/library/stories/${T.pub}/reactions`, { type: 'pray' });
    const r3 = await B.json('POST', `/api/library/stories/${T.pub}/reactions`, { type: 'grace' });
    check('공감 toggles (grace on → off, pray on)', r1.data.reactions.grace === 1 && r2.data.reactions.pray === 1 && r3.data.reactions.grace === 0 && r3.data.myReactions.join() === 'pray');
    check('bad 공감 type → 400', (await B.json('POST', `/api/library/stories/${T.pub}/reactions`, { type: 'wow' })).status === 400);
    check('guest 공감 → 401', (await guest.json('POST', `/api/library/stories/${T.pub}/reactions`, { type: 'grace' })).status === 401);
    const bm = await B.json('POST', `/api/library/stories/${T.pub}/bookmark`);
    const mineB = (await B.json('GET', '/api/library/mine')).data;
    check('책갈피 → listed in 나의 서재 bookmarks', bm.data.bookmarked === true && mineB.bookmarks.some((s) => s.id === T.pub));
    const bm2 = await C.json('POST', `/api/library/stories/${T.group}/bookmark`);
    check('cannot bookmark a book you may not see (404)', bm2.status === 404);
    await B.json('GET', `/api/library/stories/${T.pub}`);
    await B.json('GET', `/api/library/stories/${T.pub}`);
    await C.json('GET', `/api/library/stories/${T.pub}`);
    await A.json('GET', `/api/library/stories/${T.pub}`);
    await guest.json('GET', `/api/library/stories/${T.pub}`);
    const readers = (await guest.json('GET', `/api/library/stories/${T.pub}`)).data.readers;
    check('📖 readers: unique and idempotent (B twice, C once; author and guests not counted) = 2', readers === 2, `${readers}`);
    const listB = (await B.json('GET', '/api/library/shelves/testimony')).data.items.find((i) => i.id === T.pub);
    const listD = (await D.json('GET', '/api/library/shelves/testimony')).data.items.find((i) => i.id === T.pub);
    check('reading state per viewer (B: read, D: new)', listB?.read === true && listD?.read === false);

    // Reports → auto-hide → admin.
    step('reports');
    check('report: own book refused', (await A.json('POST', `/api/library/stories/${T.anon}/report`, { reason: 'spam' })).status === 400);
    check('report: bad reason 400', (await B.json('POST', `/api/library/stories/${T.anon}/report`, { reason: 'boring' })).status === 400);
    await B.json('POST', `/api/library/stories/${T.anon}/report`, { reason: 'privacy' });
    const dup = await B.json('POST', `/api/library/stories/${T.anon}/report`, { reason: 'spam' });
    await R1.json('POST', `/api/library/stories/${T.anon}/report`, { reason: 'inappropriate' });
    check('after 2 distinct reporters (one duplicate) still visible', dup.data.duplicate === true && (await see(guest, T.anon)) === 200);
    await R2.json('POST', `/api/library/stories/${T.anon}/report`, { reason: 'other' });
    check('3 distinct reporters → auto-hidden (404 for others)', (await see(guest, T.anon)) === 404 && (await see(C, T.anon)) === 404);
    const own = (await A.json('GET', `/api/library/stories/${T.anon}`)).data;
    check('owner still sees it, flagged hidden (notice)', own.hidden === true);
    check('non-admin: admin library endpoints 404', (await B.json('GET', '/api/admin/library')).status === 404 && (await B.json('POST', `/api/admin/library/${T.anon}`, { action: 'restore' })).status === 404 && (await guest.json('GET', '/api/admin/library')).status === 404);
    const adm = await ADM.json('GET', '/api/admin/library');
    const row = adm.data.stories.find((s) => s.id === T.anon);
    check('admin list: the hidden anonymous book with its real author and reasons', row && row.hidden && row.author === NICK.a && row.reporters === 3, JSON.stringify(row && { a: row.author, n: row.reporters }));
    await ADM.json('POST', `/api/admin/library/${T.anon}`, { action: 'restore' });
    check('admin 복구 → visible again', (await see(guest, T.anon)) === 200);
    await ADM.json('POST', `/api/admin/library/${T.anon}`, { action: 'hide' });
    check('admin 숨김 유지 → hidden', (await see(guest, T.anon)) === 404);
  }

  // ================================================================ browsers
  browser = await launch(['--autoplay-policy=no-user-gesture-required']);
  step('browser A (desktop)');
  const ctxA = await contextFor(browser, A, { viewport: { width: 1280, height: 720 } });
  const pa = await ctxA.newPage();
  await enterWorld(pa, Q('14:00'));

  // ---------------------------------------------------------------- 📸 capture + upload validation
  step('photos');
  let shotBytes = null;
  {
    const iframes = (await debug(pa)).m3.worship.iframes;
    const shot = await pa.evaluate(() => window.__WORLDS_TEST__.capture());
    check('capture → valid WebP ≤ 1280 px, < 150 KB, uploaded', shot && shot.uploaded && shot.type === 'image/webp' && shot.bytes < 150 * 1024 && Math.max(shot.width, shot.height) <= 1280, JSON.stringify(shot));
    check('stamp: date, time, place, nickname, "QT 월드"', shot && shot.stamp.includes(P.kstDateOf(Date.now()).slice(0, 4)) && /오[전후] \d+:\d\d/.test(shot.stamp) && shot.stamp.includes('중앙 광장') && shot.stamp.includes(NICK.a) && shot.stamp.includes('QT 월드'), shot?.stamp);
    check('photo is copied from the 3D canvas only (the YouTube iframe and HUD are DOM, never in it)', shot?.source === 'webgl-canvas', `iframes on page: ${iframes}`);
    const res = await A.raw('GET', `/api/shots/${shot.id}`);
    shotBytes = Buffer.from(await res.arrayBuffer());
    check('owner fetches the photo', res.status === 200 && shotBytes.toString('ascii', 0, 4) === 'RIFF' && shotBytes.toString('ascii', 8, 12) === 'WEBP');
    // The stamp is drawn into the pixels: the bottom-left strip is dark paper.
    const stampDark = await pa.evaluate(async (id) => {
      const blob = await (await fetch(`/api/shots/${id}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const x = c.getContext('2d');
      x.drawImage(bmp, 0, 0);
      const k = Math.max(0.6, Math.min(1.4, Math.min(bmp.width, bmp.height) / 600));
      const px = x.getImageData(Math.round(12 * k), bmp.height - Math.round(14 * k) - 4, 6, 3).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
      return sum / (px.length / 4) / 3;
    }, shot.id);
    check('stamp strip is in the image (dark paper at the bottom-left)', stampDark < 120, `avg ${Math.round(stampDark)}`);
    check('others cannot fetch an unpublished photo (404)', (await B.json('GET', `/api/shots/${shot.id}`)).status === 404 && (await guest.json('GET', `/api/shots/${shot.id}`)).status === 404);
    // Validation.
    check('upload: guest 401', (await guest.json('POST', '/api/shots', shotBytes, 'image/webp')).status === 401);
    check('upload: not an image (bad magic) 400', (await A.json('POST', '/api/shots', Buffer.from('<svg>'.repeat(40)), 'image/webp')).status === 400);
    check('upload: PNG/GIF content-type 415', (await A.json('POST', '/api/shots', shotBytes, 'image/png')).status === 415);
    check('upload: type/content mismatch 400', (await A.json('POST', '/api/shots', shotBytes, 'image/jpeg')).status === 400);
    check('upload: > 1280 px 400', (await A.json('POST', '/api/shots', bigWebp(), 'image/webp')).status === 400);
    check('upload: > max bytes 413', (await A.json('POST', '/api/shots', Buffer.concat([shotBytes, Buffer.alloc(420 * 1024)]), 'image/webp')).status === 413);
    let last = null;
    for (let i = 0; i < 9; i++) last = await A.json('POST', '/api/shots?place=테스트', shotBytes, 'image/webp');
    check('10 photos a day accepted', last.status === 201 && last.data.usedToday === 10, `${last.status} ${last.data?.usedToday}`);
    const eleventh = await A.json('POST', '/api/shots', shotBytes, 'image/webp');
    check('11th photo → 429', eleventh.status === 429);
    check('files stored under the shots dir with random names', readdirSync(SHOTS).filter((f) => /^[0-9a-f]{32}\.webp$/.test(f)).length === 10);
    // Keep only the first photo for the diary; delete the rest.
    const all = (await A.json('GET', '/api/shots')).data.shots;
    for (const s of all) if (s.id !== shot.id) await A.json('DELETE', `/api/shots/${s.id}`);
    check('deleting photos removes their files', readdirSync(SHOTS).length === 1);
    T.shot = shot.id;
  }

  // ================================================================ 발자취 + diary (scripted day)
  if (run('day') || run('account')) {
    step('footprints');
    const cookie = (agent) => ({ cookie: agent.cookieHeader() });
    // Letter (twice: once only).
    const l1 = await A.json('POST', '/api/footprints/letter');
    const l2 = await A.json('POST', '/api/footprints/letter');
    check('letter: recorded once (same key)', l1.data.recorded === true && l2.data.recorded === false);
    // Meditation at 기도의 뜰.
    await A.json('PUT', `/api/wordbook/pages/${TODAY}`);
    await A.json('POST', '/api/wordbook/meditations', { date: TODAY, place: '기도의 뜰', meditation: '주님은 나의 목자시니 내게 부족함이 없도다. 오늘도 쉴 만한 물가로 인도하심을 믿어요.' });
    // B's public lantern; A reads it and prays.
    await B.json('PUT', `/api/wordbook/pages/${TODAY}`);
    const bm = (await B.json('POST', '/api/wordbook/meditations', { date: TODAY, place: '골방', meditation: '나래의 묵상입니다' })).data;
    const lantern = (await B.json('POST', '/api/lanterns', { meditationId: bm.id, visibility: 'public' })).data;
    await A.json('GET', `/api/lanterns/${lantern.id}`);
    await A.json('GET', `/api/lanterns/${lantern.id}`);
    await A.json('POST', `/api/lanterns/${lantern.id}/reactions`, { type: 'pray' });
    // Pray on a mat (raw socket as A).
    const wa = await rawClient(WS, { nickname: 'x', test: true }, cookie(A));
    const mat = P.MATS[0];
    wa.send({ t: 'state', x: mat.x + 0.5, y: 3, z: mat.z, yaw: 0, speed: 0 });
    await sleep(200);
    wa.send({ t: 'sit', kind: 'mat', seat: 0 });
    await sleep(2600);
    wa.send({ t: 'stand' });
    // Reconnect: same minutes and same keys do not count twice.
    wa.ws.close();
    await sleep(300);
    const wa2 = await rawClient(WS, { nickname: 'x', test: true }, cookie(A));
    await A.json('POST', '/api/footprints/letter');
    // Campfire with two others; a secret line said there must never reach the diary.
    const wb = await rawClient(WS, { nickname: 'x', test: true }, cookie(B));
    const wg = await rawClient(WS, { nickname: '불가손님', test: true });
    for (const [c, dx] of [[wa2, 0], [wb, 1], [wg, -1]]) c.send({ t: 'state', x: P.CAMPFIRE.x + 3 + dx, y: 3, z: P.CAMPFIRE.z + 3, yaw: 0, speed: 0 });
    await sleep(300);
    wb.send({ t: 'chat', text: '비밀이야기XYZ 아무도 몰라요' });
    wa2.send({ t: 'chat', text: '나의말ABC' });
    await sleep(2600);
    const heard = of(wa2, 'chat').some((m) => m.text.includes('비밀이야기XYZ'));
    // Bench sit.
    const bench = P.BENCH_SEATS[0];
    wa2.send({ t: 'state', x: bench.x, y: 3, z: bench.z + 0.4, yaw: 0, speed: 0 });
    await sleep(150);
    wa2.send({ t: 'sit', kind: 'bench', seat: 0 });
    await sleep(300);
    wa2.send({ t: 'stand' });
    for (const c of [wa2, wb, wg]) c.ws.close();
    check('campfire chat really happened (and was heard)', heard);
    check('letter event stored exactly once after a reconnect', count("SELECT COUNT(*) n FROM footprints WHERE user_id = ? AND type = 'letter'", A.id) === 1);
    check('lantern read stored once (read twice)', count("SELECT COUNT(*) n FROM footprints WHERE user_id = ? AND type = 'lantern_read'", A.id) === 1);
    const pray = count("SELECT COUNT(*) n FROM footprint_minutes WHERE user_id = ? AND kind = 'pray'", A.id);
    check('prayer minutes on the mat recorded (per minute, no duplicates)', pray >= 1 && pray <= 2, `${pray}`);
    const fire = (() => {
      const d = db();
      try {
        return d.prepare("SELECT MAX(n) n, COUNT(*) c FROM footprint_minutes WHERE user_id = ? AND kind = 'fire'").get(A.id);
      } finally {
        d.close();
      }
    })();
    check('campfire minutes with the number of others present (2)', fire.c >= 1 && fire.n === 2, JSON.stringify(fire));
    check('no chat text stored anywhere in 발자취', count("SELECT COUNT(*) n FROM footprints WHERE payload LIKE '%XYZ%' OR payload LIKE '%ABC%'") === 0);

    // Toggle off stops recording; clear today; 30-day purge (D).
    step('footprint controls');
    await D.json('POST', '/api/footprints/letter');
    const before = (await D.json('GET', '/api/footprints')).data;
    const off = await D.json('PUT', '/api/footprints/settings', { enabled: false });
    await D.json('GET', `/api/lanterns/${lantern.id}`);
    const offLetter = await D.json('POST', '/api/footprints/letter');
    const after = (await D.json('GET', '/api/footprints')).data;
    check('toggle off: nothing more is recorded', before.events === 1 && off.data.enabled === false && after.events === 1 && offLetter.data.recorded === false, `${before.events}→${after.events}`);
    await D.json('PUT', '/api/footprints/settings', { enabled: true });
    await D.json('GET', `/api/lanterns/${lantern.id}`);
    check('toggle on again: records again', (await D.json('GET', '/api/footprints')).data.events === 2);
    const cleared = await D.json('DELETE', '/api/footprints/today');
    check('오늘 기록 지우기 clears today', cleared.data.events === 0 && count('SELECT COUNT(*) n FROM footprints WHERE user_id = ?', D.id) === 0);
    await D.json('GET', `/api/lanterns/${lantern.id}`);

    // Diary draft.
    step('diary');
    const shot2 = await A.json('POST', '/api/shots?place=모닥불 모임터', shotBytes, 'image/webp');
    check('a second photo is refused today (10 already counted, deletes do not refund)', shot2.status === 429);
    const draft = (await A.json('GET', '/api/diary/draft')).data;
    const text = draft.lines.map((l) => l.text).join('\n');
    const expect = [
      ['letter', /오늘의 말씀 편지를 열었어요/],
      ['meditation', /기도의 뜰에서 말씀을 묵상하며 “주님은 나의 목자시니/],
      ['mat prayer', /엔 기도의 뜰에서 \d+분 동안 기도했어요/],
      ['lantern + pray', /한 성도의 등불을 읽으며 함께 기도했어요 🤲/],
      ['campfire', /모닥불에서 2명과 이야기를 나눴어요 🔥/],
      ['photo', /오늘의 풍경을 사진 1장에 담았어요 📸/],
      ['bench', /광장 벤치에 앉아/],
      ['time spent', /오늘 QT 월드에서 .*머물렀어요/],
    ];
    for (const [label, re] of expect) check(`diary draft: ${label}`, re.test(text), text.split('\n').find((l) => re.test(l)) ?? text);
    const others = [NICK.b, NICK.c, NICK.d, '불가손님', NICK.r1];
    check('diary draft: no other user\'s nickname', !others.some((n) => text.includes(n)), others.filter((n) => text.includes(n)).join());
    check('diary draft: no chat text (theirs or mine)', !/XYZ|ABC|비밀이야기/.test(text));
    check('diary draft: today\'s word and photos offered', !!draft.word?.ref && draft.photos.some((p) => p.id === T.shot));
    check('default visibility: 모임 (A has a group), 나만 for D (none)', draft.defaultVisibility === 'group' && (await D.json('GET', '/api/diary/draft')).data.defaultVisibility === 'private');
    // Before publishing, the photo is the owner's only.
    check('photo still private before the diary', (await B.json('GET', `/api/shots/${T.shot}`)).status === 404);
    T.draftLines = draft.lines.map((l) => l.text);
  }

  // ================================================================ library interior (2 browsers)
  let pb = null;
  let ctxB = null;
  if (run('library') || run('day')) {
    step('browser B (phone)');
    ctxB = await contextFor(browser, B, { viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    pb = await ctxB.newPage();
    await enterWorld(pb, Q('14:00'));

    step('seed books');
    // A few more public books so the shelves look lived-in (5 a day per person).
    const titles = ['새벽 기도의 응답', '아버지의 편지', '병상에서 만난 위로', '작은 감사 일기', '말씀이 길이 되어', '처음 교회 문을 열던 날', '광야의 만나', '고마운 이웃', '응답은 늦게 왔지만', '시편 한 구절'];
    for (let k = 0; k < 4; k++) {
      const s = await account(`la-s${k}`, `이웃${k + 1}`);
      for (let j = 0; j < 5; j++) {
        const i = k * 5 + j;
        await s.json('POST', '/api/library/stories', {
          title: titles[i % titles.length],
          parts: ['그때는 앞이 보이지 않았어요.', '조용히 기도하던 밤, 마음에 평안이 찾아왔어요.', '지금은 하루하루를 감사로 시작해요.'],
          visibility: i % 4 === 3 ? 'anonymous' : 'public',
        });
      }
    }

    step('enter the library');
    // Exterior by day.
    const door = await pa.evaluate(() => window.__WORLDS_TEST__.libraryDoor());
    const D0 = P.LIBRARY_DOOR;
    await teleport(pa, { x: D0.x + D0.fx * 7, z: D0.z + D0.fz * 7 });
    await pa.evaluate(({ fx, fz }) => window.__WORLDS_TEST__.view(Math.atan2(fx, fz), 0.28), D0);
    await pa.evaluate(() => window.__WORLDS_TEST__.face(Math.PI));
    await sleep(1500);
    await pa.screenshot({ path: shotPath('exterior-day') });
    await teleport(pa, door);
    await until(pa, () => document.getElementById('action-btn').textContent.includes('도서관'));
    await pa.keyboard.press('KeyE');
    await until(pa, () => window.__WORLDS_DEBUG__.la.inLibrary === true, null, 15000);
    check('A entered the library (shared interior scene)', (await la(pa)).space === 'library');
    await teleport(pb, door);
    await until(pb, () => document.getElementById('action-btn').textContent.includes('도서관'));
    await pb.tap('#action-btn');
    await until(pb, () => window.__WORLDS_DEBUG__.la.inLibrary === true, null, 15000);
    const aId = (await debug(pa)).net.id;
    const bId = (await debug(pb)).net.id;
    await until(pa, (id) => window.__WORLDS_DEBUG__.la.renderedRemotes.includes(id), bId, 20000).catch(() => undefined);
    await until(pb, (id) => window.__WORLDS_DEBUG__.la.renderedRemotes.includes(id), aId, 20000).catch(() => undefined);
    check('insiders see each other (A sees B, B sees A)', (await la(pa)).renderedRemotes.includes(bId) && (await la(pb)).renderedRemotes.includes(aId));
    // An outsider (raw guest in the world) and a 골방 user.
    const out = await rawClient(WS, { nickname: '밖손님', test: true });
    const room = await rawClient(WS, { nickname: '골방손님', test: true });
    room.send({ t: 'state', x: 0, y: 3, z: 8, yaw: 0, speed: 0, inside: 'room' });
    await sleep(1500);
    const snaps = of(out, 'snap');
    const lastOut = snaps[snaps.length - 1].players;
    const ia = lastOut.find((p) => p.id === aId);
    const roomId = of(room, 'welcome')[0].id;
    check('outsider: library players hidden and their positions not sent', ia?.inside === true && ia.x === 0 && ia.z === 0, JSON.stringify(ia));
    const ra = of(room, 'snap').at(-1).players;
    check('골방 stays private: the 골방 user sees nobody, nobody sees them', ra.every((p) => p.id === roomId || p.inside === true));
    await sleep(500);
    check('insiders do not see the 골방 user', !(await la(pa)).renderedRemotes.includes(roomId) && !(await la(pb)).renderedRemotes.includes(roomId));
    const outId = of(out, 'welcome')[0].id;
    check('insiders do not see the outsider', !(await la(pa)).renderedRemotes.includes(outId));
    // Server check: no stepping into the library from far away.
    const far = await rawClient(WS, { nickname: '먼손님' });
    far.send({ t: 'state', x: 0, y: 3, z: 8, yaw: 0, speed: 0 });
    await sleep(150);
    far.send({ t: 'state', x: 0, y: 0, z: 4, yaw: 0, speed: 0, inside: 'library' });
    await sleep(300);
    check('server refuses entering the library away from its door', of(far, 'correct').length >= 1);
    for (const c of [out, room, far]) c.ws.close();

    step('desks');
    const lib = await pa.evaluate(() => window.__WORLDS_TEST__.library());
    const seat = lib.desks[0];
    await teleport(pb, { x: seat.x - 0.5, z: seat.z - 0.6 });
    await until(pb, () => /책상/.test(document.getElementById('action-btn').textContent));
    await pb.tap('#action-btn');
    await until(pb, () => window.__WORLDS_DEBUG__.net.seat === 0 && window.__WORLDS_DEBUG__.net.seatKind === 'desk');
    await until(pa, (id) => window.__WORLDS_DEBUG__.net.remotes.some((r) => r.id === id && r.seat === 0 && r.seatKind === 'desk' && r.reading), bId, 15000).catch(() => undefined);
    const rb = (await debug(pa)).net.remotes.find((r) => r.id === bId);
    check('desk seat synced: A sees B seated at desk 0, reading an open book', rb?.seat === 0 && rb.seatKind === 'desk' && rb.pose === 'sit' && rb.reading === true, JSON.stringify(rb && { s: rb.seat, k: rb.seatKind, p: rb.pose, r: rb.reading }));
    check('desk occupancy synced to A', (await debug(pa)).net.desks[0] === bId);
    await until(pb, () => window.__WORLDS_DEBUG__.net.reading === true, null, 10000).catch(() => undefined);
    check('B reads too (local pose)', (await debug(pb)).net.reading === true);
    // A tries the same chair.
    await teleport(pa, { x: seat.x + 0.4, z: seat.z - 0.7 });
    await sleep(400);
    const taken = await pa.evaluate(() => document.getElementById('action-btn').textContent);
    check('taken chair is not offered to A', !/책상에 앉아/.test(taken) || (await debug(pa)).net.desks[0] === bId, taken);

    step('books in the two bookcases');
    const countsA = (await A.json('GET', '/api/library/shelves')).data.shelves;
    await until(pa, () => !!window.__WORLDS_DEBUG__.la.counts, null, 10000);
    const books = (await la(pa)).books;
    check('exactly two bookcases in the hall (🙏 testimony, 📔 diary), no 오늘 꽂힌 책 table', JSON.stringify(Object.keys(books).sort()) === '["diary","testimony"]', JSON.stringify(books));
    check('3D spines = this viewer\'s books per bookcase', ['testimony', 'diary'].every((k) => books[k] === Math.min(countsA[k], 160)) && books.testimony > 0, `${JSON.stringify(books)} vs ${JSON.stringify(countsA)}`);
    const booksB = (await la(pb)).books;
    const countsB = (await B.json('GET', '/api/library/shelves')).data.shelves;
    check('…and for B (different visibility)', ['testimony', 'diary'].every((k) => booksB[k] === countsB[k]) && countsB.testimony !== countsA.testimony, `${JSON.stringify(booksB)} vs ${JSON.stringify(countsB)}`);
    // The hall with its two bookcases (wide view from the door side).
    await teleport(pa, { x: 0, z: 0.4 });
    await pa.evaluate(() => window.__WORLDS_TEST__.face(Math.PI));
    await pa.evaluate(() => window.__WORLDS_TEST__.view(0, 0.32, 4));
    await sleep(1800);
    await pa.screenshot({ path: lib2Path('interior-two-bookcases') });
    // Interior screenshot: two players, one seated reading.
    await teleport(pa, { x: P.DESKS[0].x + 1.35, z: P.DESKS[0].z + 0.2 });
    await pa.evaluate(() => window.__WORLDS_TEST__.face(-Math.PI / 2));
    await pa.evaluate(() => window.__WORLDS_TEST__.view(0.35, 0.42));
    await sleep(1500);
    await pa.screenshot({ path: shotPath('interior-two-players') });

    // Bookcase list via the action button (tap-equivalent), on the phone.
    step('bookcase list (phone)');
    await pb.tap('#action-btn'); // stand up
    await until(pb, () => window.__WORLDS_DEBUG__.net.seat === -1);
    check('fronts: exactly the two bookcases', JSON.stringify(Object.keys(lib.fronts).sort()) === '["diary","testimony"]', JSON.stringify(lib.fronts));
    const front = lib.fronts.testimony;
    await teleport(pb, front);
    await until(pb, () => /하나님 이야기 책장 보기/.test(document.getElementById('action-btn').textContent));
    await pb.tap('#action-btn');
    await until(pb, () => window.__WORLDS_DEBUG__.la.view.page === 'shelf' && window.__WORLDS_DEBUG__.la.view.items.length > 0, null, 15000);
    const v = (await la(pb)).view;
    const apiPage = (await B.json('GET', '/api/library/shelves/testimony')).data;
    const pick = (items) => JSON.stringify(items.map((i) => [i.id, i.read]));
    check(
      '🙏 하나님 이야기 list opens from its bookcase: every visible testimony, newest first (paged), with reading state',
      v.list === 'testimony' && pick(v.items) === pick(apiPage.items) && v.hasMore === apiPage.hasMore && apiPage.hasMore && v.items.length === 20,
      `${pick(v.items)} vs ${pick(apiPage.items)}`,
    );
    // Page 2 (더 보기) reaches the older books, including the one B read.
    await pb.tap('#lib-more');
    await until(pb, () => window.__WORLDS_DEBUG__.la.view.items.length > 20, null, 10000);
    check('더 보기 loads the next page (B\'s read book shows as read)', (await la(pb)).view.items.some((i) => i.id === T.pub && i.read === true));
    await pb.evaluate(() => (document.querySelector('.overlay.shown .sheet').scrollTop = 0));
    check('the list offers ✍️ 하나님 이야기 쓰기 and 나의 서재', (await pb.textContent('#lib-write')).includes('하나님 이야기 쓰기') && (await pb.isVisible('#lib-mine')));
    await sleep(600);
    await pb.screenshot({ path: shotPath('shelf-list-phone') });
    await pb.screenshot({ path: lib2Path('list-testimony-phone') });
    // Switch to the 📔 일기 case from the same sheet.
    await pb.tap('#lib-chip-diary');
    await until(pb, () => window.__WORLDS_DEBUG__.la.view.list === 'diary', null, 10000);
    check('📔 일기 tab: the diary list with 📔 오늘 일기 쓰기', (await pb.textContent('#lib-diary')).includes('오늘 일기 쓰기'));
    await pb.keyboard.press('Escape');
    await modalIs(pb, null);
    await teleport(pb, lib.fronts.diary);
    const diaryAction = await until(pb, () => /일기 책장 보기/.test(document.getElementById('action-btn').textContent), null, 8000).then(() => true, () => false);
    check('standing at the 📔 bookcase offers 일기 책장 보기', diaryAction);
    // Tap a bookcase in the 3D view (ray pick).
    await pb.evaluate(() => window.__WORLDS_TEST__.view(Math.PI * 0.0, 0.35));
    await sleep(500);
    const pos = await pb.evaluate(({ x, z }) => window.__WORLDS_TEST__.libraryScreen(x, 1.3, z - 1.1), lib.fronts.diary);
    await pb.touchscreen.tap(pos.x, pos.y);
    await until(pb, () => window.__WORLDS_DEBUG__.la.view.page === 'shelf', null, 8000).catch(() => undefined);
    check('tapping a bookcase opens its list', (await la(pb)).view.page === 'shelf', JSON.stringify(pos));
    await pb.keyboard.press('Escape');
    await modalIs(pb, null);

    // The library top (also what the ✍️ 쓰는 책상 opens): two bookcases, two ways to write, 나의 서재.
    step('library top (phone)');
    await pb.evaluate(() => window.__WORLDS_TEST__.libraryOpen('desk'));
    await until(pb, () => window.__WORLDS_DEBUG__.la.view.page === 'desk' && document.getElementById('lib-case-testimony'), null, 10000);
    const top = await pb.evaluate(() => ({
      ids: [...document.querySelectorAll('.overlay.shown .lib-body button')].map((b) => b.id),
      text: document.querySelector('.overlay.shown .sheet').textContent,
    }));
    check(
      'library top: 🙏 / 📔 bookcases, ✍️ 하나님 이야기 쓰기, 📔 오늘 일기 쓰기, 나의 서재 and nothing else',
      JSON.stringify(top.ids) === JSON.stringify(['lib-case-testimony', 'lib-desk-write', 'lib-case-diary', 'lib-desk-diary', 'lib-desk-mine']) &&
        top.text.includes('하나님 이야기 쓰기') &&
        top.text.includes('오늘 일기 쓰기') &&
        !/오늘 꽂힌|공감받은|서가/.test(top.text),
      JSON.stringify(top.ids),
    );
    await sleep(500);
    await pb.screenshot({ path: lib2Path('sheet-top-phone') });
    await pb.tap('#lib-case-diary');
    await until(pb, () => window.__WORLDS_DEBUG__.la.view.page === 'shelf' && window.__WORLDS_DEBUG__.la.view.list === 'diary', null, 10000);
    await pb.tap('#lib-back');
    await until(pb, () => window.__WORLDS_DEBUG__.la.view.page === 'desk', null, 10000);
    check('a bookcase opened from the top goes back to the top', true);
    await pb.keyboard.press('Escape');
    await modalIs(pb, null);

    // Testimony form on the phone (guided steps, draft autosave).
    step('testimony form (phone)');
    await pb.evaluate(() => window.__WORLDS_TEST__.libraryOpen('write'));
    await until(pb, () => window.__WORLDS_DEBUG__.la.view.page === 'write' && document.getElementById('lib-part-0'), null, 10000);
    await pb.fill('#lib-part-0', '대학교 시험에 떨어지고 모든 게 무너진 것 같았어요.');
    await pb.tap('#lib-next');
    await pb.waitForSelector('#lib-part-1');
    await pb.fill('#lib-part-1', '친구가 건넨 시편 23편 한 구절에서 하나님을 만났어요.');
    await sleep(1600);
    check('draft autosaved on the server while typing', (await B.json('GET', '/api/library/draft')).data.draft?.parts?.[1]?.includes('시편 23편'));
    await pb.screenshot({ path: shotPath('testimony-form-phone') });
    await pb.tap('#lib-next');
    await pb.waitForSelector('#lib-part-2');
    await pb.fill('#lib-part-2', '이제는 실패도 감사로 받아요. 연락은 010-2222-3333 으로 주세요.');
    await pb.tap('#lib-next');
    await pb.waitForSelector('#lib-title');
    await pb.fill('#lib-title', '시편 23편이 찾아온 날');
    check('no shelf picker in the testimony form', (await pb.locator('[id^="lib-shelf-"]').count()) === 0 && !(await pb.textContent('.overlay.shown .sheet')).includes('서가'));
    await pb.fill('#lib-ref', '시편 23:1');
    await pb.tap('#lib-vis-group');
    await pb.tap('#lib-publish');
    await until(pb, () => !document.getElementById('lib-personal-warning')?.hidden, null, 8000).catch(() => undefined);
    check('personal-info warning shown before publishing (phone number)', await pb.isVisible('#lib-personal-warning'));
    await pb.screenshot({ path: shotPath('personal-warning-phone') });
    await pb.tap('#lib-personal-confirm');
    await until(pb, () => window.__WORLDS_DEBUG__.la.view.page === 'story', null, 10000);
    const published = (await la(pb)).view.lastPublished;
    const story = (await B.json('GET', `/api/library/stories/${published}`)).data;
    check('그래도 올리기 → the testimony is in the 🙏 하나님 이야기 case, 모임 only, with 시편 23:1', story.kind === 'testimony' && story.visibility === 'group' && story.ref === '시편 23:1' && story.parts.length === 3 && (await B.json('GET', '/api/library/shelves/testimony')).data.items[0]?.id === published);
    check('draft cleared after publishing', (await B.json('GET', '/api/library/draft')).data.draft === null);
    check('C (not in the group) cannot open it', (await C.json('GET', `/api/library/stories/${published}`)).status === 404);
    await pb.keyboard.press('Escape');
    await modalIs(pb, null);

    // B takes a photo inside the library and writes today's diary with it.
    step('diary (phone)');
    const bShot = await pb.evaluate(() => window.__WORLDS_TEST__.capture());
    check('B photo in the library', bShot?.uploaded === true && bShot.stamp.includes('이야기 도서관'), JSON.stringify(bShot));
    await pb.evaluate(() => window.__WORLDS_TEST__.libraryOpen('diary'));
    await until(pb, () => window.__WORLDS_DEBUG__.la.view.page === 'diary' && document.getElementById('lib-diary-lines'), null, 15000);
    const linesB = (await la(pb)).view.diaryLines;
    check('B diary draft lists the library photo line and visibility 모임 by default', linesB.some((l) => /사진 1장/.test(l)) && (await la(pb)).view.diaryVisibility === 'group', JSON.stringify(linesB));
    // L-B (B5): today's photos start picked.
    check('B diary draft: the library photo is already picked', (await pb.getAttribute(`#lib-pick-${bShot.id}`, 'aria-pressed')) === 'true');
    await pb.fill('#lib-diary-note', '오늘은 도서관이 참 따뜻했어요.');
    await pb.evaluate(() => {
      document.activeElement?.blur();
      document.querySelector('.overlay .sheet').scrollTop = 0;
    });
    await sleep(400);
    await pb.screenshot({ path: shotPath('diary-draft-phone'), fullPage: false });
    await pb.evaluate(() => document.querySelector('.lib-pick')?.scrollIntoView({ block: 'center' }));
    await sleep(300);
    await pb.screenshot({ path: shotPath('diary-draft-phone-photo') });
    await pb.tap('#lib-diary-publish');
    await until(pb, () => window.__WORLDS_DEBUG__.la.view.page === 'story', null, 15000);
    const bDiary = (await la(pb)).view.lastPublished;
    await pb.keyboard.press('Escape');
    await modalIs(pb, null);
    // A (same group) reads B's diary on desktop, with the photo.
    await pa.evaluate((id) => window.__WORLDS_TEST__.libraryOpen('story', id), bDiary);
    await until(pa, () => window.__WORLDS_DEBUG__.la.view.page === 'story' && document.querySelector('.lib-photo'), null, 15000);
    await pa.waitForFunction(() => [...document.querySelectorAll('.lib-photo')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 }).catch(() => undefined);
    const imgOk = await pa.evaluate(() => [...document.querySelectorAll('.lib-photo')].map((i) => i.naturalWidth));
    check('A (group member) reads B\'s diary with its photo inline', imgOk.length === 1 && imgOk[0] > 0, JSON.stringify(imgOk));
    await sleep(400);
    await pa.screenshot({ path: shotPath('diary-read-by-other') });
    check('the diary photo now follows the diary: member 200, non-member/guest 404', (await A.json('GET', `/api/shots/${bShot.id}`)).status === 200 && (await C.json('GET', `/api/shots/${bShot.id}`)).status === 404 && (await guest.json('GET', `/api/shots/${bShot.id}`)).status === 404);
    await pa.keyboard.press('Escape');
    await modalIs(pa, null);

    step('leave the library');
    const exit = lib.spots.exit;
    await teleport(pa, { x: exit.x, z: exit.z - 0.4 });
    await until(pa, () => /밖으로 나가기/.test(document.getElementById('action-btn').textContent));
    await pa.keyboard.press('KeyE');
    await until(pa, () => window.__WORLDS_DEBUG__.la.inLibrary === false, null, 10000);
    const pA = (await debug(pa)).player;
    check('leaving puts A outside the library door', Math.hypot(pA.x - door.x, pA.z - door.z) < 2.5 && (await la(pa)).space === 'world', JSON.stringify(pA));
    await until(pb, (id) => !window.__WORLDS_DEBUG__.la.renderedRemotes.includes(id), aId, 10000).catch(() => undefined);
    check('B (still inside) no longer sees A', !(await la(pb)).renderedRemotes.includes(aId));
  }

  // ================================================================ A's diary: edit, add, publish, one per day
  if (run('day') || run('account')) {
    step('publish A diary');
    const lines = [...T.draftLines];
    const removed = lines.splice(lines.findIndex((l) => /벤치/.test(l)), 1)[0];
    lines[0] = `${lines[0]} 설레는 마음으로!`;
    const pub = await A.json('POST', '/api/diary', { lines, note: '✏️ 오늘은 감사가 넘친 하루', photoIds: [T.shot], visibility: 'group', groupId: g.id });
    check('A publishes the edited diary (a line removed, one edited, a note added, a photo)', pub.status === 200 && pub.data.kind === 'diary' && !pub.data.parts.includes(removed) && pub.data.parts[0].endsWith('설레는 마음으로!') && pub.data.note.includes('감사가 넘친') && pub.data.photoIds[0] === T.shot);
    T.diary = pub.data.id;
    const again = await A.json('POST', '/api/diary', { lines: ['다시 쓴 일기'], visibility: 'group', groupId: g.id });
    check('one diary per day: publishing again replaces it (same id)', again.status === 200 && again.data.id === T.diary && again.data.parts.join() === '다시 쓴 일기' && count("SELECT COUNT(*) n FROM stories WHERE user_id = ? AND kind = 'diary'", A.id) === 1);
    await A.json('POST', '/api/diary', { lines, note: '✏️ 오늘은 감사가 넘친 하루', photoIds: [T.shot], visibility: 'group', groupId: g.id });
    check('diary visibility: member B 200, C 404, guest 404', (await B.json('GET', `/api/library/stories/${T.diary}`)).status === 200 && (await C.json('GET', `/api/library/stories/${T.diary}`)).status === 404 && (await guest.json('GET', `/api/library/stories/${T.diary}`)).status === 404);
    check('diary photo: member 200, non-member 404', (await B.json('GET', `/api/shots/${T.shot}`)).status === 200 && (await C.json('GET', `/api/shots/${T.shot}`)).status === 404);
    const xss = await A.json('POST', '/api/diary', { lines: [...lines, '<img src=x onerror=alert(1)>'], note: '<b>굵게</b>', photoIds: [T.shot], visibility: 'group', groupId: g.id });
    check('diary text stored as plain text (markup kept as text, rendered with textContent)', xss.data.parts.includes('<img src=x onerror=alert(1)>'));

    step('30-day purge');
    const dEvents = count('SELECT COUNT(*) n FROM footprints WHERE user_id = ?', D.id);
    const aEvents = count('SELECT COUNT(*) n FROM footprints WHERE user_id = ?', A.id);
    const sw = await A.json('POST', '/api/test/library/sweep', { days: 31 });
    check('purge (fake clock +31 d): D\'s unused 발자취 deleted, A\'s (diary published) kept', dEvents > 0 && count('SELECT COUNT(*) n FROM footprints WHERE user_id = ?', D.id) === 0 && count('SELECT COUNT(*) n FROM footprints WHERE user_id = ?', A.id) === aEvents, JSON.stringify(sw.data));
    check('purge keeps the photo used in the diary', count('SELECT COUNT(*) n FROM screenshots WHERE id = ?', T.shot) === 1 && existsSync(SHOTS));
  }

  // ================================================================ admin list screenshot, ban
  if (run('api') || run('account')) {
    step('admin ban');
    const cStory = await C.json('POST', '/api/library/stories', { title: '다솜의 이야기', parts: ['처음 교회에 간 날이었어요', '찬양이 마음을 울렸어요', '지금은 매주 기다려요'], visibility: 'public' });
    for (const r of [A, B, R1]) await r.json('POST', `/api/library/stories/${cStory.data.id}/report`, { reason: 'spam' });
    await ADM.json('POST', `/api/admin/library/${cStory.data.id}`, { action: 'ban', days: 3 });
    const banned = await C.json('POST', '/api/library/stories', { title: '금지 중', parts: ['쓸 수 없어야 해요 정말로', '', ''], visibility: 'public' });
    check('admin 글쓰기 금지: C cannot write for 3 days (403)', banned.status === 403 && banned.data.error === 'story_banned');
    check('…nor publish a diary', (await C.json('POST', '/api/diary', { lines: ['금지'] })).status === 403);
    // Admin list screenshot (desktop admin browser).
    const ctxAdm = await contextFor(browser, ADM, { viewport: { width: 1280, height: 720 } });
    const padm = await ctxAdm.newPage();
    padm.on('dialog', (d) => void d.accept());
    await enterWorld(padm, Q('14:00') + '&noworship=1');
    await until(padm, () => window.__WORLDS_DEBUG__.m8.admin === true, null, 15000);
    await padm.evaluate(() => window.__WORLDS_TEST__.openSettings('admin'));
    await padm.click('#settings-admin-library');
    await padm.waitForSelector('#admin-library-list .admin-story');
    const items = await padm.$$eval('#admin-library-list .admin-story', (els) => els.length);
    check('admin 도서관 관리 lists reported/hidden books', items >= 2, `${items}`);
    await padm.click('#admin-library-list .admin-story details summary').catch(() => undefined);
    await sleep(400);
    await padm.screenshot({ path: shotPath('admin-list') });
    await padm.click('#admin-library-list .admin-story .admin-delete').catch(() => undefined);
    await ctxAdm.close();
    check('admin 삭제 via the UI removes the book', count('SELECT COUNT(*) n FROM stories WHERE id IN (?, ?)', T.anon, cStory.data.id) <= 1);
  }

  // ================================================================ YouTube compliance in the library with sheets
  if ((run('yt') || run('library')) && pb) {
    step('worship in the library');
    for (const [name, p, touch] of [
      ['phone', pb, true],
      ['desktop', pa, false],
    ]) {
      if (!(await la(p)).inLibrary) {
        const door = await p.evaluate(() => window.__WORLDS_TEST__.libraryDoor());
        await teleport(p, door);
        await p.evaluate(() => window.__WORLDS_TEST__.enterLibrary());
        await until(p, () => window.__WORLDS_DEBUG__.la.inLibrary === true, null, 10000);
      }
      const ws = (await debug(p)).m3.worship;
      if (ws.mode === 'hidden') await (touch ? p.tap('#btn-worship') : p.click('#btn-worship'));
      await p.evaluate(() => window.__WORLDS_TEST__.worshipFold('open'));
      await until(p, () => window.__WORLDS_DEBUG__.m3.worship.state === 'playing', null, 20000).catch(() => undefined);
      const sheets = [
        ['shelf', () => p.evaluate(() => window.__WORLDS_TEST__.libraryOpen('shelf', 'testimony'))],
        ['story', () => p.evaluate((id) => window.__WORLDS_TEST__.libraryOpen('story', id), T.pub)],
        ['mine', () => p.evaluate(() => window.__WORLDS_TEST__.libraryOpen('mine', 'album'))],
        ['write', () => p.evaluate(() => window.__WORLDS_TEST__.libraryOpen('write'))],
        ['diary', () => p.evaluate(() => window.__WORLDS_TEST__.libraryOpen('diary'))],
        ['desk', () => p.evaluate(() => window.__WORLDS_TEST__.libraryOpen('desk'))],
      ];
      let playing = true;
      for (const [sheet, open] of sheets) {
        await open();
        await modalIs(p, '이야기 도서관');
        await p.waitForSelector('.overlay.shown .lib-body > *', { timeout: 10000 }).catch(() => undefined);
        await sleep(900);
        const r = await probe(p);
        const problems = [];
        if (!inside(r.frame, r.vw, r.vh)) problems.push(`frame off-screen ${fmt(r.frame)}`);
        if (!r.frame || r.frame.width < 199.5 || r.frame.height < 199.5) problems.push(`frame < 200 ${fmt(r.frame)}`);
        if (overlaps(r.card, r.sheet)) problems.push(`card overlaps the sheet ${fmt(r.sheet)}`);
        if (r.covered.length) problems.push(`something over the video ${r.covered.join(' ')}`);
        if (!r.titleOnTop) problems.push('sheet title covered');
        check(`${name} library + ${sheet} sheet: video on screen ≥200×200, nothing over it, clear of the sheet`, problems.length === 0, problems.join('; ') || `frame ${fmt(r.frame)} sheet ${fmt(r.sheet)}`);
        if ((await debug(p)).m3.worship.state !== 'playing') playing = false;
        await p.keyboard.press('Escape');
        await modalIs(p, null);
      }
      const w = (await debug(p)).m3.worship;
      check(`${name}: kept playing, one iframe`, playing && w.iframes <= 1, `${w.state} iframes=${w.iframes}`);
      await p.evaluate(() => window.__WORLDS_TEST__.worshipFold('folded'));
      await until(p, () => window.__WORLDS_DEBUG__.m3.worship.state !== 'playing', null, 8000).catch(() => undefined);
      const wf = (await debug(p)).m3.worship;
      check(`${name}: folded in the library → paused`, wf.state !== 'playing' && !wf.playedWhileFolded, wf.state);
      await p.evaluate(() => window.__WORLDS_TEST__.worshipFold('open'));
    }
  }

  // ================================================================ camera button layout
  if (run('layout') && pb) {
    step('camera button layout');
    const tabletCtx = await contextFor(browser, R1, { viewport: { width: 820, height: 1180 }, screen: { width: 820, height: 1180 }, isMobile: true, hasTouch: true });
    const pt = await tabletCtx.newPage();
    await enterWorld(pt, Q('14:00'));
    const devices = [
      ['p360', pb, 360, 740, true],
      ['p390', pb, 390, 844, true],
      ['p412', pb, 412, 915, true],
      ['tablet', pt, 820, 1180, true],
      ['desktop', pa, 1280, 720, false],
    ];
    for (const [name, p, w, h, touch] of devices) {
      await p.setViewportSize({ width: w, height: h });
      if ((await la(p)).inLibrary) {
        await p.evaluate(() => window.__WORLDS_TEST__.leaveLibrary());
        await until(p, () => window.__WORLDS_DEBUG__.la.inLibrary === false, null, 10000);
      }
      // Next to a campfire log: the action button and the campfire chat both show.
      const logs = await p.evaluate(() => window.__WORLDS_TEST__.logSeats());
      const s0 = logs.seats[0];
      await teleport(p, { x: s0.x + (s0.x - logs.campfire.x) * 0.25, z: s0.z + (s0.z - logs.campfire.z) * 0.25 });
      await sleep(600);
      if ((await debug(p)).m3.worship.mode === 'hidden') await (touch ? p.tap('#btn-worship') : p.click('#btn-worship'));
      for (const fold of ['open', 'mini', 'folded', 'hidden']) {
        if (fold === 'hidden') {
          if ((await debug(p)).m3.worship.mode !== 'hidden') await p.evaluate(() => window.__WORLDS_TEST__.worshipFold('open'));
          await (touch ? p.tap('#btn-worship') : p.click('#btn-worship'));
        } else {
          if ((await debug(p)).m3.worship.mode === 'hidden') await (touch ? p.tap('#btn-worship') : p.click('#btn-worship'));
          await p.evaluate((f) => window.__WORLDS_TEST__.worshipFold(f), fold);
        }
        for (const chatFold of [false, true]) {
          const folded = await p.evaluate(() => document.getElementById('chat')?.classList.contains('folded'));
          if (folded !== chatFold && (await p.isVisible(chatFold ? '#chat-fold' : '#chat-pill'))) await p.click(chatFold ? '#chat-fold' : '#chat-pill');
          await sleep(500);
          const b = await p.evaluate(() => {
            const vis = (el) => {
              if (!el) return null;
              const s = getComputedStyle(el);
              if (el.hidden || s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return null;
              for (let e = el; e; e = e.parentElement) if (Number(getComputedStyle(e).opacity) === 0) return null;
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
            };
            // Show the voice chip and the prop dock where they would be (they appear only in a voice room / with a rental).
            const voice = document.getElementById('voice-chip');
            const dock = document.getElementById('prop-dock');
            const was = [voice?.hidden, dock?.hidden];
            if (voice) voice.hidden = false;
            if (dock) dock.hidden = false;
            const out = {
              vw: innerWidth,
              vh: innerHeight,
              camera: vis(document.getElementById('camera-btn')),
              joystick: vis(document.getElementById('stick-base')),
              action: vis(document.getElementById('action-btn')),
              worship: vis(document.querySelector('#worship:not(.folded)')),
              tab: vis(document.getElementById('worship-tab')),
              chatPill: vis(document.getElementById('chat-pill')),
              chat: vis(document.querySelector('#chat:not(.folded)')),
              voice: vis(voice),
              dock: vis(dock),
              tools: vis(document.getElementById('tools')),
              place: vis(document.querySelector('.place-card')),
              prompt: vis(document.getElementById('prompt')),
            };
            if (voice) voice.hidden = was[0];
            if (dock) dock.hidden = was[1];
            return out;
          });
          const bad = [];
          if (!b.camera) bad.push('camera hidden');
          else if (!inside(b.camera, b.vw, b.vh)) bad.push(`camera off-screen ${fmt(b.camera)}`);
          for (const k of ['joystick', 'action', 'worship', 'tab', 'chatPill', 'chat', 'voice', 'dock', 'tools', 'place', 'prompt']) if (overlaps(b.camera, b[k])) bad.push(`overlaps ${k} ${fmt(b[k])}`);
          check(`${name} worship=${fold} chat=${chatFold ? 'folded' : 'open'}: 📷 visible, clear of joystick/action/worship/chat/voice/prop dock`, bad.length === 0, bad.join('; ') || fmt(b.camera));
          if (name === 'p390' && fold === 'open' && !chatFold) await p.screenshot({ path: shotPath('camera-button-phone') });
          if (name === 'p390' && fold === 'mini' && chatFold) await p.screenshot({ path: shotPath('camera-button-phone-mini') });
        }
      }
      if ((await debug(p)).m3.worship.mode === 'hidden') await (touch ? p.tap('#btn-worship') : p.click('#btn-worship'));
    }
    await tabletCtx.close();
  }

  // ================================================================ export + deletion
  if (run('account')) {
    step('export');
    const ex = await A.json('GET', '/api/me/export');
    const data = ex.data;
    check('export: books (testimonies + diary) with content', data.library.books.some((b) => b.kind === 'diary' && b.parts.length > 0) && data.library.books.some((b) => b.kind === 'testimony'));
    check('export: 발자취 events and minutes', data.footprints.events.some((e) => e.type === 'letter') && data.footprints.minutesByDay.some((m) => m.kind === 'pray'));
    check('export: screenshots with the image itself', data.screenshots.length >= 1 && data.screenshots[0].image?.startsWith('data:image/webp;base64,'));
    const exB = (await B.json('GET', '/api/me/export')).data;
    check('export (B): 공감, 책갈피, books read, reports made, draft', exB.library.reactionsGiven.length >= 1 && exB.library.bookmarks.length >= 1 && exB.library.booksRead.length >= 1 && exB.library.reportsMade.length >= 1);

    step('deletion');
    const filesBefore = readdirSync(SHOTS).length;
    const aFiles = (() => {
      const d = db();
      try {
        return d.prepare('SELECT file FROM screenshots WHERE user_id = ?').all(A.id).map((r) => r.file);
      } finally {
        d.close();
      }
    })();
    const del = await A.json('POST', '/api/me/delete', { nickname: NICK.a });
    check('A deletes the account', del.status === 200);
    const left = ['stories', 'footprints', 'footprint_minutes', 'screenshots', 'story_drafts', 'shot_days', 'story_days'].map((t) => [t, count(`SELECT COUNT(*) n FROM ${t} WHERE user_id = ?`, A.id)]);
    const left2 = [
      ['story_reactions', count('SELECT COUNT(*) n FROM story_reactions WHERE user_id = ?', A.id)],
      ['story_bookmarks', count('SELECT COUNT(*) n FROM story_bookmarks WHERE user_id = ?', A.id)],
      ['story_reads', count('SELECT COUNT(*) n FROM story_reads WHERE user_id = ?', A.id)],
      ['story_reports', count('SELECT COUNT(*) n FROM story_reports WHERE reporter_id = ?', A.id)],
      ['others\' reactions on A\'s books', count('SELECT COUNT(*) n FROM story_reactions WHERE story_id IN (?, ?)', T.pub, T.diary ?? -1)],
    ];
    check('deletion removes every library row of A', [...left, ...left2].every(([, n]) => n === 0), JSON.stringify([...left, ...left2].filter(([, n]) => n)));
    check('deletion removes A\'s screenshot files on disk', aFiles.length >= 1 && aFiles.every((f) => !existsSync(resolve(SHOTS, f))) && readdirSync(SHOTS).length === filesBefore - aFiles.length, `${filesBefore} → ${readdirSync(SHOTS).length}`);
    check('B\'s bookmark of A\'s book is gone', (await B.json('GET', '/api/library/mine')).data.bookmarks.every((b) => b.id !== T.pub));
  }
} catch (err) {
  check('test run completed', false, `[step: ${currentStep()}] ${String(err?.stack ?? err).split('\n').slice(0, 3).join(' | ')}`);
} finally {
  await browser?.close();
  await stopAll();
  dropDb(DB);
  rmSync(SHOTS, { recursive: true, force: true });
}
process.exit(summary());
