import {
  isPropId,
  kstDateOf,
  PROP_IDS,
  PROP_REMIND_MS,
  PROPS,
  SHOP_DAILY_LIMIT,
  SHOP_MAX_ACTIVE,
  SHOP_STOCK_MAX,
  SHOP_WINDOWS,
  shopWindowAt,
  type MyShop,
  type PropId,
  type PropWear,
  type Rental,
  type ShopStatus,
} from '../../shared/protocol.js';
import type { DB } from './db.js';
import { HttpError } from './http.js';
import type { PushService } from './push.js';

const DAY_MS = 86_400_000;
/** Rental records (and the request log) are deleted this long after they end. */
export const RENTAL_KEEP_DAYS = 30;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface RentalRow {
  id: number;
  user_id: number;
  request_id: string;
  item: string;
  slot: string;
  kst_date: string;
  win: number;
  started_at: number;
  ends_at: number;
  status: Rental['status'];
  ended_at: number | null;
  reminded_at: number | null;
}

interface RequestRow {
  request_id: string;
  user_id: number;
  item: string;
  rental_id: number | null;
  status: number;
  error: string | null;
  message: string | null;
  created_at: number;
}

/** What the realtime room is told. */
export interface ShopEvents {
  /** Someone's worn props changed: everyone sees it. */
  propsChanged(userId: number): void;
  /** Open/closed or stock changed: refresh everyone's shop status. */
  shopChanged(): void;
  /** That account's own rentals changed (ended: props that just expired). */
  myShopChanged(userId: number, ended?: PropId[]): void;
  /** 10 minutes left (once per rental). */
  propReminder(userId: number, item: PropId, endsAt: number): void;
}

export type RentOutcome =
  | { ok: true; status: 200; rental: Rental; replayed: boolean }
  | { ok: false; status: number; error: string; message: string; replayed: boolean };

const toRental = (r: RentalRow): Rental => ({
  id: r.id,
  item: r.item as PropId,
  slot: PROPS[r.item as PropId]?.slot ?? (r.slot as Rental['slot']),
  startedAt: r.started_at,
  endsAt: r.ends_at,
  status: r.status,
});

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * 나눔 소품 가게 (M9). The server clock decides everything: which window is
 * open, stock, expiry and reminders. Renting is idempotent per client
 * requestId (UUID v4): the first outcome, success or refusal, is stored and a
 * repeat gets exactly that answer back without touching anything.
 */
export class ShopService {
  /** Injectable clock (tests move it; never in production). */
  now: () => number = () => Date.now();
  events: ShopEvents | null = null;
  private lastWindowKey = '';
  private ticking = false;

  constructor(
    private readonly db: DB,
    private readonly push: PushService | null = null,
  ) {}

  // ---------------------------------------------------------------- stock

  private defaultStock(item: PropId): number {
    const row = this.db.prepare('SELECT stock FROM shop_defaults WHERE item = ?').get(item) as { stock: number } | undefined;
    return row ? row.stock : PROPS[item].stock;
  }

