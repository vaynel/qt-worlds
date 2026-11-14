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
export const TERMS_VERSION = '2026-11-14';
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
  /** 🔥 campfire voice: muted by reports for a while (listeners don't play them). */
  silenced?: boolean;
}

/**
 * 🔥 모닥불 공개 음성: the public voice room at the campfire. It travels as
 * voice room "group" 0 (real groups start at 1). Signed-in, consented people
 * inside the campfire circle only; relay-only ICE (TURN) so strangers never
 * see each other's IP address; nothing is recorded.
 */
export const CAMPFIRE_VOICE_ROOM = 0;
export const VOICE_REPORT_REASONS = ['abuse', 'sexual', 'harass', 'other'] as const;
export type VoiceReportReason = (typeof VOICE_REPORT_REASONS)[number];
export const VOICE_REPORT_LABELS: Record<VoiceReportReason, string> = { abuse: '욕설·혐오', sexual: '음란', harass: '괴롭힘', other: '기타' };
/** Distinct reporters within VOICE_REPORT_WINDOW_MS that mute someone from campfire voice. */
export const VOICE_REPORTS_TO_MUTE = 3;
export const VOICE_REPORT_WINDOW_MS = 10 * 60 * 1000;
/** First mute: a day; any later one (not lifted by an admin): a week. */
export const VOICE_MUTE_MS = 24 * 3600 * 1000;
export const VOICE_MUTE_REPEAT_MS = 7 * 24 * 3600 * 1000;

/** 표현 (emotes): fixed content, so guests may use them too. Index = wire id. */
export const EMOTES = [
  { emoji: '🙏', label: '기도해요' },
  { emoji: '✝️', label: '아멘' },
  { emoji: '🙌', label: '할렐루야' },
  { emoji: '😊', label: '반가워요' },
  { emoji: '🥹', label: '감동이에요' },
  { emoji: '🤗', label: '위로해요' },
  { emoji: '👋', label: '안녕하세요' },
  { emoji: '❤️', label: '사랑해요' },
] as const;

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

/** What a player sits on: a prayer mat (기도의 뜰), a campfire log, a plaza bench or a library reading desk. */
export type SeatKind = 'mat' | 'log' | 'bench' | 'desk';

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

// ------------------------------------------------------------------ 이야기 도서관 (L-A)

/** Interiors: the private 골방 ('room', nobody else is ever seen) and the shared library. */
export type InteriorId = 'room' | 'library';
export type Space = 'world' | InteriorId;

/** The library building in the world (between 기도의 뜰 and 등불 언덕), door facing the plaza. */
export const LIBRARY = { x: -27, z: -45 } as const;
/** Outside door spot (3.6 m from the building centre toward the plaza). */
export const LIBRARY_DOOR = (() => {
  const len = Math.hypot(PLAZA.x - LIBRARY.x, PLAZA.z - LIBRARY.z);
  const fx = (PLAZA.x - LIBRARY.x) / len;
  const fz = (PLAZA.z - LIBRARY.z) / len;
  return { x: LIBRARY.x + fx * 3.6, z: LIBRARY.z + fz * 3.6, fx, fz };
})();
/** How close to the outside door you must be to step in (server check, with lag slack). */
export const LIBRARY_ENTER_REACH = 7;

/**
 * Library interior, in its own local frame (floor y = 0): a hall HALF_W x HALF_D
 * either side of the origin, door in the south wall (+z), the two bookcases
 * along the north wall. Two reading tables with four chairs each (seat kind 'desk').
 */
