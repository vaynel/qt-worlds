import { cleanText, GROUP_CHAT_DAYS, nicknameKey, TERMS_VERSION } from '../../shared/protocol.js';
import type { DB } from './db.js';
import { HttpError } from './http.js';
import { LANTERN_DAYS } from './services.js';
import { RENTAL_KEEP_DAYS } from './shop.js';
import type { LookService } from './looks.js';
import type { ShopService } from './shop.js';

const DAY_MS = 86_400_000;
/** A 내린 lantern's copy is kept this long (the daily limit counts it), then deleted. */
export const REMOVED_LANTERN_GRACE_MS = DAY_MS;
/** An expired lantern (off the hill after LANTERN_DAYS) is deleted a day later. */
export const EXPIRED_LANTERN_GRACE_MS = DAY_MS;
/** Sign-ups that never finished (no nickname, no consent) are deleted after this. */
export const ABANDONED_SIGNUP_MS = DAY_MS;

const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

export interface DeletionResult {
  /** Lanterns deleted (tell every connected client they are gone). */
  lanternIds: number[];
  /** Other people's lanterns whose reaction counts dropped. */
  reactedLanternIds: number[];
  /** Groups handed to another member: [groupId, new owner nickname]. */
  transferred: { groupId: number; newOwnerId: number; newOwner: string }[];
  /** Groups deleted because nobody else was left. */
  deletedGroups: number[];
  /** Groups the user was in that still exist (for live refreshes). */
  remainingGroups: number[];
}

/**
 * 정보주체 권리 (M7): 내 데이터 내려받기 (export) and 회원 탈퇴 (delete), plus the
 * hourly 파기 sweep for lantern copies and unfinished sign-ups.
 */
export class AccountService {
  constructor(
    private readonly db: DB,
    private readonly looks: LookService | null = null,
    private readonly shop: ShopService | null = null,
  ) {}

