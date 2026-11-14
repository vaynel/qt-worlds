import { existsSync, readdirSync, statSync } from 'node:fs';
import { kstDateOf } from '../../shared/protocol.js';
import {
  ACTIVITY_KEYS,
  DEVICE_CLASSES,
  type ActivityKey,
  type AdminStats,
  type AdminSystem,
  type CohortRow,
  type DeviceClass,
  type FunnelStep,
  type RetentionCell,
} from '../../shared/stats.js';
import type { DB } from './db.js';

const DAY_MS = 86_400_000;
/** active_days and concurrency are kept 13 months (about 396 days). */
export const STATS_KEEP_DAYS = 396;
/** Charts cover the last 90 days. */
export const STATS_DAYS = 90;
const CACHE_MS = 60_000;
/** A manual refresh (?fresh=1) may recompute at most this often. */
const FRESH_MIN_MS = 5_000;
const COHORT_WEEKS = 12;
const HEATMAP_WEEKS = 8;
const FUNNEL_DAYS = 30;

export type Milestone = 'first_entry_at' | 'first_letter_at' | 'first_meditation_at' | 'first_lantern_at';
const MILESTONES: readonly Milestone[] = ['first_entry_at', 'first_letter_at', 'first_meditation_at', 'first_lantern_at'];

// ------------------------------------------------------------------ pure maths (unit-tested)

/** 'YYYY-MM-DD' plus n days. */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Monday of that date's week. */
export function mondayOf(date: string): string {
  const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday
  return addDays(date, -dow);
}

/** Days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** Inclusive list of dates ending at `last`. */
export function dateRange(last: string, count: number): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(addDays(last, -i));
  return out;
}

/**
 * DAU / WAU / MAU for every day in `days` (ascending): distinct accounts active on
 * that day, in the 7 days ending that day and in the 30 days ending that day.
 * `days` must be consecutive; `rows` must also cover the 29 days before days[0] for MAU to be complete.
 */
export function rollingActive(rows: { user_id: number; kst_date: string }[], days: string[]): { dau: number[]; wau: number[]; mau: number[] } {
  const byDay = new Map<string, number[]>();
  for (const r of rows) {
    const list = byDay.get(r.kst_date);
    if (list) list.push(r.user_id);
    else byDay.set(r.kst_date, [r.user_id]);
  }
  const windowCount = (len: number) => {
    const counts = new Map<number, number>();
    const add = (date: string, d: number) => {
      for (const u of byDay.get(date) ?? []) {
        const n = (counts.get(u) ?? 0) + d;
        if (n <= 0) counts.delete(u);
        else counts.set(u, n);
      }
    };
    const out: number[] = [];
    if (!days.length) return out;
    for (let i = len - 1; i >= 1; i--) add(addDays(days[0], -i), 1);
    for (const day of days) {
      add(day, 1);
      out.push(counts.size);
      add(addDays(day, -(len - 1)), -1);
    }
    return out;
  };
  return { dau: days.map((d) => new Set(byDay.get(d) ?? []).size), wau: windowCount(7), mau: windowCount(30) };
}

export interface CohortMember {
  /** KST sign-up date. */
  signup: string;
  /** KST dates this account was active. */
  active: Set<string>;
}

/**
 * Classic N-day retention: of the members whose day N (signup + N) is already over
 * (day N <= lastComplete), how many were active exactly on day N.
 */
export function retentionCell(members: CohortMember[], n: number, lastComplete: string, collectStart: string): RetentionCell {
  let eligible = 0;
  let active = 0;
  let estimated = false;
  for (const m of members) {
    const target = addDays(m.signup, n);
    if (target > lastComplete) continue;
    eligible++;
    if (m.active.has(target)) active++;
    if (target < collectStart) estimated = true;
  }
  return { eligible, active, partial: eligible > 0 && eligible < members.length, estimated };
}

/** Weekly sign-up cohorts (Monday weeks), newest first, the last `weeks` weeks including this one. */
export function weeklyCohorts(members: CohortMember[], today: string, collectStart: string, weeks = COHORT_WEEKS): CohortRow[] {
  const lastComplete = addDays(today, -1);
  const thisWeek = mondayOf(today);
  const out: CohortRow[] = [];
  for (let w = 0; w < weeks; w++) {
    const week = addDays(thisWeek, -7 * w);
    const end = addDays(week, 6);
    const group = members.filter((m) => m.signup >= week && m.signup <= end);
    out.push({
      week,
      size: group.length,
      d1: retentionCell(group, 1, lastComplete, collectStart),
      d7: retentionCell(group, 7, lastComplete, collectStart),
      d30: retentionCell(group, 30, lastComplete, collectStart),
    });
  }
  return out;
}

