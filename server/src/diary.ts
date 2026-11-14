import { isPropId, PROPS } from '../../shared/protocol.js';
import type { FootprintEvent, FootprintMinute, MinuteKind } from './footprints.js';

/**
 * 📔 오늘의 일기: written from the day's 발자취 with fixed, warm Korean
 * sentence templates. Runs on our own server only (no AI, nothing leaves the
 * server). Privacy by construction: no template takes another person's name
 * or anything anyone said; other people only ever appear as a count
 * ("한 성도", "4명과").
 */

export interface DiaryLine {
  /** Stable id of the source (for the editor; not stored). */
  key: string;
  /** Minute of the day the line is ordered by. */
  minute: number;
  text: string;
}

/** 새벽 / 아침 / 낮 / 오후 / 저녁 / 밤 for a minute of the day. */
export function partOfDay(minute: number): string {
  const h = Math.floor(minute / 60);
  if (h < 5) return '새벽';
  if (h < 11) return '아침';
  if (h < 14) return '낮';
  if (h < 18) return '오후';
  if (h < 21) return '저녁';
  return '밤';
}

/** "밤 9시", "아침 7시 반" */
export function clockPhrase(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  if (h === 0 && m < 30) return '자정 무렵';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${partOfDay(minute)} ${h12}시${m >= 30 ? ' 반' : ''}`;
}

/** 을/를 after a word (by its last syllable's final consonant). */
export function objectParticle(word: string): string {
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return '을(를)';
  return code % 28 === 0 ? '를' : '을';
}

function duration(min: number): string {
  if (min < 60) return `${min}분`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}

interface Run {
  start: number;
  end: number;
  minutes: number;
  n: number;
}

/** Contiguous stretches of one kind of minute (gaps of up to 3 minutes join). */
export function runs(minutes: FootprintMinute[], kind: MinuteKind): Run[] {
  const list = minutes.filter((m) => m.kind === kind).sort((a, b) => a.minute - b.minute);
  const out: Run[] = [];
  for (const m of list) {
    const last = out[out.length - 1];
    if (last && m.minute - last.end <= 3) {
      last.end = m.minute;
      last.minutes++;
      last.n = Math.max(last.n, m.n);
    } else out.push({ start: m.minute, end: m.minute, minutes: 1, n: m.n });
  }
  return out;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function diaryLines(events: FootprintEvent[], minutes: FootprintMinute[]): DiaryLine[] {
  const lines: DiaryLine[] = [];
  const add = (key: string, minute: number, text: string) => lines.push({ key, minute, text });
  const of = (type: FootprintEvent['type']) => events.filter((e) => e.type === type);

  const letter = of('letter')[0];
  if (letter) add('letter', letter.minute, `${partOfDay(letter.minute)}에 오늘의 말씀 편지를 열었어요 💌`);

  const meds = of('meditation');
  meds.slice(0, 3).forEach((e, i) => {
    const place = str(e.payload.place) || '골방';
    const excerpt = str(e.payload.excerpt);
    add(`med:${i}`, e.minute, excerpt ? `${place}에서 말씀을 묵상하며 “${excerpt}”라고 적었어요 ✍️` : `${place}에서 말씀을 묵상했어요 ✍️`);
  });
  if (meds.length > 3) add('med:more', meds[3].minute, `그리고 ${meds.length - 3}번 더 묵상을 적었어요`);

  runs(minutes, 'pray').forEach((r, i) => add(`pray:${i}`, r.start, `${partOfDay(r.start)}엔 기도의 뜰에서 ${r.minutes}분 동안 기도했어요 🙏`));

  // Lanterns: ids only, never whose lantern it was.
  const reads = of('lantern_read');
  const reacts = of('lantern_react');
  const readIds = [...new Set(reads.map((e) => num(e.payload.lanternId)).filter((x) => x !== null))];
  const set = (type: string) => new Set(reacts.filter((e) => e.payload.type === type).map((e) => num(e.payload.lanternId)).filter((x) => x !== null));
  const prayed = set('pray');
  const amen = set('amen');
  const record = set('record');
  const firstLantern = Math.min(...[...reads, ...reacts].map((e) => e.minute), 1440);
  if (readIds.length === 1 && prayed.size === 1 && prayed.has(readIds[0])) {
    add('lantern', firstLantern, '한 성도의 등불을 읽으며 함께 기도했어요 🤲');
  } else {
    if (readIds.length === 1) add('lantern', firstLantern, '한 성도의 등불을 읽었어요 🏮');
    else if (readIds.length > 1) add('lantern', firstLantern, `${readIds.length}개의 등불을 읽었어요 🏮`);
    if (prayed.size === 1) add('lantern:pray', firstLantern, '한 성도를 위해 함께 기도했어요 🤲');
    else if (prayed.size > 1) add('lantern:pray', firstLantern, `${prayed.size}명의 성도를 위해 함께 기도했어요 🤲`);
  }
  if (amen.size) add('lantern:amen', firstLantern, amen.size === 1 ? '등불 하나에 아멘으로 마음을 보탰어요' : `등불 ${amen.size}개에 아멘으로 마음을 보탰어요`);
  if (record.size) add('lantern:record', firstLantern, '마음에 닿은 등불을 말씀 책에 담았어요 📖');

  const fires = runs(minutes, 'fire');
  fires.forEach((r, i) =>
    add(
      `fire:${i}`,
      r.start,
      r.n >= 1 ? `${clockPhrase(r.start)}, 모닥불에서 ${r.n}명과 이야기를 나눴어요 🔥` : `${clockPhrase(r.start)}, 모닥불 곁에서 ${r.minutes}분 동안 불을 쬐었어요 🔥`,
    ),
  );

  runs(minutes, 'voice').forEach((r, i) => add(`voice:${i}`, r.start, `${partOfDay(r.start)}엔 모임 음성 기도방에서 ${r.minutes}분 동안 함께 기도했어요 🎙️`));

  const sits = of('sit');
  const firstSit = (kind: string) => sits.find((e) => e.payload.kind === kind);
  const bench = firstSit('bench');
  if (bench) add('sit:bench', bench.minute, '광장 벤치에 앉아 잠시 쉬어 갔어요 🪑');
  const log = firstSit('log');
  if (log && fires.length === 0) add('sit:log', log.minute, '모닥불 통나무에 앉아 불을 바라봤어요 🪵');

  of('rent').forEach((e, i) => {
    const item = e.payload.item;
    if (!isPropId(item)) return;
    const p = PROPS[item];
    add(`rent:${i}`, e.minute, `나눔 소품 가게에서 ${p.emoji} ${p.name}${objectParticle(p.name)} 빌렸어요`);
  });

  const storyReads = [...new Set(of('story_read').map((e) => num(e.payload.storyId)).filter((x) => x !== null))];
  const libraryAt = Math.min(...[...of('library'), ...of('story_read')].map((e) => e.minute), ...runs(minutes, 'library').map((r) => r.start), 1440);
  if (storyReads.length === 1) add('library', libraryAt, '이야기 도서관에서 한 권의 이야기를 읽었어요 📚');
  else if (storyReads.length > 1) add('library', libraryAt, `이야기 도서관에서 ${storyReads.length}권의 이야기를 읽었어요 📚`);
  else if (libraryAt < 1440) {
    const desk = firstSit('desk');
    add('library', libraryAt, desk ? '이야기 도서관 책상에 앉아 조용히 머물렀어요 📚' : '이야기 도서관에 들렀어요 📚');
  }

  // 표현: how many, never which or to whom.
  const emotes = of('emote');
  if (emotes.length) add('emote', emotes[0].minute, `표현을 ${emotes.length}번 나눴어요 😊`);

  const shots = of('shot');
  if (shots.length) add('shot', shots[0].minute, `오늘의 풍경을 사진 ${shots.length}장에 담았어요 📸`);

  lines.sort((a, b) => a.minute - b.minute);
  const play = minutes.filter((m) => m.kind === 'play').length;
  if (play > 0) add('play', 1440, `오늘 QT 월드에서 ${duration(play)} 머물렀어요 🌿`);
  if (lines.length === 0) add('quiet', 0, '오늘은 조용히 다녀간 하루였어요.');
  return lines;
}