  /** Everything we hold about this account, as plain JSON. Only this user's rows. */
  export(userId: number) {
    const u = this.db
      .prepare('SELECT id, google_sub, email, email_verified, nickname, created_at, onboarded_at, terms_agreed_at, terms_version FROM users WHERE id = ?')
      .get(userId) as
      | {
          id: number;
          google_sub: string;
          email: string | null;
          email_verified: number;
          nickname: string | null;
          created_at: number;
          onboarded_at: number | null;
          terms_agreed_at: number | null;
          terms_version: string | null;
        }
      | undefined;
    if (!u) throw new HttpError(404, 'not_found', '계정을 찾을 수 없어요.');

    const pages = this.db.prepare('SELECT date, word_json, created_at FROM wordbook_pages WHERE user_id = ? ORDER BY date').all(userId) as {
      date: string;
      word_json: string;
      created_at: number;
    }[];
    const meditations = this.db
      .prepare('SELECT id, date, place, meditation, feeling, application, created_at, updated_at FROM meditations WHERE user_id = ? ORDER BY created_at')
      .all(userId) as { id: number; date: string; place: string; meditation: string; feeling: string; application: string; created_at: number; updated_at: number }[];
    const lanterns = this.db
      .prepare(
        `SELECT l.id, l.meditation_id, l.group_id, g.name AS group_name, l.date, l.ref, l.verse, l.translation, l.meditation, l.feeling, l.application,
                l.anonymous, l.created_at, l.removed_at,
                (SELECT COUNT(*) FROM reactions r WHERE r.lantern_id = l.id AND r.type = 'amen') AS amen,
                (SELECT COUNT(*) FROM reactions r WHERE r.lantern_id = l.id AND r.type = 'pray') AS pray,
                (SELECT COUNT(*) FROM reactions r WHERE r.lantern_id = l.id AND r.type = 'record') AS record
         FROM lanterns l LEFT JOIN groups g ON g.id = l.group_id WHERE l.user_id = ? ORDER BY l.created_at`,
      )
      .all(userId) as {
      id: number;
      meditation_id: number | null;
      group_id: number | null;
      group_name: string | null;
      date: string;
      ref: string;
      verse: string;
      translation: string;
      meditation: string;
      feeling: string;
      application: string;
      anonymous: number;
      created_at: number;
      removed_at: number | null;
      amen: number;
      pray: number;
      record: number;
    }[];
    const reactions = this.db.prepare('SELECT lantern_id, type, created_at FROM reactions WHERE user_id = ? ORDER BY created_at').all(userId) as {
      lantern_id: number;
      type: string;
      created_at: number;
    }[];
    const saved = this.db.prepare('SELECT lantern_id, snapshot_json, created_at FROM saved_lanterns WHERE user_id = ? ORDER BY created_at').all(userId) as {
      lantern_id: number;
      snapshot_json: string;
      created_at: number;
    }[];
    const groups = this.db
      .prepare(
        `SELECT g.id, g.name, g.code, g.owner_id, g.created_at, m.joined_at FROM group_members m JOIN groups g ON g.id = m.group_id
         WHERE m.user_id = ? ORDER BY m.joined_at`,
      )
      .all(userId) as { id: number; name: string; code: string; owner_id: number; created_at: number; joined_at: number }[];
    const messages = this.db
      .prepare(
        `SELECT m.id, m.group_id, g.name AS group_name, m.text, m.created_at, m.deleted_at, m.hidden_at FROM group_messages m
         LEFT JOIN groups g ON g.id = m.group_id WHERE m.user_id = ? AND m.kind = 'msg' ORDER BY m.id`,
      )
      .all(userId) as { id: number; group_id: number; group_name: string | null; text: string; created_at: number; deleted_at: number | null; hidden_at: number | null }[];
    const subs = this.db.prepare('SELECT endpoint, user_agent, created_at, last_ok_at FROM push_subscriptions WHERE user_id = ? ORDER BY id').all(userId) as {
      endpoint: string;
      user_agent: string;
      created_at: number;
      last_ok_at: number | null;
    }[];
    const prefs = this.db.prepare('SELECT daily, daily_time, prayer, props, updated_at FROM push_prefs WHERE user_id = ?').get(userId) as
      | { daily: number; daily_time: number; prayer: number; props: number; updated_at: number }
      | undefined;
    const sessions = this.db.prepare('SELECT created_at, expires_at, persistent FROM sessions WHERE user_id = ? ORDER BY created_at').all(userId) as {
      created_at: number;
      expires_at: number;
      persistent: number;
    }[];

    const origin = (raw: string) => {
      try {
        return new URL(raw).origin;
      } catch {
        return '';
      }
    };

    return {
      service: 'QT 월드 (https://qt.log2u.me)',
      exportedAt: new Date().toISOString(),
      note: '내 계정에 저장된 정보를 모두 담았어요. 다른 분의 정보는 들어 있지 않아요 (담아 둔 묵상은 내가 기록하기로 담은 사본이에요).',
      account: {
        googleSub: u.google_sub,
        email: u.email,
        emailVerified: u.email_verified === 1,
        nickname: u.nickname,
        createdAt: iso(u.created_at),
        guideSeenAt: iso(u.onboarded_at),
        termsAgreedAt: iso(u.terms_agreed_at),
        termsVersion: u.terms_version,
      },
      wordBook: pages.map((p) => ({
        date: p.date,
        word: JSON.parse(p.word_json) as unknown,
        createdAt: iso(p.created_at),
        meditations: meditations
          .filter((m) => m.date === p.date)
          .map((m) => ({
            id: m.id,
            place: m.place,
            meditation: m.meditation,
            feeling: m.feeling,
            application: m.application,
            createdAt: iso(m.created_at),
            updatedAt: iso(m.updated_at),
          })),
      })),
      lanterns: lanterns.map((l) => ({
        id: l.id,
        meditationId: l.meditation_id,
        visibility: l.group_id === null ? 'public' : 'group',
        group: l.group_name,
        anonymous: l.anonymous === 1,
        date: l.date,
        ref: l.ref,
        verse: l.verse,
        translation: l.translation,
        meditation: l.meditation,
        feeling: l.feeling,
        application: l.application,
        reactions: { amen: l.amen, pray: l.pray, record: l.record },
        createdAt: iso(l.created_at),
        removedAt: iso(l.removed_at),
      })),
      myReactions: reactions.map((r) => ({ lanternId: r.lantern_id, type: r.type, createdAt: iso(r.created_at) })),
      savedLanterns: saved.map((s) => ({ lanternId: s.lantern_id, savedAt: iso(s.created_at), ...(JSON.parse(s.snapshot_json) as object) })),
      groups: groups.map((g) => ({ id: g.id, name: g.name, code: g.code, role: g.owner_id === userId ? '모임장' : '참여', createdAt: iso(g.created_at), joinedAt: iso(g.joined_at) })),
      groupMessages: messages.map((m) => ({
        id: m.id,
        group: m.group_name,
        text: m.deleted_at !== null ? '' : m.text,
        createdAt: iso(m.created_at),
        deleted: m.deleted_at !== null,
        hiddenByOwner: m.hidden_at !== null,
      })),
      notifications: {
        devices: subs.map((s) => ({ service: origin(s.endpoint), device: s.user_agent, createdAt: iso(s.created_at), lastDeliveredAt: iso(s.last_ok_at) })),
        prefs: prefs
          ? { daily: prefs.daily === 1, dailyTimeMinutes: prefs.daily_time, prayer: prefs.prayer === 1, propReminders: prefs.props === 1, updatedAt: iso(prefs.updated_at) }
          : null,
      },
      appearance: this.looks?.export(userId) ?? null,
      propShop: this.shop?.export(userId) ?? null,
      sessions: sessions.map((s) => ({ createdAt: iso(s.created_at), expiresAt: iso(s.expires_at), keepSignedIn: s.persistent === 1 })),
      retention: {
        groupMessagesDays: GROUP_CHAT_DAYS,
        lanternDays: LANTERN_DAYS,
        propRentalDays: RENTAL_KEEP_DAYS,
        termsVersionCurrent: TERMS_VERSION,
      },
    };
  }