  /**
   * Release a window's stock: INSERT OR IGNORE keyed by (date, window, item),
   * so running it again (every tick, after a restart mid-window) never adds more.
   */
  ensureStock(date: string, win: number): number {
    const insert = this.db.prepare('INSERT OR IGNORE INTO shop_stock (kst_date, win, item, total, remaining, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const now = this.now();
    let added = 0;
    this.db.transaction(() => {
      for (const item of PROP_IDS) {
        const n = this.defaultStock(item);
        added += insert.run(date, win, item, n, n, now).changes;
      }
    })();
    return added;
  }

  private stockRows(date: string, win: number) {
    return this.db.prepare('SELECT item, total, remaining FROM shop_stock WHERE kst_date = ? AND win = ?').all(date, win) as {
      item: string;
      total: number;
      remaining: number;
    }[];
  }

  status(now = this.now()): ShopStatus {
    const w = shopWindowAt(now);
    const stock: ShopStatus['stock'] = {};
    if (w.open && w.win !== null) {
      let rows = this.stockRows(w.date, w.win);
      if (rows.length < PROP_IDS.length) {
        this.ensureStock(w.date, w.win);
        rows = this.stockRows(w.date, w.win);
      }
      for (const r of rows) if (isPropId(r.item)) stock[r.item] = { remaining: r.remaining, total: r.total };
    }
    return { ...w, now, stock };
  }

  // ---------------------------------------------------------------- mine

  private activeRows(userId: number, now: number): RentalRow[] {
    return this.db
      .prepare("SELECT * FROM rentals WHERE user_id = ? AND status = 'active' AND ends_at > ? ORDER BY started_at")
      .all(userId, now) as RentalRow[];
  }

  usedToday(userId: number, now = this.now()): number {
    const row = this.db.prepare('SELECT count FROM rental_days WHERE user_id = ? AND kst_date = ?').get(userId, kstDateOf(now)) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  mine(userId: number, now = this.now()): MyShop {
    return { rentals: this.activeRows(userId, now).map(toRental), usedToday: this.usedToday(userId, now), dailyLimit: SHOP_DAILY_LIMIT, now };
  }

  /** What others see on this account's avatar. */
  activeProps(userId: number, now = this.now()): PropWear[] {
    return this.activeRows(userId, now)
      .filter((r) => isPropId(r.item))
      .map((r) => ({ item: r.item as PropId, slot: PROPS[r.item as PropId].slot }));
  }

  // ---------------------------------------------------------------- rent

  /**
   * Borrow a prop. One BEGIN IMMEDIATE transaction: replay check, window,
   * limits, stock decrement, daily count, rental insert and the request log.
   */
  rent(userId: number, rawRequestId: unknown, rawItem: unknown): RentOutcome {
    const requestId = typeof rawRequestId === 'string' ? rawRequestId.toLowerCase() : '';
    if (!UUID_V4.test(requestId)) throw new HttpError(400, 'bad_request_id', '요청 번호가 올바르지 않아요. 새로고침 후 다시 시도해 주세요.');
    if (!isPropId(rawItem)) throw new HttpError(400, 'bad_item', '없는 소품이에요.');
    const item = rawItem;
    const now = this.now();
    // Overdue rentals end first, so they don't count against slots or limits.
    this.expireDue(now);

    const outcome = this.db
      .transaction((): RentOutcome => {
        const prior = this.db.prepare('SELECT * FROM rental_requests WHERE request_id = ?').get(requestId) as RequestRow | undefined;
        if (prior) return this.replay(prior, userId, item);

        const refuse = (status: number, error: string, message: string): RentOutcome => {
          this.db
            .prepare('INSERT INTO rental_requests (request_id, user_id, item, rental_id, status, error, message, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)')
            .run(requestId, userId, item, status, error, message, now);
          return { ok: false, status, error, message, replayed: false };
        };

        const w = shopWindowAt(now);
        if (!w.open || w.win === null) return refuse(409, 'shop_closed', `지금은 가게 문이 닫혀 있어요. ${hhmm(SHOP_WINDOWS[w.nextWin].start)}에 다시 열어요.`);
        const def = PROPS[item];
        const active = this.activeRows(userId, now);
        if (active.some((r) => r.item === item)) return refuse(409, 'already_renting', `이미 ${def.name}을(를) 빌려 쓰고 있어요.`);
        const used = this.usedToday(userId, now);
        if (used >= SHOP_DAILY_LIMIT) return refuse(409, 'daily_limit', `오늘 대여 ${SHOP_DAILY_LIMIT}회를 모두 썼어요. 내일 다시 빌릴 수 있어요.`);
        if (active.some((r) => r.slot === def.slot)) return refuse(409, 'slot_busy', '같은 자리에 쓰는 소품을 이미 빌렸어요. 반납한 뒤 빌릴 수 있어요.');
        if (active.length >= SHOP_MAX_ACTIVE) return refuse(409, 'max_active', `소품은 한 번에 ${SHOP_MAX_ACTIVE}개까지 쓸 수 있어요.`);

        // Stock rows exist from the window's opening; make sure (restart, fake clock).
        this.ensureStock(w.date, w.win);
        const took = this.db
          .prepare('UPDATE shop_stock SET remaining = remaining - 1 WHERE kst_date = ? AND win = ? AND item = ? AND remaining > 0')
          .run(w.date, w.win, item).changes;
        if (!took) return refuse(409, 'sold_out', `${def.name}은(는) 이번 시간에 모두 나갔어요. 다음 문 여는 시간에 다시 들어와요.`);

        this.db
          .prepare('INSERT INTO rental_days (user_id, kst_date, count) VALUES (?, ?, 1) ON CONFLICT(user_id, kst_date) DO UPDATE SET count = count + 1')
          .run(userId, w.date);
        const info = this.db
          .prepare('INSERT INTO rentals (user_id, request_id, item, slot, kst_date, win, started_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(userId, requestId, item, def.slot, w.date, w.win, now, now + def.minutes * 60_000);
        const rentalId = Number(info.lastInsertRowid);
        this.db
          .prepare('INSERT INTO rental_requests (request_id, user_id, item, rental_id, status, error, message, created_at) VALUES (?, ?, ?, ?, 200, NULL, NULL, ?)')
          .run(requestId, userId, item, rentalId, now);
        const row = this.db.prepare('SELECT * FROM rentals WHERE id = ?').get(rentalId) as RentalRow;
        return { ok: true, status: 200, rental: toRental(row), replayed: false };
      })
      .immediate();

    if (outcome.ok && !outcome.replayed) {
      this.events?.propsChanged(userId);
      this.events?.myShopChanged(userId);
      this.events?.shopChanged();
    }
    return outcome;
  }

  /** The stored first outcome for a repeated requestId. */
  private replay(prior: RequestRow, userId: number, item: PropId): RentOutcome {
    // Another account's key (or a different item under the same key) is never answered with that result.
    if (prior.user_id !== userId || prior.item !== item) {
      return { ok: false, status: 409, error: 'request_conflict', message: '이미 쓰인 요청 번호예요. 새로고침 후 다시 시도해 주세요.', replayed: true };
    }
    if (prior.error === null) {
      const row = (prior.rental_id !== null ? this.db.prepare('SELECT * FROM rentals WHERE id = ?').get(prior.rental_id) : undefined) as RentalRow | undefined;
      if (row) return { ok: true, status: 200, rental: toRental(row), replayed: true };
      return { ok: false, status: 410, error: 'rental_gone', message: '이 대여 기록은 이미 지워졌어요.', replayed: true };
    }
    return { ok: false, status: prior.status, error: prior.error, message: prior.message ?? '', replayed: true };
  }

  // ---------------------------------------------------------------- return / expiry

  /** Early 반납. Idempotent: an already returned or expired rental is a success no-op. */
  returnRental(userId: number, rawId: unknown): { ok: true; already: boolean; rental: Rental } {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'bad_rental', '대여 번호가 올바르지 않아요.');
    const now = this.now();
    this.expireDue(now);
    const changed = this.db
      .prepare("UPDATE rentals SET status = 'returned', ended_at = ? WHERE id = ? AND user_id = ? AND status = 'active'")
      .run(now, id, userId).changes;
    const row = this.db.prepare('SELECT * FROM rentals WHERE id = ? AND user_id = ?').get(id, userId) as RentalRow | undefined;
    if (!row) throw new HttpError(404, 'not_found', '대여 기록을 찾을 수 없어요.');
    if (changed) {
      this.events?.propsChanged(userId);
      this.events?.myShopChanged(userId);
    }
    return { ok: true, already: changed === 0, rental: toRental(row) };
  }

  /**
   * End every rental whose time is up: one UPDATE … WHERE status = 'active' AND
   * ends_at <= now. Safe to run any number of times (also after a restart);
   * only the rows this run changed are announced, so each expiry is announced once.
   */
  expireDue(now = this.now()): number {
    const rows = this.db
      .prepare("UPDATE rentals SET status = 'expired', ended_at = ends_at WHERE status = 'active' AND ends_at <= ? RETURNING user_id, item")
      .all(now) as { user_id: number; item: string }[];
    if (rows.length) {
      const byUser = new Map<number, PropId[]>();
      for (const r of rows) if (isPropId(r.item)) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r.item]);
      for (const [userId, items] of byUser) {
        this.events?.propsChanged(userId);
        this.events?.myShopChanged(userId, items);
      }
    }
    return rows.length;
  }

