// Curated "오늘의 말씀" pool: every reference valid, deterministic, no repeats per cycle.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DailyWord } from '../dist/server/src/dailyWord.js';

const dw = new DailyWord();
const day = (n) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);

test('curated file loads with no invalid references', () => {
  assert.equal(dw.mode, 'curated');
  assert.deepEqual(dw.curatedErrors, []);
  assert.ok(dw.curatedSize >= 365 && dw.curatedSize <= 500, `size ${dw.curatedSize}`);
});

test('no repeats until the pool is exhausted (two cycles, incl. dates before the epoch)', () => {
  const n = dw.curatedSize;
  for (const offset of [0, n, -n]) {
    const refs = new Set();
    for (let i = 0; i < n; i++) refs.add(dw.forDate(day(offset + i)).ref);
    assert.equal(refs.size, n, `cycle at ${offset}`);
  }
});

test('deterministic by date; ranges are labelled and carry every line', () => {
  assert.equal(new DailyWord().forDate('2026-11-08').ref, dw.forDate('2026-11-08').ref);
  let range = null;
  for (let i = 0; i < dw.curatedSize && !range; i++) {
    const w = dw.forDate(day(i));
    if (w.endVerse) range = w;
  }
  assert.ok(range, 'some range in the pool');
  assert.match(range.ref, /:\d+-\d+$/);
  assert.equal(range.lines.length, range.endVerse - range.verse + 1);
  assert.equal(range.text, range.lines.map((l) => l.text).join(' '));
});

test('falls back to the rule-based picker without the curated file', () => {
  const fallback = new DailyWord(undefined, null);
  assert.equal(fallback.mode, 'rules');
  assert.ok(fallback.forDate('2026-11-08').text.length > 0);
});

test('invalid curated entries are reported and skipped', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const f = join(mkdtempSync(join(tmpdir(), 'curated-')), 'c.json');
  writeFileSync(f, JSON.stringify({ verses: ['시편 23:1', '시편 999:1', '없는책 1:1', '시편 23:1-9', '시편 23:1'] }));
  const t = new DailyWord(undefined, f);
  assert.equal(t.curatedSize, 1);
  assert.equal(t.curatedErrors.length, 4);
});
