/**
 * Wire protocol shared by client and server (JSON over WebSocket).
 * This file must stay dependency-free: the server compiles it with tsc
 * (NodeNext) and the client bundles it with Vite.
 */

export const PROTOCOL_VERSION = 1;

/**
 * Version of 이용약관 + 개인정보처리방침 that sign-up consent refers to.
 * Bump it (to the new 시행일) when the texts change materially: every account
 * is then asked to agree again on its next visit.
 */
export const TERMS_VERSION = '2026-11-10';
/** Minimum age for an account (만 14세 이상; PIPA art. 22-2). */
export const MIN_AGE = 14;

/** Server -> client snapshot rate. */
export const SNAPSHOT_HZ = 12;
/** Client -> server state send rate. */
export const STATE_SEND_HZ = 12;

export const NICKNAME_MAX = 12;
export const CHAT_MAX = 200;
export const MAX_PLAYERS = 50;
/** Hard cap for one incoming frame, in bytes. */
/** Hard cap for one incoming frame (voice SDP offers need a few KB). */
export const MAX_FRAME_BYTES = 16 * 1024;

/** Voice prayer rooms (one per group). */
export const VOICE_MAX = 8;
export const VOICE_SDP_MAX = 12_000;
export const VOICE_CANDIDATE_MAX = 1024;
/** Kicked users can't rejoin that room for this long. */
export const VOICE_KICK_BLOCK_MS = 10 * 60 * 1000;

export interface VoicePeerInfo {
  /** Session (connection) id, as used in snapshots. */
  id: string;
  name: string;
  muted: boolean;
  speaking: boolean;
  /** Group creator (may kick). */
  owner: boolean;
}

/** Group text chat (모임 채팅). */
export const GROUP_CHAT_MAX = 500;
export const GROUP_CHAT_DAYS = 7;

export interface GroupMessage {
  id: number;
  groupId: number;
  /** null for system lines. */
  userId: number | null;
  nickname: string;
  kind: 'msg' | 'system';
  /** Empty when deleted or hidden. */
  text: string;
  createdAt: string;
  deleted: boolean;
  hidden: boolean;
}

/** NFC, strip control characters except line breaks, at most 3 blank lines in a row. */
export function cleanMultiline(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(UNSAFE_CHARS_KEEP_NL, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

export type VoiceSignal =
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'ice'; candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } };

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

/** What a player sits on: a prayer mat (기도의 뜰), a campfire log or a plaza bench. */
export type SeatKind = 'mat' | 'log' | 'bench';

/**
 * 모닥불 log benches (Landmarks.buildCampfire builds the logs from these
 * numbers): LOG_COUNT logs, each LOG_LENGTH long, lying tangent to a circle of
 * LOG_RING_RADIUS around the fire, centres at angle i/LOG_COUNT*2π + LOG_ANGLE0.
 */
export const LOG_COUNT = 5;
export const LOG_RING_RADIUS = 4.2;
export const LOG_ANGLE0 = 0.3;
export const LOG_LENGTH = 2.0;
export const LOG_RADIUS = 0.32;
/** Seats per log, this far either side of the log's middle. */
export const LOG_SEATS_PER_LOG = 2;
export const LOG_SEAT_SPREAD = 0.5;
/** Seat sits a touch behind the log's axis (away from the fire), so the
 *  knees land on the log's front edge and the shins hang clear of it. */
export const LOG_SEAT_BACK = 0.02;
export const LOG_SEAT_COUNT = LOG_COUNT * LOG_SEATS_PER_LOG;

export interface LogSeat extends MatSpot {
  /** Which log (0..LOG_COUNT-1). */
  log: number;
}

export const LOG_SEATS: readonly LogSeat[] = Array.from({ length: LOG_SEAT_COUNT }, (_, index) => {
  const log = Math.floor(index / LOG_SEATS_PER_LOG);
  const side = (index % LOG_SEATS_PER_LOG) - (LOG_SEATS_PER_LOG - 1) / 2; // -0.5, +0.5
  const a = (log / LOG_COUNT) * Math.PI * 2 + LOG_ANGLE0;
  const r = LOG_RING_RADIUS + LOG_SEAT_BACK;
  // Tangent direction (perpendicular to the radius).
  const tx = -Math.sin(a);
  const tz = Math.cos(a);
  const x = CAMPFIRE.x + Math.cos(a) * r + tx * side * 2 * LOG_SEAT_SPREAD;
  const z = CAMPFIRE.z + Math.sin(a) * r + tz * side * 2 * LOG_SEAT_SPREAD;
  return { index, log, x, z, yaw: Math.atan2(CAMPFIRE.x - x, CAMPFIRE.z - z) };
});