export interface FunnelAccount {
  created_at: number;
  first_entry_at: number | null;
  first_letter_at: number | null;
  first_meditation_at: number | null;
  first_lantern_at: number | null;
}

/**
 * 첫날 흐름: accounts created between `from` and now - 24 h. Step k counts an account
 * when every milestone up to k happened within 24 h of sign-up (so the bars never grow).
 */
export function firstDayFunnel(accounts: FunnelAccount[], now: number, windowDays = FUNNEL_DAYS): { steps: FunnelStep[]; pending: number } {
  const from = now - windowDays * DAY_MS;
  const keys: FunnelStep['key'][] = ['signup', 'entry', 'letter', 'meditation', 'lantern'];
  const counts = [0, 0, 0, 0, 0];
  let pending = 0;
  for (const a of accounts) {
    if (a.created_at < from || a.created_at > now) continue;
    if (a.created_at > now - DAY_MS) {
      pending++;
      continue;
    }
    counts[0]++;
    const within = (t: number | null) => t !== null && t <= a.created_at + DAY_MS;
    const ms = [a.first_entry_at, a.first_letter_at, a.first_meditation_at, a.first_lantern_at];
    for (let k = 0; k < ms.length; k++) {
      if (!within(ms[k])) break;
      counts[k + 1]++;
    }
  }
  return { steps: keys.map((key, i) => ({ key, n: counts[i] })), pending };
}

/** Only these device classes are ever counted (the client sends a coarse class, never a user agent). */
export function deviceClass(raw: unknown): DeviceClass | null {
  return typeof raw === 'string' && (DEVICE_CLASSES as readonly string[]).includes(raw) ? (raw as DeviceClass) : null;
}

// ------------------------------------------------------------------ service

export interface StatsDeps {
  online: () => number;
  weather?: () => { kind: string; updatedAt: number; stale?: boolean } | null;
  dbPath?: string;
  backupDir?: string;
}

/**
 * 운영자 통계: records aggregate counters, the KST dates signed-in accounts were
 * active, first-time milestones and sampled concurrency, and answers the admin
 * dashboard with aggregates only.
 */
export class StatsService {
  now: () => number = () => Date.now();
  private readonly seen = new Set<string>();
  private seenDay = '';
  private cache: { at: number; body: AdminStats } | null = null;
  private deps: StatsDeps = { online: () => 0 };

  constructor(private readonly db: DB) {}

  attach(deps: StatsDeps) {
    this.deps = deps;
  }

  get collectStart(): string {
    const row = this.db.prepare("SELECT value FROM stats_meta WHERE key = 'collect_start'").get() as { value: string } | undefined;
    return row?.value ?? kstDateOf(this.now());
  }

  /** Add to one daily counter. */
  bump(key: string, n = 1, at = this.now()) {
    if (n <= 0) return;
    this.db
      .prepare('INSERT INTO daily_counts (kst_date, key, n) VALUES (?, ?, ?) ON CONFLICT (kst_date, key) DO UPDATE SET n = n + excluded.n')
      .run(kstDateOf(at), key, Math.floor(n));
  }

  /** In-memory "already written today" check, so per-request calls cost nothing after the first. */
  private once(key: string, at: number): boolean {
    const day = kstDateOf(at);
    if (day !== this.seenDay) {
      this.seen.clear();
      this.seenDay = day;
    }
    if (this.seen.has(key)) return false;
    if (this.seen.size > 50_000) this.seen.clear();
    this.seen.add(key);
    return true;
  }

  /** This account used the app on this KST day (idempotent). Returns whether a row was added. */
  markActive(userId: number, at = this.now()): boolean {
    const date = kstDateOf(at);
    if (!this.once(`a:${userId}:${date}`, at)) return false;
    return this.db.prepare('INSERT OR IGNORE INTO active_days (user_id, kst_date) VALUES (?, ?)').run(userId, date).changes > 0;
  }

  /** 회원 탈퇴: drop the in-memory marks (the rows go with the account). */
  forget(userId: number) {
    for (const k of this.seen) if (k.startsWith(`a:${userId}:`) || k.endsWith(`:${userId}`)) this.seen.delete(k);
  }

