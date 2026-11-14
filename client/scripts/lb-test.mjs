// L-B test: ✉️ 답장 편지 (threads, visibility, anonymity, moderation, idempotency,
// rate limits), 📬 받은 편지 (server read state, two devices), notifications (mock
// push: 공감 batching, letters/replies, prefs, 📔 밤 일기 알림 with a fake clock,
// notification links), B3 photo backups (mirror, retention, restore), B4 (library
// movement: nobody gets stuck), B5 (diary photos on the production-mode server),
// B6 (the reader) screenshots, export and account deletion.
// One server serves the built client (SERVE_CLIENT: CSP + service worker, like production).
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/lb-test.mjs
// Port: TEST_SERVER_PORT (5196); the restore simulation uses the next port.
// LB_ONLY=api,notify,backup,walk,photo,ui,account runs a subset.
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, debug, freshDb, launch, of, rawClient, serverDir, shotDir, sleep, start, startServer, step, stop, stopAll, summary, until, waitHttp } from './lib/harness.mjs';

const PORT = Number(process.env.TEST_SERVER_PORT ?? 5196);
const RPORT = PORT + 1;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const Q = (time = '14:00') => `?test=1&shadows=0&time=${time}&noguide=1`;
const DB = freshDb('lb');
const SHOTS = resolve(serverDir, 'data/test/lb-shots');
const BACKUPS = resolve(serverDir, 'data/test/lb-backups');
const RESTORE = resolve(serverDir, 'data/test/lb-restore');
const require = createRequire(resolve(serverDir, 'package.json'));
const Database = require('better-sqlite3');
const webpush = require('web-push');
const VAPID = webpush.generateVAPIDKeys(); // throwaway, test only
const P = await import(pathToFileURL(resolve(serverDir, 'dist/shared/protocol.js')).href);
const ONLY = (process.env.LB_ONLY ?? '').split(',').filter(Boolean);
const run = (phase) => ONLY.length === 0 || ONLY.includes(phase);
const TODAY = P.kstDateOf(Date.now());
const kst = (date, hm) => Date.parse(`${date}T${hm}:00+09:00`);
const NICK = { a: '아론', b: '보아스', c: '사무엘', d: '다윗', e: '에스더', r1: '룻', r2: '레아', r3: '라헬', x: '요셉', y: '야곱', p: '바울', admin: '관리자' };

/** Notification + PushManager stubs (headless Chromium can't subscribe for real), as in m6. */
const PUSH_STUB = () => {
  window.__perm = 'granted';
  window.__sub = null;
  Object.defineProperty(Notification, 'permission', { get: () => window.__perm, configurable: true });
  Notification.requestPermission = async () => window.__perm;
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  PushManager.prototype.getSubscription = async function () {
    return window.__sub;
  };
  PushManager.prototype.subscribe = async function () {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const endpoint = `https://push.test/browser/${Math.random().toString(36).slice(2)}`;
    const json = { endpoint, expirationTime: null, keys: { p256dh: b64(raw), auth: b64(auth) } };
    window.__sub = { endpoint, toJSON: () => json, unsubscribe: async () => ((window.__sub = null), true) };
    return window.__sub;
  };
};