export const LIBRARY_ROOM = { halfW: 9, halfD: 7 } as const;
export const LIBRARY_SPAWN = { x: 0, z: 4.8, yaw: Math.PI } as const;
export const LIBRARY_EXIT = { x: 0, z: 6.3, reach: 1.3 } as const;
export const DESK_COUNT = 2;
export const DESK_SEATS_PER_DESK = 4;
export const DESK_SEAT_COUNT = DESK_COUNT * DESK_SEATS_PER_DESK;
export const DESK_LENGTH = 2.4;
export const DESK_DEPTH = 1.0;
export const DESK_HEIGHT = 0.78;
/** Chair seat height (the reading pose sits the hips here). */
export const DESK_SEAT_HEIGHT = 0.46;
export const DESKS: readonly { index: number; x: number; z: number }[] = [
  { index: 0, x: -3.2, z: 0.6 },
  { index: 1, x: 3.2, z: 0.6 },
];
export interface DeskSeat extends MatSpot {
  desk: number;
}
/** Two chairs on each long side, facing the table. */
export const DESK_SEATS: readonly DeskSeat[] = Array.from({ length: DESK_SEAT_COUNT }, (_, index) => {
  const d = DESKS[Math.floor(index / DESK_SEATS_PER_DESK)];
  const k = index % DESK_SEATS_PER_DESK;
  const side = k < 2 ? -1 : 1; // -1 = north side (faces +z), +1 = south side (faces -z)
  const along = (k % 2 === 0 ? -1 : 1) * 0.62;
  return { index, desk: d.index, x: d.x + along, z: d.z + side * 0.92, yaw: side < 0 ? 0 : Math.PI };
});

const SEAT_COUNTS: Record<SeatKind, number> = { mat: MAT_COUNT, log: LOG_SEAT_COUNT, bench: BENCH_SEAT_COUNT, desk: DESK_SEAT_COUNT };

export function seatSpot(kind: SeatKind, index: number): MatSpot | undefined {
  return kind === 'log' ? LOG_SEATS[index] : kind === 'bench' ? BENCH_SEATS[index] : kind === 'desk' ? DESK_SEATS[index] : MATS[index];
}

/** Interior from a client frame: legacy `true` is the 골방. */
export function parseInside(raw: unknown): InteriorId | undefined {
  return raw === true || raw === 'room' ? 'room' : raw === 'library' ? 'library' : undefined;
}

// ------------------------------------------------------------------ messages

