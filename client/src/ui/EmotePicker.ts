import { EMOTES } from '../../../shared/protocol';
import { button, el } from './dom';

/**
 * 표현: a small round 😊 button in the bottom-right action cluster and a
 * compact 4×2 grid of the eight emotes above it. Desktop keys 1–8 fire
 * directly (Game forwards them). Hidden in the 골방 (private) by CSS.
 */
export class EmotePicker {
  readonly btn: HTMLButtonElement;
  private readonly grid: HTMLDivElement;
  private openNow = false;

  constructor(private readonly send: (e: number) => void) {
    this.btn = button('😊', 'emote-btn', () => this.toggle());
    this.btn.id = 'emote-btn';
    this.btn.setAttribute('aria-label', '표현하기');
    this.btn.setAttribute('aria-expanded', 'false');
    this.btn.setAttribute('aria-controls', 'emote-grid');
    this.btn.title = '표현하기 (숫자 1~8)';
    this.grid = el('div', 'emote-grid');
    this.grid.id = 'emote-grid';
    this.grid.setAttribute('role', 'menu');
    this.grid.setAttribute('aria-label', '표현');
    this.grid.hidden = true;
    EMOTES.forEach((def, i) => {
      const b = button('', 'emote-item', () => this.fire(i));
      b.dataset.e = String(i);
      b.setAttribute('role', 'menuitem');
      b.setAttribute('aria-label', `${def.label} ${def.emoji}`);
      b.title = `${def.label} (${i + 1})`;
      b.append(el('span', 'emote-emoji', def.emoji), el('span', 'emote-label', def.label));
      this.grid.append(b);
    });
    // Taps on the button or the grid must not start a camera drag.
    for (const n of [this.btn, this.grid]) n.addEventListener('pointerdown', (e) => e.stopPropagation());
    const app = document.getElementById('app')!;
    app.append(this.btn, this.grid);
    document.addEventListener('pointerdown', (e) => {
      if (this.openNow && !this.grid.contains(e.target as Node) && e.target !== this.btn) this.close();
    });
    window.addEventListener('keydown', (e) => {
      if (this.openNow && e.key === 'Escape') this.close();
    });
    window.addEventListener('worlds-modal', () => this.close());
  }

  get isOpen(): boolean {
    return this.openNow;
  }

  toggle() {
    if (this.openNow) this.close();
    else this.open();
  }

  open() {
    this.openNow = true;
    this.grid.hidden = false;
    this.btn.setAttribute('aria-expanded', 'true');
    this.btn.classList.add('on');
    this.place();
  }

  /**
   * Next to the button: above it, else to its left, else below — whichever
   * stays on screen and clear of the HUD tools.
   */
  private place() {
    const b = this.btn.getBoundingClientRect();
    // Layout size (the pop-in animation scales the box, so not getBoundingClientRect).
    const g = { width: this.grid.offsetWidth, height: this.grid.offsetHeight };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const m = 8;
    const clampX = (x: number) => Math.max(m, Math.min(vw - g.width - m, x));
    const clampY = (y: number) => Math.max(m, Math.min(vh - g.height - m, y));
    const avoid = [document.getElementById('tools')?.getBoundingClientRect() ?? null].filter((r): r is DOMRect => !!r && r.width > 0);
    const hits = (x: number, y: number) => avoid.some((r) => x < r.right && r.left < x + g.width && y < r.bottom && r.top < y + g.height);
    const candidates = [
      { x: clampX(b.right - g.width), y: b.top - g.height - m },
      { x: b.left - g.width - m, y: clampY(b.bottom - g.height) },
      { x: clampX(b.left), y: b.top - g.height - m },
      { x: clampX(b.right - g.width), y: b.bottom + m },
    ];
    const fits = (c: { x: number; y: number }) => c.x >= m - 0.5 && c.y >= m - 0.5 && c.x + g.width <= vw - m + 0.5 && c.y + g.height <= vh - m + 0.5;
    const pick = candidates.find((c) => fits(c) && !hits(c.x, c.y)) ?? candidates.find(fits) ?? { x: clampX(b.right - g.width), y: clampY(b.top - g.height - m) };
    this.grid.style.left = `${Math.round(pick.x)}px`;
    this.grid.style.top = `${Math.round(pick.y)}px`;
  }

  close() {
    if (!this.openNow) return;
    this.openNow = false;
    this.grid.hidden = true;
    this.btn.setAttribute('aria-expanded', 'false');
    this.btn.classList.remove('on');
  }

  fire(e: number) {
    this.close();
    this.btn.blur();
    this.send(e);
  }
}
