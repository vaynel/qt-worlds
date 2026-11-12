import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PassageVerse, WordPassage } from '../../shared/protocol.js';

interface BibleBook {
  book: number;
  name: string;
}
interface BibleVerse {
  book: number;
  chapter: number;
  verse: number;
  text: string;
  placeholder?: boolean;
}
interface BibleFile {
  meta: { translation: string; verseCount: number };
  books: BibleBook[];
  verses: BibleVerse[];
}

// =============================================================================
// Exclusion rules for "오늘의 말씀". Everything that decides which verses can be
// picked lives here, so the policy is easy to review and tune.
// =============================================================================

/** Shorter verses rarely stand on their own; longer ones are hard to read on a phone. */
export const MIN_LENGTH = 28;
export const MAX_LENGTH = 170;

/**
 * Where today's word may come from: books and chapters written to be read
 * prayerfully (psalms, wisdom, prophetic comfort, gospels, letters). Long
 * narrative books are left out because single verses from them usually read
 * as story fragments. Format: [book number, firstChapter, lastChapter].
 */
export const INCLUDED_SECTIONS: readonly [number, number, number][] = [
  [5, 6, 11], [5, 30, 33], // 신명기
  [6, 1, 1], // 여호수아 1장
  [18, 19, 19], [18, 23, 23], [18, 28, 28], [18, 38, 42], // 욥기
  [19, 1, 150], // 시편
  [20, 1, 31], // 잠언
  [21, 1, 12], // 전도서
  [23, 9, 9], [23, 11, 12], [23, 25, 26], [23, 35, 35], [23, 40, 66], // 이사야
  [24, 17, 17], [24, 29, 29], [24, 31, 31], [24, 33, 33], // 예레미야
  [25, 3, 3], // 예레미야애가
  [28, 6, 6], [28, 14, 14], [29, 2, 2], [33, 6, 7], [35, 3, 3], [36, 3, 3], // 소선지서
  [40, 1, 28], [41, 1, 16], [42, 1, 24], [43, 1, 21], // 복음서
  ...range(45, 65).map((b) => [b, 1, 99] as [number, number, number]), // 서신서
  [66, 1, 3], [66, 21, 22], // 요한계시록
];

/**
 * Whole passages that are lists rather than prose for meditation: genealogies,
 * censuses, land allotments, itineraries, building specifications and
 * ritual-procedure chapters. Format: [book number, chapter, fromVerse?, toVerse?].
 */
export const EXCLUDED_PASSAGES: readonly [number, number, number?, number?][] = [
  [1, 5], [1, 10], [1, 11, 10, 32], [1, 25, 12, 18], [1, 36], [1, 46, 8, 27], // 창세기 계보
  [2, 6, 14, 25], // 출 계보
  ...range(25, 31).map((c) => [2, c] as [number, number]), // 출 성막 규격
  ...range(35, 39).map((c) => [2, c] as [number, number]),
  ...range(1, 7).map((c) => [3, c] as [number, number]), // 레 제사 규례
  ...range(11, 15).map((c) => [3, c] as [number, number]), // 레 정결 규례
  ...[1, 2, 3, 4, 7, 26, 33, 34].map((c) => [4, c] as [number, number]), // 민 인구조사·예물·여정
  ...range(13, 21).map((c) => [6, c] as [number, number]), // 수 땅 분배
  [11, 4], [11, 7], // 왕상 관리 명단·성전 기구
  ...range(1, 9).map((c) => [13, c] as [number, number]), // 대상 계보
  ...range(23, 27).map((c) => [13, c] as [number, number]), // 대상 반열 명단
  [15, 2], [15, 8, 1, 14], [15, 10, 18, 44], // 에스라 명단
  [16, 3], [16, 7, 6, 73], [16, 10, 1, 27], [16, 11], [16, 12, 1, 26], // 느헤미야 명단
  ...range(40, 48).map((c) => [26, c] as [number, number]), // 겔 성전 측량
  [40, 1, 1, 17], // 마 족보
  [42, 3, 23, 38], // 눅 족보
];

