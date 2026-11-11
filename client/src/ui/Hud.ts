import type { DayPhase } from '../world/DayNight';

const HINT_DESKTOP = 'WASD · 방향키로 걷기 · Shift 달리기 · 마우스로 끌어서 둘러보기 · 휠로 가까이/멀리';
const HINT_TOUCH = '왼쪽 아래를 눌러 걷기 · 화면을 끌어서 둘러보기 · 두 손가락으로 가까이/멀리';
const PROMPT_SECONDS = 6;

const $ = <T extends HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} 요소가 없어요`);
  return el as T;
};

/**
 * DOM overlay. Writes only when a value changes, so per-frame calls are cheap.
 * Game state flows in; the HUD never decides game rules.
 */
export class Hud {
  private readonly placeName = $('place-name');
  private readonly clockTime = $('clock-time');
  private readonly clockPhase = $('clock-phase');
  private readonly clockIcon = $('clock-icon');
  private readonly prompt = $('prompt');
  private readonly hint = $('hint');
  private readonly loading = $('loading');
  private readonly netStatus = $('net-status');
  private readonly actionBtn = $<HTMLButtonElement>('action-btn');
  private readonly toastEl = $('toast');
  private readonly meditateBtn = $<HTMLButtonElement>('meditate-btn');
  private readonly letterBtn = $<HTMLButtonElement>('letter-btn');
  private readonly wordBtn = $<HTMLButtonElement>('btn-word');
  private readonly worshipBtn = $<HTMLButtonElement>('btn-worship');
  private readonly settingsBtn = $<HTMLButtonElement>('btn-settings');
  private readonly groupsBtn = $<HTMLButtonElement>('btn-groups');
  private netText = '';
  private actionText: string | null = null;
  private toastUntil = 0;

  private place = '';
  private clock = '';
  private phase = '';
  private promptKey = '';
  private promptUntil = 0;
  private hintFadeAt = Infinity;
  private touch: boolean | null = null;

  setTouch(touch: boolean) {
    if (touch === this.touch) return;
    this.touch = touch;
    document.body.classList.toggle('touch', touch);
    this.hint.textContent = touch ? HINT_TOUCH : HINT_DESKTOP;
  }

  ready() {
    document.body.classList.add('in-world');
    this.loading.hidden = false;
    this.loading.classList.add('done');
    window.setTimeout(() => this.loading.remove(), 1000);
  }

  /** Connection line under the place name. */
  setNet(text: string, state: 'online' | 'waiting' | 'solo') {
    const key = `${state}|${text}`;
    if (key === this.netText) return;
    this.netText = key;
    this.netStatus.textContent = text;
    this.netStatus.className = `net-status ${state === 'solo' ? '' : state}`;
  }

  /** Contextual action (sit/stand). null hides the button. */
  setAction(text: string | null) {
    if (text === this.actionText) return;
    this.actionText = text;
    this.actionBtn.hidden = text === null;
    if (text !== null) this.actionBtn.textContent = text;
  }

  onAction(fn: () => void) {
    this.actionBtn.addEventListener('click', (e) => {
      e.preventDefault();
      fn();
    });
    // Keep taps on the button from also starting a camera drag.
    this.actionBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  /** Tap on "함께 N명": who is here. */
  onPeople(fn: () => void) {
    this.netStatus.setAttribute('role', 'button');
    this.netStatus.tabIndex = 0;
    this.netStatus.setAttribute('aria-label', '함께 있는 사람 보기');
    this.netStatus.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.netStatus.addEventListener('click', (e) => {
      e.preventDefault();
      fn();
    });
    this.netStatus.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fn();
      }
    });
  }

  /** Wire a HUD button; taps never leak into camera drags. */
  bind(which: 'meditate' | 'letter' | 'word' | 'worship' | 'settings' | 'groups', fn: () => void) {
    const btn = {
      meditate: this.meditateBtn,
      letter: this.letterBtn,
      word: this.wordBtn,
      worship: this.worshipBtn,
      settings: this.settingsBtn,
      groups: this.groupsBtn,
    }[which];
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      fn();
      btn.blur();
    });
  }

  setMeditate(visible: boolean) {
    if (this.meditateBtn.hidden === !visible) return;
    this.meditateBtn.hidden = !visible;
  }

  setLetter(visible: boolean) {
    if (this.letterBtn.hidden === !visible) return;
    this.letterBtn.hidden = !visible;
  }

  /** Highlight 말씀 until today's letter has been opened. */
  setWordNew(isNew: boolean) {
    this.wordBtn.classList.toggle('has-new', isNew);
    this.wordBtn.setAttribute('aria-label', isNew ? '말씀 · 오늘의 말씀이 도착했어요' : '말씀');
  }

  /** 🔴 unread group chat messages on the 모임 button. */
  setGroupsUnread(n: number) {
    let badge = this.groupsBtn.querySelector<HTMLSpanElement>('.badge');
    if (n <= 0) {
      badge?.remove();
      this.groupsBtn.setAttribute('aria-label', '모임');
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'badge';
      this.groupsBtn.append(badge);
    }
    badge.textContent = n > 99 ? '99+' : String(n);
    this.groupsBtn.setAttribute('aria-label', `모임 · 읽지 않은 메시지 ${n}개`);
  }

  /** 찬양 button shows whether the player is open (by colour; the label stays 찬양). */
  setWorshipOpen(open: boolean) {
    this.worshipBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
    this.worshipBtn.setAttribute('aria-label', open ? '찬양 닫기' : '찬양 열기');
  }

  toast(text: string, now: number, seconds = 3.5) {
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    this.toastUntil = now + seconds;
  }

  setPlace(name: string) {
    if (name === this.place) return;
    this.place = name;
    this.placeName.textContent = name;
  }

  setClock(text: string, phase: DayPhase, night: boolean) {
    if (text !== this.clock) {
      this.clock = text;
      this.clockTime.textContent = text;
    }
    if (phase !== this.phase) {
      this.phase = phase;
      this.clockPhase.textContent = phase;
    }
    this.clockIcon.classList.toggle('moon', night);
    this.clockIcon.classList.toggle('sun', !night);
  }

  /**
   * Show a gentle message. `sticky` keeps it while the caller keeps asking;
   * otherwise it shows for a few seconds each time the key changes.
   */
  showPrompt(key: string, title: string, body: string, now: number, sticky = false) {
    if (key !== this.promptKey) {
      this.promptKey = key;
      this.prompt.innerHTML = '';
      const t = document.createElement('strong');
      t.textContent = title;
      const b = document.createElement('span');
      b.textContent = body;
      this.prompt.append(t, b);
      this.prompt.hidden = false;
      // Restart the entrance animation.
      this.prompt.style.animation = 'none';
      void this.prompt.offsetWidth;
      this.prompt.style.animation = '';
      this.promptUntil = sticky ? Infinity : now + PROMPT_SECONDS;
    }
  }

  clearPrompt(key?: string) {
    if (key !== undefined && key !== this.promptKey) return;
    this.promptKey = '';
    this.prompt.hidden = true;
  }

  update(now: number, playerHasMoved: boolean) {
    if (this.promptKey && now > this.promptUntil) this.prompt.hidden = true;
    if (playerHasMoved && this.hintFadeAt === Infinity) this.hintFadeAt = now + 8;
    if (now > this.hintFadeAt) this.hint.classList.add('faded');
    if (!this.toastEl.hidden && now > this.toastUntil) this.toastEl.hidden = true;
  }
}