  /** 10 minutes left: in-app toast + push (if enabled for 소품 만료 알림). Claimed first, so at most once per rental. */
  async remindDue(now = this.now()): Promise<number> {
    const due = this.db
      .prepare("SELECT id, user_id, item, ends_at FROM rentals WHERE status = 'active' AND reminded_at IS NULL AND ends_at > ? AND ends_at <= ?")
      .all(now, now + PROP_REMIND_MS) as { id: number; user_id: number; item: string; ends_at: number }[];
    let sent = 0;
    for (const r of due) {
      const claimed = this.db.prepare('UPDATE rentals SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL').run(now, r.id).changes;
      if (!claimed || !isPropId(r.item)) continue;
      sent++;
      this.events?.propReminder(r.user_id, r.item, r.ends_at);
      if (this.push?.enabled) {
        const prefs = this.db.prepare('SELECT props FROM push_prefs WHERE user_id = ?').get(r.user_id) as { props: number } | undefined;
        if (prefs && prefs.props === 1) {
          const def = PROPS[r.item];
          await this.push
            .sendToUser(
              r.user_id,
              { kind: 'prop', title: `⏰ ${def.name} 사용 시간이 10분 남았어요`, body: '시간이 다 되면 소품은 가게로 돌아가요.', url: '/?props=1', tag: `prop-${r.id}` },
              Math.max(60, Math.round((r.ends_at - now) / 1000)),
            )
            .catch((e) => console.error('push prop reminder', e));
        }
      }
    }
    return sent;
  }

