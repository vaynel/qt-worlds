import {
  isPropId,
  kstDateOf,
  kstTimeOf,
  PROPS,
  SHOP_DAILY_LIMIT,
  SHOP_MAX_ACTIVE,
  type MyShop,
  type PropId,
  type PropWear,
  type Rental,
  type ShopStatus,
} from '../../../shared/protocol';

/** UUID v4 (crypto.randomUUID needs a secure context; LAN http dev doesn't have one). */
export function uuid4(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export type RentResult = { ok: true; rental: Rental } | { ok: false; code: string; message: string };

/** Why a prop can't be rented right now (null = it can), in the order the sheet shows them. */
export type RentBlock = 'login' | 'closed' | 'pending' | 'renting' | 'sold_out' | 'daily' | 'slot' | 'max';

export const BLOCK_LABELS: Record<RentBlock, string> = {
  login: '로그인 필요',
  closed: '문 닫힘',
  pending: '빌리는 중…',
  renting: '사용 중',
  sold_out: '품절',
  daily: `오늘 ${SHOP_DAILY_LIMIT}회 모두 사용`,
  slot: '같은 자리 소품 사용 중',
  max: `${SHOP_MAX_ACTIVE}개까지 쓸 수 있어요`,
};

const RETRIES = 3;

/**
 * Client side of 나눔 소품 가게. Never guesses: everything shown comes from
 * the server (status, stock, my rentals, ends_at), with the clock offset taken
 * from the server's `now`. Renting sends one requestId per tap and reuses it
 * for retries (timeouts, network errors), so the server applies it once.
 */
export class ShopClient {
  status: ShopStatus | null = null;
  mine: MyShop | null = null;
  /** server time − local time (ms). */
  offset = 0;
  /** item -> requestId while a rent call is in flight (the button stays locked). */
  readonly pending = new Map<PropId, string>();
  /** rental id -> in flight. */
  readonly returning = new Set<number>();
  private listeners: (() => void)[] = [];
  /** Test hook: the requestIds actually sent (to check retries reuse them). */
  readonly sentIds: string[] = [];

  constructor(private readonly signedIn: () => boolean) {}

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  serverNow(): number {
    return Date.now() + this.offset;
  }

  /** Any server message that carries the server's time keeps the offset fresh. */
  syncClock(serverNow: number) {
    if (typeof serverNow !== 'number' || !Number.isFinite(serverNow)) return;
    this.offset = serverNow - Date.now();
    this.changed();
  }

  setStatus(s: ShopStatus) {
    if (!s || typeof s.now !== 'number') return;
    this.status = s;
    this.offset = s.now - Date.now();
    this.changed();
  }

  setMine(m: MyShop | null) {
    if (m && typeof m.now === 'number') this.offset = m.now - Date.now();
    this.mine = m ? { ...m, rentals: (m.rentals ?? []).filter((r) => isPropId(r.item)) } : null;
    this.changed();
  }

  /** Full re-sync over HTTP (sheet opened, after errors). */
  async refresh(): Promise<void> {
    try {
      const res = await fetch('/api/shop', { credentials: 'same-origin' });
      if (!res.ok) return;
      const d = (await res.json()) as { shop: ShopStatus; mine: MyShop | null };
      if (d.shop) this.setStatus(d.shop);
      this.setMine(d.mine ?? null);
    } catch {
      /* offline: keep what we have */
    }
  }

  get open(): boolean {
    return !!this.status?.open;
  }

  /** Active rentals as the server last told us (ordered by start). */
  get rentals(): Rental[] {
    return this.mine?.rentals ?? [];
  }

  get props(): PropWear[] {
    return this.rentals.map((r) => ({ item: r.item, slot: PROPS[r.item].slot }));
  }

  /** "18:00" or "내일 06:00" for the next opening. */
  nextOpenLabel(): string {
    const s = this.status;
    if (!s) return '';
    const t = kstTimeOf(s.nextOpenAt);
    return kstDateOf(s.nextOpenAt) === kstDateOf(this.serverNow()) ? t : `내일 ${t}`;
  }

  closesLabel(): string {
    return this.status?.closesAt ? kstTimeOf(this.status.closesAt) : '';
  }

  block(item: PropId): RentBlock | null {
    if (!this.signedIn()) return 'login';
    if (!this.open) return 'closed';
    if (this.pending.has(item)) return 'pending';
    const active = this.rentals;
    if (active.some((r) => r.item === item)) return 'renting';
    const stock = this.status?.stock[item];
    if (!stock || stock.remaining <= 0) return 'sold_out';
    if ((this.mine?.usedToday ?? 0) >= (this.mine?.dailyLimit ?? SHOP_DAILY_LIMIT)) return 'daily';
    if (active.some((r) => PROPS[r.item].slot === PROPS[item].slot)) return 'slot';
    if (active.length >= SHOP_MAX_ACTIVE) return 'max';
    return null;
  }

  /** Remaining ms of a rental by the server's clock (display only; the server ends it). */
  remainingMs(r: Rental): number {
    return r.endsAt - this.serverNow();
  }

  /**
   * Rent with a fresh requestId; network failures and timeouts retry with the
   * same id. The UI stays locked until an answer arrives.
   */
  async rent(item: PropId, requestId = uuid4()): Promise<RentResult> {
    if (this.pending.has(item)) return { ok: false, code: 'pending', message: '빌리는 중이에요.' };
    this.pending.set(item, requestId);
    this.changed();
    try {
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          this.sentIds.push(requestId);
          res = await fetch('/api/shop/rent', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestId, item }),
            signal: AbortSignal.timeout(8000),
          });
        } catch {
          if (attempt + 1 >= RETRIES) {
            void this.refresh();
            return { ok: false, code: 'network', message: '연결이 불안정해요. 빌렸는지 다시 확인했어요. 잠시 후 다시 시도해 주세요.' };
          }
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          continue;
        }
        let d: { ok?: boolean; rental?: Rental; error?: string; message?: string; shop?: ShopStatus; mine?: MyShop } = {};
        try {
          d = await res.json();
        } catch {
          /* empty */
        }
        if (d.shop) this.setStatus(d.shop);
        if (d.mine) this.setMine(d.mine);
        if (res.status >= 500 && attempt + 1 < RETRIES) {
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          continue;
        }
        if (res.ok && d.rental) return { ok: true, rental: d.rental };
        if (!d.error) {
          // Ambiguous answer (no JSON error, e.g. a proxy hiccup): the server may
          // have rented it anyway. Never guess: re-sync, then report what is true.
          await this.refresh();
          const got = this.rentals.find((r) => r.item === item);
          if (got) return { ok: true, rental: got };
          if (attempt + 1 < RETRIES) {
            // Same requestId, so a retry can't double-rent (server replays).
            await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
            continue;
          }
        }
        return { ok: false, code: d.error ?? 'error', message: d.message ?? '빌리지 못했어요.' };
      }
    } finally {
      this.pending.delete(item);
      this.changed();
    }
  }

  async giveBack(rentalId: number): Promise<{ ok: boolean; message?: string }> {
    if (this.returning.has(rentalId)) return { ok: false };
    this.returning.add(rentalId);
    this.changed();
    try {
      for (let attempt = 0; attempt < RETRIES; attempt++) {
        try {
          const res = await fetch('/api/shop/return', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rentalId }),
            signal: AbortSignal.timeout(8000),
          });
          const d = (await res.json().catch(() => ({}))) as { mine?: MyShop; message?: string };
          if (d.mine) this.setMine(d.mine);
          if (res.ok) return { ok: true };
          if (res.status < 500) return { ok: false, message: d.message };
        } catch {
          /* retry: returning twice is harmless */
        }
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
      void this.refresh();
      return { ok: false, message: '반납하지 못했어요. 잠시 후 다시 시도해 주세요.' };
    } finally {
      this.returning.delete(rentalId);
      this.changed();
    }
  }

  describe() {
    return {
      status: this.status,
      mine: this.mine,
      offset: this.offset,
      pending: [...this.pending.keys()],
      sentIds: [...this.sentIds],
    };
  }
}

/** "47분" / "1분 미만" / "곧 끝나요". */
export function minutesLeft(ms: number): string {
  if (ms <= 0) return '곧 끝나요';
  if (ms < 60_000) return '1분 미만';
  return `${Math.ceil(ms / 60_000)}분`;
}
