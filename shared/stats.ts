// 운영자 통계 (/admin): the response shapes of the admin-only stats API.
// Aggregates only (counts, ratios, histograms). Nothing here may ever carry text,
// titles, nicknames, emails, account ids, IPs or a per-user row.

/** Activity counters shown under 나눔 활동 (daily_counts keys). */
export const ACTIVITY_KEYS = [
  'meditation',
  'lantern_public',
  'lantern_group',
  'lantern_anon',
  'testimony',
  'diary',
  'letter',
  'reply',
  'chat_campfire',
  'chat_group',
  'react_pray',
  'react_empathy',
  'emote',
  'voice_campfire',
  'voice_group',
  'rental',
] as const;
export type ActivityKey = (typeof ACTIVITY_KEYS)[number];

export type DeviceClass = 'phone' | 'tablet' | 'desktop';
export const DEVICE_CLASSES: readonly DeviceClass[] = ['phone', 'tablet', 'desktop'];

/** One retention cell: share of the eligible members active on day N after sign-up. */
export interface RetentionCell {
  /** Members whose day N is already over (yesterday or earlier). 0 = 데이터 수집 중. */
  eligible: number;
  active: number;
  /** Fewer than the whole cohort could be measured yet. */
  partial: boolean;
  /** Some of the measured days fall before collection began (backfilled from older records). */
  estimated: boolean;
}

export interface CohortRow {
  /** Monday (KST) of the sign-up week, YYYY-MM-DD. */
  week: string;
  size: number;
  d1: RetentionCell;
  d7: RetentionCell;
  d30: RetentionCell;
}

export interface FunnelStep {
  key: 'signup' | 'entry' | 'letter' | 'meditation' | 'lantern';
  n: number;
}

export interface AdminStats {
  generatedAt: number;
  today: string;
  /** First day of real collection; earlier numbers are best-effort backfills. */
  collectStart: string;
  /** Oldest to newest, 90 days ending today. */
  days: string[];
  visits: {
    dau: number[];
    wau: number[];
    mau: number[];
    signups: number[];
    guestSessions: number[];
    sessions: number[];
  };
  retention: {
    cohorts: CohortRow[];
    /** Sign-ups in the last 30 days. */
    overall: { d1: RetentionCell; d7: RetentionCell; d30: RetentionCell; signups: number };
  };
  funnel: {
    /** Accounts that finished sign-up in the window (older than 24 h, so the first day is complete). */
    windowDays: number;
    steps: FunnelStep[];
    /** Sign-ups from the last 24 h, not yet counted. */
    pending: number;
    /** Some milestones of accounts from before collection began were backfilled. */
    estimated: boolean;
  };
  activity: Record<ActivityKey, number[]>;
  together: {
    /** [weekday 0=월 .. 6=일][hour 0..23], over the last 8 weeks. null = no samples. */
    avg: (number | null)[][];
    max: (number | null)[][];
    peak: { players: number; date: string | null; hour: number | null };
    online: number;
    weeks: number;
  };
  devices: {
    /** Sessions over the last 30 days by device class. */
    mix: Record<DeviceClass, number>;
    pwa: { standalone: number; browser: number };
    pushUsers: number;
    /** Accounts with push on, by notification type switched on. */
    pushTypes: Record<string, number>;
  };
  pending: {
    outfits: number;
    books: number;
    letters: number;
    /** People reported at the campfire in the last 30 days, and active mutes. */
    voiceReported: number;
    voiceMuted: number;
  };
}

export interface AdminSystem {
  generatedAt: number;
  uptimeS: number;
  dbBytes: number;
  backups: { count: number; lastAt: number | null };
  weather: { kind: string; updatedAt: number; stale: boolean } | null;
  node: string;
}
