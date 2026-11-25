import { el, Modal } from './dom';

/** Every first-time tip, in the order they usually come up. */
export const TIP_IDS = ['letter', 'word', 'seat', 'chat', 'lantern', 'library', 'share', 'emote'] as const;
export type TipId = (typeof TIP_IDS)[number];

/** Where a tip points: a DOM element, or a point on screen (a 3D spot projected by the game). */
export type TipAnchor = HTMLElement | { x: number; y: number } | null;

interface Tip {
  id: TipId;
  text: string;
  anchor: () => TipAnchor;
}

const STORE_KEY = 'worlds.tips.seen';
/** A tip hides by itself after this many seconds on screen. */
const SHOW_SECONDS = 8;
/** A tip whose target has been off screen this long steps back into the queue. */
const LOST_SECONDS = 1.5;
const GAP = 10;
const MARGIN = 8;

/**
 * HUD pieces a tip must never cover (unless it points at one of them, and
 * then it sits beside it). Checked only while a tip is placed.
 */
const CRITICAL = ['#tools', '.chat-head-btn', '.place-card', '.clock-card', '#prompt', '#action-btn', '#meditate-btn', '#letter-btn', '#chat-form', '#chat-pill', '#emote-btn', '#camera-btn', '#stick-base', '#closet-ui', '#library-exit', '.prop-dock', '.voice-chip'];

type Rect = { left: number; top: number; right: number; bottom: number };
const overlaps = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Contextual first-time tips ("coach marks"): a small bubble with an arrow
 * that points at the real button or 3D spot at the moment it is useful.
 * Each tip shows once per device (localStorage), one at a time (the rest
 * wait in a queue), never while a sheet is open, and goes away when tapped,
 * when the action is done, or after about 8 s.
 */
export class CoachTips {
  private readonly root = el('div', 'coach-tip');
  private readonly textEl = el('span', 'coach-tip-text');
  private seen = new Set<TipId>();
  private readonly queue: Tip[] = [];
  private current: Tip | null = null;
  private shownFor = 0;
  private lostFor = 0;
  private visible = false;
  private lastTick = performance.now() / 1000;
  /** Every tip shown in this page's life, in order (tests). */
  readonly history: TipId[] = [];

