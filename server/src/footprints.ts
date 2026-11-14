import { FOOTPRINT_KEEP_DAYS, kstDateOf, TERMS_VERSION } from '../../shared/protocol.js';
import type { DB } from './db.js';

const DAY_MS = 86_400_000;
const KST_MS = 9 * 3600_000;

/** Discrete things that happened (each with a stable idempotency key). */
export type FootprintType = 'letter' | 'meditation' | 'lantern_read' | 'lantern_react' | 'sit' | 'rent' | 'story_read' | 'shot' | 'library' | 'emote';
/** Time spent, counted per KST minute (a reconnect or a second tab never counts twice). */
export type MinuteKind = 'play' | 'pray' | 'fire' | 'voice' | 'library';

export interface FootprintEvent {
  type: FootprintType;
  /** Minute of the KST day (0..1439). */
  minute: number;
  at: number;
  payload: Record<string, unknown>;
}
export interface FootprintMinute {
  kind: MinuteKind;
  minute: number;
  /** Extra count (campfire: how many others were there). */
  n: number;
}

export const minuteOfDay = (ms: number) => Math.floor(((ms + KST_MS) % DAY_MS) / 60_000);

/**
 * 발자취: a private, per-user activity log the auto diary is written from.
 * Only the account itself ever reads it. Recording can be switched off; a
 * day's records are kept while a published diary of that day exists,
 * otherwise deleted after FOOTPRINT_KEEP_DAYS (hourly sweep).
 */
export class FootprintService {
  now: () => number = () => Date.now();
  private readonly offCache = new Map<number, boolean>();

  constructor(private readonly db: DB) {}

  enabled(userId: number): boolean {
    let off = this.offCache.get(userId);
    if (off === undefined) {
      // Off when switched off, and until the account agreed to the terms that introduced 발자취.
      const row = this.db.prepare('SELECT footprints_off, terms_agreed_at, terms_version FROM users WHERE id = ?').get(userId) as
        | { footprints_off: number; terms_agreed_at: number | null; terms_version: string | null }
        | undefined;
      off = !row || row.footprints_off === 1 || row.terms_agreed_at === null || row.terms_version !== TERMS_VERSION;
      if (this.offCache.size > 5000) this.offCache.clear();
      this.offCache.set(userId, off);
    }
    return !off;
  }

  /** Whether the account itself switched recording off (the settings toggle). */
  switchedOff(userId: number): boolean {
    const row = this.db.prepare('SELECT footprints_off FROM users WHERE id = ?').get(userId) as { footprints_off: number } | undefined;
    return !row || row.footprints_off === 1;
  }

  setEnabled(userId: number, on: boolean) {
    this.db.prepare('UPDATE users SET footprints_off = ? WHERE id = ?').run(on ? 0 : 1, userId);
    this.offCache.delete(userId);
  }

  forget(userId: number) {
    this.offCache.delete(userId);
  }