  /**
   * 회원 탈퇴: one transaction. The nickname must be typed to confirm (when the
   * account has one). Afterwards no row refers to this user any more.
   */
  delete(userId: number, confirmRaw: unknown): DeletionResult {
    const u = this.db.prepare('SELECT nickname, nickname_key FROM users WHERE id = ?').get(userId) as
      | { nickname: string | null; nickname_key: string | null }
      | undefined;
    if (!u) throw new HttpError(404, 'not_found', '계정을 찾을 수 없어요.');
    if (u.nickname) {
      const typed = typeof confirmRaw === 'string' && confirmRaw.length <= 64 ? nicknameKey(cleanText(confirmRaw)) : '';
      if (!typed || typed !== u.nickname_key) throw new HttpError(400, 'confirm_mismatch', '닉네임을 똑같이 적어 주세요.');
    }

    return this.db.transaction((): DeletionResult => {
      const lanternIds = (this.db.prepare('SELECT id FROM lanterns WHERE user_id = ?').all(userId) as { id: number }[]).map((r) => r.id);
      const reactedLanternIds = (
        this.db.prepare('SELECT DISTINCT lantern_id FROM reactions WHERE user_id = ? AND lantern_id NOT IN (SELECT id FROM lanterns WHERE user_id = ?)').all(userId, userId) as {
          lantern_id: number;
        }[]
      ).map((r) => r.lantern_id);
      const memberOf = (this.db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(userId) as { group_id: number }[]).map((r) => r.group_id);

      // Groups I made: hand them to the longest-standing remaining member, or delete them.
      const transferred: DeletionResult['transferred'] = [];
      const deletedGroups: number[] = [];
      for (const { id: gid } of this.db.prepare('SELECT id FROM groups WHERE owner_id = ?').all(userId) as { id: number }[]) {
        const next = this.db
          .prepare(
            `SELECT m.user_id, u.nickname FROM group_members m JOIN users u ON u.id = m.user_id
             WHERE m.group_id = ? AND m.user_id != ? ORDER BY m.joined_at, m.user_id LIMIT 1`,
          )
          .get(gid, userId) as { user_id: number; nickname: string | null } | undefined;
        if (next) {
          this.db.prepare('UPDATE groups SET owner_id = ? WHERE id = ?').run(next.user_id, gid);
          transferred.push({ groupId: gid, newOwnerId: next.user_id, newOwner: next.nickname ?? '' });
        } else {
          // Cascades: members, messages, read pointers, lanterns shared to it.
          this.db.prepare('DELETE FROM lanterns WHERE group_id = ?').run(gid);
          this.db.prepare('DELETE FROM groups WHERE id = ?').run(gid);
          deletedGroups.push(gid);
        }
      }

      // My group chat messages, and the "○○님이 …" notices that carry my nickname.
      this.db.prepare('DELETE FROM group_messages WHERE user_id = ?').run(userId);
      if (u.nickname && memberOf.length) {
        const prefix = `${u.nickname}님이 `;
        const del = this.db.prepare("DELETE FROM group_messages WHERE group_id = ? AND kind = 'system' AND substr(text, 1, ?) = ?");
        for (const gid of memberOf) del.run(gid, [...prefix].length, prefix);
      }

      // Copies of my lanterns that others kept with 기록하기 (snapshots hold my words and name).
      if (lanternIds.length) {
        const delSaved = this.db.prepare('DELETE FROM saved_lanterns WHERE lantern_id = ?');
        for (const id of lanternIds) delSaved.run(id);
      }

      // Everything else cascades from users: sessions, word book pages, meditations,
      // lanterns (→ their reactions), my reactions, my saved lanterns, memberships,
      // read pointers, push subscriptions and preferences, appearance and strikes
      // (columns on users), my outfit drawings (→ reports about them) and my reports,
      // prop rentals, their request log and daily counts (stock is not given back).
      this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);

      const remainingGroups = memberOf.filter((g) => !deletedGroups.includes(g));
      return { lanternIds, reactedLanternIds, transferred, deletedGroups, remainingGroups };
    })();
  }

  /**
   * Hourly 파기:
   *  - lantern copies: 내린 ones after a day, expired ones a day after leaving the hill;
   *  - sign-ups that never chose a nickname nor agreed to the terms, after a day.
   */
  sweep(now = Date.now()): { lanterns: number; signups: number; outfits: number; rentals: number } {
    const lanterns = this.db
      .prepare('DELETE FROM lanterns WHERE (removed_at IS NOT NULL AND removed_at < ?) OR created_at < ?')
      .run(now - REMOVED_LANTERN_GRACE_MS, now - LANTERN_DAYS * DAY_MS - EXPIRED_LANTERN_GRACE_MS).changes;
    const signups = this.db
      .prepare('DELETE FROM users WHERE nickname IS NULL AND terms_agreed_at IS NULL AND created_at < ?')
      .run(now - ABANDONED_SIGNUP_MS).changes;
    const outfits = this.looks?.sweep(now) ?? 0;
    const rentals = this.shop?.sweep(now) ?? 0;
    return { lanterns, signups, outfits, rentals };
  }
}
