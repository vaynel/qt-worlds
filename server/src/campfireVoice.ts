import {
  VOICE_MUTE_MS,
  VOICE_MUTE_REPEAT_MS,
  VOICE_REPORT_REASONS,
  VOICE_REPORT_WINDOW_MS,
  VOICE_REPORTS_TO_MUTE,
  type VoiceReportReason,
} from '../../shared/protocol.js';
import type { DB } from './db.js';
import { HttpError } from './http.js';

const DAY_MS = 86_400_000;
/** Reports are kept this long (review, repeat-offender context), then deleted. */
export const VOICE_REPORT_KEEP_DAYS = 90;
/** An ended or lifted mute is kept this long (the 7-day repeat rule looks back at it). */
export const VOICE_SANCTION_KEEP_DAYS = 365;

export interface VoiceSanctionAdmin {
  userId: number;
  nickname: string;
  /** Reports received in the last 30 days, by reason. */
  reports: number;
  reasons: Partial<Record<VoiceReportReason, number>>;
  lastReportAt: number | null;
  /** The sanction in force now, if any. */
  active: { id: number; level: number; startedAt: number; until: number } | null;
  /** Earlier sanctions (lifted ones included). */
  past: number;
}

/**
 * 🔥 모닥불 공개 음성 moderation: reports against speakers, and the automatic
 * campfire-voice mute (VOICE_REPORTS_TO_MUTE distinct reporters within
 * VOICE_REPORT_WINDOW_MS → 24 h, later ones a week). Muted people can still
 * listen. Nothing about the audio itself is ever stored: the server never
 * touches it. `now` is overridable in test mode (fake clock).
 */
export class CampfireVoiceService {
  offsetMs = 0;
  now = () => Date.now() + this.offsetMs;

  constructor(private readonly db: DB) {}

  /** When this account may speak at the campfire again (null = it may now). */
  silencedUntil(userId: number): number | null {
    const row = this.db
      .prepare('SELECT MAX(until) u FROM voice_sanctions WHERE user_id = ? AND lifted_at IS NULL AND until > ?')
      .get(userId, this.now()) as { u: number | null } | undefined;
    return row?.u ?? null;
  }

  /**
   * One report. The same reporter counts once per window. Returns the new
   * sanction when this report tipped the balance.
   */
  report(reporterId: number, targetId: number, reasonRaw: unknown): { added: boolean; sanction: { until: number; level: number } | null } {
    if (typeof reasonRaw !== 'string' || !(VOICE_REPORT_REASONS as readonly string[]).includes(reasonRaw)) {
      throw new HttpError(400, 'bad_reason', '신고 이유를 골라 주세요.');
    }
    if (reporterId === targetId) throw new HttpError(400, 'bad_target', '나 자신은 신고할 수 없어요.');
    const now = this.now();
    const since = now - VOICE_REPORT_WINDOW_MS;
    return this.db.transaction(() => {
      const dup = this.db.prepare('SELECT 1 FROM voice_reports WHERE target_id = ? AND reporter_id = ? AND created_at > ?').get(targetId, reporterId, since);
      if (dup) return { added: false, sanction: null };
      this.db.prepare('INSERT INTO voice_reports (target_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?)').run(targetId, reporterId, reasonRaw, now);
      if (this.silencedUntil(targetId) !== null) return { added: true, sanction: null };
      // Reports before the last sanction started were already "used".
      const last = this.db.prepare('SELECT MAX(started_at) s FROM voice_sanctions WHERE user_id = ?').get(targetId) as { s: number | null };
      const from = Math.max(since, last.s ?? 0);
      const { n } = this.db.prepare('SELECT COUNT(DISTINCT reporter_id) n FROM voice_reports WHERE target_id = ? AND created_at > ?').get(targetId, from) as { n: number };
      if (n < VOICE_REPORTS_TO_MUTE) return { added: true, sanction: null };
      // Repeat offenders: any earlier sanction an admin didn't lift.
      const prior = (this.db.prepare('SELECT COUNT(*) n FROM voice_sanctions WHERE user_id = ? AND lifted_at IS NULL').get(targetId) as { n: number }).n;
      const level = prior + 1;
      const until = now + (level === 1 ? VOICE_MUTE_MS : VOICE_MUTE_REPEAT_MS);
      this.db.prepare('INSERT INTO voice_sanctions (user_id, level, started_at, until) VALUES (?, ?, ?, ?)').run(targetId, level, now, until);
      return { added: true, sanction: { until, level } };
    })();
  }

