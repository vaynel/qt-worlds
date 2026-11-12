import webpush from 'web-push';
import { seoulDate } from '../../shared/protocol.js';
import type { DailyWord } from './dailyWord.js';
import type { DB } from './db.js';
import { HttpError } from './http.js';

/**
 * Web Push (M6). Kinds of notifications, each opt-out per user:
 *  - 🕊️ daily word at the user's chosen time (Asia/Seoul), at most once a day;
 *  - 🤲 someone prayed (기도하기) for one of my lanterns: never who, never which
 *    lantern, throttled and batched;
 *  - ⏰ a borrowed prop (M9 나눔 소품 가게) has 10 minutes left (sent by ShopService);
 *  - 📚 내 이야기 소식 (L-B): 공감 on one of my books, batched per book (at most
 *    once per STORY_WINDOW_MS: "N명이 공감했어요"), never who;
 *  - ✉️ a new letter on my book / 💌 an answer in a letter thread (fixed text:
 *    never the letter's words, the book's title or anyone's name);
 *  - 📔 밤 일기 알림 (default off): at the chosen time, once a day, only if I
 *    left 발자취 today and haven't published today's diary.
 * Payloads only ever hold our own fixed text and the (public) daily word.
 * Disabled unless VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT are set.
 */

export const MAX_SUBSCRIPTIONS = 10;
export const DEFAULT_DAILY_MIN = 6 * 60;
/** Missed ticks (restart, sleep) still deliver within this many minutes. */
export const DAILY_GRACE_MIN = 120;
/** At most one prayer notification per lantern owner per window; the rest are batched. */
export const PRAYER_WINDOW_MS = 15 * 60_000;
/** The same person praying for the same lantern again (toggle) is counted once per this. */
const PRAYER_DEDUPE_MS = 6 * 3600_000;

export const DAILY_TITLE = '🕊️ 오늘의 말씀이 도착했어요';
export const PRAYER_TITLE = '🤲 누군가 당신의 묵상을 위해 기도하고 있어요';
export const STORY_TITLE = '📚 내 이야기 소식';
export const LETTER_TITLE = '✉️ 내 이야기에 새 편지가 왔어요';
export const REPLY_TITLE = '💌 편지에 답장이 왔어요';
export const DIARY_TITLE = '📔 오늘 하루를 일기로 남겨 볼까요?';
/** 공감 on one book: at most one notification per this window (the rest are counted into the next). */
export const STORY_WINDOW_MS = 30 * 60_000;
export const DEFAULT_DIARY_MIN = 21 * 60;

export interface PushPayload {
  kind: 'daily' | 'prayer' | 'prop' | 'story' | 'letter' | 'reply' | 'diary';
  title: string;
  body: string;
  url: string;
  tag: string;
}

interface SubRow {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}
interface PrefsRow {
  daily: number;
  daily_time: number;
  prayer: number;
  props: number;
  library: number;
  letters: number;
  replies: number;
  diary: number;
  diary_time: number;
}

export interface Delivery {
  userId: number;
  endpoint: string;
  payload: PushPayload;
  status: number;
  at: number;
}

type Sender = (sub: SubRow, payload: string, opts: webpush.RequestOptions) => Promise<number>;

