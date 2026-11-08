/** Tiny DOM helpers. Text always goes through textContent (never innerHTML). */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(label: string, className = '', onClick?: () => void): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** "2026년 11월 8일 일요일" from YYYY-MM-DD. */
export function koreanDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y}년 ${m}월 ${d}일 ${weekday}요일`;
}

/**
 * Modal sheet. Only one is open at a time; Esc closes; focus returns to the
 * element that opened it. Game input is paused while any modal is open.
 */
export class Modal {
  static current: Modal | null = null;
  readonly root: HTMLDivElement;
  readonly sheet: HTMLDivElement;
  private lastFocus: Element | null = null;
  private onCloseFn: (() => void) | null = null;

  constructor(
    className: string,
    private readonly label: string,
  ) {
    this.root = el('div', `overlay ${className}`);
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', label);
    this.sheet = el('div', 'sheet');
    this.root.append(this.sheet);
    this.root.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.target === this.root) this.close();
    });
    // Keys typed in the sheet never reach the game.
    this.root.addEventListener('keydown', (e) => e.stopPropagation());
  }

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && Modal.current === this) {
      e.preventDefault();
      this.close();
    }
  };

  static get anyOpen(): boolean {
    return Modal.current !== null;
  }

  open(onClose?: () => void) {
    if (Modal.current && Modal.current !== this) Modal.current.close();
    this.onCloseFn = onClose ?? null;
    this.lastFocus = document.activeElement;
    document.getElementById('app')!.append(this.root);
    document.body.classList.add('overlay-open');
    Modal.current = this;
    window.dispatchEvent(new Event('worlds-modal'));
    window.addEventListener('keydown', this.onKey, true);
    requestAnimationFrame(() => this.root.classList.add('shown'));
  }

  close() {
    if (Modal.current !== this) return;
    Modal.current = null;
    window.removeEventListener('keydown', this.onKey, true);
    this.root.classList.remove('shown');
    this.root.remove();
    document.body.classList.remove('overlay-open');
    window.dispatchEvent(new Event('worlds-modal'));
    if (this.lastFocus instanceof HTMLElement) this.lastFocus.blur();
    window.scrollTo(0, 0);
    const fn = this.onCloseFn;
    this.onCloseFn = null;
    fn?.();
  }

  get isOpen(): boolean {
    return Modal.current === this;
  }

  get name(): string {
    return this.label;
  }
}