  /** People reported in the last 30 days or muted now, active mutes first. */
  adminList(): VoiceSanctionAdmin[] {
    const now = this.now();
    const since = now - 30 * DAY_MS;
    const ids = this.db
      .prepare(
        `SELECT DISTINCT user_id FROM (
           SELECT target_id AS user_id FROM voice_reports WHERE created_at > ?
           UNION SELECT user_id FROM voice_sanctions WHERE lifted_at IS NULL AND until > ?
         ) LIMIT 300`,
      )
      .all(since, now) as { user_id: number }[];
    const nick = this.db.prepare('SELECT nickname FROM users WHERE id = ?');
    const reasons = this.db.prepare('SELECT reason, COUNT(*) n, MAX(created_at) last FROM voice_reports WHERE target_id = ? AND created_at > ? GROUP BY reason');
    const active = this.db.prepare('SELECT id, level, started_at, until FROM voice_sanctions WHERE user_id = ? AND lifted_at IS NULL AND until > ? ORDER BY until DESC LIMIT 1');
    const pastQ = this.db.prepare('SELECT COUNT(*) n FROM voice_sanctions WHERE user_id = ?');
    const out = ids.map(({ user_id }) => {
      const rs = reasons.all(user_id, since) as { reason: VoiceReportReason; n: number; last: number }[];
      const a = active.get(user_id, now) as { id: number; level: number; started_at: number; until: number } | undefined;
      const total = (pastQ.get(user_id) as { n: number }).n;
      return {
        userId: user_id,
        nickname: (nick.get(user_id) as { nickname: string | null } | undefined)?.nickname ?? '(이름 없음)',
        reports: rs.reduce((s, r) => s + r.n, 0),
        reasons: Object.fromEntries(rs.map((r) => [r.reason, r.n])),
        lastReportAt: rs.length ? Math.max(...rs.map((r) => r.last)) : null,
        active: a ? { id: a.id, level: a.level, startedAt: a.started_at, until: a.until } : null,
        past: total - (a ? 1 : 0),
      };
    });
    return out.sort((x, y) => Number(!!y.active) - Number(!!x.active) || (y.lastReportAt ?? 0) - (x.lastReportAt ?? 0));
  }

  /** 해제 (lift the mute now) or 연장 (+days; mutes now when nothing is in force). */
  adminAction(userId: number, action: unknown, daysRaw: unknown): { until: number | null } {
    const exists = this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
    if (!exists) throw new HttpError(404, 'not_found', '찾을 수 없어요.');
    const now = this.now();
    if (action === 'lift') {
      this.db.prepare('UPDATE voice_sanctions SET lifted_at = ? WHERE user_id = ? AND lifted_at IS NULL AND until > ?').run(now, userId, now);
      return { until: null };
    }
    if (action === 'extend') {
      const days = Number(daysRaw);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, 'bad_days', '1~365일 사이로 정해 주세요.');
      const a = this.db.prepare('SELECT id, until FROM voice_sanctions WHERE user_id = ? AND lifted_at IS NULL AND until > ? ORDER BY until DESC LIMIT 1').get(userId, now) as
        | { id: number; until: number }
        | undefined;
      if (a) {
        const until = a.until + days * DAY_MS;
        this.db.prepare('UPDATE voice_sanctions SET until = ? WHERE id = ?').run(until, a.id);
        return { until };
      }
      const prior = (this.db.prepare('SELECT COUNT(*) n FROM voice_sanctions WHERE user_id = ? AND lifted_at IS NULL').get(userId) as { n: number }).n;
      const until = now + days * DAY_MS;
      this.db.prepare('INSERT INTO voice_sanctions (user_id, level, started_at, until) VALUES (?, ?, ?, ?)').run(userId, prior + 1, now, until);
      return { until };
    }
    throw new HttpError(400, 'bad_action', '알 수 없는 요청이에요.');
  }

  /** Hourly 파기: old reports and long-ended mutes. Returns rows deleted. */
  sweep(): number {
    const now = this.now();
    const a = this.db.prepare('DELETE FROM voice_reports WHERE created_at < ?').run(now - VOICE_REPORT_KEEP_DAYS * DAY_MS).changes;
    const b = this.db.prepare('DELETE FROM voice_sanctions WHERE MIN(until, COALESCE(lifted_at, until)) < ?').run(now - VOICE_SANCTION_KEEP_DAYS * DAY_MS).changes;
    return a + b;
  }

  /** 내 데이터 내려받기: reports I made (never who reported me) and mutes I received. */
  export(userId: number) {
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    const made = this.db.prepare('SELECT reason, created_at FROM voice_reports WHERE reporter_id = ? ORDER BY created_at').all(userId) as { reason: string; created_at: number }[];
    const mutes = this.db.prepare('SELECT level, started_at, until, lifted_at FROM voice_sanctions WHERE user_id = ? ORDER BY started_at').all(userId) as {
      level: number;
      started_at: number;
      until: number;
      lifted_at: number | null;
    }[];
    return {
      reportsMade: made.map((r) => ({ reason: r.reason, createdAt: iso(r.created_at) })),
      campfireVoiceMutes: mutes.map((m) => ({ level: m.level, startedAt: iso(m.started_at), until: iso(m.until), liftedAt: iso(m.lifted_at) })),
    };
  }
}