  /** Every second: window opened/closed (release stock), expiry, reminders. */
  async tick(now = this.now()): Promise<{ windowChanged: boolean; expired: number; reminded: number }> {
    if (this.ticking) return { windowChanged: false, expired: 0, reminded: 0 };
    this.ticking = true;
    try {
      const w = shopWindowAt(now);
      const key = w.open ? `${w.date}:${w.win}` : 'closed';
      const windowChanged = key !== this.lastWindowKey;
      if (windowChanged) {
        this.lastWindowKey = key;
        if (w.open && w.win !== null) this.ensureStock(w.date, w.win);
        this.events?.shopChanged();
      }
      const expired = this.expireDue(now);
      const reminded = await this.remindDue(now);
      return { windowChanged, expired, reminded };
    } finally {
      this.ticking = false;
    }
  }

  // ---------------------------------------------------------------- admin

  adminOverview(now = this.now()) {
    const date = kstDateOf(now);
    const cur = shopWindowAt(now);
    const midnight = Math.floor((now + 9 * 3600_000) / DAY_MS) * DAY_MS - 9 * 3600_000;
    const windows = SHOP_WINDOWS.map((w, win) => {
      const rows = this.stockRows(date, win);
      const rentals = this.db.prepare('SELECT item, COUNT(*) n FROM rentals WHERE kst_date = ? AND win = ? GROUP BY item').all(date, win) as { item: string; n: number }[];
      const state = cur.open && cur.win === win && cur.date === date ? 'open' : now >= midnight + w.end * 60_000 ? 'past' : 'upcoming';
      return {
        win,
        start: hhmm(w.start),
        end: hhmm(w.end),
        state,
        released: rows.length > 0,
        items: PROP_IDS.map((item) => {
          const r = rows.find((x) => x.item === item);
          const total = r ? r.total : this.defaultStock(item);
          return { item, total, remaining: r ? r.remaining : total, rented: rentals.find((x) => x.item === item)?.n ?? 0 };
        }),
        rentals: rentals.reduce((n, x) => n + x.n, 0),
      };
    });
    const defaults = PROP_IDS.map((item) => ({ item, stock: this.defaultStock(item), base: PROPS[item].stock }));
    const activeNow = (this.db.prepare("SELECT COUNT(*) n FROM rentals WHERE status = 'active' AND ends_at > ?").get(now) as { n: number }).n;
    return { date, now, windows, defaults, activeNow };
  }