export interface PushOptions {
  publicKey?: string;
  privateKey?: string;
  subject?: string;
  /** Tests: don't contact push services; encrypt for real, record, answer with mockStatus. */
  mock?: boolean;
  /** Tests: allow any *.test push host. */
  testMode?: boolean;
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const b64len = (s: string) => Buffer.from(s.replace(/=+$/, ''), 'base64url').length;

/** Push services browsers actually use; anything else is refused (no SSRF via endpoints). */
const PUSH_HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

export const minutesToTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** KST date and minutes-of-day for an instant. */
export function seoulClock(now: number): { date: string; minutes: number } {
  const d = new Date(now + 9 * 3600_000);
  return { date: seoulDate(new Date(now)), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

export class PushService {
  readonly enabled: boolean;
  readonly publicKey: string;
  readonly mock: boolean;
  /** Injectable clock (tests move it through the day). */
  now: () => number = () => Date.now();
  /** Mock mode only: what would have been delivered. */
  readonly deliveries: Delivery[] = [];
  /** Mock mode only: status the fake push service answers per endpoint (default 201). */
  readonly mockStatus = new Map<string, number>();
  private readonly sender: Sender;
  private readonly prayerState = new Map<number, { lastSent: number; pending: number }>();
  private readonly prayerSeen = new Map<string, number>();

  constructor(
    private readonly db: DB,
    private readonly daily: DailyWord | null,
    private readonly opts: PushOptions,
  ) {
    const pub = opts.publicKey?.trim() ?? '';
    const priv = opts.privateKey?.trim() ?? '';
    const subject = opts.subject?.trim() ?? '';
    let ok = false;
    if (pub && priv && subject) {
      try {
        webpush.setVapidDetails(subject, pub, priv);
        ok = true;
      } catch (err) {
        console.error('web push disabled: bad VAPID settings:', (err as Error).message);
      }
    }
    this.enabled = ok;
    this.publicKey = ok ? pub : '';
    this.mock = !!opts.mock;
    const vapidDetails = { subject, publicKey: pub, privateKey: priv };
    this.sender = this.mock
      ? async (sub, payload, o) => {
          // Real encryption + VAPID signing, so bad keys fail here too; nothing leaves the process.
          webpush.generateRequestDetails({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { ...o, vapidDetails });
          const status = this.mockStatus.get(sub.endpoint) ?? 201;
          this.deliveries.push({ userId: sub.user_id, endpoint: sub.endpoint, payload: JSON.parse(payload) as PushPayload, status, at: this.now() });
          return status;
        }
      : async (sub, payload, o) => {
          try {
            const r = await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { ...o, timeout: 10_000 });
            return r.statusCode;
          } catch (err) {
            const code = (err as { statusCode?: number }).statusCode;
            return typeof code === 'number' ? code : 0;
          }
        };
  }

  /** 회원 탈퇴: drop in-memory prayer batching for that account (DB rows cascade). */
  forget(userId: number) {
    this.prayerState.delete(userId);
    // Keys are `${lanternId}:${actorId}`.
    for (const k of this.prayerSeen.keys()) if (k.endsWith(`:${userId}`)) this.prayerSeen.delete(k);
  }

  // ---------------------------------------------------------------- subscriptions

  private validEndpoint(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length > 2048) throw new HttpError(400, 'bad_subscription', '알림 구독 정보가 올바르지 않아요.');
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new HttpError(400, 'bad_subscription', '알림 구독 정보가 올바르지 않아요.');
    }
    const host = u.hostname.toLowerCase();
    const allowed = PUSH_HOSTS.some((re) => re.test(host)) || (this.opts.testMode === true && /(^|\.)test$/.test(host));
    if (u.protocol !== 'https:' || u.username || u.password || !allowed) {
      throw new HttpError(400, 'bad_subscription', '지원하지 않는 알림 서비스예요.');
    }
    return u.toString();
  }

  subscribe(userId: number, body: Record<string, unknown>, userAgent: string) {
    const sub = (typeof body.subscription === 'object' && body.subscription ? body.subscription : body) as Record<string, unknown>;
    const endpoint = this.validEndpoint(sub.endpoint);
    const keys = (typeof sub.keys === 'object' && sub.keys ? sub.keys : {}) as Record<string, unknown>;
    const { p256dh, auth } = keys;
    if (typeof p256dh !== 'string' || !B64URL.test(p256dh) || b64len(p256dh) !== 65 || Buffer.from(p256dh, 'base64url')[0] !== 4) {
      throw new HttpError(400, 'bad_subscription', '알림 구독 정보가 올바르지 않아요.');
    }
    if (typeof auth !== 'string' || !B64URL.test(auth) || b64len(auth) !== 16) throw new HttpError(400, 'bad_subscription', '알림 구독 정보가 올바르지 않아요.');
    const ua = userAgent.replace(/[^\x20-\x7e]/g, '').slice(0, 80);
    const now = this.now();
    this.db.transaction(() => {
      // The same device may switch accounts: the endpoint follows the current user.
      this.db
        .prepare(
          `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
        )
        .run(userId, endpoint, p256dh, auth, ua, now);
      // At most MAX_SUBSCRIPTIONS devices: the oldest ones are dropped.
      this.db
        .prepare(
          `DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (
             SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY COALESCE(last_ok_at, created_at) DESC, id DESC LIMIT ?)`,
        )
        .run(userId, userId, MAX_SUBSCRIPTIONS);
      this.db.prepare('INSERT OR IGNORE INTO push_prefs (user_id, updated_at) VALUES (?, ?)').run(userId, now);
    })();
    return { ok: true, subscriptions: this.count(userId) };
  }

  unsubscribe(userId: number, body: Record<string, unknown>) {
    if (body.all === true) {
      this.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
    } else {
      if (typeof body.endpoint !== 'string' || body.endpoint.length > 2048) throw new HttpError(400, 'bad_subscription', '알림 구독 정보가 올바르지 않아요.');
      let endpoint = body.endpoint;
      try {
        endpoint = new URL(endpoint).toString();
      } catch {
        /* removed as given */
      }
      this.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
    }
    return { ok: true, subscriptions: this.count(userId) };
  }

  count(userId: number): number {
    return (this.db.prepare('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id = ?').get(userId) as { n: number }).n;
  }

  // ---------------------------------------------------------------- preferences

  prefs(userId: number) {
    const p = this.db.prepare('SELECT daily, daily_time, prayer, props, library, letters, replies, diary, diary_time FROM push_prefs WHERE user_id = ?').get(userId) as
      | PrefsRow
      | undefined;
    return {
      daily: p ? p.daily === 1 : true,
      dailyTime: minutesToTime(p ? p.daily_time : DEFAULT_DAILY_MIN),
      prayer: p ? p.prayer === 1 : true,
      /** 소품 만료 알림 (M9): 10 minutes before a borrowed prop goes back. */
      props: p ? p.props === 1 : true,
      /** 📚 내 이야기 소식: 공감 on my books (batched). */
      library: p ? p.library === 1 : true,
      /** ✉️ new letters on my books (and their writers' answers). */
      letters: p ? p.letters === 1 : true,
      /** 💌 answers to my letters. */
      replies: p ? p.replies === 1 : true,
      /** 📔 밤 일기 알림 (default off) and its time. */
      diary: p ? p.diary === 1 : false,
      diaryTime: minutesToTime(p ? p.diary_time : DEFAULT_DIARY_MIN),
      subscriptions: this.count(userId),
    };
  }

  setPrefs(userId: number, body: Record<string, unknown>) {
    const cur = this.prefs(userId);
    const bool = (v: unknown, fallback: boolean, name: string) => {
      if (v === undefined) return fallback;
      if (typeof v !== 'boolean') throw new HttpError(400, 'bad_field', `${name} 값이 올바르지 않아요.`);
      return v;
    };
    const daily = bool(body.daily, cur.daily, '말씀 알림');
    const prayer = bool(body.prayer, cur.prayer, '기도 알림');
    const props = bool(body.props, cur.props, '소품 만료 알림');
    const library = bool(body.library, cur.library, '내 이야기 소식 알림');
    const letters = bool(body.letters, cur.letters, '편지 알림');
    const replies = bool(body.replies, cur.replies, '답장 알림');
    const diary = bool(body.diary, cur.diary, '밤 일기 알림');
    const time = (raw: unknown) => {
      const m = typeof raw === 'string' ? /^([01]\d|2[0-3]):(00|30)$/.exec(raw) : null;
      if (!m) throw new HttpError(400, 'bad_time', '알림 시간은 30분 단위로 골라 주세요.');
      return Number(m[1]) * 60 + Number(m[2]);
    };
    const minutes = time(body.dailyTime === undefined ? cur.dailyTime : body.dailyTime);
    const diaryMinutes = time(body.diaryTime === undefined ? cur.diaryTime : body.diaryTime);
    this.db
      .prepare(
        `INSERT INTO push_prefs (user_id, daily, daily_time, prayer, props, library, letters, replies, diary, diary_time, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET daily = excluded.daily, daily_time = excluded.daily_time, prayer = excluded.prayer, props = excluded.props,
           library = excluded.library, letters = excluded.letters, replies = excluded.replies, diary = excluded.diary, diary_time = excluded.diary_time,
           updated_at = excluded.updated_at`,
      )
      .run(userId, daily ? 1 : 0, minutes, prayer ? 1 : 0, props ? 1 : 0, library ? 1 : 0, letters ? 1 : 0, replies ? 1 : 0, diary ? 1 : 0, diaryMinutes, this.now());
    return this.prefs(userId);
  }

  // ---------------------------------------------------------------- sending

  /** Send to every device of a user. 404/410 = the browser dropped it: delete. */
  async sendToUser(userId: number, payload: PushPayload, ttlSeconds: number): Promise<number> {
    if (!this.enabled) return 0;
    const subs = this.db.prepare('SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId) as SubRow[];
    const body = JSON.stringify(payload);
    let ok = 0;
    await Promise.all(
      subs.map(async (s) => {
        const status = await this.sender(s, body, { TTL: ttlSeconds, urgency: 'normal', topic: payload.tag });
        if (status >= 200 && status < 300) {
          ok++;
          this.db.prepare('UPDATE push_subscriptions SET last_ok_at = ? WHERE id = ?').run(this.now(), s.id);
        } else if (status === 404 || status === 410) {
          this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
        } else {
          console.warn(`push to subscription ${s.id} failed (${status || 'network'})`);
        }
      }),
    );
    return ok;
  }

  dailyPayload(date: string): PushPayload {
    let body = '오늘의 말씀 편지를 열어 보세요.';
    try {
      const w = this.daily?.forDate(date);
      if (w) {
        const chars = [...w.text.replace(/\s+/g, ' ').trim()];
        body = `${w.ref} · ${chars.slice(0, 40).join('')}${chars.length > 40 ? '…' : ''}`;
      }
    } catch {
      /* generic body */
    }
    return { kind: 'daily', title: DAILY_TITLE, body, url: '/', tag: 'daily-word' };
  }

  /**
   * Runs every minute: daily words that are due (chosen time reached today,
   * within the grace window, not yet sent today), then batched prayers.
   */
  async tick(now = this.now()): Promise<{ daily: number; prayer: number; stories: number; diary: number }> {
    if (!this.enabled) return { daily: 0, prayer: 0, stories: 0, diary: 0 };
    const { date, minutes } = seoulClock(now);
    const due = this.db
      .prepare(
        `SELECT p.user_id FROM push_prefs p
         WHERE p.daily = 1 AND p.daily_time <= ? AND p.daily_time > ?
           AND (p.last_daily_date IS NULL OR p.last_daily_date <> ?)
           AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = p.user_id)`,
      )
      .all(minutes, minutes - DAILY_GRACE_MIN, date) as { user_id: number }[];
    let daily = 0;
    const payload = due.length ? this.dailyPayload(date) : null;
    for (const { user_id } of due) {
      // Record first: at most once per day even if a send fails or ticks overlap.
      const claimed = this.db
        .prepare('UPDATE push_prefs SET last_daily_date = ? WHERE user_id = ? AND (last_daily_date IS NULL OR last_daily_date <> ?)')
        .run(date, user_id, date).changes;
      if (!claimed) continue;
      await this.sendToUser(user_id, payload!, 6 * 3600);
      daily++;
    }
    const prayer = await this.flushPrayers(now);
    const stories = await this.flushStories(now);
    const diary = await this.diaryReminders(now);
    return { daily, prayer, stories, diary };
  }

  // ---------------------------------------------------------------- 이야기 도서관 (L-B)

  private wants(userId: number, pref: 'library' | 'letters' | 'replies'): boolean {
    const p = this.db.prepare(`SELECT ${pref} AS on_ FROM push_prefs WHERE user_id = ?`).get(userId) as { on_: number } | undefined;
    return !!p && p.on_ === 1 && this.count(userId) > 0;
  }

  /** 💛 공감 was added to a book (by someone else). Batched: at most once per STORY_WINDOW_MS per book. */
  async storyReacted(storyId: number, at = this.now()): Promise<void> {
    if (!this.enabled) return;
    const s = this.db.prepare('SELECT user_id FROM stories WHERE id = ?').get(storyId) as { user_id: number } | undefined;
    if (!s || !this.wants(s.user_id, 'library')) return;
    // Only reactions from now on count toward this book's next notice.
    this.db.prepare('INSERT OR IGNORE INTO story_push (story_id, cursor_at, last_sent_at) VALUES (?, ?, NULL)').run(storyId, at - 1);
    await this.sendStory(storyId, this.now());
  }

  /** Claim (once per window, survives restarts) and send "N명이 공감했어요" for one book. */
  private async sendStory(storyId: number, now: number): Promise<boolean> {
    const row = this.db
      .prepare('SELECT p.cursor_at, p.last_sent_at, s.user_id FROM story_push p JOIN stories s ON s.id = p.story_id WHERE p.story_id = ?')
      .get(storyId) as { cursor_at: number; last_sent_at: number | null; user_id: number } | undefined;
    if (!row) return false;
    if (row.last_sent_at !== null && now - row.last_sent_at < STORY_WINDOW_MS) return false;
    const { n } = this.db
      .prepare('SELECT COUNT(DISTINCT user_id) n FROM story_reactions WHERE story_id = ? AND created_at > ? AND user_id <> ?')
      .get(storyId, row.cursor_at, row.user_id) as { n: number };
    if (n === 0) return false;
    const claimed = this.db
      .prepare('UPDATE story_push SET cursor_at = ?, last_sent_at = ? WHERE story_id = ? AND (last_sent_at IS NULL OR last_sent_at <= ?) AND cursor_at = ?')
      .run(now, now, storyId, now - STORY_WINDOW_MS, row.cursor_at).changes;
    if (!claimed || !this.wants(row.user_id, 'library')) return false;
    await this.sendToUser(
      row.user_id,
      { kind: 'story', title: STORY_TITLE, body: n > 1 ? `내 이야기에 ${n}명이 공감했어요` : '내 이야기에 누군가 공감했어요', url: `/?book=${storyId}`, tag: `story-${storyId}` },
      12 * 3600,
    );
    return true;
  }

  private async flushStories(now: number): Promise<number> {
    const due = this.db
      .prepare(
        `SELECT p.story_id FROM story_push p WHERE (p.last_sent_at IS NULL OR p.last_sent_at <= ?)
           AND EXISTS (SELECT 1 FROM story_reactions x WHERE x.story_id = p.story_id AND x.created_at > p.cursor_at)`,
      )
      .all(now - STORY_WINDOW_MS) as { story_id: number }[];
    let sent = 0;
    for (const { story_id } of due) if (await this.sendStory(story_id, now)) sent++;
    // Books nobody reacted to for a day don't need a row.
    this.db.prepare('DELETE FROM story_push WHERE last_sent_at IS NOT NULL AND last_sent_at < ? AND NOT EXISTS (SELECT 1 FROM story_reactions x WHERE x.story_id = story_push.story_id AND x.created_at > story_push.cursor_at)').run(now - 86_400_000);
    return sent;
  }

  /**
   * ✉️ / 💌: a new letter on `userId`'s book, or an answer in a thread they're part of.
   * Fixed text only: no letter words, no book title, no names (anonymous stays anonymous).
   */
  async letter(userId: number, kind: 'letter' | 'reply', recipientRole: 'author' | 'writer', storyId: number, letterId: number): Promise<boolean> {
    if (!this.enabled || !this.wants(userId, recipientRole === 'author' ? 'letters' : 'replies')) return false;
    const payload: PushPayload =
      kind === 'letter'
        ? { kind: 'letter', title: LETTER_TITLE, body: '이야기 도서관에서 편지를 읽어 보세요.', url: `/?book=${storyId}&letter=${letterId}`, tag: `letters-${storyId}` }
        : {
            kind: 'reply',
            title: REPLY_TITLE,
            body: recipientRole === 'author' ? '내 이야기에 온 편지에 답장이 이어졌어요.' : '내가 쓴 편지에 글쓴이가 답장했어요.',
            url: `/?book=${storyId}&letter=${letterId}`,
            tag: `letter-${letterId}`,
          };
    return (await this.sendToUser(userId, payload, 24 * 3600)) > 0;
  }

  /** 📔 밤 일기 알림: due (chosen time, grace window), 발자취 today, no diary yet; claimed once a day. */
  private async diaryReminders(now: number): Promise<number> {
    const { date, minutes } = seoulClock(now);
    const due = this.db
      .prepare(
        `SELECT p.user_id FROM push_prefs p
         WHERE p.diary = 1 AND p.diary_time <= @minutes AND p.diary_time > @minutes - ${DAILY_GRACE_MIN}
           AND (p.last_diary_date IS NULL OR p.last_diary_date <> @date)
           AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = p.user_id)
           AND (EXISTS (SELECT 1 FROM footprints f WHERE f.user_id = p.user_id AND f.kst_date = @date)
             OR EXISTS (SELECT 1 FROM footprint_minutes m WHERE m.user_id = p.user_id AND m.kst_date = @date))
           AND NOT EXISTS (SELECT 1 FROM stories s WHERE s.user_id = p.user_id AND s.kind = 'diary' AND s.kst_date = @date)`,
      )
      .all({ minutes, date }) as { user_id: number }[];
    let sent = 0;
    for (const { user_id } of due) {
      const claimed = this.db
        .prepare('UPDATE push_prefs SET last_diary_date = ? WHERE user_id = ? AND (last_diary_date IS NULL OR last_diary_date <> ?)')
        .run(date, user_id, date).changes;
      if (!claimed) continue;
      await this.sendToUser(user_id, { kind: 'diary', title: DIARY_TITLE, body: '오늘 QT 월드에서 보낸 하루로 일기 초안이 준비돼 있어요.', url: '/?diary=1', tag: 'diary' }, 3 * 3600);
      sent++;
    }
    return sent;
  }

  /** 기도하기 was added to a lantern (by `actorId`). Who and which lantern never leave the server. */
  async prayed(lanternId: number, actorId: number): Promise<void> {
    if (!this.enabled) return;
    const l = this.db.prepare('SELECT user_id FROM lanterns WHERE id = ?').get(lanternId) as { user_id: number } | undefined;
    if (!l || l.user_id === actorId) return;
    const owner = l.user_id;
    const p = this.db.prepare('SELECT prayer FROM push_prefs WHERE user_id = ?').get(owner) as { prayer: number } | undefined;
    if (!p || p.prayer !== 1 || this.count(owner) === 0) return;
    const now = this.now();
    const key = `${lanternId}:${actorId}`;
    if (now - (this.prayerSeen.get(key) ?? -Infinity) < PRAYER_DEDUPE_MS) return;
    this.prayerSeen.set(key, now);
    if (this.prayerSeen.size > 20_000) this.prayerSeen.clear();
    const st = this.prayerState.get(owner) ?? { lastSent: -Infinity, pending: 0 };
    st.pending++;
    this.prayerState.set(owner, st);
    if (now - st.lastSent >= PRAYER_WINDOW_MS) await this.sendPrayers(owner, st, now);
  }

  private async sendPrayers(owner: number, st: { lastSent: number; pending: number }, now: number) {
    const n = st.pending;
    st.pending = 0;
    st.lastSent = now;
    await this.sendToUser(
      owner,
      {
        kind: 'prayer',
        title: PRAYER_TITLE,
        body: n > 1 ? `등불 언덕에서 ${n}번의 기도가 더해졌어요` : '등불 언덕에서 기도가 더해졌어요',
        url: '/',
        tag: 'prayer',
      },
      12 * 3600,
    );
  }

  private async flushPrayers(now: number): Promise<number> {
    let sent = 0;
    for (const [owner, st] of this.prayerState) {
      if (st.pending > 0 && now - st.lastSent >= PRAYER_WINDOW_MS) {
        await this.sendPrayers(owner, st, now);
        sent++;
      } else if (st.pending === 0 && now - st.lastSent > PRAYER_WINDOW_MS) {
        this.prayerState.delete(owner);
      }
    }
    return sent;
  }
}
