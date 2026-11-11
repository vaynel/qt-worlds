import { createHash } from 'node:crypto';
import {
  DEFAULT_APPEARANCE,
  OUTFIT_BAN_DAYS,
  OUTFIT_HIDE_REPORTS,
  OUTFIT_SLOTS,
  OUTFIT_STRIKES_BAN,
  REPORT_REASONS,
  validateAppearance,
  validateOutfitPixels,
  type Appearance,
  type Look,
  type ReportReason,
} from '../../shared/protocol.js';
import type { DB } from './db.js';
import { HttpError } from './http.js';

const DAY_MS = 86_400_000;
/** A replaced drawing that was reported is kept this long after its last report (for review), then deleted. */
export const REPLACED_OUTFIT_KEEP_MS = 30 * DAY_MS;
/** Longest ban an admin can set (days). */
export const MAX_BAN_DAYS = 365;

interface OutfitRow {
  id: number;
  user_id: number;
  slot: number | null;
  hash: string;
  pixels: string;
  created_at: number;
  hidden_at: number | null;
  review: 'kept' | 'restored' | null;
  reviewed_at: number | null;
}

export interface SlotInfo {
  slot: number;
  id: number;
  hash: string;
  pixels: string;
  hidden: boolean;
  createdAt: number;
}

export interface MyLook {
  appearance: Appearance | null;
  /** Worn slot, or null (입지 않기). */
  worn: number | null;
  slots: (SlotInfo | null)[];
  /** Drawing uploads paused until (ms), or null. */
  banUntil: number | null;
  strikes: number;
}

export const outfitHash = (pixels: string) => createHash('sha256').update(pixels).digest('hex').slice(0, 16);

