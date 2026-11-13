// Day change at 00:00 KST: the cheap arithmetic must match the Intl (Asia/Seoul) answer exactly.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kstDateOf, kstDayNumber, seoulDate } from '../dist/shared/protocol.js';
import { Room } from '../dist/server/src/Room.js';

const DAY = 86_400_000;
const intl = (ms) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
};
/** 00:00 KST of the day after `ms`. */
const nextMidnight = (ms) => (kstDayNumber(ms) + 1) * DAY - 9 * 3600_000;

test('seoulDate / kstDayNumber match Intl around many midnights', () => {
  let ms = Date.UTC(2024, 0, 1);
  for (let i = 0; i < 1000; i++, ms += DAY + 3_600_000 * 7 + 13) {
    const m = nextMidnight(ms);
    for (const t of [m - 1, m, m + 1, m - 60_000, m + 12 * 3600_000]) {
      assert.equal(seoulDate(new Date(t)), intl(t), `at ${new Date(t).toISOString()}`);
      assert.equal(kstDateOf(t), intl(t));
    }
    assert.equal(kstDayNumber(m - 1) + 1, kstDayNumber(m));
  }
});

test('Room sends the new day exactly at 00:00 KST (fake clock)', () => {
  const logs = [];
  const room = new Room({ seed: 'kst', maxPlayers: 4, log: (m) => logs.push(m) });
  try {
    const m = nextMidnight(Date.now());
    room.checkDayChange(m - 1);
    assert.deepEqual(logs.filter((l) => l.startsWith('new day')), []);
    room.checkDayChange(m);
    assert.deepEqual(logs.filter((l) => l.startsWith('new day')), [`new day ${intl(m)}`]);
    room.checkDayChange(m + 1000);
    room.checkDayChange(m + DAY - 1);
    assert.equal(logs.filter((l) => l.startsWith('new day')).length, 1);
    room.checkDayChange(m + DAY);
    assert.deepEqual(logs.filter((l) => l.startsWith('new day')).at(-1), `new day ${intl(m + DAY)}`);
  } finally {
    room.close();
  }
});
