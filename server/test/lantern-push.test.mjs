// 🏮 내 등불 반응 notices: per-kind dedupe, self-exclusion, per-kind opt-outs,
// one combined notice per 15-minute window, anonymity, presence (toast vs push)
// and batching that survives a restart (state in the DB).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createECDH } from 'node:crypto';
import webpush from 'web-push';
import { openDb } from '../dist/server/src/db.js';
import { AMEN_TITLE, LANTERN_DEDUPE_MS, LANTERN_TITLE, LANTERN_WINDOW_MS, lanternNotice, PRAYER_TITLE, PushService, RECORD_TITLE } from '../dist/server/src/push.js';

const T0 = Date.UTC(2026, 10, 19, 3, 0, 0);
const MIN = 60_000;
const keys = webpush.generateVAPIDKeys();
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const p256dh = ecdh.getPublicKey().toString('base64url');
const auth = Buffer.alloc(16, 3).toString('base64url');

function setup(db = openDb(':memory:')) {
  const push = new PushService(db, null, { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:test@example.test', mock: true, testMode: true });
  let now = T0;
  push.now = () => now;
  const toasts = [];
  const presence = new Map();
  push.presence = (id) => presence.get(id) ?? { online: false, visible: false };
  push.inApp = (id, text) => toasts.push({ id, text });
  const user = (name) => db.prepare('INSERT INTO users (google_sub, nickname, created_at) VALUES (?, ?, ?)').run(`sub-${name}`, name, T0).lastInsertRowid;
  const lantern = (owner, text, anonymous = 0) =>
    db
      .prepare(
        `INSERT INTO lanterns (user_id, slot, date, ref, verse, translation, meditation, feeling, application, created_at, anonymous)
         VALUES (?, 0, '2026-11-19', '시편 23:1', '여호와는 나의 목자시니', 'KRV', ?, '', '', ?, ?)`,
      )
      .run(owner, text, T0, anonymous).lastInsertRowid;
  const subscribe = (id) => push.subscribe(id, { endpoint: `https://push.test/${id}-${Math.random()}`, keys: { p256dh, auth } }, 'test');
  return {
    db,
    push,
    toasts,
    presence,
    user,
    lantern,
    subscribe,
    at: (ms) => (now = T0 + ms),
    sent: () => push.deliveries.map((d) => d.payload),
  };
}

test('lanternNotice: one kind uses its own text, several kinds merge into one', () => {
  assert.equal(lanternNotice({ pray: 0, amen: 0, record: 0 }), null);
  assert.equal(lanternNotice({ pray: 1, amen: 0, record: 0 }).payload.title, PRAYER_TITLE);
  assert.match(lanternNotice({ pray: 3, amen: 0, record: 0 }).payload.body, /3번의 기도/);
  assert.equal(lanternNotice({ pray: 0, amen: 1, record: 0 }).payload.title, AMEN_TITLE);
  assert.equal(lanternNotice({ pray: 0, amen: 4, record: 0 }).payload.title, '🙏 4명이 당신의 묵상에 아멘했어요');
  assert.equal(lanternNotice({ pray: 0, amen: 0, record: 1 }).payload.title, RECORD_TITLE);
  assert.equal(lanternNotice({ pray: 0, amen: 0, record: 2 }).toast, '📌 2명이 당신의 묵상을 마음에 담아 두었어요');
  const m = lanternNotice({ pray: 2, amen: 3, record: 1 });
  assert.equal(m.payload.kind, 'lantern');
  assert.equal(m.payload.title, LANTERN_TITLE);
  assert.equal(m.toast, '🤲 기도 2 · 🙏 아멘 3 · 📌 기록 1 — 당신의 묵상이 누군가에게 닿았어요');
  assert.equal(lanternNotice({ pray: 0, amen: 1, record: 1 }).payload.body, '🙏 아멘 1 · 📌 기록 1');
  assert.deepEqual(Object.keys(m.payload).sort(), ['body', 'kind', 'tag', 'title', 'url']);
  assert.equal(m.payload.url, '/');
});

test('아멘 and 기록 each notify; never for your own lantern', async () => {
  const s = setup();
  const owner = s.user('주인');
  const a = s.user('아멘하는분');
  s.subscribe(owner);
  s.subscribe(a);
  const l = s.lantern(owner, '비밀 묵상');
  assert.equal(await s.push.lanternReacted(l, owner, 'amen'), false);
  assert.equal(s.sent().length, 0);
  assert.equal(await s.push.lanternReacted(l, a, 'amen'), true);
  assert.equal(s.sent().length, 1);
  assert.equal(s.sent()[0].title, AMEN_TITLE);
  s.at(16 * MIN);
  assert.equal(await s.push.lanternReacted(l, a, 'record'), true);
  assert.equal(s.sent()[1].title, RECORD_TITLE);
  assert.ok(s.push.deliveries.every((d) => d.userId === Number(owner)));
});

test('a mixed burst gives one push, the rest wait for the window and merge', async () => {
  const s = setup();
  const owner = s.user('주인');
  const [a, b, c] = [s.user('가'), s.user('나'), s.user('다')];
  s.subscribe(owner);
  const l1 = s.lantern(owner, '첫 묵상');
  const l2 = s.lantern(owner, '둘째 묵상', 1);
  await s.push.lanternReacted(l1, a, 'pray'); // sent at once
  await s.push.lanternReacted(l1, b, 'amen');
  await s.push.lanternReacted(l2, c, 'amen');
  await s.push.lanternReacted(l1, c, 'record');
  await s.push.lanternReacted(l2, a, 'pray');
  assert.equal(s.sent().length, 1);
  s.at(10 * MIN);
  await s.push.tick();
  assert.equal(s.sent().length, 1, 'held inside the window');
  s.at(15 * MIN);
  const r = await s.push.tick();
  assert.equal(r.prayer, 1);
  assert.equal(s.sent().length, 2);
  assert.equal(s.sent()[1].kind, 'lantern');
  assert.equal(s.sent()[1].body, '🤲 기도 1 · 🙏 아멘 2 · 📌 기록 1');
  // Nothing pending: later ticks send nothing.
  s.at(40 * MIN);
  await s.push.tick();
  assert.equal(s.sent().length, 2);
});

test('dedupe is per person, lantern and kind for 6 h (toggling never spams)', async () => {
  const s = setup();
  const owner = s.user('주인');
  const a = s.user('가');
  s.subscribe(owner);
  const l = s.lantern(owner, '묵상');
  await s.push.lanternReacted(l, a, 'amen');
  s.at(20 * MIN);
  assert.equal(await s.push.lanternReacted(l, a, 'amen'), false, 'same kind again: not counted');
  assert.equal(await s.push.lanternReacted(l, a, 'pray'), true, 'another kind counts');
  s.at(40 * MIN);
  await s.push.tick();
  assert.equal(s.sent().length, 2);
  s.at(LANTERN_DEDUPE_MS + 1);
  await s.push.tick(); // sweeps old dedupe rows
  assert.equal(await s.push.lanternReacted(l, a, 'amen'), true, 'after 6 h it counts again');
});

test('per-kind opt-outs, including kinds switched off while pending', async () => {
  const s = setup();
  const owner = s.user('주인');
  const [a, b] = [s.user('가'), s.user('나')];
  s.subscribe(owner);
  const l = s.lantern(owner, '묵상');
  s.push.setPrefs(owner, { amen: false });
  assert.deepEqual([s.push.prefs(owner).prayer, s.push.prefs(owner).amen, s.push.prefs(owner).record], [true, false, true]);
  assert.equal(await s.push.lanternReacted(l, a, 'amen'), false);
  assert.equal(s.sent().length, 0);
  await s.push.lanternReacted(l, a, 'record'); // sent
  await s.push.lanternReacted(l, b, 'record'); // pending
  await s.push.lanternReacted(l, b, 'pray'); // pending
  s.push.setPrefs(owner, { record: false });
  s.at(LANTERN_WINDOW_MS);
  await s.push.tick();
  assert.equal(s.sent().length, 2);
  assert.equal(s.sent()[1].kind, 'prayer', 'only the kind still on is told');
  s.push.setPrefs(owner, { prayer: false, record: true });
  s.at(LANTERN_WINDOW_MS * 3);
  assert.equal(await s.push.lanternReacted(l, a, 'pray'), false);
});

test('payloads never carry names, ids or lantern text (anonymous lanterns too)', async () => {
  const s = setup();
  const owner = s.user('등불주인닉');
  const a = s.user('반응한사람닉');
  s.subscribe(owner);
  const l = s.lantern(owner, '아주비밀스러운문장', 1);
  await s.push.lanternReacted(l, a, 'record');
  s.at(LANTERN_WINDOW_MS);
  const b = s.user('또다른사람닉');
  await s.push.lanternReacted(l, b, 'amen');
  await s.push.lanternReacted(l, b, 'pray');
  s.at(2 * LANTERN_WINDOW_MS);
  await s.push.tick();
  const text = JSON.stringify(s.push.deliveries.map((d) => d.payload));
  assert.equal(s.push.deliveries.length, 3);
  for (const bad of ['등불주인닉', '반응한사람닉', '또다른사람닉', '아주비밀스러운문장', '시편', '여호와', `"${l}"`, `/${l}`]) assert.ok(!text.includes(bad), bad);
  for (const d of s.push.deliveries) assert.deepEqual(Object.keys(d.payload).sort(), ['body', 'kind', 'tag', 'title', 'url']);
});

test('online: a toast always; the push only when no page is visible', async () => {
  const s = setup();
  const owner = s.user('주인');
  const [a, b] = [s.user('가'), s.user('나')];
  s.subscribe(owner);
  const l = s.lantern(owner, '묵상');
  s.presence.set(owner, { online: true, visible: true });
  await s.push.lanternReacted(l, a, 'amen');
  assert.deepEqual(s.toasts, [{ id: owner, text: AMEN_TITLE }]);
  assert.equal(s.sent().length, 0, 'visible page: toast only');
  await s.push.lanternReacted(l, b, 'amen');
  assert.equal(s.toasts.length, 1, 'toasts are batched too');
  s.presence.set(owner, { online: true, visible: false });
  s.at(LANTERN_WINDOW_MS);
  await s.push.tick();
  assert.equal(s.toasts.length, 2);
  assert.equal(s.toasts[1].text, AMEN_TITLE);
  assert.equal(s.sent().length, 1, 'hidden page: toast and push');
});

test('online without push devices still gets toasts; offline without devices keeps nothing', async () => {
  const s = setup();
  const owner = s.user('주인');
  const a = s.user('가');
  const l = s.lantern(owner, '묵상');
  assert.equal(await s.push.lanternReacted(l, a, 'pray'), false);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM lantern_push').get().n, 0);
  s.presence.set(owner, { online: true, visible: true });
  s.at(MIN);
  assert.equal(await s.push.lanternReacted(l, a, 'amen'), true);
  assert.equal(s.toasts.length, 1);
});

test('batching and dedupe survive a restart (state is in the DB)', async () => {
  const db = openDb(':memory:');
  const s1 = setup(db);
  const owner = s1.user('주인');
  const [a, b] = [s1.user('가'), s1.user('나')];
  s1.subscribe(owner);
  const l = s1.lantern(owner, '묵상');
  await s1.push.lanternReacted(l, a, 'amen'); // sent
  await s1.push.lanternReacted(l, b, 'amen'); // pending
  const s2 = setup(db); // "restart": a new PushService on the same DB
  s2.at(MIN);
  assert.equal(await s2.push.lanternReacted(l, a, 'amen'), false, 'dedupe remembered');
  await s2.push.tick();
  assert.equal(s2.sent().length, 0, 'window remembered');
  s2.at(LANTERN_WINDOW_MS);
  await s2.push.tick();
  assert.equal(s2.sent().length, 1);
  assert.equal(s2.sent()[0].title, AMEN_TITLE, 'the pending count was kept');
});

test('account deletion cascades the batch and dedupe rows', async () => {
  const s = setup();
  const owner = s.user('주인');
  const a = s.user('가');
  s.subscribe(owner);
  const l = s.lantern(owner, '묵상');
  await s.push.lanternReacted(l, a, 'amen');
  s.db.prepare('DELETE FROM users WHERE id = ?').run(a);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM lantern_push_seen').get().n, 0);
  s.db.prepare('DELETE FROM users WHERE id = ?').run(owner);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM lantern_push').get().n, 0);
});
