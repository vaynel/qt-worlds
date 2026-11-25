import { button, el, Modal } from './dom';

interface Card {
  img: string;
  alt: string;
  title: string;
  sub: string;
}

/**
 * Picture cards: real in-game screenshots made by client/scripts/make-guide-shots.mjs
 * (served same-origin from public/guide/ and precached by the service worker).
 * Regenerate them whenever the world's look changes.
 */
const CARDS: readonly Card[] = [
  {
    img: '/guide/letter.webp',
    alt: '광장 근처 들판에서 내 캐릭터 앞에 "오늘의 말씀" 편지가 빛나며 내려와 있어요',
    title: '매일 말씀 편지가 날아와요',
    sub: '편지를 눌러 오늘의 말씀을 읽어요',
  },
  {
    img: '/guide/closet.webp',
    alt: '십자가가 걸린 따뜻한 골방에서 말씀 · 묵상 · 느낀 점 · 적용 순서의 묵상 카드가 열려 있어요',
    title: '골방에서 조용히 묵상해요',
    sub: '말씀 · 묵상 · 느낀 점 · 적용',
  },
  {
    img: '/guide/lanterns.webp',
    alt: '저녁 등불 언덕에 사람들이 나눈 묵상 등불이 동그랗게 켜져 있어요',
    title: '묵상을 등불로 나눠요',
    sub: '등불을 읽고 함께 기도해 줘요',
  },
  {
    img: '/guide/campfire.webp',
    alt: '밤 모닥불가 통나무에 여러 사람이 앉아 "오늘 말씀 참 좋았어요", "함께 기도해요" 하고 이야기하고 있어요',
    title: '모닥불에서 함께 이야기해요',
    sub: '가까이 가면 이야기 창이 열려요',
  },
  {
    img: '/guide/library.webp',
    alt: '이야기 도서관 안, 하나님 이야기 책장과 일기 책장에 책이 꽂혀 있어요',
    title: '도서관에 하나님 이야기를',
    sub: '함께 읽고, 내 이야기도 꽂아요',
  },
];

/** Image URLs (the SW precache list and the tests read the same files). */
export const GUIDE_IMAGES = CARDS.map((c) => c.img);

export interface GuideOpenOptions {
  /** Reopened from ⚙: also offer "도움말 다시 보기" (resets the first-time tips). */
  onResetTips?: () => void;
}

/**
 * First-time guide: a few picture cards (show, don't tell). Shown once per
 * account (server flag) or once per device for guests; reopenable from
 * ⚙ 설정 → ❓ 사용 안내. Swipe, arrows (buttons or ← →) and dots move between
 * cards; 시작하기 is on every card. The first card shows a small animated
 * controls hint (joystick on touch screens, WASD on desktop).
 */
export class Guide {
  private readonly modal = new Modal('guide-overlay', '사용 안내');
  private page = 0;
  private finishHandler: ((started: boolean) => void) | null = null;
  private track: HTMLElement | null = null;
  private dots: HTMLButtonElement[] = [];
  private prev: HTMLButtonElement | null = null;
  private next: HTMLButtonElement | null = null;
  private drag: { id: number; x: number; y: number; dx: number; horizontal: boolean | null } | null = null;