/**
 * 중앙 광장 benches (Landmarks.buildPlaza builds them from these numbers):
 * BENCH_COUNT benches on a circle of BENCH_RING_RADIUS around the plaza centre,
 * at angle i/BENCH_COUNT*2π + BENCH_ANGLE0, each facing the central basin with
 * its backrest on the outer side. Bench-local: x along the bench, +z forward.
 */
export const PLAZA = { x: 0, z: 0 } as const;
export const BENCH_COUNT = 4;
export const BENCH_RING_RADIUS = 5;
export const BENCH_ANGLE0 = Math.PI / 4;
export const BENCH_LENGTH = 1.8;
export const BENCH_DEPTH = 0.5;
/** Top of the seat board above the ground. */
export const BENCH_SEAT_HEIGHT = 0.51;
/** Seats per bench, this far either side of the bench's middle. */
export const BENCH_SEATS_PER_BENCH = 2;
export const BENCH_SEAT_SPREAD = 0.45;
/** Hips a touch behind the board's middle, toward the backrest. */
export const BENCH_SEAT_BACK = 0.04;
export const BENCH_SEAT_COUNT = BENCH_COUNT * BENCH_SEATS_PER_BENCH;

export interface BenchDef {
  index: number;
  x: number;
  z: number;
  /** Facing angle (0 = +z): toward the plaza centre. */
  yaw: number;
}

export const BENCHES: readonly BenchDef[] = Array.from({ length: BENCH_COUNT }, (_, index) => {
  const a = (index / BENCH_COUNT) * Math.PI * 2 + BENCH_ANGLE0;
  const x = PLAZA.x + Math.cos(a) * BENCH_RING_RADIUS;
  const z = PLAZA.z + Math.sin(a) * BENCH_RING_RADIUS;
  return { index, x, z, yaw: Math.atan2(PLAZA.x - x, PLAZA.z - z) };
});

export interface BenchSeat extends MatSpot {
  /** Which bench (0..BENCH_COUNT-1). */
  bench: number;
}

export const BENCH_SEATS: readonly BenchSeat[] = Array.from({ length: BENCH_SEAT_COUNT }, (_, index) => {
  const b = BENCHES[Math.floor(index / BENCH_SEATS_PER_BENCH)];
  const side = (index % BENCH_SEATS_PER_BENCH) - (BENCH_SEATS_PER_BENCH - 1) / 2; // -0.5, +0.5
  // Bench-local axes in world space: right (+x) and forward (+z).
  const rx = Math.cos(b.yaw);
  const rz = -Math.sin(b.yaw);
  const fx = Math.sin(b.yaw);
  const fz = Math.cos(b.yaw);
  const along = side * 2 * BENCH_SEAT_SPREAD;
  return { index, bench: b.index, x: b.x + rx * along - fx * BENCH_SEAT_BACK, z: b.z + rz * along - fz * BENCH_SEAT_BACK, yaw: b.yaw };
});

const SEAT_COUNTS: Record<SeatKind, number> = { mat: MAT_COUNT, log: LOG_SEAT_COUNT, bench: BENCH_SEAT_COUNT };

export function seatSpot(kind: SeatKind, index: number): MatSpot | undefined {
  return kind === 'log' ? LOG_SEATS[index] : kind === 'bench' ? BENCH_SEATS[index] : MATS[index];
}

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
  /** Sit on a mat (legacy shape: { t: 'sit', mat }), a log or bench seat ({ t: 'sit', kind, seat }). */
  | { t: 'sit'; kind: SeatKind; seat: number }
  | { t: 'stand' }
  | { t: 'voiceJoin'; groupId: number }
  | { t: 'voiceLeave' }
  | { t: 'voiceSignal'; to: string; data: VoiceSignal }
  | { t: 'voiceMute'; muted: boolean }
  | { t: 'voiceSpeaking'; speaking: boolean }
  | { t: 'voiceKick'; target: string };

export interface PlayerInfo {
  id: string;
  /** Display name (guest duplicates get a " (2)" style suffix). */
  name: string;
  /** Not signed in (shown with a small "손님" marker). */
  guest?: boolean;
}