  /** First time this account reached a milestone (kept only once). */
  milestone(userId: number, which: Milestone, at = this.now()) {
    if (!MILESTONES.includes(which)) return;
    if (!this.once(`m:${which}:${userId}`, at)) return;
    this.db.prepare(`UPDATE users SET ${which} = ? WHERE id = ? AND ${which} IS NULL`).run(at, userId);
  }

  /** Whether 📔 today's diary already exists (publishing again replaces it: not a new diary). */
  hasDiary(userId: number, date: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM stories WHERE user_id = ? AND kind = 'diary' AND kst_date = ?").get(userId, date);
  }

  /** A fresh session (not a reconnect) began: only aggregate counters, never an identifier. */
  session(opts: { guest: boolean; device: DeviceClass | null; standalone: boolean | null }, at = this.now()) {
    this.bump('session_total', 1, at);
    if (opts.guest) this.bump('session_guest', 1, at);
    if (opts.device) this.bump(`device_${opts.device}`, 1, at);
    if (opts.standalone !== null) this.bump(opts.standalone ? 'pwa_standalone' : 'pwa_browser', 1, at);
  }

  /** One concurrency sample (every 5 minutes): players now and the peak since the last sample. */
  sample(players: number, peak: number, at = this.now()) {
    const date = kstDateOf(at);
    const hour = Math.floor(((at + 9 * 3600_000) % DAY_MS) / 3600_000);
    this.db
      .prepare(
        `INSERT INTO concurrency (kst_date, hour, samples, total, peak) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT (kst_date, hour) DO UPDATE SET samples = samples + 1, total = total + excluded.total, peak = MAX(peak, excluded.peak)`,
      )
      .run(date, hour, Math.max(0, players), Math.max(players, peak, 0));
  }

  /** Hourly 파기: active days and concurrency older than 13 months. */
  sweep(at = this.now()): number {
    const cutoff = kstDateOf(at - STATS_KEEP_DAYS * DAY_MS);
    const a = this.db.prepare('DELETE FROM active_days WHERE kst_date < ?').run(cutoff).changes;
    const c = this.db.prepare('DELETE FROM concurrency WHERE kst_date < ?').run(cutoff).changes;
    return a + c;
  }