  constructor(readonly enabled: boolean) {
    this.root.id = 'coach-tip';
    this.root.setAttribute('role', 'status');
    this.root.append(this.textEl);
    this.root.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.root.addEventListener('click', () => this.current && this.done(this.current.id));
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
      if (Array.isArray(raw)) for (const id of raw) if ((TIP_IDS as readonly string[]).includes(id)) this.seen.add(id as TipId);
    } catch {
      /* private mode: tips simply show again next time */
    }
    if (enabled) document.getElementById('app')?.append(this.root);
  }

  /** Ask for a tip; ignored when it was seen, is showing or is already waiting. */
  request(id: TipId, text: string, anchor: () => TipAnchor) {
    if (!this.enabled || this.seen.has(id) || this.current?.id === id || this.queue.some((t) => t.id === id)) return;
    this.queue.push({ id, text, anchor });
  }

  /** The action was done (or the tip tapped): never show this tip again. */
  done(id: TipId) {
    if (!this.enabled || this.seen.has(id)) return;
    this.seen.add(id);
    this.save();
    const i = this.queue.findIndex((t) => t.id === id);
    if (i >= 0) this.queue.splice(i, 1);
    if (this.current?.id === id) this.clear();
  }

  isSeen(id: TipId): boolean {
    return this.seen.has(id);
  }

  /** ⚙ → ❓ 사용 안내 → 도움말 다시 보기. */
  reset() {
    this.seen.clear();
    this.queue.length = 0;
    this.clear();
    this.save();
  }

  /** Once per frame. blocked: a sheet or a full-screen card is up, or a transition is running. */
  update(blocked: boolean) {
    if (!this.enabled) return;
    // Wall-clock seconds (the game's dt is clamped per frame, so slow devices would keep tips up longer).
    const now = performance.now() / 1000;
    const dt = Math.min(0.5, Math.max(0, now - this.lastTick));
    this.lastTick = now;
    if (!this.current) {
      if (blocked) return;
      // Take the first waiting tip whose target is on screen right now.
      const i = this.queue.findIndex((t) => this.rectOf(t.anchor()) !== null);
      if (i < 0) return;
      this.current = this.queue.splice(i, 1)[0];
      this.shownFor = 0;
      this.textEl.textContent = this.current.text;
      this.root.dataset.tip = this.current.id;
      this.lostFor = 0;
    }
    const sheet = blocked || Modal.anyOpen;
    const target = sheet ? null : this.rectOf(this.current.anchor());
    if (!target || !this.place(target)) {
      this.setVisible(false);
      // Under a sheet it waits; but if its target is simply gone (walked away), let the next tip go first.
      if (!sheet && (this.lostFor += dt) > LOST_SECONDS) {
        this.queue.push(this.current);
        this.clear();
      }
      return;
    }
    this.lostFor = 0;
    this.setVisible(true);
    if (!this.history.includes(this.current.id)) this.history.push(this.current.id);
    this.shownFor += dt;
    if (this.shownFor >= SHOW_SECONDS) this.done(this.current.id);
  }

  private clear() {
    this.current = null;
    this.setVisible(false);
    delete this.root.dataset.tip;
  }

  private setVisible(v: boolean) {
    if (this.visible === v) return;
    this.visible = v;
    this.root.classList.toggle('on', v);
  }

  private save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify([...this.seen]));
    } catch {
      /* ignore */
    }
  }

  private rectOf(anchor: TipAnchor): Rect | null {
    if (!anchor) return null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (anchor instanceof HTMLElement) {
      if (anchor.hidden || !anchor.isConnected) return null;
      const r = anchor.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) return null;
      if (anchor.checkVisibility?.({ visibilityProperty: true }) === false) return null;
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    if (anchor.x < 12 || anchor.y < 12 || anchor.x > vw - 12 || anchor.y > vh - 12) return null;
    return { left: anchor.x - 14, top: anchor.y - 14, right: anchor.x + 14, bottom: anchor.y + 14 };
  }

  /** Above the target, else below, else beside it: the first spot that covers nothing important. */
  private place(t: Rect): boolean {
    // Laid out even while hidden (visibility only), so it can be measured.
    const r = this.root;
    const w = r.offsetWidth;
    const h = r.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cx = (t.left + t.right) / 2;
    const cy = (t.top + t.bottom) / 2;
    const clampX = (x: number) => Math.max(MARGIN, Math.min(vw - MARGIN - w, x));
    const clampY = (y: number) => Math.max(MARGIN, Math.min(vh - MARGIN - h, y));
    const spots: { side: 'top' | 'bottom' | 'left' | 'right'; x: number; y: number }[] = [
      { side: 'top', x: clampX(cx - w / 2), y: t.top - GAP - h },
      { side: 'bottom', x: clampX(cx - w / 2), y: t.bottom + GAP },
      { side: 'left', x: t.left - GAP - w, y: clampY(cy - h / 2) },
      { side: 'right', x: t.right + GAP, y: clampY(cy - h / 2) },
    ];
    const blockers: Rect[] = [];
    for (const sel of CRITICAL) {
      for (const node of document.querySelectorAll<HTMLElement>(sel)) {
        if (node.hidden || node.checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) === false) continue;
        const b = node.getBoundingClientRect();
        if (b.width < 1 || b.height < 1) continue;
        blockers.push({ left: b.left, top: b.top, right: b.right, bottom: b.bottom });
      }
    }
    for (const s of spots) {
      const box = { left: s.x, top: s.y, right: s.x + w, bottom: s.y + h };
      if (box.left < MARGIN - 0.5 || box.top < MARGIN - 0.5 || box.right > vw - MARGIN + 0.5 || box.bottom > vh - MARGIN + 0.5) continue;
      if (blockers.some((b) => overlaps(box, b))) continue;
      r.style.left = `${Math.round(s.x)}px`;
      r.style.top = `${Math.round(s.y)}px`;
      r.dataset.side = s.side;
      // The arrow points at the target's centre along the bubble's edge.
      if (s.side === 'top' || s.side === 'bottom') r.style.setProperty('--arrow', `${Math.round(Math.max(14, Math.min(w - 14, cx - s.x)))}px`);
      else r.style.setProperty('--arrow', `${Math.round(Math.max(12, Math.min(h - 12, cy - s.y)))}px`);
      return true;
    }
    return false;
  }

  describe() {
    return {
      enabled: this.enabled,
      current: this.current?.id ?? null,
      visible: this.visible,
      queued: this.queue.map((t) => t.id),
      seen: [...this.seen],
      history: [...this.history],
    };
  }
}