export interface StatePayload {
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  /** Which interior the player is in (absent = the open world). Positions are then in that interior's frame. */
  inside?: InteriorId;
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
  | { t: 'voiceKick'; target: string }
  /** 표현: one of EMOTES (index). */
  | { t: 'emote'; e: number };

export interface PlayerInfo {
  id: string;
  /** Display name (guest duplicates get a " (2)" style suffix). */
  name: string;
  /** Not signed in (shown with a small "손님" marker). */
  guest?: boolean;
  /** Saved appearance (M8); absent = today's default/hashed look. */
  look?: Look;
  /** Props borrowed from 나눔 소품 가게 (M9): item and slot only, never timers. */
  props?: PropWear[];
}

export interface PlayerSnap extends Omit<StatePayload, 'inside'> {
  id: string;
  /** Seat index while seated (mat, log, bench or desk, see seatKind), else -1. */
  seat: number;
  /** Present when seated on a campfire log, plaza bench or library desk ('mat' is implied otherwise). */
  seatKind?: 'log' | 'bench' | 'desk';
  /**
   * Not in the viewer's space (another interior, or the world while the viewer is
   * inside): hide this avatar. Positions of hidden players are not sent (zeros).
   */
  inside?: true;
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
  | 'voice_login'
  | 'voice_consent'
  | 'voice_not_near'
  | 'voice_unavailable';

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

/**
 * 서울 날씨 (MET Norway Locationforecast, fetched by the server only; clients never call a weather API).
 * Wind is m/s, cloud cover 0..100 %. `stale`: no fresh reading (startup default or an old one).
 */
export const WEATHER_KINDS = ['clear', 'partly', 'cloudy', 'fog', 'drizzle', 'rain', 'heavyRain', 'thunder', 'snow', 'heavySnow'] as const;
export type WeatherKind = (typeof WEATHER_KINDS)[number];
export interface WeatherState {
  kind: WeatherKind;
  tempC: number;
  wind: number;
  cloud: number;
  isDay: boolean;
  updatedAt: number;
  source: 'met-no';
  stale?: boolean;
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
      /** Library desk seat occupancy (DESK_SEATS order). */
      desks?: (string | null)[];
      snapshotHz: number;
      word?: WordPassage | null;
      /** The signed-in account, or null for a guest. */
      account?: AccountInfo | null;
      guest?: boolean;
      /** Your own saved appearance (M8), as only you see it. */
      look?: Look | null;
      /** 서울 날씨 right now (see WeatherState). */
      weather?: WeatherState;
    }
  | { t: 'word'; word: WordPassage }
  /** 서울 날씨 changed (sent only on a real change). */
  | { t: 'weather'; weather: WeatherState }
  | { t: 'lanterns'; lanterns: LanternInfo[] }
  | { t: 'lantern'; lantern: LanternInfo }
  | { t: 'lanternGone'; id: number }
  /** You are in a voice room: everyone already there (connect to each). */
  | { t: 'voiceRoom'; groupId: number; groupName: string; selfId: string; owner: boolean; peers: VoicePeerInfo[]; campfire?: boolean; silencedUntil?: number | null }
  /** Someone joined or changed mute/speaking. */
  | { t: 'voicePeer'; peer: VoicePeerInfo; joined: boolean }
  | { t: 'voicePeerLeft'; id: string }
  | { t: 'voiceSignal'; from: string; data: VoiceSignal }
  /** You left the room (left, kicked, removed from the group, error). */
  | { t: 'voiceLeft'; reason: 'left' | 'kicked' | 'removed' | 'away' }
  /** 🔥 campfire voice: you may (null) or may not speak until `until` (reports). */
  | { t: 'voiceSilenced'; until: number | null }
  /** 표현: someone in your space (or you) showed an emote. */
  | { t: 'emote'; id: string; e: number }
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
  /** Someone's appearance changed (null = back to the default look). Also sent for your own id. */
  | { t: 'look'; id: string; look: Look | null }
  | { t: 'snap'; players: PlayerSnap[] }
  | { t: 'chat'; id: string; name: string; text: string }
  | { t: 'mats'; mats: (string | null)[] }
  | { t: 'logs'; logs: (string | null)[] }
  | { t: 'benches'; benches: (string | null)[] }
  /** Library reading desk seat occupancy (DESK_SEATS order). */
  | { t: 'desks'; desks: (string | null)[] }
  /** 이야기 도서관: how many books stand on each shelf, as this viewer may see them. */
  | { t: 'library'; shelves: BookcaseCounts }
  /** Someone's borrowed props changed (rented, returned, expired). Also sent for your own id. */
  | { t: 'props'; id: string; props: PropWear[] }
  /** 나눔 소품 가게: open/closed, this window's stock (server clock). */
  | { t: 'shop'; shop: ShopStatus }
  /** Your own rentals and today's count (only to your account's connections). */
  | { t: 'myShop'; mine: MyShop; ended?: PropId[] }
  /** 10 minutes left on a borrowed prop (once per rental). */
  | { t: 'propReminder'; item: PropId; endsAt: number; now: number }
  /**
   * ✉️ 받은 편지 (L-B): this account's unread count (only to its own connections).
   * `toast` (fixed text, never letter content or names) when something new arrived.
   */
  | { t: 'letters'; unread: number; toast?: string; storyId?: number }
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
      const inside = parseInside(m.inside);
      return { t: 'state', x: m.x, y: m.y, z: m.z, yaw: m.yaw, speed: Math.max(0, m.speed), ...(inside ? { inside } : {}) };
    }
    case 'chat':
      return typeof m.text === 'string' ? { t: 'chat', text: m.text } : null;
    case 'sit': {
      if (m.kind === 'log' || m.kind === 'bench' || m.kind === 'desk') {
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
      // 0 = the campfire's public room (CAMPFIRE_VOICE_ROOM).
      return Number.isInteger(m.groupId) && (m.groupId as number) >= 0 ? { t: 'voiceJoin', groupId: m.groupId as number } : null;
    case 'emote':
      return Number.isInteger(m.e) && (m.e as number) >= 0 && (m.e as number) < EMOTES.length ? { t: 'emote', e: m.e as number } : null;
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

// ------------------------------------------------------------------ appearance (M8)

/** 겉옷 palette: warm, earthy low-poly tones. Index 0 is today's default cream robe. */
export const ROBE_COLORS = [
  0xf1e4c8, 0xe6d6bb, 0xd9bf94, 0xc9a06a, 0xb8735a, 0xa0503a, 0xd9a3a3, 0x9a6a8e,
  0x7d5a7e, 0x9cbfd6, 0x5f7fa6, 0x3f4f6e, 0x9fb39a, 0x6f8a5b, 0x8c8f5a, 0x4a4540,
] as const;
/** 목도리 palette. Index 0 is the default terracotta. */
export const SCARF_COLORS = [0xc8644a, 0xe08a3c, 0xd2a03c, 0x5f8f6b, 0x3f8f8f, 0x4f78a6, 0x9a5fa0, 0xc77a8a, 0xb04050, 0x8a6a4a, 0xf3ece0, 0x3a3a44] as const;
/** 피부 tones. Index 1 is the default. */
export const SKIN_COLORS = [0xf6dcc0, 0xf0c9a4, 0xe0b088, 0xc68e62, 0xa06a44, 0x6e4a30] as const;
/** 머리색. Index 0 is the default brown. */
export const HAIR_COLORS = [0x5a3e2b, 0x2f2620, 0x15120f, 0x7a5236, 0xa8743a, 0xd9b26a, 0x8f4a2c, 0xa8a29a] as const;
/** 머리 모양: 짧은 머리, 단발, 긴 머리, 묶은 머리, 민머리. */
export const HAIR_STYLES = ['short', 'bob', 'long', 'tied', 'bald'] as const;
export type HairStyle = (typeof HAIR_STYLES)[number];

/** Saved colours + hair style as palette indices (what the DB stores). */
export interface Appearance {
  /** robe */
  r: number;
  /** scarf */
  s: number;
  /** skin */
  k: number;
  /** hair colour */
  h: number;
  /** hair style (HAIR_STYLES index) */
  y: number;
}
export const DEFAULT_APPEARANCE: Appearance = { r: 0, s: 0, k: 1, h: 0, y: 0 };

/** What others see: appearance plus the worn outfit drawing (if visible to this viewer). */
export interface Look extends Appearance {
  /** Worn outfit id (fetch pixels from /api/outfits?ids=). */
  o?: number;
  /** Content hash of that outfit. */
  oh?: string;
  /** Only in your own look: the worn drawing was hidden after reports (others see the plain robe). */
  hid?: true;
}

const inRange = (v: unknown, n: number): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < n;

/** Strict: exactly the five palette indices, each in range. */
export function validateAppearance(raw: unknown): Appearance | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  if (Object.keys(a).some((k) => !['r', 's', 'k', 'h', 'y'].includes(k))) return null;
  if (!inRange(a.r, ROBE_COLORS.length) || !inRange(a.s, SCARF_COLORS.length) || !inRange(a.k, SKIN_COLORS.length)) return null;
  if (!inRange(a.h, HAIR_COLORS.length) || !inRange(a.y, HAIR_STYLES.length)) return null;
  return { r: a.r, s: a.s, k: a.k, h: a.h, y: a.y };
}

/** Pixel outfit (옷 그리기): OUTFIT_SIZE² cells, row by row from the top-left. */
export const OUTFIT_SIZE = 16;
export const OUTFIT_CELLS = OUTFIT_SIZE * OUTFIT_SIZE;
export const OUTFIT_SLOTS = 3;
/** Encoding: one character per cell, '0'-'9' 'a'-'f' = OUTFIT_PALETTE index, '.' = transparent (robe colour). */
export const OUTFIT_TRANSPARENT = '.';
export const OUTFIT_PALETTE = [
  0x1f1a1c, 0xf7f1e3, 0xc8463c, 0xe8833a, 0xf2c94c, 0x8bbf4a, 0x3e8e5a, 0x5bb3d6,
  0x2f5d9e, 0x7d4f9e, 0xe58fac, 0x8a5a3b, 0xdcb68e, 0xa29c96, 0x55525e, 0xc9a03a,
] as const;
const OUTFIT_RE = new RegExp(`^[0-9a-f.]{${OUTFIT_CELLS}}$`);

/** Exact size, only palette indices < 16 or transparent, and not completely empty. */
export function validateOutfitPixels(raw: unknown): string | null {
  if (typeof raw !== 'string' || !OUTFIT_RE.test(raw)) return null;
  return /[0-9a-f]/.test(raw) ? raw : null;
}

/** Reasons for 🚩 옷 신고. */
export const REPORT_REASONS = ['inappropriate', 'hate', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REPORT_LABELS: Record<ReportReason, string> = { inappropriate: '부적절한 그림', hate: '혐오·욕설', other: '기타' };
/** Distinct reporters that hide an outfit automatically. */
export const OUTFIT_HIDE_REPORTS = 3;
/** Hidden outfits after which drawing uploads pause for OUTFIT_BAN_DAYS. */
export const OUTFIT_STRIKES_BAN = 3;
export const OUTFIT_BAN_DAYS = 7;

// ------------------------------------------------------------------ dates

/** Calendar date in Korea (YYYY-MM-DD). The day changes at 00:00 KST. */
export function seoulDate(now: Date = new Date()): string {
  // Fixed +9 h arithmetic (Korea has no daylight saving): ~100× cheaper than Intl.
  return kstDateOf(now.getTime());
}

/** Days since the epoch in Korea: changes exactly at 00:00 KST (cheap day-change checks). */
export function kstDayNumber(ms: number): number {
  return Math.floor((ms + 9 * 3600_000) / 86_400_000);
}

// ------------------------------------------------------------------ 나눔 소품 가게 (M9)

/**
 * Free prop rental. No money, no points, no random draws: every prop is free,
 * first come first served, a fixed number per opening window.
 */
export const PROP_IDS = ['lantern', 'guitar', 'bible', 'dove', 'footprints', 'hat'] as const;
export type PropId = (typeof PROP_IDS)[number];
export const PROP_SLOTS = ['hand', 'head', 'shoulder', 'back', 'effect'] as const;
export type PropSlot = (typeof PROP_SLOTS)[number];
export const PROP_SLOT_LABELS: Record<PropSlot, string> = { hand: '손', head: '머리', shoulder: '어깨', back: '등', effect: '효과' };

export interface PropDef {
  id: PropId;
  name: string;
  emoji: string;
  slot: PropSlot;
  /** How long one rental lasts. */
  minutes: number;
  /** Default stock released at each opening window (admins can change it). */
  stock: number;
  rare?: boolean;
  blurb: string;
}

export const PROPS: Record<PropId, PropDef> = {
  lantern: { id: 'lantern', name: '손등불', emoji: '🏮', slot: 'hand', minutes: 60, stock: 4, blurb: '밤길을 밝혀 주는 작은 등불' },
  guitar: { id: 'guitar', name: '기타', emoji: '🎸', slot: 'back', minutes: 60, stock: 2, blurb: '모닥불 통나무에 앉으면 연주해요' },
  bible: { id: 'bible', name: '성경책', emoji: '📖', slot: 'hand', minutes: 60, stock: 5, blurb: '광장 벤치에 앉으면 펼쳐 읽어요' },
  dove: { id: 'dove', name: '어깨 위 비둘기', emoji: '🕊️', slot: 'shoulder', minutes: 30, stock: 1, rare: true, blurb: '어깨에 앉아 함께 걸어요' },
  footprints: { id: 'footprints', name: '빛나는 발자국', emoji: '✨', slot: 'effect', minutes: 30, stock: 1, rare: true, blurb: '걸은 자리에 빛이 잠깐 남아요' },
  hat: { id: 'hat', name: '털모자', emoji: '🧣', slot: 'head', minutes: 60, stock: 4, blurb: '포근한 뜨개 모자' },
};

/** Rentals per account per KST day (early returns still count). */
export const SHOP_DAILY_LIMIT = 2;
/** Props worn at the same time (at most one per slot). */
export const SHOP_MAX_ACTIVE = 2;
/** The in-app toast and push reminder come this long before a rental ends. */
export const PROP_REMIND_MS = 10 * 60_000;
/** Stock an admin may set for one window. */
export const SHOP_STOCK_MAX = 99;

/** Opening windows (Asia/Seoul minutes of the day, end exclusive), the same every day. */
export const SHOP_WINDOWS: readonly { start: number; end: number }[] = [
  { start: 6 * 60, end: 9 * 60 },
  { start: 12 * 60, end: 15 * 60 },
  { start: 18 * 60, end: 23 * 60 },
];

/** Where the stall stands on the 중앙 광장 (behind the south-east bench, facing the basin). */
export const SHOP_STALL = (() => {
  const a = Math.PI / 4;
  const r = 9.1;
  const x = PLAZA.x + Math.cos(a) * r;
  const z = PLAZA.z + Math.sin(a) * r;
  return { x, z, yaw: Math.atan2(PLAZA.x - x, PLAZA.z - z), reach: 3.2 };
})();

export interface PropWear {
  item: PropId;
  slot: PropSlot;
}

const KST_MS = 9 * 3600_000;
const DAY_MS = 86_400_000;

/** YYYY-MM-DD in Korea for an instant (fixed +9 h; Korea has no daylight saving). */
export function kstDateOf(ms: number): string {
  return new Date(ms + KST_MS).toISOString().slice(0, 10);
}

/** "18:00" for a KST instant. */
export function kstTimeOf(ms: number): string {
  const d = new Date(ms + KST_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export interface ShopWindowInfo {
  open: boolean;
  /** KST date of the current (or, when closed, the next) window. */
  date: string;
  /** Current window index (0..2) while open, else null. */
  win: number | null;
  /** While open: when this window opened / closes. */
  opensAt: number | null;
  closesAt: number | null;
  /** The next opening after this window (or from now when closed). */
  nextOpenAt: number;
  nextWin: number;
}

/** Shop window state at an instant (server clock). */
export function shopWindowAt(ms: number): ShopWindowInfo {
  const midnight = Math.floor((ms + KST_MS) / DAY_MS) * DAY_MS - KST_MS;
  const date = kstDateOf(ms);
  let win: number | null = null;
  for (let i = 0; i < SHOP_WINDOWS.length; i++) {
    const w = SHOP_WINDOWS[i];
    if (ms >= midnight + w.start * 60_000 && ms < midnight + w.end * 60_000) win = i;
  }
  let nextWin = SHOP_WINDOWS.findIndex((w) => midnight + w.start * 60_000 > ms);
  let nextOpenAt: number;
  if (nextWin >= 0) nextOpenAt = midnight + SHOP_WINDOWS[nextWin].start * 60_000;
  else {
    nextWin = 0;
    nextOpenAt = midnight + DAY_MS + SHOP_WINDOWS[0].start * 60_000;
  }
  if (win === null) return { open: false, date: kstDateOf(nextOpenAt), win: null, opensAt: null, closesAt: null, nextOpenAt, nextWin };
  return {
    open: true,
    date,
    win,
    opensAt: midnight + SHOP_WINDOWS[win].start * 60_000,
    closesAt: midnight + SHOP_WINDOWS[win].end * 60_000,
    nextOpenAt,
    nextWin,
  };
}

export interface ShopStatus extends ShopWindowInfo {
  /** Server time when this was made (clients correct their clock offset with it). */
  now: number;
  /** This window's stock while open (empty when closed). */
  stock: Partial<Record<PropId, { remaining: number; total: number }>>;
}

export interface Rental {
  id: number;
  item: PropId;
  slot: PropSlot;
  startedAt: number;
  endsAt: number;
  status: 'active' | 'returned' | 'expired';
}

export interface MyShop {
  /** Active rentals only. */
  rentals: Rental[];
  usedToday: number;
  dailyLimit: number;
  now: number;
}

export const isPropId = (v: unknown): v is PropId => typeof v === 'string' && (PROP_IDS as readonly string[]).includes(v);

/** Props from the network: known items only, slot from our own table, one per slot, at most SHOP_MAX_ACTIVE. */
export function validProps(raw: unknown): PropWear[] {
  if (!Array.isArray(raw)) return [];
  const out: PropWear[] = [];
  for (const p of raw.slice(0, 8)) {
    const item = (p as { item?: unknown } | null)?.item;
    if (!isPropId(item)) continue;
    const slot = PROPS[item].slot;
    if (out.some((o) => o.slot === slot || o.item === item)) continue;
    out.push({ item, slot });
    if (out.length >= SHOP_MAX_ACTIVE) break;
  }
  return out;
}

// ------------------------------------------------------------------ 이야기 도서관: books (L-A)

/**
 * The library has two bookcases (2026-11-13): 🙏 하나님 이야기 holds every
 * testimony, 📔 일기 every diary. Testimonies written before kept a topic in
 * stories.shelf (first/answer/wilderness/thanks/word); it stays in the DB but
 * nothing reads it. New testimonies store 'story', diaries 'diary'.
 */
export const BOOKCASE_IDS = ['testimony', 'diary'] as const;
export type BookcaseId = (typeof BOOKCASE_IDS)[number];
export const BOOKCASES: Record<BookcaseId, { emoji: string; name: string; blurb: string }> = {
  testimony: { emoji: '🙏', name: '하나님 이야기', blurb: '하나님을 만난 이야기, 기도 응답, 감사를 직접 쓴 책' },
  diary: { emoji: '📔', name: '일기', blurb: 'QT 월드에서 보낸 하루가 날짜별로 꽂혀 있어요' },
};
/** How many books stand in each bookcase, as one viewer may see them. */
export type BookcaseCounts = Record<BookcaseId, number>;
export const isBookcaseId = (v: unknown): v is BookcaseId => typeof v === 'string' && (BOOKCASE_IDS as readonly string[]).includes(v);

/** The guided form: three questions instead of a blank page. */
export const STORY_PROMPTS = ['그때 어떤 상황이었나요?', '하나님을 어떻게 만났나요?', '지금 무엇이 달라졌나요?'] as const;
export const STORY_TITLE_MAX = 40;
/** All three answers together. */
export const STORY_BODY_MAX = 3000;
export const STORIES_PER_DAY = 5;
/** Diary: lines kept from the generated draft, each at most DIARY_LINE_MAX; plus ✏️ 오늘 한 줄. */
export const DIARY_LINES_MAX = 40;
export const DIARY_LINE_MAX = 200;
export const DIARY_NOTE_MAX = 300;
export const DIARY_PHOTOS_MAX = 4;

/** 공개 / 모임 / 익명 공개 / 나만. */
export const STORY_VISIBILITIES = ['public', 'group', 'anonymous', 'private'] as const;
export type StoryVisibility = (typeof STORY_VISIBILITIES)[number];
export const VISIBILITY_LABELS: Record<StoryVisibility, string> = { public: '공개', group: '모임', anonymous: '익명 공개', private: '나만' };

/** 💛 공감: one of each per reader, toggled. */
export const STORY_REACTIONS = ['grace', 'same', 'pray'] as const;
export type StoryReaction = (typeof STORY_REACTIONS)[number];
export const STORY_REACTION_LABELS: Record<StoryReaction, string> = { grace: '은혜받았어요', same: '저도 그랬어요', pray: '함께 기도해요' };

export const STORY_REPORT_REASONS = ['inappropriate', 'privacy', 'spam', 'other'] as const;
export type StoryReportReason = (typeof STORY_REPORT_REASONS)[number];
export const STORY_REPORT_LABELS: Record<StoryReportReason, string> = { inappropriate: '부적절함', privacy: '개인정보 노출', spam: '광고·도배', other: '기타' };
/** Distinct reporters that hide a book automatically. */
export const STORY_HIDE_REPORTS = 3;

/** 📸 In-world screenshots. */
export const SHOTS_PER_DAY = 10;
export const SHOT_MAX_DIM = 1280;
/** Hard upload limit (the client aims for < 150 KB). */
export const SHOT_MAX_BYTES = 400 * 1024;
/** 발자취 and unused screenshots are deleted after this many days. */
export const FOOTPRINT_KEEP_DAYS = 30;

/** Phone numbers, e-mail addresses and resident registration numbers: warn before publishing. */
const PERSONAL_PATTERNS: [string, RegExp][] = [
  ['전화번호', /(?:^|[^\d])(?:01[016789]|0[2-6]\d?)[\s.-]?\d{3,4}[\s.-]?\d{4}(?!\d)/],
  ['이메일', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['주민등록번호', /(?:^|[^\d])\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[\s-]?[1-8]\d{6}(?!\d)/],
];
export function personalInfoKinds(text: string): string[] {
  return PERSONAL_PATTERNS.filter(([, re]) => re.test(text)).map(([k]) => k);
}

/** A diary line's source: the template key (e.g. 'letter', 'lantern:pray', 'shot') and minute of the day (1440 = the whole day). */
export interface DiaryLineMeta {
  key: string;
  minute: number;
}

/** One book in a list (never the author's account id; anonymous books never carry the nickname). */
export interface StoryItem {
  id: number;
  kind: 'testimony' | 'diary';
  title: string;
  excerpt: string;
  /** Display name: the nickname, or ANONYMOUS_NAME for anonymous books (except to their author). */
  author: string;
  visibility: StoryVisibility;
  /** Group name for 모임 books. */
  group: string | null;
  /** Diary date (KST) or the day it was written. */
  date: string;
  createdAt: string;
  updatedAt: string;
  reactions: Record<StoryReaction, number>;
  readers: number;
  /** This viewer has opened it before. */
  read: boolean;
  bookmarked: boolean;
  mine: boolean;
  /** Hidden after reports (only its author and admins see it). */
  hidden: boolean;
  photos: number;
}

export interface StoryDetail extends StoryItem {
  /** Testimony: the three answers (STORY_PROMPTS order). Diary: its lines. */
  parts: string[];
  /** Diary: ✏️ 오늘 한 줄. */
  note: string;
  /** Bible reference (testimony: optional; diary: the day's word) and its text. */
  ref: string | null;
  verse: string | null;
  /** Screenshot ids shown inline (diary). */
  photoIds: number[];
  /** Diary: per line (same order as parts) the template it came from and its minute of the day (KST), or null for lines without one. */
  lineMeta: (DiaryLineMeta | null)[] | null;
  myReactions: StoryReaction[];
  /** Testimony: author-only group id (for editing). */
  groupId: number | null;
}

// ------------------------------------------------------------------ 이야기 도서관: ✉️ 답장 편지 (L-B)

export const LETTER_MAX = 300;
/** Replies under one letter (book author ↔ letter writer, taking turns). */
export const LETTER_REPLIES_MAX = 20;
/** Per user per hour (overridable on the server with LETTER_RATE_LIMIT / LETTER_REPLY_RATE_LIMIT). */
export const LETTERS_PER_HOUR = 20;
export const LETTER_REPLIES_PER_HOUR = 60;
/** What an anonymous book's author is called in letter threads (never the nickname). */
export const BOOK_AUTHOR_NAME = '글쓴이';

/** One letter or reply as a viewer sees it (no account ids; masked names). */
export interface LetterMessage {
  id: number;
  /** '' when deleted (or hidden from this viewer). */
  text: string;
  /** Nickname, ANONYMOUS_NAME (anonymous letter writer) or BOOK_AUTHOR_NAME (anonymous book's author). */
  author: string;
  /** Who wrote it in this thread: the book's author or the letter's writer. */
  role: 'author' | 'writer';
  mine: boolean;
  createdAt: string;
  deleted: boolean;
  /** Hidden after reports (only its writer and admins still see the text). */
  reported: boolean;
}

export interface LetterThread extends LetterMessage {
  /** Sent with 익명으로 보내기. */
  anonymous: boolean;
  /** The book's author hid this letter (others don't see it any more). */
  hiddenByAuthor: boolean;
  replies: LetterMessage[];
  /** This viewer may answer now (a party, their turn, under the cap). */
  canReply: boolean;
  /** Why not (shown under the thread), e.g. waiting for the other person. */
  replyNote: string | null;
  /** This viewer is the book's author (may hide it). */
  canHide: boolean;
  /** Messages in this thread this viewer hasn't seen. */
  unread: number;
}

export interface LettersOfBook {
  storyId: number;
  /** Letters others can see (not deleted/hidden). */
  count: number;
  /** May this viewer write a new letter here, and if not why. */
  canWrite: boolean;
  note: string | null;
  letters: LetterThread[];
}

/** One conversation in 📬 받은 편지. */
export interface InboxItem {
  letterId: number;
  storyId: number;
  storyTitle: string;
  storyKind: 'testimony' | 'diary';
  /** My side: 'author' = a letter on my book; 'writer' = my letter on someone's book. */
  role: 'author' | 'writer';
  /** Display name of whoever wrote the newest message (masked like the thread). */
  from: string;
  excerpt: string;
  lastAt: string;
  messages: number;
  unread: number;
}