const kstDate = (ms: number) => {
  const d = new Date(ms + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`;
};

/**
 * 꾸미기 (M8): appearance (palette indices only), up to three pixel outfits
 * per account (one worn), 🚩 reports with auto-hide after OUTFIT_HIDE_REPORTS
 * distinct reporters, strikes and upload bans, and the admin review queue.
 */
export class LookService {
  constructor(private readonly db: DB) {}

  private user(userId: number) {
    const u = this.db.prepare('SELECT appearance, outfit_slot, outfit_strikes, outfit_ban_until FROM users WHERE id = ?').get(userId) as
      | { appearance: string | null; outfit_slot: number | null; outfit_strikes: number; outfit_ban_until: number | null }
      | undefined;
    if (!u) throw new HttpError(404, 'not_found', '계정을 찾을 수 없어요.');
    return u;
  }

  private parseAppearance(raw: string | null): Appearance | null {
    if (!raw) return null;
    try {
      return validateAppearance(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private slotRow(userId: number, slot: number): OutfitRow | undefined {
    return this.db.prepare('SELECT * FROM outfits WHERE user_id = ? AND slot = ?').get(userId, slot) as OutfitRow | undefined;
  }

  mine(userId: number): MyLook {
    const u = this.user(userId);
    const rows = this.db.prepare('SELECT * FROM outfits WHERE user_id = ? AND slot IS NOT NULL').all(userId) as OutfitRow[];
    const slots: (SlotInfo | null)[] = Array.from({ length: OUTFIT_SLOTS }, (_, i) => {
      const r = rows.find((x) => x.slot === i);
      return r ? { slot: i, id: r.id, hash: r.hash, pixels: r.pixels, hidden: r.hidden_at !== null, createdAt: r.created_at } : null;
    });
    const now = Date.now();
    return {
      appearance: this.parseAppearance(u.appearance),
      worn: u.outfit_slot !== null && slots[u.outfit_slot] ? u.outfit_slot : null,
      slots,
      banUntil: u.outfit_ban_until && u.outfit_ban_until > now ? u.outfit_ban_until : null,
      strikes: u.outfit_strikes,
    };
  }

  /** The look a viewer gets: the owner also sees a hidden drawing (flagged), others don't. */
  lookFor(userId: number, owner: boolean): Look | null {
    const u = this.db.prepare('SELECT appearance, outfit_slot FROM users WHERE id = ?').get(userId) as
      | { appearance: string | null; outfit_slot: number | null }
      | undefined;
    if (!u) return null;
    const appearance = this.parseAppearance(u.appearance);
    const outfit = u.outfit_slot !== null ? this.slotRow(userId, u.outfit_slot) : undefined;
    if (!appearance && !outfit) return null;
    const look: Look = { ...(appearance ?? DEFAULT_APPEARANCE) };
    if (outfit) {
      if (outfit.hidden_at === null) Object.assign(look, { o: outfit.id, oh: outfit.hash });
      else if (owner) Object.assign(look, { o: outfit.id, oh: outfit.hash, hid: true });
    }
    return look;
  }

  /** Save colours/hair and which slot is worn (null = 입지 않기). */
  setLook(userId: number, rawAppearance: unknown, rawWorn: unknown): MyLook {
    const appearance = validateAppearance(rawAppearance);
    if (!appearance) throw new HttpError(400, 'bad_look', '고를 수 있는 색과 머리 모양만 저장할 수 있어요.');
    let worn: number | null = null;
    if (rawWorn !== null && rawWorn !== undefined) {
      if (!Number.isInteger(rawWorn) || (rawWorn as number) < 0 || (rawWorn as number) >= OUTFIT_SLOTS) {
        throw new HttpError(400, 'bad_look', '옷 칸이 올바르지 않아요.');
      }
      worn = rawWorn as number;
      if (!this.slotRow(userId, worn)) throw new HttpError(400, 'empty_slot', '빈 칸의 옷은 입을 수 없어요. 먼저 그림을 저장해 주세요.');
    }
    this.db.prepare('UPDATE users SET appearance = ?, outfit_slot = ? WHERE id = ?').run(JSON.stringify(appearance), worn, userId);
    return this.mine(userId);
  }

  /** Save a drawing into a slot (content-hashed). Returns whether the worn drawing changed. */
  saveOutfit(userId: number, slot: number, rawPixels: unknown): { mine: MyLook; wornChanged: boolean } {
    if (!Number.isInteger(slot) || slot < 0 || slot >= OUTFIT_SLOTS) throw new HttpError(404, 'not_found', '옷 칸을 찾을 수 없어요.');
    const pixels = validateOutfitPixels(rawPixels);
    if (!pixels) throw new HttpError(400, 'bad_outfit', '그림 데이터가 올바르지 않아요. (16×16칸, 정해진 16색)');
    const u = this.user(userId);
    const now = Date.now();
    if (u.outfit_ban_until && u.outfit_ban_until > now) {
      throw new HttpError(403, 'outfit_banned', `신고가 쌓여 ${kstDate(u.outfit_ban_until)}까지 새 그림을 올릴 수 없어요.`);
    }
    const hash = outfitHash(pixels);
    if (this.db.prepare('SELECT 1 FROM outfits WHERE user_id = ? AND hash = ? AND hidden_at IS NOT NULL').get(userId, hash)) {
      throw new HttpError(409, 'outfit_hidden', '신고로 숨겨진 그림과 똑같아요. 그림을 고쳐서 저장해 주세요.');
    }
    const existing = this.slotRow(userId, slot);
    if (existing?.hash === hash) return { mine: this.mine(userId), wornChanged: false };
    this.db.transaction(() => {
      if (existing) this.retire(existing.id);
      this.db.prepare('INSERT INTO outfits (user_id, slot, hash, pixels, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, slot, hash, pixels, now);
    })();
    return { mine: this.mine(userId), wornChanged: u.outfit_slot === slot };
  }

  /** Empty a slot. If it was worn, the user wears nothing. */
  deleteOutfit(userId: number, slot: number): { mine: MyLook; wornChanged: boolean } {
    if (!Number.isInteger(slot) || slot < 0 || slot >= OUTFIT_SLOTS) throw new HttpError(404, 'not_found', '옷 칸을 찾을 수 없어요.');
    const u = this.user(userId);
    const existing = this.slotRow(userId, slot);
    if (!existing) return { mine: this.mine(userId), wornChanged: false };
    this.db.transaction(() => {
      this.retire(existing.id);
      if (u.outfit_slot === slot) this.db.prepare('UPDATE users SET outfit_slot = NULL WHERE id = ?').run(userId);
    })();
    return { mine: this.mine(userId), wornChanged: u.outfit_slot === slot };
  }

  /** A drawing leaves its slot: kept (slotless) while it has reports to review, otherwise deleted. */
  private retire(outfitId: number) {
    const reported = this.db.prepare('SELECT 1 FROM outfit_reports WHERE outfit_id = ? LIMIT 1').get(outfitId);
    if (reported) this.db.prepare('UPDATE outfits SET slot = NULL WHERE id = ?').run(outfitId);
    else this.db.prepare('DELETE FROM outfits WHERE id = ?').run(outfitId);
  }

  /** Pixels by id for rendering. Hidden or replaced drawings only for their owner (and admins). */
  pixels(ids: number[], viewerId: number | null, admin: boolean): { id: number; hash: string; pixels: string }[] {
    if (ids.length === 0) return [];
    const rows = this.db.prepare(`SELECT id, user_id, hash, pixels, hidden_at, slot FROM outfits WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as OutfitRow[];
    return rows
      .filter((r) => admin || r.user_id === viewerId || (r.hidden_at === null && r.slot !== null))
      .map((r) => ({ id: r.id, hash: r.hash, pixels: r.pixels }));
  }

  /** Hide a drawing and count a strike; every OUTFIT_STRIKES_BAN strikes pause uploads. */
  private hide(o: OutfitRow, now: number, review: 'kept' | null) {
    this.db.prepare('UPDATE outfits SET hidden_at = ?, review = COALESCE(?, review), reviewed_at = CASE WHEN ? IS NULL THEN reviewed_at ELSE ? END WHERE id = ?').run(
      now,
      review,
      review,
      now,
      o.id,
    );
    this.db.prepare('UPDATE users SET outfit_strikes = outfit_strikes + 1 WHERE id = ?').run(o.user_id);
    const { outfit_strikes: strikes } = this.db.prepare('SELECT outfit_strikes FROM users WHERE id = ?').get(o.user_id) as { outfit_strikes: number };
    if (strikes > 0 && strikes % OUTFIT_STRIKES_BAN === 0) {
      this.db
        .prepare('UPDATE users SET outfit_ban_until = MAX(COALESCE(outfit_ban_until, 0), ?) WHERE id = ?')
        .run(now + OUTFIT_BAN_DAYS * DAY_MS, o.user_id);
    }
  }

  /** 🚩 One report per reporter per drawing. */
  report(reporterId: number, outfitId: number, rawReason: unknown): { duplicate: boolean; reporters: number; hidden: boolean; ownerId: number; changed: boolean } {
    const reason = REPORT_REASONS.includes(rawReason as ReportReason) ? (rawReason as ReportReason) : null;
    if (!reason) throw new HttpError(400, 'bad_reason', '신고 이유를 골라 주세요.');
    const o = this.db.prepare('SELECT * FROM outfits WHERE id = ?').get(outfitId) as OutfitRow | undefined;
    if (!o) throw new HttpError(404, 'not_found', '옷 그림을 찾을 수 없어요.');
    if (o.user_id === reporterId) throw new HttpError(400, 'own_outfit', '내 옷은 신고할 수 없어요.');
    const now = Date.now();
    return this.db.transaction(() => {
      const added = this.db.prepare('INSERT OR IGNORE INTO outfit_reports (outfit_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?)').run(outfitId, reporterId, reason, now).changes;
      const { n } = this.db.prepare('SELECT COUNT(*) n FROM outfit_reports WHERE outfit_id = ?').get(outfitId) as { n: number };
      let changed = false;
      if (added && n >= OUTFIT_HIDE_REPORTS && o.hidden_at === null && o.review === null) {
        this.hide(o, now, null);
        changed = true;
      }
      return { duplicate: added === 0, reporters: n, hidden: changed || o.hidden_at !== null, ownerId: o.user_id, changed };
    })();
  }

  // ------------------------------------------------------------------ admin

  adminList() {
    const rows = this.db
      .prepare(
        `SELECT o.id, o.user_id, o.slot, o.hash, o.pixels, o.created_at, o.hidden_at, o.review, o.reviewed_at,
                u.nickname, u.outfit_strikes, u.outfit_ban_until, u.outfit_slot,
                (SELECT COUNT(*) FROM outfit_reports r WHERE r.outfit_id = o.id) AS reporters,
                (SELECT MAX(created_at) FROM outfit_reports r WHERE r.outfit_id = o.id) AS last_report
         FROM outfits o JOIN users u ON u.id = o.user_id
         WHERE o.hidden_at IS NOT NULL OR EXISTS (SELECT 1 FROM outfit_reports r WHERE r.outfit_id = o.id)
         ORDER BY (o.review IS NULL) DESC, last_report DESC LIMIT 200`,
      )
      .all() as (OutfitRow & {
      nickname: string | null;
      outfit_strikes: number;
      outfit_ban_until: number | null;
      outfit_slot: number | null;
      reporters: number;
      last_report: number | null;
    })[];
    const reasons = this.db.prepare('SELECT reason, COUNT(*) n FROM outfit_reports WHERE outfit_id = ? GROUP BY reason');
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id,
      hash: r.hash,
      pixels: r.pixels,
      owner: { id: r.user_id, nickname: r.nickname ?? '', strikes: r.outfit_strikes, banUntil: r.outfit_ban_until && r.outfit_ban_until > now ? r.outfit_ban_until : null },
      reporters: r.reporters,
      reasons: Object.fromEntries((reasons.all(r.id) as { reason: string; n: number }[]).map((x) => [x.reason, x.n])),
      hidden: r.hidden_at !== null,
      review: r.review,
      worn: r.slot !== null && r.outfit_slot === r.slot,
      replaced: r.slot === null,
      createdAt: r.created_at,
      lastReportAt: r.last_report,
    }));
  }

  /** 숨김 유지 (hide/keep hidden) · 복구 (restore) · 그림 금지 n일 (ban). Returns the owner to refresh. */
  adminAction(outfitId: number, action: unknown, rawDays: unknown): { ownerId: number } {
    const o = this.db.prepare('SELECT * FROM outfits WHERE id = ?').get(outfitId) as OutfitRow | undefined;
    if (!o) throw new HttpError(404, 'not_found', '옷 그림을 찾을 수 없어요.');
    const now = Date.now();
    this.db.transaction(() => {
      if (action === 'hide') {
        if (o.hidden_at === null) this.hide(o, now, 'kept');
        else this.db.prepare("UPDATE outfits SET review = 'kept', reviewed_at = ? WHERE id = ?").run(now, o.id);
      } else if (action === 'restore') {
        if (o.hidden_at !== null) this.db.prepare('UPDATE users SET outfit_strikes = MAX(0, outfit_strikes - 1) WHERE id = ?').run(o.user_id);
        this.db.prepare("UPDATE outfits SET hidden_at = NULL, review = 'restored', reviewed_at = ? WHERE id = ?").run(now, o.id);
      } else if (action === 'ban') {
        const days = Number(rawDays);
        if (!Number.isInteger(days) || days < 1 || days > MAX_BAN_DAYS) throw new HttpError(400, 'bad_days', `1~${MAX_BAN_DAYS}일 사이로 정해 주세요.`);
        this.db.prepare('UPDATE users SET outfit_ban_until = ? WHERE id = ?').run(now + days * DAY_MS, o.user_id);
      } else {
        throw new HttpError(400, 'bad_action', '알 수 없는 조치예요.');
      }
    })();
    return { ownerId: o.user_id };
  }

  /** For 내 데이터 내려받기: this user's appearance, drawings and their own reports. */
  export(userId: number) {
    const u = this.user(userId);
    const rows = this.db.prepare('SELECT * FROM outfits WHERE user_id = ? ORDER BY id').all(userId) as OutfitRow[];
    const count = this.db.prepare('SELECT COUNT(*) n FROM outfit_reports WHERE outfit_id = ?');
    const reports = this.db.prepare('SELECT outfit_id, reason, created_at FROM outfit_reports WHERE reporter_id = ? ORDER BY created_at').all(userId) as {
      outfit_id: number;
      reason: string;
      created_at: number;
    }[];
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    return {
      appearance: this.parseAppearance(u.appearance),
      wornSlot: u.outfit_slot,
      outfits: rows.map((r) => ({
        id: r.id,
        slot: r.slot,
        hash: r.hash,
        size: '16x16',
        pixels: r.pixels,
        createdAt: iso(r.created_at),
        hiddenAt: iso(r.hidden_at),
        reportsReceived: (count.get(r.id) as { n: number }).n,
      })),
      outfitStrikes: u.outfit_strikes,
      outfitUploadsPausedUntil: iso(u.outfit_ban_until),
      outfitReportsMade: reports.map((r) => ({ outfitId: r.outfit_id, reason: r.reason, createdAt: iso(r.created_at) })),
    };
  }

  /** Hourly 파기: replaced drawings kept for review, 30 days after their last report. */
  sweep(now = Date.now()): number {
    return this.db
      .prepare(
        `DELETE FROM outfits WHERE slot IS NULL AND
         COALESCE((SELECT MAX(created_at) FROM outfit_reports r WHERE r.outfit_id = outfits.id), created_at) < ?`,
      )
      .run(now - REPLACED_OUTFIT_KEEP_MS).changes;
  }
}