class Agent {
  constructor(origin = ORIGIN) {
    this.jar = new Map();
    this.origin = origin;
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
  async raw(method, path, body, type, origin = this.origin) {
    const binary = body instanceof Uint8Array || body instanceof Buffer;
    const res = await fetch(path.startsWith('http') ? path : origin + path, {
      method,
      redirect: 'manual',
      headers: { ...(this.jar.size ? { cookie: this.cookieHeader() } : {}), ...(body !== undefined ? { 'content-type': type ?? 'application/json' } : {}) },
      body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
    });
    this.absorb(res);
    return res;
  }
  async json(method, path, body, type, origin) {
    const res = await this.raw(method, path, body, type, origin);
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
  return a;
}
async function contextFor(browser, agent, opts = {}) {
  const ctx = await browser.newContext({ deviceScaleFactor: 1, ...opts });
  await ctx.addCookies([...agent.jar].map(([name, value]) => ({ name, value, url: ORIGIN })));
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
  await until(page, () => window.__WORLDS_DEBUG__?.ready && window.__WORLDS_DEBUG__.net?.status === 'online', null, Number(process.env.TEST_ONLINE_MS ?? 180000));
}
const view = async (page) => (await debug(page)).la.view;
const modalIs = (p, name, ms = 15000) => until(p, (n) => window.__WORLDS_DEBUG__.m3.modal === n, name, ms);
const count = (sql, ...args) => {
  const d = new Database(DB, { readonly: true });
  try {
    return d.prepare(sql).get(...args).n;
  } finally {
    d.close();
  }
};
let subN = 0;
function fakeSub(tag = 'dev') {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { endpoint: `https://push.test/${tag}/${++subN}`, keys: { p256dh: raw.toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}
const rid = () => randomBytes(10).toString('hex');
const shotPath = (name) => resolve(shotDir, `lb-${name}.png`);
/** A tiny real WebP (VP8L 16x16) for uploads. */
function webp16(seed) {
  // VP8L header: 16x16; the body is junk-but-parseable for our header check.
  const b = Buffer.alloc(120 + seed);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8L', 12, 'ascii');
  b.writeUInt32LE(b.length - 20, 16);
  b[20] = 0x2f;
  // width-1 = 15 (14 bits), height-1 = 15 (14 bits)
  const v = 15 | (15 << 14);
  b.writeUInt32LE(v, 21);
  for (let i = 25; i < b.length; i++) b[i] = (i * 7 + seed) & 0xff;
  return b;
}
const runBackup = (env, args = []) =>
  execFileSync('node', ['scripts/backup.mjs', ...args], { cwd: serverDir, env: { ...process.env, WORLDS_DB: DB, WORLDS_SHOTS_DIR: SHOTS, BACKUP_DIR: BACKUPS, BACKUP_KEEP: '3', ...env }, encoding: 'utf-8' });
const mirrorFiles = () => (existsSync(resolve(BACKUPS, 'screenshots')) ? readdirSync(resolve(BACKUPS, 'screenshots')).filter((f) => /^[0-9a-f]{32}\.(webp|jpg)$/.test(f)).sort() : []);
const fileOf = (shotId) => {
  const d = new Database(DB, { readonly: true });
  try {
    return d.prepare('SELECT file FROM screenshots WHERE id = ?').get(shotId)?.file ?? null;
  } finally {
    d.close();
  }
};

let browser;
try {
  for (const d of [SHOTS, BACKUPS, RESTORE]) rmSync(d, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  startServer(PORT, DB, {
    WORLDS_AUTH_MOCK: '1',
    WORLDS_PUSH_MOCK: '1',
    VAPID_PUBLIC_KEY: VAPID.publicKey,
    VAPID_PRIVATE_KEY: VAPID.privateKey,
    VAPID_SUBJECT: 'mailto:test@example.invalid',
    SERVE_CLIENT: '1',
    WORLDS_SHOTS_DIR: SHOTS,
    WORLDS_FOOTPRINT_TICK_MS: '1000',
    MAX_CONN_PER_IP: '80',
    AUTH_RATE_LIMIT: '400',
    NEW_ACCOUNTS_PER_HOUR: '500',
    IP_RATE_LIMIT: '20000',
    LIBRARY_RATE_LIMIT: '2000',
    WORLDS_ADMIN_EMAILS: 'MOCK-lb-admin@example.test',
  });
  await waitHttp(`${ORIGIN}/health`);

  step('accounts');
  const A = await account('lb-a', NICK.a);
  const B = await account('lb-b', NICK.b);
  const C = await account('lb-c', NICK.c);
  const D = await account('lb-d', NICK.d);
  const E = await account('lb-e', NICK.e);
  const R = [await account('lb-r1', NICK.r1), await account('lb-r2', NICK.r2), await account('lb-r3', NICK.r3)];
  const X = await account('lb-x', NICK.x);
  const Y = await account('lb-y', NICK.y);
  const PH = await account('lb-p', NICK.p);
  const PH2 = await account('lb-p2', '실라');
  const ADM = await account('lb-admin', NICK.admin);
  const guest = new Agent();
  const g = (await A.json('POST', '/api/groups', { name: '새벽 모임' })).data;
  await B.json('POST', '/api/groups/join', { code: g.code });
  const base = { title: '광야에서 들은 소리', parts: ['몹시 힘든 한 해였어요. 일도 사람도 다 떠났어요.', '새벽에 시편을 읽다가 울었어요.', '이제는 매일 아침 감사로 시작해요.'] };
  const T = {};
  T.pub = (await A.json('POST', '/api/library/stories', { ...base, ref: '시편 23:1', visibility: 'public' })).data.id;
  T.grp = (await A.json('POST', '/api/library/stories', { ...base, title: '모임 이야기', visibility: 'group', groupId: g.id })).data.id;
  T.anon = (await A.json('POST', '/api/library/stories', { ...base, title: '익명으로 쓰는 감사', visibility: 'anonymous' })).data.id;
  T.priv = (await A.json('POST', '/api/library/stories', { ...base, title: '나만 보는 기도', visibility: 'private' })).data.id;
  check('setup: four books (public, group, anonymous, private) and a group A+B', [T.pub, T.grp, T.anon, T.priv].every(Number.isInteger) && !!g.id, JSON.stringify(T));
  const letters = (agent, sid) => agent.json('GET', `/api/library/stories/${sid}/letters`);
  const write = (agent, sid, body) => agent.json('POST', `/api/library/stories/${sid}/letters`, { requestId: rid(), ...body });
  const reply = (agent, lid, body) => agent.json('POST', `/api/library/letters/${lid}/replies`, { requestId: rid(), ...body });
  // Every inbox read also asks the badge-only endpoint: one SQL COUNT must agree with the full inbox.
  const unreadMismatch = [];
  let unreadCompared = 0;
  const inbox = async (agent) => {
    const data = (await agent.json('GET', '/api/library/letters/inbox')).data;
    const badge = await agent.json('GET', '/api/library/letters/unread');
    unreadCompared++;
    if (badge.status !== 200 || badge.data?.unread !== data?.unread) unreadMismatch.push(`${badge.status}:${badge.data?.unread}≠${data?.unread}`);
    return data;
  };
  const L = {};

  // ================================================================ API: letters
  if (run('api') || run('notify') || run('ui') || run('account')) {
    step('letters: thread on a public testimony');
    check('guest cannot write a letter (401)', (await guest.json('POST', `/api/library/stories/${T.pub}/letters`, { text: '안녕하세요', requestId: rid() })).status === 401);
    const bad = [
      [{ text: '' }, 400, 'empty'],
      [{ text: '가'.repeat(301) }, 400, '> 300 chars'],
      [{ text: '좋아요', requestId: 'x' }, 400, 'bad requestId'],
    ];
    for (const [body, status, label] of bad) {
      const r = await C.json('POST', `/api/library/stories/${T.pub}/letters`, { requestId: rid(), ...body });
      check(`letter rejected: ${label} (${status})`, r.status === status, `${r.status} ${r.data?.error}`);
    }
    const l1 = await write(C, T.pub, { text: '이야기 읽고 많이 울었어요.\n고마워요.' });
    L.c = l1.data?.thread?.id;
    check('C writes a letter (201, 300 chars max, line breaks kept)', l1.status === 201 && l1.data.thread.text === '이야기 읽고 많이 울었어요.\n고마워요.' && l1.data.thread.author === NICK.c && l1.data.thread.mine);
    check('author cannot write a letter on their own book (400 own_story)', (await write(A, T.pub, { text: '내 책' })).data?.error === 'own_story');
    const seenGuest = (await letters(guest, T.pub)).data;
    check('guest sees the letter on a public book (count 1, cannot write)', seenGuest.count === 1 && seenGuest.letters[0].text.startsWith('이야기 읽고') && seenGuest.canWrite === false);
    check('A (author) inbox: 1 unread letter', (await inbox(A)).unread === 1);
    const ra = await reply(A, L.c, { text: '읽어 주셔서 고마워요. 같이 기도해요.' });
    check('A (book author) replies (201), marked 글쓴이', ra.status === 201 && ra.data.thread.replies.length === 1 && ra.data.thread.replies[0].role === 'author');
    check('…A cannot reply twice in a row (409 not_your_turn)', (await reply(A, L.c, { text: '한 번 더' })).data?.error === 'not_your_turn');
    check('C (writer) inbox: 1 unread (the reply)', (await inbox(C)).unread === 1);
    const rc = await reply(C, L.c, { text: '네, 꼭 기도할게요.' });
    check('C replies back (201)', rc.status === 201 && rc.data.thread.replies.length === 2);
    check('a third person (D) cannot reply in the thread (403 not_party)', (await reply(D, L.c, { text: '저도요' })).data?.error === 'not_party');
    // Thread cap: D's letter, alternate A/D until LETTER_REPLIES_MAX.
    L.d = (await write(D, T.pub, { text: '답장 끝까지 이어 보기' })).data.thread.id;
    let ok = 0;
    for (let i = 0; i < P.LETTER_REPLIES_MAX; i++) if ((await reply(i % 2 === 0 ? A : D, L.d, { text: `답장 ${i + 1}` })).status === 201) ok++;
    const cap = await reply(A, L.d, { text: '21번째' });
    const cap2 = await reply(D, L.d, { text: '21번째' });
    check(`thread cap: ${P.LETTER_REPLIES_MAX} replies, then 409 thread_full`, ok === P.LETTER_REPLIES_MAX && [cap, cap2].some((r) => r.data?.error === 'thread_full') && [cap, cap2].every((r) => r.status >= 400), `${ok} ${cap.data?.error} ${cap2.data?.error}`);
    const thr = (await letters(D, T.pub)).data.letters.find((t) => t.id === L.d);
    check('…the thread says why (replyNote) and canReply is false', thr && !thr.canReply && /20번/.test(thr.replyNote ?? ''));

    step('letters: group / private visibility (+ no WS leak)');
    const cookie = (agent) => ({ cookie: agent.cookieHeader() });
    const wsC = await rawClient(WS, { nickname: 'x', test: true }, cookie(C));
    const wsA = await rawClient(WS, { nickname: 'x', test: true }, cookie(A));
    const wsG = await rawClient(WS, { nickname: '손님', test: true });
    const lg = await write(B, T.grp, { text: '모임 비밀편지QQQ 함께 기도해요' });
    L.g = lg.data?.thread?.id;
    check('member B writes on the group book (201)', lg.status === 201);
    check('non-member C: letters 404, write 404', (await letters(C, T.grp)).status === 404 && (await write(C, T.grp, { text: '안녕' })).status === 404);
    check('guest: group letters 404', (await letters(guest, T.grp)).status === 404);
    check('non-member C: reply to the group letter 404', (await reply(C, L.g, { text: 'x' })).status === 404);
    await reply(A, L.g, { text: '모임 답장QQQ' });
    await sleep(700);
    const leak = [...wsC.inbox, ...wsG.inbox].filter((m) => JSON.stringify(m).includes('QQQ') || m.t === 'letters');
    check('no WS leak: C and a guest socket got no letters message and no letter text', leak.length === 0, JSON.stringify(leak).slice(0, 200));
    const aMsgs = of(wsA, 'letters');
    check('A socket: a letters badge update with fixed text (no letter text, no names)', aMsgs.length >= 1 && aMsgs.every((m) => !JSON.stringify(m).includes('QQQ') && !JSON.stringify(m).includes(NICK.b)) && aMsgs.some((m) => m.toast === '✉️ 내 이야기에 새 편지가 왔어요'), JSON.stringify(aMsgs));
    for (const c of [wsC, wsA, wsG]) c.ws.close();
    check('private book: others 404 for letters and writing', (await letters(C, T.priv)).status === 404 && (await write(C, T.priv, { text: '안녕' })).status === 404);
    const pa = (await letters(A, T.priv)).data;
    check('private book: its author sees no compose and a note (no letters on 나만)', pa.canWrite === false && /나만/.test(pa.note ?? '') && pa.letters.length === 0);

    step('letters: anonymous');
    const la1 = await write(C, T.anon, { text: '익명 책에 쓰는 편지예요' });
    L.anonBook = la1.data.thread.id;
    await reply(A, L.anonBook, { text: '글쓴이의 답장AAA' });
    const la2 = await write(D, T.anon, { text: '저는 익명으로 보내요ZZZ', anonymous: true });
    L.anonLetter = la2.data.thread.id;
    await reply(A, L.anonLetter, { text: '익명 편지에 답해요' });
    await reply(D, L.anonLetter, { text: '익명 답장도 가려져요' });
    // Same on a public book: anonymous letter writer.
    L.anonPub = (await write(E, T.pub, { text: '공개 책에 익명 편지', anonymous: true })).data.thread.id;
    const idLeak = (text) => /"user_?[iI]d"\s*:/.test(text) || text.includes('"authorId"') || text.includes('lb-');
    const scans = [];
    // D wrote anonymously on the anonymous book (and with a name on the public one); E anonymously on the public one.
    const hiddenNames = (path) => (path.includes(`/stories/${T.anon}`) ? [NICK.d] : [NICK.e]);
    for (const [who, agent] of [['guest', guest], ['B', B], ['C', C], ['R1', R[0]], ['A', A]]) {
      for (const path of [`/api/library/stories/${T.anon}/letters`, `/api/library/stories/${T.pub}/letters`, `/api/library/stories/${T.anon}`]) {
        const r = await agent.json('GET', path);
        if (idLeak(r.text)) scans.push(`${who} ${path} id`);
        if (agent !== A && path.startsWith(`/api/library/stories/${T.anon}`) && r.text.includes(NICK.a)) scans.push(`${who} ${path} author nickname`);
        for (const n of hiddenNames(path)) if (r.text.includes(n)) scans.push(`${who} ${path} anonymous writer nickname`);
      }
      if (agent !== guest) {
        const ib = await agent.json('GET', '/api/library/letters/inbox');
        if (idLeak(ib.text)) scans.push(`${who} inbox id`);
        for (const it of ib.data.items) {
          if ([L.anonLetter, L.anonPub].includes(it.letterId) && JSON.stringify(it).match(new RegExp(`${NICK.d}|${NICK.e}`))) scans.push(`${who} inbox anonymous writer`);
          if (it.storyId === T.anon && agent !== A && JSON.stringify(it).includes(NICK.a)) scans.push(`${who} inbox anonymous book author`);
        }
      }
    }
    check('anonymous deep scan: no nickname of an anonymous book author or anonymous letter writer, no ids (guest, B, C, R1, A)', scans.length === 0, scans.join(', '));
    const anonView = (await letters(C, T.anon)).data;
    const tb = anonView.letters.find((t) => t.id === L.anonBook);
    const tl = anonView.letters.find((t) => t.id === L.anonLetter);
    check('anonymous book: the author\'s reply shows as 글쓴이', tb.replies[0].author === P.BOOK_AUTHOR_NAME && tb.replies[0].role === 'author');
    check('anonymous letter: writer and their replies show as 익명의 성도', tl.author === P.ANONYMOUS_NAME && tl.replies.filter((r) => r.role === 'writer').every((r) => r.author === P.ANONYMOUS_NAME));
    const own = (await letters(D, T.anon)).data.letters.find((t) => t.id === L.anonLetter);
    const ownA = (await letters(A, T.anon)).data.letters.find((t) => t.id === L.anonBook);
    check('…but each sees their own name (D its letter, A its replies)', own.author === NICK.d && own.anonymous === true && ownA.replies[0].author === NICK.a);

    step('letters: delete, hide, report, admin');
    const dl = await D.json('DELETE', `/api/library/letters/${L.d}`);
    const afterDel = (await letters(guest, T.pub)).data.letters.find((t) => t.id === L.d);
    check('writer deletes own letter: "삭제된 편지예요" (text wiped in the DB), replies stay', dl.status === 200 && afterDel?.deleted === true && afterDel.text === '' && count("SELECT COUNT(*) n FROM story_letters WHERE id = ? AND text = ''", L.d) === 1);
    check('others cannot delete a letter (404)', (await C.json('DELETE', `/api/library/letters/${L.anonPub}`)).status === 404);
    const replyId = (await letters(C, T.pub)).data.letters.find((t) => t.id === L.c).replies[1].id;
    check('C deletes own reply', (await C.json('DELETE', `/api/library/letters/${replyId}`)).status === 200 && (await letters(guest, T.pub)).data.letters.find((t) => t.id === L.c).replies[1].deleted === true);
    const hid = await A.json('POST', `/api/library/letters/${L.c}/hide`, { hidden: true });
    const gHidden = (await letters(guest, T.pub)).data.letters.some((t) => t.id === L.c);
    const cHidden = (await letters(C, T.pub)).data.letters.find((t) => t.id === L.c);
    check('book author hides a letter: gone for guests, its writer still sees it, author sees it folded', hid.status === 200 && !gHidden && !!cHidden && hid.data.thread.hiddenByAuthor === true);
    check('only the book author can hide (C → 404)', (await C.json('POST', `/api/library/letters/${L.anonPub}/hide`, { hidden: true })).status === 404);
    await A.json('POST', `/api/library/letters/${L.c}/hide`, { hidden: false });
    check('…and unhide', (await letters(guest, T.pub)).data.letters.some((t) => t.id === L.c));
    L.x = (await write(X, T.pub, { text: '광고 편지예요 광고광고' })).data.thread.id;
    const reps = [];
    reps.push((await R[0].json('POST', `/api/library/letters/${L.x}/report`, { reason: 'spam' })).status);
    const dup = await R[0].json('POST', `/api/library/letters/${L.x}/report`, { reason: 'spam' });
    reps.push((await R[1].json('POST', `/api/library/letters/${L.x}/report`, { reason: 'spam' })).status);
    check('two reports: still visible', (await letters(guest, T.pub)).data.letters.some((t) => t.id === L.x));
    reps.push((await R[2].json('POST', `/api/library/letters/${L.x}/report`, { reason: 'spam' })).status);
    check('3 distinct reporters → auto-hidden (a repeat report is a duplicate)', reps.every((s) => s === 200) && dup.data.duplicate === true && !(await letters(guest, T.pub)).data.letters.some((t) => t.id === L.x));
    check('…its writer still sees it marked reported', (await letters(X, T.pub)).data.letters.find((t) => t.id === L.x)?.reported === true);
    check('own letter cannot be reported (400)', (await X.json('POST', `/api/library/letters/${L.x}/report`, { reason: 'spam' })).status === 400);
    check('non-admin: admin letters 404 (GET and POST)', (await C.json('GET', '/api/admin/library/letters')).status === 404 && (await C.json('POST', `/api/admin/library/letters/${L.x}`, { action: 'restore' })).status === 404);
    const al = await ADM.json('GET', '/api/admin/library/letters');
    const item = al.data?.letters?.find((l) => l.id === L.x);
    check('admin lists the reported letter (writer name, reasons, hidden)', al.status === 200 && item?.writer === NICK.x && item.hidden && item.reasons.spam === 3);
    await ADM.json('POST', `/api/admin/library/letters/${L.x}`, { action: 'restore' });
    check('admin restore → visible again', (await letters(guest, T.pub)).data.letters.some((t) => t.id === L.x));
    await ADM.json('POST', `/api/admin/library/letters/${L.x}`, { action: 'delete' });
    check('admin delete → gone (row removed)', !(await letters(X, T.pub)).data.letters.some((t) => t.id === L.x) && count('SELECT COUNT(*) n FROM story_letters WHERE id = ?', L.x) === 0);

    step('letters: idempotency, rate limit, personal info');
    const req = rid();
    const seq = [];
    for (let i = 0; i < 5; i++) seq.push(await C.json('POST', `/api/library/stories/${T.anon}/letters`, { text: '한 번만 가야 하는 편지', requestId: req }));
    check('same requestId 5× (sequential) → 1 letter (201 then 200 replayed)', seq[0].status === 201 && seq.slice(1).every((r) => r.status === 200 && r.data.replayed && r.data.thread.id === seq[0].data.thread.id) && count('SELECT COUNT(*) n FROM story_letters WHERE request_id = ?', req) === 1);
    const req2 = rid();
    const conc = await Promise.all(Array.from({ length: 5 }, () => C.json('POST', `/api/library/stories/${T.anon}/letters`, { text: '동시에 다섯 번', requestId: req2 })));
    check('same requestId 5× (concurrent) → 1 letter', conc.filter((r) => r.status === 201).length === 1 && conc.every((r) => r.status === 201 || r.status === 200) && new Set(conc.map((r) => r.data.thread.id)).size === 1 && count('SELECT COUNT(*) n FROM story_letters WHERE request_id = ?', req2) === 1);
    const lid2 = seq[0].data.thread.id;
    const req3 = rid();
    const rr = await Promise.all(Array.from({ length: 5 }, () => A.json('POST', `/api/library/letters/${lid2}/replies`, { text: '답장도 한 번만', requestId: req3 })));
    check('reply with the same requestId 5× (concurrent) → 1 reply', rr.filter((r) => r.status === 201).length === 1 && count('SELECT COUNT(*) n FROM story_letters WHERE request_id = ?', req3) === 1);
    check('a requestId reused for another book → 409', (await C.json('POST', `/api/library/stories/${T.pub}/letters`, { text: '다른 책', requestId: req })).status === 409);
    const ys = [];
    const yReq = [];
    for (let i = 0; i < P.LETTERS_PER_HOUR; i++) {
      yReq.push(rid());
      ys.push((await Y.json('POST', `/api/library/stories/${T.pub}/letters`, { text: `편지 ${i + 1}`, requestId: yReq[i] })).status);
    }
    const over = await Y.json('POST', `/api/library/stories/${T.pub}/letters`, { text: '한 통 더', requestId: rid() });
    const replay = await Y.json('POST', `/api/library/stories/${T.pub}/letters`, { text: '편지 1', requestId: yReq[0] });
    check(`rate limit: ${P.LETTERS_PER_HOUR} letters an hour, then 429 (replays still answer 200)`, ys.every((s) => s === 201) && over.status === 429 && replay.status === 200, `${ys.filter((s) => s === 201).length} ${over.status} ${replay.status}`);
    const phone = await write(C, T.pub, { text: '연락 주세요 010-1234-5678' });
    const mail = await write(C, T.pub, { text: '메일 test@example.com 으로' });
    const rrn = await write(C, T.pub, { text: '900101-1234567' });
    check('personal info in a letter → 409 personal_info (phone, email, resident number)', [phone, mail, rrn].every((r) => r.status === 409 && r.data.error === 'personal_info'), [phone, mail, rrn].map((r) => r.status).join());
    check('…confirmPersonal sends it', (await write(C, T.pub, { text: '연락 주세요 010-1234-5678', confirmPersonal: true })).status === 201);
    // Read state: two sessions of A agree; reading the book marks the threads read.
    const A2 = new Agent();
    await A2.login('lb-a');
    const u1 = (await inbox(A)).unread;
    const u2 = (await inbox(A2)).unread;
    check('받은 편지 unread is server-side (two sessions of A agree, > 0)', u1 > 0 && u1 === u2, `${u1} ${u2}`);
    await A2.json('POST', '/api/library/letters/read', { all: true });
    check('모두 읽음 in one session → 0 in the other', (await inbox(A)).unread === 0);
  }

  // ================================================================ notifications (mock push)
  const sent = async () => (await guest.json('GET', '/api/test/push/sent')).data.deliveries;
  const resetSent = () => guest.json('POST', '/api/test/push/reset', {});
  const setClock = (now) => guest.json('POST', '/api/test/push/clock', { now });
  const tick = async () => (await guest.json('POST', '/api/test/push/tick', {})).data;
  if (run('notify')) {
    step('push: prefs');
    for (const u of [A, B, C, D, E]) await u.json('POST', '/api/push/subscribe', { subscription: fakeSub(u.nickname) });
    const p0 = (await A.json('GET', '/api/push/prefs')).data;
    check('new prefs: 내 이야기 소식, 편지, 답장 on; 밤 일기 off at 21:00', p0.library === true && p0.letters === true && p0.replies === true && p0.diary === false && p0.diaryTime === '21:00', JSON.stringify(p0));
    check('diary time validated (30-minute steps)', (await A.json('PUT', '/api/push/prefs', { diaryTime: '21:15' })).status === 400);
    const t0 = kst(TODAY, '10:00');
    await setClock(t0);
    await resetSent();

    step('push: 공감 batching');
    const sid = T.grp; // A's group book: B is a member; reactions from B only, plus A's public book for others
    await B.json('POST', `/api/library/stories/${T.pub}/reactions`, { type: 'grace' });
    await sleep(200);
    let d1 = (await sent()).filter((x) => x.userId === A.id && x.payload.kind === 'story');
    check('first 공감 → one notice right away ("누군가 공감했어요", link to the book)', d1.length === 1 && /누군가 공감/.test(d1[0].payload.body) && d1[0].payload.url === `/?book=${T.pub}`, JSON.stringify(d1.map((x) => x.payload)));
    await setClock(t0 + 5 * 60_000);
    await C.json('POST', `/api/library/stories/${T.pub}/reactions`, { type: 'same' });
    await D.json('POST', `/api/library/stories/${T.pub}/reactions`, { type: 'pray' });
    await E.json('POST', `/api/library/stories/${T.pub}/reactions`, { type: 'grace' });
    await setClock(t0 + 20 * 60_000);
    await tick();
    d1 = (await sent()).filter((x) => x.userId === A.id && x.payload.kind === 'story');
    check('more 공감 within 30 minutes → no new notice yet (batched)', d1.length === 1, String(d1.length));
    await setClock(t0 + 31 * 60_000);
    await tick();
    d1 = (await sent()).filter((x) => x.userId === A.id && x.payload.kind === 'story');
    check('after 30 minutes the tick sends one batched notice "3명이 공감했어요"', d1.length === 2 && /3명이 공감/.test(d1[1].payload.body), JSON.stringify(d1.map((x) => x.payload.body)));
    await setClock(t0 + 40 * 60_000);
    await tick();
    check('…and nothing more when nothing new happened', (await sent()).filter((x) => x.userId === A.id && x.payload.kind === 'story').length === 2);
    await A.json('PUT', '/api/push/prefs', { library: false });
    await B.json('POST', `/api/library/stories/${sid}/reactions`, { type: 'pray' });
    await setClock(t0 + 80 * 60_000);
    await C.json('POST', `/api/library/stories/${T.pub}/reactions`, { type: 'grace' });
    await tick();
    check('내 이야기 소식 off → no 공감 notice', (await sent()).filter((x) => x.userId === A.id && x.payload.kind === 'story').length === 2);
    await A.json('PUT', '/api/push/prefs', { library: true });

    step('push: letters and replies');
    await resetSent();
    const gl = await write(B, T.grp, { text: '모임책 편지 내용PPP' });
    const pl = await write(C, T.pub, { text: '공개책 편지 내용PPP' });
    await reply(A, pl.data.thread.id, { text: '답장 내용PPP' });
    const al = await write(D, T.anon, { text: '익명 편지 내용PPP', anonymous: true });
    await reply(A, al.data.thread.id, { text: '익명 편지 답장PPP' });
    await reply(D, al.data.thread.id, { text: '익명 답장 다시PPP' });
    await sleep(300);
    const ds = await sent();
    const toA = ds.filter((x) => x.userId === A.id);
    const toC = ds.filter((x) => x.userId === C.id);
    const toD = ds.filter((x) => x.userId === D.id);
    check('new letters → the book author (group, public and anonymous books)', toA.filter((x) => x.payload.kind === 'letter').length === 3 && toA.every((x) => x.payload.url.startsWith('/?book=')), JSON.stringify(toA.map((x) => x.payload.kind)));
    check('author reply → the letter writer (💌), writer reply back → the author', toC.some((x) => x.payload.kind === 'reply' && x.payload.url === `/?book=${T.pub}&letter=${pl.data.thread.id}`) && toD.some((x) => x.payload.kind === 'reply') && toA.some((x) => x.payload.kind === 'reply'));
    const leaks = ds.filter((x) => /PPP/.test(JSON.stringify(x.payload)) || [NICK.a, NICK.b, NICK.c, NICK.d].some((n) => JSON.stringify(x.payload).includes(n)) || JSON.stringify(x.payload).includes('익명으로 쓰는 감사'));
    check('payloads: no letter text, no names, no book titles (anonymous stays anonymous)', leaks.length === 0 && ds.length >= 6, JSON.stringify(leaks.map((x) => x.payload)));
    check('generic titles', toA.find((x) => x.payload.kind === 'letter').payload.title === '✉️ 내 이야기에 새 편지가 왔어요' && toC.find((x) => x.payload.kind === 'reply').payload.title === '💌 편지에 답장이 왔어요');
    await resetSent();
    await A.json('PUT', '/api/push/prefs', { letters: false });
    await C.json('PUT', '/api/push/prefs', { replies: false });
    const pl2 = await write(C, T.pub, { text: '편지 알림 끔 확인' });
    await reply(A, pl2.data.thread.id, { text: '답장 알림 끔 확인' });
    await sleep(300);
    check('prefs off (편지 for A, 답장 for C) → no push', (await sent()).filter((x) => x.userId === A.id || x.userId === C.id).length === 0, JSON.stringify((await sent()).map((x) => [x.userId, x.payload.kind])));
    await A.json('PUT', '/api/push/prefs', { letters: true });
    await C.json('PUT', '/api/push/prefs', { replies: true });

    step('push: 📔 밤 일기 알림 (fake clock)');
    // A has 발자취 today (reading B's… A reads C's? A reads a book by someone else).
    const bBook = (await B.json('POST', '/api/library/stories', { ...base, title: '보아스의 이야기', visibility: 'public' })).data.id;
    await A.json('GET', `/api/library/stories/${bBook}`);
    await C.json('GET', `/api/library/stories/${bBook}`);
    for (const u of [A, C, E]) await u.json('PUT', '/api/push/prefs', { diary: true, diaryTime: '21:00' });
    check('setup: A and C have 발자취 today, E has none', count('SELECT COUNT(*) n FROM footprints WHERE user_id = ? AND kst_date = ?', A.id, TODAY) > 0 && count('SELECT COUNT(*) n FROM footprints WHERE user_id = ? AND kst_date = ?', E.id, TODAY) === 0);
    await setClock(kst(TODAY, '20:00'));
    const cd = await C.json('POST', '/api/diary', { lines: ['오늘은 일찍 일기를 썼어요'], visibility: 'private' });
    check('C publishes today\'s diary before 21:00', cd.status === 200);
    await resetSent();
    await setClock(kst(TODAY, '20:30'));
    await tick();
    const diaryN = async () => (await sent()).filter((x) => x.payload.kind === 'diary');
    check('20:30 → no diary reminder yet', (await diaryN()).length === 0);
    await setClock(kst(TODAY, '21:00'));
    await tick();
    let dd = await diaryN();
    check('21:00 → one reminder to A (발자취 today, no diary), text and link', dd.length === 1 && dd[0].userId === A.id && dd[0].payload.title === '📔 오늘 하루를 일기로 남겨 볼까요?' && dd[0].payload.url === '/?diary=1', JSON.stringify(dd));
    await setClock(kst(TODAY, '21:30'));
    await tick();
    await setClock(kst(TODAY, '22:00'));
    await tick();
    dd = await diaryN();
    check('…at most once a day; not to C (diary published) nor E (no 발자취)', dd.length === 1);
    await setClock(null);
    await resetSent();
  }

  // ================================================================ B3 backup
  if (run('backup')) {
    step('backup: photo mirror');
    const up = async (agent, seed) => (await agent.json('POST', '/api/shots?place=들판', webp16(seed), 'image/webp')).data;
    const s1 = await up(PH, 1);
    const s2 = await up(PH, 2);
    check('setup: two photos uploaded', !!s1?.shot?.id && !!s2?.shot?.id, JSON.stringify(s1));
    const pd = await PH.json('POST', '/api/diary', { lines: ['오늘의 풍경을 사진 1장에 담았어요 📸'], photoIds: [s1.shot.id], visibility: 'public' });
    check('setup: a public diary with photo 1', pd.status === 200 && pd.data.photoIds[0] === s1.shot.id);
    const f1 = fileOf(s1.shot.id);
    const f2 = fileOf(s2.shot.id);
    const out1 = runBackup();
    check('backup 1: DB written and both photos mirrored', /backup written/.test(out1) && mirrorFiles().includes(f1) && mirrorFiles().includes(f2), out1.trim().split('\n').pop());
    const out2 = runBackup();
    check('backup 2: idempotent (0 copied, same mirror)', /0 copied, 0 removed/.test(out2) && mirrorFiles().length === 2, out2.trim().split('\n').pop());
    check('mirror files are private (0600)', (await import('node:fs')).statSync(resolve(BACKUPS, 'screenshots', f1)).mode % 0o1000 === 0o600);
    await PH.json('DELETE', `/api/shots/${s2.shot.id}`);
    runBackup();
    check('photo 2 deleted: still in the mirror while a kept backup lists it', mirrorFiles().includes(f2));
    runBackup();
    runBackup();
    const out6 = runBackup();
    check('…gone once the last backup that knew it is pruned (BACKUP_KEEP=3), photo 1 stays', !mirrorFiles().includes(f2) && mirrorFiles().includes(f1), out6.trim().split('\n').pop());
    const dbs = readdirSync(BACKUPS).filter((f) => /^worlds-\d{8}-\d{6}\.db$/.test(f)).sort();
    check('only BACKUP_KEEP DB backups kept', dbs.length === 3, dbs.join(','));

    step('backup: restore simulation');
    mkdirSync(RESTORE, { recursive: true });
    copyFileSync(resolve(BACKUPS, dbs[dbs.length - 1]), resolve(RESTORE, 'worlds.db'));
    const ro = execFileSync('node', ['scripts/backup.mjs', '--restore-photos', resolve(BACKUPS, dbs[dbs.length - 1])], {
      cwd: serverDir,
      env: { ...process.env, WORLDS_DB: resolve(RESTORE, 'worlds.db'), WORLDS_SHOTS_DIR: resolve(RESTORE, 'screenshots'), BACKUP_DIR: BACKUPS },
      encoding: 'utf-8',
    });
    check('--restore-photos copies exactly the photos that backup lists', /1 copied/.test(ro) && readdirSync(resolve(RESTORE, 'screenshots')).join() === f1, ro.trim());
    const rs = startServer(RPORT, resolve(RESTORE, 'worlds.db'), { WORLDS_SHOTS_DIR: resolve(RESTORE, 'screenshots'), QUIET: '1' });
    await waitHttp(`http://127.0.0.1:${RPORT}/health`);
    const rg = new Agent(`http://127.0.0.1:${RPORT}`);
    const story = await rg.json('GET', `/api/library/stories/${pd.data.id}`);
    const img = await rg.raw('GET', `/api/shots/${s1.shot.id}`);
    check('restored server: the published diary and its photo load (200, image/webp)', story.status === 200 && img.status === 200 && img.headers.get('content-type') === 'image/webp');
    await stop(rs);
  }

  // ================================================================ browsers
  browser = await launch();
  const phone = (w = 390, h = 844) => ({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  // ---------------------------------------------------------------- B4: library movement
  if (run('walk')) {
    step('B4: library walk');
    const ctx = await contextFor(browser, PH, phone(412, 915));
    const pg = await ctx.newPage();
    await enterWorld(pg, Q());
    await pg.evaluate(() => window.__WORLDS_TEST__.enterLibrary());
    await until(pg, () => window.__WORLDS_DEBUG__.la.inLibrary === true, null, 15000);
    const w = await pg.evaluate(() => window.__WORLDS_TEST__.libraryWalk(0.35));
    check(`walk: every free grid point (${w.starts}) can reach the door with the real movement code`, w.starts > 300 && w.reached === w.starts && w.unreachable.length === 0 && w.stuck.length === 0, `${w.reached}/${w.starts} unreachable=${w.unreachable.slice(0, 5)} stuck=${w.stuck.slice(0, 5)}`);
    check('walk: nobody ever leaves the floor while walking', w.offFloor.length === 0, w.offFloor.slice(0, 5).join(' '));
    check(`walk: pushing into every wall, corner and piece of furniture (${w.pushes}×3 s) never traps or drops the player`, w.pushes > 60 && w.pushFails.length === 0, w.pushFails.slice(0, 6).join(' | '));
    check('walk: standing up from every desk chair lands on free floor', w.seats.length === 0, w.seats.join(' | '));
    // Two bookcases (🙏 하나님 이야기, 📔 일기) on the north wall: where you stand to browse each is free floor.
    const hall = await pg.evaluate(() => window.__WORLDS_TEST__.library());
    const fronts = Object.values(hall.fronts).filter(Boolean);
    const frontFree = await pg.evaluate((list) => list.map((s) => window.__WORLDS_TEST__.libraryFree(s.x, s.z)), fronts);
    check('walk: exactly two bookcases, both browsable from free floor', JSON.stringify(Object.keys(hall.fronts).sort()) === '["diary","testimony"]' && fronts.length === 2 && frontFree.every(Boolean), JSON.stringify(hall.fronts));
    // A stale world-coordinate correction inside the hall is ignored; a bad teleport lands on free floor.
    const pos = await pg.evaluate(() => {
      window.__WORLDS_TEST__.teleport(-8.9, 6.9);
      return window.__WORLDS_TEST__.playerPos();
    });
    check('teleport into a corner/out of the hall lands on free floor', await pg.evaluate(({ x, z }) => window.__WORLDS_TEST__.libraryFree(x, z), pos), JSON.stringify(pos));
    // Escape from anywhere: the ↩ 문으로 나가기 link in the place card.
    await pg.evaluate(() => window.__WORLDS_TEST__.teleport(-7.5, -5));
    await sleep(400);
    check('↩ 문으로 나가기 is visible inside the library', await pg.isVisible('#library-exit'));
    await pg.screenshot({ path: shotPath('b4-library-exit-phone') });
    await pg.tap('#library-exit');
    await until(pg, () => window.__WORLDS_DEBUG__.la.inLibrary === false, null, 10000);
    check('…and takes you out of the door from the far corner', !(await pg.isVisible('#library-exit')));
    await ctx.close();
  }

  // ---------------------------------------------------------------- B5: photos on the production-mode server
  let phDiary = null;
  if (run('photo') || run('ui')) {
    step('B5: diary photos (production-mode server: CSP + service worker)');
    const ctx = await contextFor(browser, PH2, phone(412, 915));
    const pg = await ctx.newPage();
    const csp = [];
    pg.on('console', (m) => {
      if (/Content Security Policy|Refused to/.test(m.text())) csp.push(m.text());
    });
    await enterWorld(pg, Q('15:00'));
    // Let the service worker take control (second load), like a returning phone.
    await enterWorld(pg, Q('15:00'));
    const controlled = await pg.evaluate(() => !!navigator.serviceWorker?.controller);
    const shot = await pg.evaluate(() => window.__WORLDS_TEST__.capture());
    check('photo taken and uploaded', shot?.uploaded === true, JSON.stringify(shot));
    await pg.evaluate(() => window.__WORLDS_TEST__.libraryOpen('diary'));
    await until(pg, () => window.__WORLDS_DEBUG__.la.view.page === 'diary' && document.getElementById('lib-diary-lines'), null, 15000);
    const v = await view(pg);
    check('B5: today\'s photo is preselected in the draft (checked, aria-pressed)', v.diaryPhotos.includes(shot.id) && (await pg.getAttribute(`#lib-pick-${shot.id}`, 'aria-pressed')) === 'true', JSON.stringify(v.diaryPhotos));
    check('…and the photo line matches what is picked', v.diaryLines.some((l) => /사진 \d+장에 담았어요/.test(l)));
    await pg.evaluate(() => document.getElementById('lib-pick-label')?.scrollIntoView({ block: 'center' }));
    await sleep(500);
    await pg.screenshot({ path: shotPath('b5-diary-draft-phone') });
    // Unpick → the line goes; pick again → it comes back.
    await pg.tap(`#lib-pick-${shot.id}`);
    await until(pg, (id) => !window.__WORLDS_DEBUG__.la.view.diaryPhotos.includes(id), shot.id, 5000).catch(() => undefined);
    const off = await view(pg);
    await pg.tap(`#lib-pick-${shot.id}`);
    await until(pg, (id) => window.__WORLDS_DEBUG__.la.view.diaryPhotos.includes(id), shot.id, 5000).catch(() => undefined);
    const on = await view(pg);
    check('unpicking removes the "사진 N장" line, picking adds it back', !off.diaryLines.some((l) => /사진 \d+장/.test(l)) && on.diaryLines.some((l) => /사진 1장/.test(l)) && on.diaryPhotos.length >= 1, JSON.stringify({ off: [off.diaryPhotos, off.diaryLines.filter((l) => /사진/.test(l))], on: [on.diaryPhotos, on.diaryLines.filter((l) => /사진/.test(l))] }));
    await pg.fill('#lib-diary-note', '오늘은 들판 바람이 참 좋았어요.');
    await pg.click('#lib-vis-public');
    await pg.tap('#lib-diary-publish');
    await until(pg, () => window.__WORLDS_DEBUG__.la.view.page === 'story' && document.querySelector('.lib-photo'), null, 15000);
    phDiary = (await view(pg)).lastPublished;
    await pg.waitForFunction(() => [...document.querySelectorAll('.lib-photo')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 }).catch(() => undefined);
    const own = await pg.evaluate(() => [...document.querySelectorAll('.lib-photo')].map((i) => i.naturalWidth));
    check('B5: published diary shows the photo to its owner (diary_photos row, image decoded)', own.length >= 1 && own.every((n) => n > 0) && count('SELECT COUNT(*) n FROM diary_photos WHERE story_id = ?', phDiary) >= 1, JSON.stringify(own));
    await pg.keyboard.press('Escape');
    await modalIs(pg, null);
    await pg.evaluate(() => window.__WORLDS_TEST__.libraryOpen('mine', 'album'));
    await until(pg, () => document.querySelector('#lib-album img'), null, 15000);
    await pg.waitForFunction(() => [...document.querySelectorAll('#lib-album img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 }).catch(() => undefined);
    const album = await pg.evaluate(() => [...document.querySelectorAll('#lib-album img')].map((i) => i.naturalWidth));
    check('B5: 오늘 앨범 shows it (served through the service worker scope, private cache)', album.length >= 1 && album.every((n) => n > 0), JSON.stringify(album));
    check('B5: no CSP violations; the page is service-worker controlled', csp.length === 0 && controlled, `${csp.join(' | ')} controlled=${controlled}`);
    await pg.keyboard.press('Escape');
    // "일기 고치기" can add photos later: a diary without photos opens with today's picked.
    await PH2.json('POST', '/api/diary', { lines: ['사진 없이 꽂은 일기'], photoIds: [], visibility: 'public' });
    await pg.evaluate(() => window.__WORLDS_TEST__.libraryOpen('diary'));
    await until(pg, () => window.__WORLDS_DEBUG__.la.view.page === 'diary' && document.getElementById('lib-diary-lines'), null, 15000);
    check('일기 고치기 on a photo-less diary offers today\'s photos picked', (await view(pg)).diaryPhotos.includes(shot.id));
    await pg.tap('#lib-diary-publish');
    await until(pg, () => window.__WORLDS_DEBUG__.la.view.page === 'story' && document.querySelector('.lib-photo'), null, 15000);
    await pg.keyboard.press('Escape');
    await modalIs(pg, null);
    await sleep(1100);
    const shot2 = await pg.evaluate(() => window.__WORLDS_TEST__.capture());
    await pg.evaluate(() => window.__WORLDS_TEST__.libraryOpen('diary'));
    await until(pg, () => window.__WORLDS_DEBUG__.la.view.page === 'diary' && document.getElementById('lib-diary-lines'), null, 15000);
    const vv = (await view(pg)).diaryPhotos;
    check('일기 고치기 keeps my picks and adds a photo taken after publishing', vv.includes(shot.id) && vv.includes(shot2.id), JSON.stringify(vv));
    await pg.keyboard.press('Escape');
    await ctx.close();
    const other = await C.raw('GET', `/api/shots/${shot.id}`);
    check('B5: another user can fetch the public diary photo (200), a guest too', other.status === 200 && (await guest.raw('GET', `/api/shots/${shot.id}`)).status === 200);
  }

  // ---------------------------------------------------------------- UI: reader, letters, inbox, notify, admin
  if (run('ui')) {
    step('B6 reader screenshots');
    const ctxR = await contextFor(browser, C, phone(390, 844));
    const pr = await ctxR.newPage();
    await enterWorld(pr, Q('15:00'));
    const shots = async (name, id, widths) => {
      for (const [w, h, label] of widths) {
        await pr.setViewportSize({ width: w, height: h });
        await pr.evaluate((sid) => window.__WORLDS_TEST__.libraryOpen('story', sid), id);
        await until(pr, (sid) => window.__WORLDS_DEBUG__.la.view.page === 'story' && window.__WORLDS_DEBUG__.la.view.story?.id === sid && document.getElementById('lib-letters-title'), id, 15000);
        await pr.waitForFunction(() => [...document.querySelectorAll('.lib-photo')].every((i) => i.complete), null, { timeout: 8000 }).catch(() => undefined);
        await sleep(500);
        const r = await pr.evaluate(() => {
          const s = document.querySelector('.overlay .sheet').getBoundingClientRect();
          const scrollW = document.querySelector('.overlay .sheet').scrollWidth;
          const cw = document.querySelector('.overlay .sheet').clientWidth;
          return { top: s.top, h: s.height, vh: innerHeight, vw: innerWidth, overflowX: scrollW - cw };
        });
        check(`reader ${label} ${w}px: ${w < 600 ? 'full height' : 'fits'}, no horizontal overflow`, r.overflowX <= 1 && (w >= 600 || r.h >= r.vh - 300), JSON.stringify(r));
        await pr.screenshot({ path: shotPath(`reader-after-${name}-${label}`) });
      }
    };
    if (phDiary) await shots('diary', phDiary, [[360, 780, 'phone360'], [390, 844, 'phone390'], [412, 915, 'phone412'], [820, 1180, 'tablet'], [1280, 800, 'desktop']]);
    await shots('testimony', T.pub, [[390, 844, 'phone390']]);
    // Author actions moved into ⋯ (for others: 신고 only).
    await pr.setViewportSize({ width: 390, height: 844 });
    await pr.tap('#lib-more-menu');
    check('⋯ menu: others see only 🚩 신고 (no 고치기/빼기)', (await pr.isVisible('#lib-report')) && !(await pr.isVisible('#lib-delete')));
    await pr.tap('#lib-more-menu');
    // Letter thread under the testimony, phone; compose stays above the keyboard.
    await pr.evaluate(() => document.getElementById('lib-letters')?.scrollIntoView({ block: 'start' }));
    await sleep(400);
    await pr.screenshot({ path: shotPath('letter-thread-phone') });
    await pr.focus('#lib-letter-text');
    await pr.evaluate(() => {
      // Simulate the keyboard: the visual viewport shrinks by ~45%.
      document.documentElement.style.setProperty('--vvh', `${Math.round(innerHeight * 0.55)}px`);
      document.documentElement.style.setProperty('--kb', `${Math.round(innerHeight * 0.45)}px`);
      document.getElementById('lib-letter-text').scrollIntoView({ block: 'center' });
    });
    await sleep(600);
    const kb = await pr.evaluate(() => {
      const t = document.getElementById('lib-letter-text').getBoundingClientRect();
      return { bottom: t.bottom, visible: innerHeight * 0.55 };
    });
    check('compose box sits above the (simulated) keyboard', kb.bottom <= kb.visible + 2, JSON.stringify(kb));
    await pr.type('#lib-letter-text', '저도 광야 같은 시간을 지나고 있어요. 이 이야기가 힘이 됐어요.');
    await pr.screenshot({ path: shotPath('letter-compose-keyboard-phone') });
    await pr.evaluate(() => {
      document.documentElement.style.removeProperty('--kb');
      window.dispatchEvent(new Event('resize'));
    });
    await pr.tap('#lib-letter-send');
    await until(pr, () => window.__WORLDS_DEBUG__.la.view.letters?.threads.some((t) => t.text.startsWith('저도 광야')), null, 10000);
    check('C sends a letter from the phone UI', true);
    await pr.keyboard.press('Escape');
    await ctxR.close();

    step('받은 편지: badge and two-device sync');
    const ctx1 = await contextFor(browser, A, phone(390, 844));
    await ctx1.addInitScript(PUSH_STUB);
    const p1 = await ctx1.newPage();
    const ctx2 = await contextFor(browser, A, { viewport: { width: 1280, height: 800 } });
    const p2 = await ctx2.newPage();
    await enterWorld(p1, Q('15:00'));
    await enterWorld(p2, Q('15:00'));
    const badge = (p) => p.evaluate(() => Number(document.getElementById('word-letters-badge')?.textContent ?? 0));
    await until(p1, () => Number(document.getElementById('word-letters-badge')?.textContent ?? 0) > 0, null, 10000).catch(() => undefined);
    const b1 = await badge(p1);
    const b2 = await badge(p2);
    check('unread badge on 말씀 in both contexts of A (same count)', b1 > 0 && b1 === b2, `${b1} ${b2}`);
    await p1.screenshot({ path: shotPath('inbox-badge-phone') });
    // A new letter arrives live: toast + badge +1 on both.
    await write(D, T.pub, { text: '실시간으로 도착하는 편지' });
    await until(p2, (n) => Number(document.getElementById('word-letters-badge')?.textContent ?? 0) === n + 1, b2, 10000).catch(() => undefined);
    check('a new letter arrives live on both devices (WS badge)', (await badge(p1)) === b1 + 1 && (await badge(p2)) === b2 + 1, `${await badge(p1)} ${await badge(p2)}`);
    await p1.tap('#btn-word');
    await p1.waitForSelector('#today-inbox');
    check('말씀 책 → 오늘 has 📬 받은 편지 with the count', /📬 받은 편지 \d+/.test(await p1.textContent('#today-inbox')));
    await p1.tap('#today-inbox');
    await until(p1, () => window.__WORLDS_DEBUG__.la.view.page === 'mine' && document.querySelector('#lib-inbox .lib-inbox-item'), null, 15000);
    await sleep(400);
    await p1.screenshot({ path: shotPath('inbox-phone') });
    const first = (await view(p1)).inbox.find((i) => i.unread > 0);
    await p1.tap(`#lib-inbox [data-letter="${first.letterId}"]`);
    await until(p1, (lid) => window.__WORLDS_DEBUG__.la.view.page === 'story' && document.getElementById(`letter-${lid}`), first.letterId, 15000);
    await until(p2, (n) => Number(document.getElementById('word-letters-badge')?.textContent ?? 0) === n, (await badge(p1)), 10000).catch(() => undefined);
    check('opening a thread on the phone lowers the badge on the desktop too', (await badge(p2)) === (await badge(p1)) && (await badge(p1)) < b1 + 1, `${await badge(p1)} ${await badge(p2)}`);
    await p1.keyboard.press('Escape');
    await modalIs(p1, null);
    await p1.evaluate(() => window.__WORLDS_TEST__.libraryOpen('mine', 'inbox'));
    await p1.waitForSelector('#lib-inbox');
    if (await p1.isVisible('#lib-inbox-read-all')) await p1.tap('#lib-inbox-read-all');
    await until(p2, () => !document.getElementById('word-letters-badge'), null, 10000).catch(() => undefined);
    check('모두 읽음 on the phone → no badge on the desktop', (await badge(p2)) === 0 && (await badge(p1)) === 0);
    await p1.keyboard.press('Escape');

    step('notification links');
    const lid = (await letters(A, T.pub)).data.letters[0].id;
    await p2.evaluate(({ sid, lid }) => window.dispatchEvent(new CustomEvent('worlds-notification-click', { detail: `/?book=${sid}&letter=${lid}` })), { sid: T.pub, lid });
    await until(p2, ({ sid, lid }) => window.__WORLDS_DEBUG__.la.view.story?.id === sid && document.getElementById(`letter-${lid}`), { sid: T.pub, lid }, 15000).catch(() => undefined);
    check('a notification click (?book=…&letter=…) opens that book at the letter', (await view(p2)).story?.id === T.pub && !!(await p2.$(`#letter-${lid}`)));
    await p2.keyboard.press('Escape');
    await p2.evaluate(() => window.dispatchEvent(new CustomEvent('worlds-notification-click', { detail: '/?diary=1' })));
    await until(p2, () => window.__WORLDS_DEBUG__.la.view.page === 'diary', null, 15000).catch(() => undefined);
    check('…?diary=1 opens today\'s diary draft', (await view(p2)).page === 'diary');
    await p2.keyboard.press('Escape');
    await p2.goto(`${BASE}${Q('15:00')}&book=${T.anon}`);
    await p2.waitForSelector('#entry-continue:not([hidden])');
    await p2.click('#entry-continue');
    await until(p2, (sid) => window.__WORLDS_DEBUG__?.la?.view?.story?.id === sid, T.anon, Number(process.env.TEST_ONLINE_MS ?? 180000)).catch(() => undefined);
    check('opening the app with /?book=<id> (a tap that launched it) shows that book, and the URL is tidied', (await view(p2)).story?.id === T.anon && !(await p2.evaluate(() => location.search.includes('book='))));
    await ctx2.close();

    step('⚙ → 🔔 알림 with the new toggles');
    await p1.click('#btn-settings');
    await p1.waitForSelector('.settings-menu');
    await p1.click('#settings-nav-notify');
    await p1.waitForSelector('#notify-enable, #notify-daily', { timeout: 15000 });
    if (await p1.isVisible('#notify-enable')) {
      await p1.click('#notify-enable');
      await p1.click('#notify-allow');
    }
    await p1.waitForSelector('#notify-diary', { timeout: 15000 });
    check('toggles: 내 이야기 소식, 편지, 답장 on; 밤 일기 off with its time picker disabled at 21:00', (await p1.isChecked('#notify-library')) && (await p1.isChecked('#notify-letters')) && (await p1.isChecked('#notify-replies')) && (await p1.inputValue('#notify-diary-time')) === '21:00');
    if (!(await p1.isChecked('#notify-diary'))) await p1.check('#notify-diary');
    await p1.selectOption('#notify-diary-time', '21:30');
    await until(p1, () => document.querySelector('#notify-settings .groups-status')?.textContent === '저장했어요.');
    check('turning 밤 일기 on and choosing 21:30 is saved', (await A.json('GET', '/api/push/prefs')).data.diary === true && (await A.json('GET', '/api/push/prefs')).data.diaryTime === '21:30');
    await p1.evaluate(() => document.getElementById('notify-library')?.scrollIntoView({ block: 'start' }));
    await sleep(400);
    await p1.screenshot({ path: shotPath('settings-notify-phone') });
    await ctx1.close();

    step('admin: reported letters');
    const bad = (await write(X, T.pub, { text: '신고될 편지예요 (관리 화면 확인용)' })).data.thread.id;
    for (const r of R) await r.json('POST', `/api/library/letters/${bad}/report`, { reason: 'inappropriate' });
    const ctxA = await contextFor(browser, ADM, { viewport: { width: 1280, height: 800 } });
    const pa = await ctxA.newPage();
    await enterWorld(pa, Q('15:00'));
    await pa.click('#btn-settings');
    await pa.waitForSelector('.settings-menu');
    await pa.click('#settings-nav-admin');
    await pa.click('#settings-admin-library');
    await pa.waitForSelector('#admin-letters-list .admin-letter', { timeout: 15000 });
    await pa.evaluate(() => document.getElementById('admin-letters-list')?.scrollIntoView({ block: 'start' }));
    await sleep(400);
    await pa.screenshot({ path: shotPath('admin-letters') });
    await pa.click(`#admin-letters-list .admin-letter[data-id="${bad}"] .admin-restore`);
    await until(pa, () => /복구했어요/.test(document.querySelector('.admin-library .groups-status')?.textContent ?? ''), null, 10000).catch(() => undefined);
    check('admin UI: restore a reported letter', (await letters(guest, T.pub)).data.letters.some((t) => t.id === bad));
    await ctxA.close();
  }

  // ================================================================ export and deletion
  if (run('account')) {
    step('export and deletion');
    const ex = await C.json('GET', '/api/me/export');
    const lw = ex.data?.library?.lettersWritten ?? [];
    check('export: my letters and replies (my words), my letter reports', lw.length >= 3 && lw.some((l) => l.text.startsWith('이야기 읽고')) && Array.isArray(ex.data.library.letterReportsMade));
    check('export: no other person\'s letter text', !ex.text.includes('읽어 주셔서 고마워요'));
    const rex = await R[0].json('GET', '/api/me/export');
    check('export: letter reports made', rex.data.library.letterReportsMade.length >= 1);
    // C deletes the account: C's letters go with their whole threads (A's replies too).
    const cLetters = count('SELECT COUNT(*) n FROM story_letters WHERE user_id = ? AND parent_id IS NULL', C.id);
    const aRepliesUnderC = count('SELECT COUNT(*) n FROM story_letters r JOIN story_letters l ON l.id = r.parent_id WHERE l.user_id = ? AND r.user_id = ?', C.id, A.id);
    const del = await C.json('POST', '/api/me/delete', { nickname: NICK.c });
    check('C deletes the account', del.status === 200 && cLetters > 0 && aRepliesUnderC > 0);
    check('…every row C wrote is gone, and the threads under C\'s letters (A\'s replies too)', count('SELECT COUNT(*) n FROM story_letters WHERE user_id = ?', C.id) === 0 && count('SELECT COUNT(*) n FROM story_letters r WHERE r.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM story_letters l WHERE l.id = r.parent_id)') === 0 && count('SELECT COUNT(*) n FROM letter_reads WHERE user_id = ?', C.id) === 0);
    check('…and C\'s words appear nowhere for others', !(await letters(guest, T.pub)).text.includes('이야기 읽고'));
    // A deletes the account: A's books go with every letter thread on them.
    const onA = count('SELECT COUNT(*) n FROM story_letters l JOIN stories s ON s.id = l.story_id WHERE s.user_id = ?', A.id);
    await A.json('POST', '/api/me/delete', { nickname: NICK.a });
    check('A (book author) deletes the account: all letters on A\'s books are gone', onA > 0 && count('SELECT COUNT(*) n FROM story_letters WHERE story_id IN (?, ?, ?)', T.pub, T.grp, T.anon) === 0);
    check('…and D\'s inbox no longer lists them', (await inbox(D)).items.every((i) => ![T.pub, T.grp, T.anon].includes(i.storyId)));
    check(`GET /letters/unread always equals the inbox's unread (${unreadCompared} comparisons)`, unreadCompared > 5 && unreadMismatch.length === 0, unreadMismatch.join(' '));
  }
} catch (err) {
  console.error(err);
  check(`no unexpected error (${err.message?.slice(0, 160)})`, false);
} finally {
  await browser?.close().catch(() => undefined);
  await stopAll();
}
process.exit(summary());