  /** 내 데이터 내려받기: the dates this account was active, and its first-time milestones. */
  export(userId: number) {
    const days = (this.db.prepare('SELECT kst_date FROM active_days WHERE user_id = ? ORDER BY kst_date').all(userId) as { kst_date: string }[]).map((r) => r.kst_date);
    const m = this.db.prepare(`SELECT ${MILESTONES.join(', ')} FROM users WHERE id = ?`).get(userId) as Record<Milestone, number | null> | undefined;
    const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null);
    return {
      activeDays: days,
      firstTimes: {
        worldEntry: iso(m?.first_entry_at),
        letterOpened: iso(m?.first_letter_at),
        meditationSaved: iso(m?.first_meditation_at),
        lanternShared: iso(m?.first_lantern_at),
      },
      keepDays: STATS_KEEP_DAYS,
    };
  }

  // ---------------------------------------------------------------- dashboard

  overview(fresh = false): AdminStats {
    const now = this.now();
    const age = this.cache ? now - this.cache.at : Infinity;
    if (this.cache && (age < (fresh ? FRESH_MIN_MS : CACHE_MS))) return this.cache.body;
    const body = this.compute(now);
    this.cache = { at: now, body };
    return body;
  }

  private compute(now: number): AdminStats {
    const today = kstDateOf(now);
    const days = dateRange(today, STATS_DAYS);
    const first = days[0];
    const collectStart = this.collectStart;
    const index = new Map(days.map((d, i) => [d, i]));
    const series = () => days.map(() => 0);

    // 방문: DAU/WAU/MAU from active_days (index on kst_date), sign-ups from users.created_at.
    const activeRows = this.db.prepare('SELECT user_id, kst_date FROM active_days WHERE kst_date >= ? AND kst_date <= ?').all(addDays(first, -29), today) as {
      user_id: number;
      kst_date: string;
    }[];
    const rolling = rollingActive(activeRows, days);
    const fromMs = Date.parse(`${first}T00:00:00Z`) - 9 * 3600_000;
    const signups = series();
    for (const r of this.db.prepare('SELECT created_at FROM users WHERE nickname IS NOT NULL AND created_at >= ?').all(fromMs) as { created_at: number }[]) {
      const i = index.get(kstDateOf(r.created_at));
      if (i !== undefined) signups[i]++;
    }

    // Counters.
    const counters = new Map<string, number[]>();
    for (const r of this.db.prepare('SELECT kst_date, key, n FROM daily_counts WHERE kst_date >= ? AND kst_date <= ?').all(first, today) as {
      kst_date: string;
      key: string;
      n: number;
    }[]) {
      const i = index.get(r.kst_date);
      if (i === undefined) continue;
      let s = counters.get(r.key);
      if (!s) counters.set(r.key, (s = series()));
      s[i] += r.n;
    }
    const counter = (k: string) => counters.get(k) ?? series();
    const sumLast = (k: string, n: number) => counter(k).slice(-n).reduce((a, b) => a + b, 0);

    // 재방문: members who signed up in the cohort window, with their active days since sign-up.
    const cohortStart = addDays(mondayOf(today), -7 * (COHORT_WEEKS - 1));
    const cohortFromMs = Date.parse(`${cohortStart}T00:00:00Z`) - 9 * 3600_000;
    const memberRows = this.db.prepare('SELECT id, created_at FROM users WHERE nickname IS NOT NULL AND created_at >= ?').all(cohortFromMs) as {
      id: number;
      created_at: number;
    }[];
    const actByUser = new Map<number, Set<string>>();
    if (memberRows.length) {
      const q = this.db.prepare('SELECT kst_date FROM active_days WHERE user_id = ? AND kst_date >= ?');
      for (const m of memberRows) actByUser.set(m.id, new Set((q.all(m.id, cohortStart) as { kst_date: string }[]).map((r) => r.kst_date)));
    }
    const members: (CohortMember & { created_at: number })[] = memberRows.map((m) => ({
      signup: kstDateOf(m.created_at),
      active: actByUser.get(m.id) ?? new Set(),
      created_at: m.created_at,
    }));
    const recent = members.filter((m) => m.signup >= addDays(today, -29));
    const lastComplete = addDays(today, -1);

    // 첫날 흐름.
    const funnelRows = this.db
      .prepare(`SELECT created_at, ${MILESTONES.join(', ')} FROM users WHERE nickname IS NOT NULL AND created_at >= ?`)
      .all(now - FUNNEL_DAYS * DAY_MS) as FunnelAccount[];
    const funnel = firstDayFunnel(funnelRows, now, FUNNEL_DAYS);
    const collectMs = Date.parse(`${collectStart}T00:00:00Z`) - 9 * 3600_000;

    // 함께하기: weekday × hour over the last 8 weeks.
    const heatFrom = addDays(today, -7 * HEATMAP_WEEKS + 1);
    const sum = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    const cnt = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    const mx: (number | null)[][] = Array.from({ length: 7 }, () => Array<number | null>(24).fill(null));
    for (const r of this.db.prepare('SELECT kst_date, hour, samples, total, peak FROM concurrency WHERE kst_date >= ?').all(heatFrom) as {
      kst_date: string;
      hour: number;
      samples: number;
      total: number;
      peak: number;
    }[]) {
      const wd = (new Date(`${r.kst_date}T00:00:00Z`).getUTCDay() + 6) % 7;
      sum[wd][r.hour] += r.total;
      cnt[wd][r.hour] += r.samples;
      mx[wd][r.hour] = Math.max(mx[wd][r.hour] ?? 0, r.peak);
    }
    const avg = sum.map((row, wd) => row.map((s, h) => (cnt[wd][h] ? Math.round((s / cnt[wd][h]) * 10) / 10 : null)));
    const peakRow = this.db.prepare('SELECT kst_date, hour, peak FROM concurrency ORDER BY peak DESC, kst_date DESC LIMIT 1').get() as
      | { kst_date: string; hour: number; peak: number }
      | undefined;

    // 기기·앱 (last 30 days of sessions).
    const mix = Object.fromEntries(DEVICE_CLASSES.map((d) => [d, sumLast(`device_${d}`, 30)])) as Record<DeviceClass, number>;
    const pushUsers = (this.db.prepare('SELECT COUNT(DISTINCT user_id) n FROM push_subscriptions').get() as { n: number }).n;
    const pt = this.db
      .prepare(
        `SELECT SUM(COALESCE(p.daily, 1)) daily, SUM(COALESCE(p.prayer, 1)) prayer, SUM(COALESCE(p.props, 1)) props,
                SUM(COALESCE(p.library, 1)) library, SUM(COALESCE(p.letters, 1)) letters, SUM(COALESCE(p.replies, 1)) replies,
                SUM(COALESCE(p.diary, 0)) diary
         FROM (SELECT DISTINCT user_id FROM push_subscriptions) s LEFT JOIN push_prefs p ON p.user_id = s.user_id`,
      )
      .get() as Record<string, number | null>;
    const pushTypes = Object.fromEntries(Object.entries(pt).map(([k, v]) => [k, v ?? 0]));

    // 관리 대기.
    const count = (sql: string, ...args: unknown[]) => (this.db.prepare(sql).get(...args) as { n: number }).n;
    const pending = {
      outfits: count(
        'SELECT COUNT(*) n FROM outfits o WHERE o.review IS NULL AND (o.hidden_at IS NOT NULL OR EXISTS (SELECT 1 FROM outfit_reports r WHERE r.outfit_id = o.id))',
      ),
      books: count(
        'SELECT COUNT(*) n FROM stories s WHERE s.review IS NULL AND (s.hidden_at IS NOT NULL OR EXISTS (SELECT 1 FROM story_reports r WHERE r.story_id = s.id))',
      ),
      letters: count(
        'SELECT COUNT(*) n FROM story_letters l WHERE l.review IS NULL AND l.deleted_at IS NULL AND (l.hidden_at IS NOT NULL OR EXISTS (SELECT 1 FROM letter_reports r WHERE r.letter_id = l.id))',
      ),
      voiceReported: count('SELECT COUNT(DISTINCT target_id) n FROM voice_reports WHERE created_at > ?', now - 30 * DAY_MS),
      voiceMuted: count('SELECT COUNT(DISTINCT user_id) n FROM voice_sanctions WHERE lifted_at IS NULL AND until > ?', now),
    };

    return {
      generatedAt: now,
      today,
      collectStart,
      days,
      visits: { ...rolling, signups, guestSessions: counter('session_guest'), sessions: counter('session_total') },
      retention: {
        cohorts: weeklyCohorts(members, today, collectStart),
        overall: {
          d1: retentionCell(recent, 1, lastComplete, collectStart),
          d7: retentionCell(recent, 7, lastComplete, collectStart),
          d30: retentionCell(recent, 30, lastComplete, collectStart),
          signups: recent.length,
        },
      },
      funnel: { windowDays: FUNNEL_DAYS, steps: funnel.steps, pending: funnel.pending, estimated: funnelRows.some((r) => r.created_at < collectMs) },
      activity: Object.fromEntries(ACTIVITY_KEYS.map((k) => [k, counter(k)])) as Record<ActivityKey, number[]>,
      together: {
        avg,
        max: mx,
        peak: { players: peakRow?.peak ?? 0, date: peakRow?.kst_date ?? null, hour: peakRow?.hour ?? null },
        online: this.deps.online(),
        weeks: HEATMAP_WEEKS,
      },
      devices: { mix, pwa: { standalone: sumLast('pwa_standalone', 30), browser: sumLast('pwa_browser', 30) }, pushUsers, pushTypes },
      pending,
    };
  }

  system(): AdminSystem {
    const now = this.now();
    let dbBytes = 0;
    try {
      const pages = this.db.pragma('page_count', { simple: true }) as number;
      const size = this.db.pragma('page_size', { simple: true }) as number;
      dbBytes = pages * size;
      if (this.deps.dbPath && existsSync(`${this.deps.dbPath}-wal`)) dbBytes += statSync(`${this.deps.dbPath}-wal`).size;
    } catch {
      /* in-memory DB */
    }
    let count = 0;
    let lastAt: number | null = null;
    const dir = this.deps.backupDir;
    if (dir && existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!/^worlds-\d{8}-\d{6}\.db$/.test(f)) continue;
        count++;
        const t = statSync(`${dir}/${f}`).mtimeMs;
        if (lastAt === null || t > lastAt) lastAt = Math.round(t);
      }
    }
    const w = this.deps.weather?.() ?? null;
    return {
      generatedAt: now,
      uptimeS: Math.round(process.uptime()),
      dbBytes,
      backups: { count, lastAt },
      weather: w ? { kind: w.kind, updatedAt: w.updatedAt, stale: !!w.stale } : null,
      node: process.version,
    };
  }
}