  private adminStock(raw: unknown): number {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > SHOP_STOCK_MAX) throw new HttpError(400, 'bad_stock', `수량은 0~${SHOP_STOCK_MAX} 사이로 정해 주세요.`);
    return n;
  }

  /** Stock for one of today's windows that is open or still to come (past windows are history). */
  adminSetWindowStock(rawWin: unknown, rawItem: unknown, rawTotal: unknown) {
    const win = Number(rawWin);
    if (!Number.isInteger(win) || win < 0 || win >= SHOP_WINDOWS.length) throw new HttpError(400, 'bad_window', '시간대가 올바르지 않아요.');
    if (!isPropId(rawItem)) throw new HttpError(400, 'bad_item', '없는 소품이에요.');
    const total = this.adminStock(rawTotal);
    const now = this.now();
    const date = kstDateOf(now);
    const midnight = Math.floor((now + 9 * 3600_000) / DAY_MS) * DAY_MS - 9 * 3600_000;
    if (now >= midnight + SHOP_WINDOWS[win].end * 60_000) throw new HttpError(409, 'past_window', '이미 지난 시간대는 바꿀 수 없어요.');
    this.db
      .transaction(() => {
        const row = this.db.prepare('SELECT total, remaining FROM shop_stock WHERE kst_date = ? AND win = ? AND item = ?').get(date, win, rawItem) as
          | { total: number; remaining: number }
          | undefined;
        if (!row) {
          // Not released yet: set it now; the opening's INSERT OR IGNORE keeps it.
          this.db.prepare('INSERT INTO shop_stock (kst_date, win, item, total, remaining, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(date, win, rawItem, total, total, now);
        } else {
          const rented = row.total - row.remaining;
          const t = Math.max(total, rented);
          this.db.prepare('UPDATE shop_stock SET total = ?, remaining = ? WHERE kst_date = ? AND win = ? AND item = ?').run(t, t - rented, date, win, rawItem);
        }
      })
      .immediate();
    this.events?.shopChanged();
    return this.adminOverview(now);
  }

  /** Default per-window stock for windows not released yet. */
  adminSetDefault(rawItem: unknown, rawStock: unknown) {
    if (!isPropId(rawItem)) throw new HttpError(400, 'bad_item', '없는 소품이에요.');
    const stock = this.adminStock(rawStock);
    this.db
      .prepare('INSERT INTO shop_defaults (item, stock, updated_at) VALUES (?, ?, ?) ON CONFLICT(item) DO UPDATE SET stock = excluded.stock, updated_at = excluded.updated_at')
      .run(rawItem, stock, this.now());
    return this.adminOverview();
  }

  // ---------------------------------------------------------------- data rights

  /** For 내 데이터 내려받기. */
  export(userId: number) {
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    const rows = this.db.prepare('SELECT * FROM rentals WHERE user_id = ? ORDER BY started_at').all(userId) as RentalRow[];
    const days = this.db.prepare('SELECT kst_date, count FROM rental_days WHERE user_id = ? ORDER BY kst_date').all(userId) as { kst_date: string; count: number }[];
    const refused = this.db
      .prepare('SELECT item, error, created_at FROM rental_requests WHERE user_id = ? AND error IS NOT NULL ORDER BY created_at')
      .all(userId) as { item: string; error: string; created_at: number }[];
    return {
      rentals: rows.map((r) => ({
        item: r.item,
        name: PROPS[r.item as PropId]?.name ?? r.item,
        slot: r.slot,
        date: r.kst_date,
        window: SHOP_WINDOWS[r.win] ? `${hhmm(SHOP_WINDOWS[r.win].start)}–${hhmm(SHOP_WINDOWS[r.win].end)}` : String(r.win),
        startedAt: iso(r.started_at),
        endsAt: iso(r.ends_at),
        status: r.status,
        endedAt: iso(r.ended_at),
        remindedAt: iso(r.reminded_at),
      })),
      rentalsPerDay: days.map((d) => ({ date: d.kst_date, count: d.count })),
      refusedRequests: refused.map((r) => ({ item: r.item, reason: r.error, at: iso(r.created_at) })),
      retentionDays: RENTAL_KEEP_DAYS,
    };
  }

  /** Hourly 파기: rental records, request logs, day counts and stock rows 30 days after they end. */
  sweep(now = Date.now()): number {
    const cutoff = now - RENTAL_KEEP_DAYS * DAY_MS;
    const cutDate = kstDateOf(cutoff);
    return this.db
      .transaction(() => {
        let n = this.db.prepare("DELETE FROM rentals WHERE status <> 'active' AND COALESCE(ended_at, ends_at) < ?").run(cutoff).changes;
        n += this.db.prepare('DELETE FROM rental_requests WHERE created_at < ? AND (rental_id IS NULL OR rental_id NOT IN (SELECT id FROM rentals))').run(cutoff).changes;
        this.db.prepare('DELETE FROM rental_days WHERE kst_date < ?').run(cutDate);
        this.db.prepare('DELETE FROM shop_stock WHERE kst_date < ?').run(cutDate);
        return n;
      })
      .immediate();
  }
}