  constructor(private readonly isTouch: () => boolean) {
    this.modal.root.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') this.go(this.page + 1);
      else if (e.key === 'ArrowLeft') this.go(this.page - 1);
      else return;
      e.preventDefault();
    });
  }

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  /** started=true when closed with 시작하기, false for 건너뛰기/닫기. */
  open(onFinish?: (started: boolean) => void, options: GuideOpenOptions = {}) {
    this.page = 0;
    this.finishHandler = onFinish ?? null;
    this.build(options);
    this.modal.open(() => {
      const fn = this.finishHandler;
      this.finishHandler = null;
      fn?.(false);
    });
    requestAnimationFrame(() => this.modal.sheet.querySelector<HTMLElement>('#guide-start')?.focus({ preventScroll: true }));
  }

  private finish(started: boolean) {
    const fn = this.finishHandler;
    this.finishHandler = null;
    this.modal.close();
    fn?.(started);
  }

  private build(options: GuideOpenOptions) {
    const sheet = this.modal.sheet;
    sheet.className = 'sheet guide';
    sheet.replaceChildren();

    const top = el('header', 'guide-top');
    const skip = button('건너뛰기', 'ghost guide-skip', () => this.finish(false));
    top.append(el('span', 'guide-step', ''), skip);

    const viewport = el('div', 'guide-viewport');
    const track = el('div', 'guide-track');
    track.setAttribute('aria-live', 'polite');
    CARDS.forEach((c, i) => {
      const card = el('figure', 'guide-card');
      card.setAttribute('aria-roledescription', '카드');
      card.setAttribute('aria-label', `${i + 1} / ${CARDS.length}`);
      const pic = el('div', 'guide-pic');
      const img = el('img', 'guide-img');
      img.src = c.img;
      img.alt = c.alt;
      img.width = 640;
      img.height = 480;
      img.decoding = 'async';
      img.draggable = false;
      pic.append(img);
      if (i === 0) pic.append(this.controlsHint());
      const cap = el('figcaption', 'guide-cap');
      cap.append(el('h2', 'guide-title', c.title), el('p', 'guide-sub', c.sub));
      card.append(pic, cap);
      track.append(card);
    });
    viewport.append(track);
    this.bindSwipe(viewport);

    const nav = el('div', 'guide-nav');
    this.prev = button('‹', 'guide-arrow', () => this.go(this.page - 1));
    this.prev.id = 'guide-prev';
    this.prev.setAttribute('aria-label', '이전 카드');
    this.next = button('›', 'guide-arrow', () => this.go(this.page + 1));
    this.next.id = 'guide-next';
    this.next.setAttribute('aria-label', '다음 카드');
    const dots = el('div', 'guide-dots');
    this.dots = CARDS.map((c, i) => {
      const d = button('', 'guide-dot', () => this.go(i));
      d.setAttribute('aria-label', `${i + 1}번째 카드: ${c.title}`);
      dots.append(d);
      return d;
    });
    nav.append(this.prev, dots, this.next);

    const foot = el('footer', 'guide-foot');
    const start = button('시작하기', 'primary guide-start', () => this.finish(true));
    start.id = 'guide-start';
    foot.append(start);
    if (options.onResetTips) {
      const reset = options.onResetTips;
      const again = button('도움말 다시 보기', 'ghost guide-tips-reset', () => {
        reset();
        this.finish(true);
      });
      again.id = 'guide-tips-reset';
      foot.append(again);
    }

    sheet.append(top, viewport, nav, foot);
    this.track = track;
    this.render();
  }

  /** First card only: walking, shown rather than explained. */
  private controlsHint(): HTMLElement {
    const hint = el('div', 'guide-controls');
    hint.setAttribute('aria-hidden', 'true');
    if (this.isTouch()) {
      const stick = el('span', 'guide-stick');
      stick.append(el('span', 'guide-stick-knob'));
      hint.append(stick, el('span', 'guide-controls-text', '왼쪽 아래 조이스틱으로 걸어요'));
    } else {
      const keys = el('span', 'guide-keys');
      for (const k of ['W', 'A', 'S', 'D']) keys.append(el('kbd', `guide-key k-${k.toLowerCase()}`, k));
      hint.append(keys, el('span', 'guide-controls-text', 'WASD로 걷고, 끌어서 둘러봐요'));
    }
    return hint;
  }

  private bindSwipe(viewport: HTMLElement) {
    viewport.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, horizontal: null };
    });
    viewport.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId || !this.track) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (d.horizontal === null && Math.hypot(dx, dy) > 8) {
        d.horizontal = Math.abs(dx) > Math.abs(dy);
        if (d.horizontal) viewport.setPointerCapture(e.pointerId);
      }
      if (!d.horizontal) return;
      d.dx = dx;
      // Rubber band at both ends.
      const edge = (this.page === 0 && dx > 0) || (this.page === CARDS.length - 1 && dx < 0);
      this.track.style.transition = 'none';
      this.track.style.transform = `translateX(calc(${-this.page * 100}% + ${edge ? dx / 3 : dx}px))`;
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      this.drag = null;
      if (!this.track) return;
      this.track.style.transition = '';
      const width = viewport.clientWidth || 1;
      if (d.horizontal && Math.abs(d.dx) > Math.min(60, width * 0.18)) this.go(this.page + (d.dx < 0 ? 1 : -1));
      else this.render();
    };
    viewport.addEventListener('pointerup', end);
    viewport.addEventListener('pointercancel', end);
  }

  private go(page: number) {
    this.page = Math.max(0, Math.min(CARDS.length - 1, page));
    this.render();
  }

  private render() {
    if (!this.track) return;
    this.track.style.transform = `translateX(${-this.page * 100}%)`;
    this.track.querySelectorAll('.guide-card').forEach((c, i) => c.setAttribute('aria-hidden', i === this.page ? 'false' : 'true'));
    this.dots.forEach((d, i) => {
      d.classList.toggle('on', i === this.page);
      d.setAttribute('aria-current', i === this.page ? 'true' : 'false');
    });
    if (this.prev) this.prev.disabled = this.page === 0;
    if (this.next) this.next.disabled = this.page === CARDS.length - 1;
    const step = this.modal.sheet.querySelector('.guide-step');
    if (step) step.textContent = `${this.page + 1} / ${CARDS.length}`;
  }

  describe() {
    return { open: this.isOpen, page: this.page, cards: CARDS.length };
  }
}
