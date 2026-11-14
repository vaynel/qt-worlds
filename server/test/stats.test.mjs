// 운영자 통계: retention / cohort / funnel maths and the idempotent active-day insert.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../dist/server/src/db.js';
import { addDays, dateRange, deviceClass, firstDayFunnel, mondayOf, retentionCell, rollingActive, StatsService, weeklyCohorts } from '../dist/server/src/stats.js';

const DAY = 86_400_000;

test('date helpers', () => {
  assert.equal(addDays('2026-11-14', 1), '2026-11-15');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(mondayOf('2026-11-14'), '2026-11-09'); // Saturday → Monday
  assert.equal(mondayOf('2026-11-09'), '2026-11-09');
  assert.equal(mondayOf('2026-11-15'), '2026-11-09'); // Sunday belongs to the week before
});

test('rollingActive: DAU, WAU and MAU count distinct accounts in their windows', () => {
  const rows = [
    { user_id: 1, kst_date: '2026-11-01' },
    { user_id: 1, kst_date: '2026-11-02' },
    { user_id: 2, kst_date: '2026-11-02' },
    { user_id: 3, kst_date: '2026-10-10' }, // only inside the 30-day window of 11-08
    { user_id: 2, kst_date: '2026-11-08' },
  ];
  const days = dateRange('2026-11-09', 9); // 11-01 .. 11-09 (consecutive, as the dashboard asks)
  const r = rollingActive(rows, days);
  const at = (a, d) => a[days.indexOf(d)];
  assert.deepEqual([at(r.dau, '2026-11-01'), at(r.dau, '2026-11-02'), at(r.dau, '2026-11-08'), at(r.dau, '2026-11-09')], [1, 2, 1, 0]);
  // 11-08: users 1 (11-02) and 2; 11-09: window 11-03..11-09 → only user 2.
  assert.deepEqual([at(r.wau, '2026-11-01'), at(r.wau, '2026-11-02'), at(r.wau, '2026-11-08'), at(r.wau, '2026-11-09')], [1, 2, 2, 1]);
  // User 3 (10-10) is inside the 30-day window through 11-08 and drops out on 11-09.
  assert.deepEqual([at(r.mau, '2026-11-01'), at(r.mau, '2026-11-02'), at(r.mau, '2026-11-08'), at(r.mau, '2026-11-09')], [2, 3, 3, 2]);
});

test('retentionCell: exact day N, only members whose day N is over', () => {
  const m = (signup, ...active) => ({ signup, active: new Set(active) });
  const members = [m('2026-11-01', '2026-11-02', '2026-11-08'), m('2026-11-01'), m('2026-11-10', '2026-11-11'), m('2026-11-13', '2026-11-14')];
  // Last complete day 11-13: day 1 of the 11-13 sign-up (11-14) isn't over yet.
  const d1 = retentionCell(members, 1, '2026-11-13', '2026-11-12');
  assert.deepEqual(d1, { eligible: 3, active: 2, partial: true, estimated: true });
  const d7 = retentionCell(members, 7, '2026-11-13', '2026-11-01');
  assert.deepEqual(d7, { eligible: 2, active: 1, partial: true, estimated: false });
  const d30 = retentionCell(members, 30, '2026-11-13', '2026-11-01');
  assert.equal(d30.eligible, 0); // 데이터 수집 중
  assert.equal(d30.partial, false);
});

test('weeklyCohorts groups by Monday week, newest first', () => {
  const m = (signup, ...active) => ({ signup, active: new Set(active) });
  const members = [m('2026-11-09', '2026-11-10'), m('2026-11-11'), m('2026-11-03', '2026-11-04', '2026-11-10')];
  const rows = weeklyCohorts(members, '2026-11-14', '2026-10-01', 3);
  assert.deepEqual(rows.map((r) => [r.week, r.size]), [
    ['2026-11-09', 2],
    ['2026-11-02', 1],
    ['2026-10-26', 0],
  ]);
  assert.deepEqual([rows[0].d1.eligible, rows[0].d1.active], [2, 1]);
  assert.deepEqual([rows[1].d1.active, rows[1].d7.active, rows[1].d7.eligible], [1, 1, 1]);
  assert.equal(rows[1].d30.eligible, 0);
});

test('firstDayFunnel: sequential within 24 h, recent sign-ups pending', () => {
  const now = Date.UTC(2026, 10, 14, 12);
  const t0 = now - 3 * DAY;
  const acc = (created, entry, letter, med, lantern) => ({ created_at: created, first_entry_at: entry, first_letter_at: letter, first_meditation_at: med, first_lantern_at: lantern });
  const h = 3600_000;
  const out = firstDayFunnel(
    [
      acc(t0, t0 + h, t0 + 2 * h, t0 + 3 * h, t0 + 4 * h), // all steps
      acc(t0, t0 + h, t0 + 2 * h, t0 + 30 * h, null), // meditation after 24 h: stops at letter
      acc(t0, t0 + h, null, t0 + 2 * h, t0 + 3 * h), // skipped the letter: stops at entry
      acc(t0, null, null, null, null), // signed up only
      acc(now - h, now, null, null, null), // < 24 h ago: pending
      acc(now - 40 * DAY, t0, t0, t0, t0), // outside the window
    ],
    now,
    30,
  );
  assert.deepEqual(out.steps.map((s) => s.n), [4, 3, 2, 1, 1]);
  assert.equal(out.pending, 1);
});