/** Verse-level patterns typical of lists (genealogy "낳고", lineage chains). */
export const EXCLUDED_PATTERNS: readonly RegExp[] = [
  /낳고/,
  /낳았고/,
  /(의 아들.*){3,}/,
  /(자손이.*){2,}/,
  // Narrative past-tense endings (story fragments, not addresses to the reader).
  /(더라|지라|었더니|였더니)$/,
  // Violence or curses rarely make a gentle standalone meditation.
  /(죽이|칼로|찌르|쳐 죽|불사르|저주를 받)/,
];

/**
 * A verse should end a sentence. 개역한글 sentences end in forms like
 * ~니라, ~도다, ~리라, ~하라, ~이다, ~소서, ~이까, ~지어다, ~하리요.
 * Verses ending mid-sentence ("~하고", "~하며", "~더니") read like fragments.
 */
export const SENTENCE_END = /(라|다|서|까|요|오|여|니라|아멘)[.?!]?$/;

// =============================================================================

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

function excludedByPassage(v: BibleVerse): boolean {
  return EXCLUDED_PASSAGES.some(
    ([b, c, from, to]) => b === v.book && c === v.chapter && (from === undefined || (v.verse >= from && v.verse <= (to ?? from))),
  );
}

export function isMeditationVerse(v: BibleVerse): boolean {
  if (v.placeholder) return false;
  const t = v.text;
  if (t.length < MIN_LENGTH || t.length > MAX_LENGTH) return false;
  if (/[[\]()]/.test(t)) return false; // bracketed textual notes
  if (!SENTENCE_END.test(t)) return false;
  if (EXCLUDED_PATTERNS.some((re) => re.test(t))) return false;
  if (!INCLUDED_SECTIONS.some(([b, from, to]) => b === v.book && v.chapter >= from && v.chapter <= to)) return false;
  return !excludedByPassage(v);
}

/** FNV-1a then a murmur-style finaliser: stable across Node versions. */
function hashDate(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// =============================================================================
// Curated pool (data/curated-verses.json): references only, text from the
// Bible file. Day N of a cycle uses a seeded permutation of the pool, so no
// verse repeats until every one has been used.
// =============================================================================

interface CuratedRef {
  ref: string;
  book: number;
  chapter: number;
  start: number;
  end: number;
  /** Index of the first verse in the verses array. */
  index: number;
}

const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(2026, 0, 1);
const REF_RE = /^(.+?) (\d+):(\d+)(?:-(\d+))?$/;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function findCuratedFile(bibleFile: string): string | null {
  if (process.env.CURATED_PATH) return existsSync(process.env.CURATED_PATH) ? process.env.CURATED_PATH : null;
  const candidate = resolve(dirname(bibleFile), 'curated-verses.json');
  return existsSync(candidate) ? candidate : null;
}

function findBibleFile(): string {
  if (process.env.BIBLE_PATH) return process.env.BIBLE_PATH;
  // Works from src/ (tsx) and dist/server/src/ (built): walk up to the repo's data/.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, 'data/bible-krv.json');
    if (existsSync(candidate)) return candidate;
    dir = resolve(dir, '..');
  }
  throw new Error('data/bible-krv.json not found (set BIBLE_PATH)');
}

/**
 * Picks one verse per Korean calendar day. Same date -> same verse for
 * everyone; the candidate pool is in canonical order, so the result depends
 * only on the date, the data file and the rules above.
 */
export class DailyWord {
  private readonly verses: BibleVerse[];
  private readonly books = new Map<number, string>();
  private readonly pool: number[];
  private readonly translation: string;
  private readonly cache = new Map<string, WordPassage>();
  private readonly curated: CuratedRef[] = [];
  private readonly permutations = new Map<number, number[]>();
  /** Problems found while validating the curated file (logged at startup). */
  readonly curatedErrors: string[] = [];
  readonly mode: 'curated' | 'rules';