  /** Record one event once (same key = same event, e.g. after a reconnect). Returns whether it was new. */
  event(userId: number, type: FootprintType, key: string, payload: Record<string, unknown> = {}, at = this.now()): boolean {
    if (!this.enabled(userId)) return false;
    const r = this.db
      .prepare('INSERT OR IGNORE INTO footprints (user_id, kst_date, type, at, key, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, kstDateOf(at), type, at, `${type}:${key}`, JSON.stringify(payload).slice(0, 600));
    return r.changes > 0;
  }

  /** Take one event back (a deleted photo is no longer part of the day). */
  forgetEvent(userId: number, type: FootprintType, key: string) {
    this.db.prepare('DELETE FROM footprints WHERE user_id = ? AND key = ?').run(userId, `${type}:${key}`);
  }

  /** This minute counts as `kind` (idempotent per user, day, kind and minute). */
  minute(userId: number, kind: MinuteKind, n = 0, at = this.now()) {
    if (!this.enabled(userId)) return;
    this.db
      .prepare(
        `INSERT INTO footprint_minutes (user_id, kst_date, kind, minute, n) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, kst_date, kind, minute) DO UPDATE SET n = MAX(n, excluded.n)`,
      )
      .run(userId, kstDateOf(at), kind, minuteOfDay(at), Math.max(0, Math.min(999, Math.floor(n))));
  }

  day(userId: number, date: string): { events: FootprintEvent[]; minutes: FootprintMinute[] } {
    const events = (
      this.db.prepare('SELECT type, at, payload FROM footprints WHERE user_id = ? AND kst_date = ? ORDER BY at, id').all(userId, date) as {
        type: FootprintType;
        at: number;
        payload: string;
      }[]
    ).map((e) => ({ type: e.type, at: e.at, minute: minuteOfDay(e.at), payload: JSON.parse(e.payload) as Record<string, unknown> }));
    const minutes = this.db
      .prepare('SELECT kind, minute, n FROM footprint_minutes WHERE user_id = ? AND kst_date = ? ORDER BY minute')
      .all(userId, date) as FootprintMinute[];
    return { events, minutes };
  }

  /** What 발자취 holds for one day (settings page). */
  summary(userId: number, date: string) {
    const events = (this.db.prepare('SELECT COUNT(*) n FROM footprints WHERE user_id = ? AND kst_date = ?').get(userId, date) as { n: number }).n;
    const rows = this.db.prepare('SELECT kind, COUNT(*) n FROM footprint_minutes WHERE user_id = ? AND kst_date = ? GROUP BY kind').all(userId, date) as {
      kind: MinuteKind;
      n: number;
    }[];
    return { date, enabled: !this.switchedOff(userId), recording: this.enabled(userId), events, minutes: Object.fromEntries(rows.map((r) => [r.kind, r.n])) as Partial<Record<MinuteKind, number>> };
  }

  /** 오늘 기록 지우기. */
  clearDay(userId: number, date: string): number {
    return this.db.transaction(() => {
      const a = this.db.prepare('DELETE FROM footprints WHERE user_id = ? AND kst_date = ?').run(userId, date).changes;
      const b = this.db.prepare('DELETE FROM footprint_minutes WHERE user_id = ? AND kst_date = ?').run(userId, date).changes;
      return a + b;
    })();
  }

  /** Hourly 파기: days older than FOOTPRINT_KEEP_DAYS without a published diary of that day. */
  sweep(now = this.now()): number {
    const cutoff = kstDateOf(now - FOOTPRINT_KEEP_DAYS * DAY_MS);
    const keep = `NOT EXISTS (SELECT 1 FROM stories s WHERE s.kind = 'diary' AND s.user_id = t.user_id AND s.kst_date = t.kst_date)`;
    const a = this.db.prepare(`DELETE FROM footprints AS t WHERE t.kst_date < ? AND ${keep}`).run(cutoff).changes;
    const b = this.db.prepare(`DELETE FROM footprint_minutes AS t WHERE t.kst_date < ? AND ${keep}`).run(cutoff).changes;
    return a + b;
  }

  export(userId: number) {
    const events = this.db.prepare('SELECT kst_date, type, at, payload FROM footprints WHERE user_id = ? ORDER BY at').all(userId) as {
      kst_date: string;
      type: string;
      at: number;
      payload: string;
    }[];
    const minutes = this.db
      .prepare('SELECT kst_date, kind, COUNT(*) AS minutes, MIN(minute) AS first, MAX(minute) AS last FROM footprint_minutes WHERE user_id = ? GROUP BY kst_date, kind ORDER BY kst_date, kind')
      .all(userId) as { kst_date: string; kind: string; minutes: number; first: number; last: number }[];
    const all = this.db.prepare('SELECT kst_date, kind, minute, n FROM footprint_minutes WHERE user_id = ? ORDER BY kst_date, kind, minute').all(userId);
    return {
      enabled: this.enabled(userId),
      events: events.map((e) => ({ date: e.kst_date, type: e.type, at: new Date(e.at).toISOString(), ...(JSON.parse(e.payload) as object) })),
      minutesByDay: minutes.map((m) => ({ date: m.kst_date, kind: m.kind, minutes: m.minutes })),
      minuteRecords: all,
    };
  }
}