test('deviceClass accepts only the three coarse classes', () => {
  assert.equal(deviceClass('phone'), 'phone');
  assert.equal(deviceClass('Mozilla/5.0 (iPhone)'), null);
  assert.equal(deviceClass(3), null);
});

test('active_days insert is idempotent, counters add up, sweep keeps 13 months', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (id, google_sub, email, nickname, nickname_key, created_at) VALUES (1, 's1', 'a@x.test', '하늘', '하늘', ?)").run(Date.now());
  const stats = new StatsService(db);
  const at = Date.UTC(2026, 10, 14, 3);
  assert.equal(stats.markActive(1, at), true);
  assert.equal(stats.markActive(1, at + 1000), false); // in-memory short cut
  const fresh = new StatsService(db); // a restarted server: the row is already there
  assert.equal(fresh.markActive(1, at + 2000), false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM active_days').get().n, 1);
  assert.equal(fresh.markActive(1, at + DAY), true);
  assert.deepEqual(stats.export(1).activeDays, ['2026-11-14', '2026-11-15']);

  stats.bump('meditation', 1, at);
  stats.bump('meditation', 2, at);
  stats.session({ guest: true, device: 'phone', standalone: false }, at);
  const counts = Object.fromEntries(db.prepare('SELECT key, n FROM daily_counts WHERE kst_date = ?').all('2026-11-14').map((r) => [r.key, r.n]));
  assert.equal(counts.meditation, 3);
  assert.equal(counts.session_guest, 1);
  assert.equal(counts.device_phone, 1);
  assert.equal(counts.pwa_browser, 1);

  stats.milestone(1, 'first_meditation_at', at);
  stats.milestone(1, 'first_meditation_at', at + 5000);
  assert.equal(db.prepare('SELECT first_meditation_at t FROM users WHERE id = 1').get().t, at);

  stats.sample(3, 5, at);
  stats.sample(1, 1, at + 60_000);
  assert.deepEqual({ ...db.prepare('SELECT samples, total, peak FROM concurrency').get() }, { samples: 2, total: 4, peak: 5 });

  db.prepare("INSERT INTO active_days (user_id, kst_date) VALUES (1, '2025-01-01')").run();
  assert.ok(stats.sweep(at) >= 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM active_days WHERE kst_date = '2025-01-01'").get().n, 0);

  // Deleting the account removes its active days (FK cascade).
  db.prepare('DELETE FROM users WHERE id = 1').run();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM active_days').get().n, 0);
  db.close();
});

test('migration v14 backfills dates, counts and milestones from existing rows only', async () => {
  const { MIGRATIONS } = await import('../dist/server/src/db.js');
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const m of MIGRATIONS.slice(0, 13)) db.exec(m);
  const t = Date.UTC(2026, 10, 10, 1); // 2026-11-10 10:00 KST
  db.prepare("INSERT INTO users (id, google_sub, nickname, nickname_key, created_at, onboarded_at) VALUES (1, 's1', '하늘', '하늘', ?, ?)").run(t, t + 60_000);
  db.prepare("INSERT INTO users (id, google_sub, created_at) VALUES (2, 's2', ?)").run(t); // unfinished sign-up
  db.prepare("INSERT INTO meditations (user_id, date, place, meditation, created_at, updated_at) VALUES (1, '2026-11-11', '골방', '비밀 묵상', ?, ?)").run(t + DAY, t + DAY);
  db.prepare("INSERT INTO footprints (user_id, kst_date, type, at, key) VALUES (1, '2026-11-12', 'letter', ?, 'letter:2026-11-12')").run(t + 2 * DAY);
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('h', 1, ?, ?)").run(t + 3 * DAY, t + 30 * DAY);
  db.exec(MIGRATIONS[13]);
  const days = db.prepare('SELECT kst_date FROM active_days WHERE user_id = 1 ORDER BY kst_date').all().map((r) => r.kst_date);
  assert.deepEqual(days, ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM active_days WHERE user_id = 2').get().n, 0);
  const u = db.prepare('SELECT first_entry_at e, first_letter_at l, first_meditation_at m, first_lantern_at la FROM users WHERE id = 1').get();
  assert.deepEqual({ ...u }, { e: t + 60_000, l: t + 2 * DAY, m: t + DAY, la: null });
  assert.equal(db.prepare("SELECT n FROM daily_counts WHERE kst_date = '2026-11-11' AND key = 'meditation'").get().n, 1);
  assert.match(db.prepare("SELECT value FROM stats_meta WHERE key = 'collect_start'").get().value, /^\d{4}-\d\d-\d\d$/);
  db.close();
});