  constructor(path = findBibleFile(), curatedPath: string | null | undefined = undefined) {
    const file = JSON.parse(readFileSync(path, 'utf-8')) as BibleFile;
    this.verses = file.verses;
    this.translation = file.meta.translation || '개역한글판';
    for (const b of file.books) this.books.set(b.book, b.name);
    this.pool = [];
    this.verses.forEach((v, i) => {
      if (isMeditationVerse(v)) this.pool.push(i);
    });
    const cp = curatedPath === undefined ? findCuratedFile(path) : curatedPath;
    if (cp) this.loadCurated(cp);
    this.mode = this.curated.length > 0 ? 'curated' : 'rules';
  }

  /** Parse and validate every reference; invalid ones are reported and skipped. */
  private loadCurated(file: string) {
    let list: unknown;
    try {
      list = (JSON.parse(readFileSync(file, 'utf-8')) as { verses?: unknown }).verses;
    } catch (err) {
      this.curatedErrors.push(`cannot read ${file}: ${(err as Error).message}`);
      return;
    }
    if (!Array.isArray(list)) {
      this.curatedErrors.push(`${file}: "verses" must be an array`);
      return;
    }
    const byName = new Map<string, number>();
    for (const [num, name] of this.books) byName.set(name, num);
    const position = new Map<string, number>();
    this.verses.forEach((v, i) => position.set(`${v.book}:${v.chapter}:${v.verse}`, i));
    const seen = new Set<string>();
    for (const raw of list) {
      const ref = typeof raw === 'string' ? raw.trim() : '';
      const m = REF_RE.exec(ref);
      const book = m ? byName.get(m[1]) : undefined;
      if (!m || !book) {
        this.curatedErrors.push(`bad reference: ${JSON.stringify(raw)}`);
        continue;
      }
      const chapter = Number(m[2]);
      const start = Number(m[3]);
      const end = m[4] ? Number(m[4]) : start;
      if (end < start || end - start > 3) {
        this.curatedErrors.push(`bad range (max 4 verses): ${ref}`);
        continue;
      }
      const index = position.get(`${book}:${chapter}:${start}`);
      let ok = index !== undefined;
      for (let v = start; ok && v <= end; v++) {
        const i = position.get(`${book}:${chapter}:${v}`);
        ok = i !== undefined && !this.verses[i].placeholder;
      }
      if (!ok) {
        this.curatedErrors.push(`no such verse(s): ${ref}`);
        continue;
      }
      if (seen.has(ref)) {
        this.curatedErrors.push(`duplicate: ${ref}`);
        continue;
      }
      seen.add(ref);
      this.curated.push({ ref, book, chapter, start, end, index: index! });
    }
  }

  get curatedSize(): number {
    return this.curated.length;
  }

