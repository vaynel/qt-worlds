/**
 * Wire protocol shared by client and server (JSON over WebSocket).
 * This file must stay dependency-free: the server compiles it with tsc
 * (NodeNext) and the client bundles it with Vite.
 */

export const PROTOCOL_VERSION = 1;

/** Server -> client snapshot rate. */
export const SNAPSHOT_HZ = 12;
/** Client -> server state send rate. */
export const STATE_SEND_HZ = 12;

export const NICKNAME_MAX = 12;
export const CHAT_MAX = 200;
export const MAX_PLAYERS = 50;
/** Hard cap for one incoming frame, in bytes. */
export const MAX_FRAME_BYTES = 2048;

/** Shared layout facts both sides need for validation (metres). */
export const CAMPFIRE = { x: 50, z: -12, chatRadius: 12 } as const;
export const LANTERN_HILL = { x: 6, z: -76 } as const;
export const PRAYER_GARDEN = { x: -52, z: -16 } as const;
export const MAT_RING_RADIUS = 5.2;
export const MAT_COUNT = 8;
/** How close you must stand to a mat to sit on it. */
export const SIT_REACH = 2.2;

export interface MatSpot {
  index: number;
  x: number;
  z: number;
  /** Facing angle (0 = +z) toward the garden centre. */
  yaw: number;
}

export const MATS: readonly MatSpot[] = Array.from({ length: MAT_COUNT }, (_, index) => {
  const a = (index / MAT_COUNT) * Math.PI * 2;
  const x = PRAYER_GARDEN.x + Math.cos(a) * MAT_RING_RADIUS;
  const z = PRAYER_GARDEN.z + Math.sin(a) * MAT_RING_RADIUS;
  return { index, x, z, yaw: Math.atan2(PRAYER_GARDEN.x - x, PRAYER_GARDEN.z - z) };
});

// ------------------------------------------------------------------ messages

export interface StatePayload {
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  /** True while inside the private room (골방); others then hide this avatar. */
  inside?: boolean;
}

/** One verse line of a passage. */
export interface PassageVerse {
  verse: number;
  text: string;
}

/** Today's word, as sent by the server (never the whole Bible). */
export interface WordPassage {
  /** Asia/Seoul calendar date, YYYY-MM-DD. */
  date: string;
  book: string;
  chapter: number;
  verse: number;
  /** e.g. "요한복음 3:16" or "시편 23:2-3" */
  ref: string;
  /** All verses of the passage joined (for books and lanterns). */
  text: string;
  /** Last verse when the passage is a short range. */
  endVerse?: number;
  /** The passage verse by verse (present for ranges). */
  lines?: PassageVerse[];
  /** Up to two verses before/after in the same chapter, shown dimmed. */
  before: PassageVerse[];
  after: PassageVerse[];
  translation: string;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ClientMessage =
  | { t: 'hello'; v: number; nickname: string; testDate?: string; test?: boolean }
  | ({ t: 'state' } & StatePayload)
  | { t: 'chat'; text: string }
  | { t: 'sit'; mat: number }
  | { t: 'stand' };

export interface PlayerInfo {
  id: string;
  /** Display name (guest duplicates get a " (2)" style suffix). */
  name: string;
  /** Not signed in (shown with a small "손님" marker). */
  guest?: boolean;
}

export interface PlayerSnap extends StatePayload {
  id: string;
  /** Mat index while seated, else -1. */
  seat: number;
}

export type ErrorCode =
  | 'bad_message'
  | 'bad_nickname'
  | 'name_taken'
  | 'full'
  | 'version'
  | 'rate_limited'
  | 'not_near'
  | 'mat_taken'
  | 'too_many';

/** Logged-in account as the server sees it. */
export interface AccountInfo {
  id: number;
  nickname: string;
}

export const REACTION_TYPES = ['amen', 'pray', 'record'] as const;
export type ReactionType = (typeof REACTION_TYPES)[number];
export const REACTION_LABELS: Record<ReactionType, string> = { amen: '아멘', pray: '기도하기', record: '기록하기' };

/** What a viewer may know about a lantern without opening it. */
export interface LanternInfo {
  id: number;
  slot: number;
  nickname: string;
  date: string;
  ref: string;
  /** null = 공개; otherwise the group's name (비공개, members only). */
  group: string | null;
  counts: Record<ReactionType, number>;
  mine: boolean;
}

/** Full card, fetched over the API only by people allowed to see it. */
export interface LanternDetail extends LanternInfo {
  verse: string;
  translation: string;
  meditation: string;
  feeling: string;
  application: string;
  createdAt: string;
  myReactions: ReactionType[];
}

export type ServerMessage =
  | {
      t: 'welcome';
      id: string;
      name: string;
      seed: string;
      players: PlayerInfo[];
      mats: (string | null)[];
      snapshotHz: number;
      word?: WordPassage | null;
      /** The signed-in account, or null for a guest. */
      account?: AccountInfo | null;
      guest?: boolean;
    }
  | { t: 'word'; word: WordPassage }
  | { t: 'lanterns'; lanterns: LanternInfo[] }
  | { t: 'lantern'; lantern: LanternInfo }
  | { t: 'lanternGone'; id: number }
  /** The server refused a position (too fast); snap back here. */
  | { t: 'correct'; x: number; y: number; z: number }
  | { t: 'join'; player: PlayerInfo }
  | { t: 'leave'; id: string }
  /** A signed-in player changed their nickname. */
  | { t: 'rename'; id: string; name: string }
  | { t: 'snap'; players: PlayerSnap[] }
  | { t: 'chat'; id: string; name: string; text: string }
  | { t: 'mats'; mats: (string | null)[] }
  | { t: 'error'; code: ErrorCode; message: string };

// ------------------------------------------------------------------ validation

// Control characters, zero-width/bidi tricks and line separators.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

/** NFC-normalise, trim and strip invisible/control characters. */
export function cleanText(value: string): string {
  return value.normalize('NFC').replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim();
}

/** Comparison key for nicknames: NFC, trimmed, case-insensitive. */
export function nicknameKey(name: string): string {
  return cleanText(name).toLowerCase();
}


// ------------------------------------------------------------------ lantern hill

/**
 * Fixed lantern spots on 등불 언덕: rings around the summit, 1.8 m apart,
 * leaving a gap where the path arrives from the plaza (+z side).
 */
export const LANTERN_SLOTS: readonly { x: number; z: number }[] = (() => {
  const out: { x: number; z: number }[] = [];
  for (const r of [4.2, 6.2, 8.2, 10.2, 12.2]) {
    const n = Math.floor((2 * Math.PI * r) / 1.8);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r * 0.37;
      const x = Math.cos(a);
      const z = Math.sin(a);
      // Skip the path corridor (toward +z) so lanterns don't block the way up.
      if (z > 0.93) continue;
      out.push({ x: LANTERN_HILL.x + x * r, z: LANTERN_HILL.z + z * r });
    }
  }
  return out;
})();

