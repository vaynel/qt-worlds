import type { DayPhase } from '../world/DayNight';

const HINT_DESKTOP = 'WASD · 방향키로 걷기 · Shift 달리기 · 마우스로 끌어서 둘러보기 · 휠로 가까이/멀리';
const HINT_TOUCH = '왼쪽 아래를 눌러 걷기 · 화면을 끌어서 둘러보기 · 두 손가락으로 가까이/멀리';
const PROMPT_SECONDS = 6;

/** Small weather icons for the clock card (fixed markup, 24×24), drawn like the sun/moon icon. */
const CLOUD = '<path d="M7 18h10.5a3.8 3.8 0 0 0 .4-7.6A5.5 5.5 0 0 0 7.4 9.2 4.4 4.4 0 0 0 7 18z" fill="#f4f1ea" stroke="#9aa3ad" stroke-width="1.3"/>';
const GREY_CLOUD = '<path d="M7 15h10.5a3.6 3.6 0 0 0 .4-7.2A5.3 5.3 0 0 0 7.6 6.6 4.2 4.2 0 0 0 7 15z" fill="#c9ced6" stroke="#7d8794" stroke-width="1.3"/>';
const drops = (xs: number[], color = '#5d8fc9') =>
  xs.map((x) => `<path d="M${x} 17.2l-1.1 3.3" stroke="${color}" stroke-width="1.6" stroke-linecap="round"/>`).join('');
const WX_ICONS: Record<string, string> = {
  partly: '<circle cx="9" cy="9" r="4.2" fill="#ffd27a"/>' + CLOUD.replace('M7 18', 'M8 19'),
  cloudy: CLOUD,
  fog: '<path d="M4 9h16M3 13h18M5 17h14" stroke="#9aa3ad" stroke-width="1.8" stroke-linecap="round"/>',
  drizzle: GREY_CLOUD + drops([9.5, 15]),
  rain: GREY_CLOUD + drops([8, 12, 16]),
  heavyRain: GREY_CLOUD.replace('#c9ced6', '#aab1bc') + drops([7, 10.5, 14, 17.5], '#3f73b5'),
  thunder: GREY_CLOUD.replace('#c9ced6', '#9ea6b2') + '<path d="M12.5 14.5l-2.6 4.2h2.4l-1.5 3.8 4.2-5.3h-2.5l1.6-2.7z" fill="#ffc94a"/>',
  snow: GREY_CLOUD + '<circle cx="8.5" cy="18.6" r="1.2" fill="#8fb3dc"/><circle cx="12.5" cy="20.4" r="1.2" fill="#8fb3dc"/><circle cx="16" cy="18.4" r="1.2" fill="#8fb3dc"/>',
  heavySnow:
    '<g stroke="#6d9bd1" stroke-width="1.7" stroke-linecap="round"><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><path d="M9.8 4.8 12 6.6l2.2-1.8M9.8 19.2 12 17.4l2.2 1.8"/></g>',
};

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
  private readonly clockWx = $('clock-wx');
  private readonly clockTip = $('clock-tip');
  private readonly clockCard = this.clockIcon.parentElement as HTMLElement;
  private wxName: string | null = null;
  private wxIcon = '';
  private wxText = '';
  private wxTip = '';
  private tipTimer = 0;
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

  constructor() {
    this.clockCard.addEventListener('click', () => this.toggleTip());
  }

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

  /**
   * ✉️ 받은 편지 (L-B): unread letters and replies, as a badge on 말씀 (the 말씀 책's
   * 오늘 page has 📬 받은 편지 and 📔 오늘 일기 쓰기).
   */
  setLettersUnread(n: number) {
    let badge = this.wordBtn.querySelector<HTMLSpanElement>('.badge');
    if (n <= 0) {
      badge?.remove();
      this.wordBtn.removeAttribute('data-letters');
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'badge';
      badge.id = 'word-letters-badge';
      this.wordBtn.append(badge);
    }
    badge.textContent = n > 99 ? '99+' : String(n);
    this.wordBtn.dataset.letters = String(n);
    this.wordBtn.setAttribute('aria-label', `말씀 · 받은 편지 ${n}통`);
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
    // A weather word ("비", "눈" …) takes the phase's place; clear skies keep 낮/밤.
    const label = this.wxName ?? phase;
    if (label !== this.phase) {
      this.phase = label;
      this.clockPhase.textContent = label;
    }
    const wx = this.clockIcon.dataset.wx !== undefined && this.clockIcon.dataset.wx !== '';
    this.clockIcon.classList.toggle('moon', night && !wx);
    this.clockIcon.classList.toggle('sun', !night && !wx);
    this.clockIcon.classList.toggle('wx', wx);
  }

  /**
   * 서울 날씨 on the clock card: "서울 비 · 12°C". name null = clear (the phase
   * shows), icon = the weather kind ('' = the drawn sun/moon), temp null = unknown (no reading yet).
   */
  setWeather(name: string | null, icon: string, temp: number | null, tip: string) {
    this.wxName = name;
    if (icon !== this.wxIcon) {
      this.wxIcon = icon;
      // Fixed icon markup from WX_ICONS (never data from the network).
      const svg = Object.prototype.hasOwnProperty.call(WX_ICONS, icon) ? WX_ICONS[icon] : '';
      this.clockIcon.innerHTML = svg ? `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">${svg}</svg>` : '';
      this.clockIcon.dataset.wx = svg ? icon : '';
    }
    const text = temp === null ? '' : ` · ${temp}°C`;
    if (text !== this.wxText) {
      this.wxText = text;
      this.clockWx.textContent = text;
    }
    this.wxTip = tip;
    if (!this.clockTip.hidden) this.clockTip.textContent = tip;
  }

  private toggleTip() {
    window.clearTimeout(this.tipTimer);
    if (!this.clockTip.hidden) {
      this.clockTip.hidden = true;
      return;
    }
    this.clockTip.textContent = this.wxTip;
    this.clockTip.hidden = false;
    this.tipTimer = window.setTimeout(() => (this.clockTip.hidden = true), 3500);
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