  /** Seeded permutation of the curated pool for one cycle. */
  private permutation(cycle: number): number[] {
    let p = this.permutations.get(cycle);
    if (p) return p;
    const rand = mulberry32(hashDate(`worlds-curated:${cycle}`));
    p = this.curated.map((_, i) => i);
    for (let i = p.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    if (this.permutations.size > 8) this.permutations.clear();
    this.permutations.set(cycle, p);
    return p;
  }

  /** Which curated entry a date uses (exposed for tests). */
  curatedIndexFor(date: string): number {
    const [y, m, d] = date.split('-').map(Number);
    const day = Math.floor((Date.UTC(y, m - 1, d) - EPOCH) / DAY_MS);
    const n = this.curated.length;
    const cycle = Math.floor(day / n);
    const pos = ((day % n) + n) % n;
    return this.permutation(cycle)[pos];
  }

  private passage(date: string, book: number, chapter: number, startIndex: number, count: number): WordPassage {
    const lines: PassageVerse[] = [];
    for (let k = 0; k < count; k++) {
      const v = this.verses[startIndex + k];
      lines.push({ verse: v.verse, text: v.text });
    }
    const near = (i: number): PassageVerse | null => {
      const o = this.verses[i];
      return o && o.book === book && o.chapter === chapter && !o.placeholder ? { verse: o.verse, text: o.text } : null;
    };
    const before = [near(startIndex - 2), near(startIndex - 1)].filter((x): x is PassageVerse => x !== null);
    const last = startIndex + count - 1;
    const after = [near(last + 1), near(last + 2)].filter((x): x is PassageVerse => x !== null);
    const name = this.books.get(book) ?? '';
    const first = lines[0].verse;
    const end = lines[lines.length - 1].verse;
    return {
      date,
      book: name,
      chapter,
      verse: first,
      ...(count > 1 ? { endVerse: end, lines } : {}),
      ref: `${name} ${chapter}:${first}${count > 1 ? `-${end}` : ''}`,
      text: lines.map((l) => l.text).join(' '),
      before,
      after,
      translation: this.translation,
    };
  }

  private positions: Map<string, number> | null = null;

  /**
   * A user-typed reference ("요한복음 3:16", "시편 23:1-3", up to 10 verses),
   * checked against the Bible file the same way the curated list is: the book
   * name must match exactly and every verse must exist. Returns the normalised
   * reference and its text, or null.
   */
  lookup(raw: string): { ref: string; text: string } | null {
    const m = REF_RE.exec(raw.replace(/\s+/g, ' ').trim());
    if (!m) return null;
    let book: number | undefined;
    for (const [num, name] of this.books) if (name === m[1]) book = num;
    if (!book) return null;
    if (!this.positions) {
      this.positions = new Map();
      this.verses.forEach((v, i) => this.positions!.set(`${v.book}:${v.chapter}:${v.verse}`, i));
    }
    const chapter = Number(m[2]);
    const start = Number(m[3]);
    const end = m[4] ? Number(m[4]) : start;
    if (end < start || end - start > 9) return null;
    const texts: string[] = [];
    for (let v = start; v <= end; v++) {
      const i = this.positions.get(`${book}:${chapter}:${v}`);
      if (i === undefined || this.verses[i].placeholder) return null;
      texts.push(this.verses[i].text);
    }
    return { ref: `${m[1]} ${chapter}:${start}${end > start ? `-${end}` : ''}`, text: texts.join(' ') };
  }

  get poolSize(): number {
    return this.pool.length;
  }

  get totalVerses(): number {
    return this.verses.length;
  }

  forDate(date: string): WordPassage {
    const hit = this.cache.get(date);
    if (hit) return hit;
    if (this.mode === 'curated') {
      const c = this.curated[this.curatedIndexFor(date)];
      const word = this.passage(date, c.book, c.chapter, c.index, c.end - c.start + 1);
      if (this.cache.size > 64) this.cache.clear();
      this.cache.set(date, word);
      return word;
    }
    // Fallback: rule-based pick (only when the curated file is missing).
    const index = this.pool[hashDate(`worlds-word:${date}`) % this.pool.length];
    const v = this.verses[index];
    const near = (offset: number): PassageVerse | null => {
      const o = this.verses[index + offset];
      return o && o.book === v.book && o.chapter === v.chapter && !o.placeholder ? { verse: o.verse, text: o.text } : null;
    };
    const before = [near(-2), near(-1)].filter((x): x is PassageVerse => x !== null);
    const after = [near(1), near(2)].filter((x): x is PassageVerse => x !== null);
    const book = this.books.get(v.book) ?? '';
    const word: WordPassage = {
      date,
      book,
      chapter: v.chapter,
      verse: v.verse,
      ref: `${book} ${v.chapter}:${v.verse}`,
      text: v.text,
      before,
      after,
      translation: this.translation,
    };
    if (this.cache.size > 64) this.cache.clear();
    this.cache.set(date, word);
    return word;
  }
}