/** Length in user-visible code points (Korean syllables count as 1). */
export function textLength(value: string): number {
  return [...value].length;
}

export function validateNickname(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const name = cleanText(raw);
  const len = textLength(name);
  return len >= 1 && len <= NICKNAME_MAX ? name : null;
}

export function validateChat(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > CHAT_MAX * 4) return null;
  const text = cleanText(raw);
  const len = textLength(text);
  if (len < 1) return null;
  return len <= CHAT_MAX ? text : [...text].slice(0, CHAT_MAX).join('');
}

const WORLD_LIMIT = 100_000;
const finite = (v: unknown, limit: number): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit;

/** Parse and validate one client frame. Returns null for anything malformed. */
export function parseClientMessage(data: string): ClientMessage | null {
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return null;
  const m = msg as Record<string, unknown>;
  switch (m.t) {
    case 'hello': {
      if (typeof m.v !== 'number') return null;
      if (typeof m.nickname !== 'string') return null;
      const testDate = typeof m.testDate === 'string' && DATE_RE.test(m.testDate) ? m.testDate : undefined;
      return { t: 'hello', v: m.v, nickname: m.nickname, testDate, test: m.test === true };
    }
    case 'state': {
      if (!finite(m.x, WORLD_LIMIT) || !finite(m.y, 1000) || !finite(m.z, WORLD_LIMIT)) return null;
      if (!finite(m.yaw, 1000) || !finite(m.speed, 100)) return null;
      return { t: 'state', x: m.x, y: m.y, z: m.z, yaw: m.yaw, speed: Math.max(0, m.speed), inside: m.inside === true };
    }
    case 'chat':
      return typeof m.text === 'string' ? { t: 'chat', text: m.text } : null;
    case 'sit':
      return Number.isInteger(m.mat) && (m.mat as number) >= 0 && (m.mat as number) < MAT_COUNT ? { t: 'sit', mat: m.mat as number } : null;
    case 'stand':
      return { t: 'stand' };
    default:
      return null;
  }
}

// ------------------------------------------------------------------ dates

/** Calendar date in Korea (YYYY-MM-DD). The day changes at 00:00 KST. */
export function seoulDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