export interface PlayerSnap extends StatePayload {
  id: string;
  /** Seat index while seated (mat, log or bench, see seatKind), else -1. */
  seat: number;
  /** Present when seated on a campfire log or plaza bench ('mat' is implied otherwise). */
  seatKind?: 'log' | 'bench';
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
  | 'seat_taken'
  | 'too_many'
  | 'voice_not_member'
  | 'voice_full'
  | 'voice_blocked'
  | 'voice_login';

/** Logged-in account as the server sees it. */
export interface AccountInfo {
  id: number;
  nickname: string;
}

/** What everyone except the author sees for an anonymous lantern. */
export const ANONYMOUS_NAME = '익명의 성도';

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
  /** Shared anonymously (public only): others see ANONYMOUS_NAME. */
  anonymous: boolean;
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
      /** Campfire log seat occupancy (LOG_SEATS order). */
      logs?: (string | null)[];
      /** Plaza bench seat occupancy (BENCH_SEATS order). */
      benches?: (string | null)[];
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
  /** You are in a voice room: everyone already there (connect to each). */
  | { t: 'voiceRoom'; groupId: number; groupName: string; selfId: string; owner: boolean; peers: VoicePeerInfo[] }
  /** Someone joined or changed mute/speaking. */
  | { t: 'voicePeer'; peer: VoicePeerInfo; joined: boolean }
  | { t: 'voicePeerLeft'; id: string }
  | { t: 'voiceSignal'; from: string; data: VoiceSignal }
  /** You left the room (left, kicked, removed from the group, error). */
  | { t: 'voiceLeft'; reason: 'left' | 'kicked' | 'removed' }
  | { t: 'voiceError'; code: ErrorCode; message: string }
  /** New group chat message (members only). */
  | { t: 'groupChat'; message: GroupMessage }
  /** A message was deleted or hidden. */
  | { t: 'groupChatUpdate'; message: GroupMessage }
  /** This user read a group on some device (sync unread badges). */
  | { t: 'groupRead'; groupId: number; lastReadId: number }
  /** The server refused a position (too fast); snap back here. */
  | { t: 'correct'; x: number; y: number; z: number }
  | { t: 'join'; player: PlayerInfo }
  | { t: 'leave'; id: string }
  /** A signed-in player changed their nickname. */
  | { t: 'rename'; id: string; name: string }
  | { t: 'snap'; players: PlayerSnap[] }
  | { t: 'chat'; id: string; name: string; text: string }
  | { t: 'mats'; mats: (string | null)[] }
  | { t: 'logs'; logs: (string | null)[] }
  | { t: 'benches'; benches: (string | null)[] }
  | { t: 'error'; code: ErrorCode; message: string };

// ------------------------------------------------------------------ validation

// Control characters, zero-width/bidi tricks and line separators.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

const UNSAFE_CHARS_KEEP_NL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

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
    case 'sit': {
      if (m.kind === 'log' || m.kind === 'bench') {
        const n = SEAT_COUNTS[m.kind];
        return Number.isInteger(m.seat) && (m.seat as number) >= 0 && (m.seat as number) < n ? { t: 'sit', kind: m.kind, seat: m.seat as number } : null;
      }
      if (m.kind !== undefined && m.kind !== 'mat') return null;
      const idx = m.seat ?? m.mat;
      return Number.isInteger(idx) && (idx as number) >= 0 && (idx as number) < MAT_COUNT ? { t: 'sit', kind: 'mat', seat: idx as number } : null;
    }
    case 'stand':
      return { t: 'stand' };
    case 'voiceJoin':
      return Number.isInteger(m.groupId) && (m.groupId as number) > 0 ? { t: 'voiceJoin', groupId: m.groupId as number } : null;
    case 'voiceLeave':
      return { t: 'voiceLeave' };
    case 'voiceMute':
      return typeof m.muted === 'boolean' ? { t: 'voiceMute', muted: m.muted } : null;
    case 'voiceSpeaking':
      return typeof m.speaking === 'boolean' ? { t: 'voiceSpeaking', speaking: m.speaking } : null;
    case 'voiceKick':
      return typeof m.target === 'string' && m.target.length <= 32 ? { t: 'voiceKick', target: m.target } : null;
    case 'voiceSignal': {
      if (typeof m.to !== 'string' || m.to.length > 32) return null;
      const d = m.data as Record<string, unknown> | null;
      if (!d || typeof d !== 'object') return null;
      if ((d.type === 'offer' || d.type === 'answer') && typeof d.sdp === 'string' && d.sdp.length <= VOICE_SDP_MAX) {
        return { t: 'voiceSignal', to: m.to, data: { type: d.type, sdp: d.sdp } };
      }
      if (d.type === 'ice') {
        const c = d.candidate as Record<string, unknown> | null;
        if (!c || typeof c !== 'object' || typeof c.candidate !== 'string' || c.candidate.length > VOICE_CANDIDATE_MAX) return null;
        const mid = typeof c.sdpMid === 'string' && c.sdpMid.length <= 32 ? c.sdpMid : null;
        const line = Number.isInteger(c.sdpMLineIndex) && (c.sdpMLineIndex as number) >= 0 && (c.sdpMLineIndex as number) < 64 ? (c.sdpMLineIndex as number) : null;
        return { t: 'voiceSignal', to: m.to, data: { type: 'ice', candidate: { candidate: c.candidate, sdpMid: mid, sdpMLineIndex: line } } };
      }
      return null;
    }
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
