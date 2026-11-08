import { WORSHIP_PLAYLIST_URL, WORSHIP_VIDEOS, type WorshipVideo } from '../config/worship';
import { button, el, Modal } from './dom';

/** Minimal typing for the parts of the YouTube IFrame API we use. */
interface YTPlayer {
  destroy(): void;
  playVideo(): void;
  pauseVideo(): void;
  loadVideoById(id: string): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setVolume(v: number): void;
  mute(): void;
  unMute(): void;
  getVideoData?(): { video_id?: string };
  cueVideoById(id: string): void;
}
interface YTNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      host: string;
      videoId: string;
      width: string;
      height: string;
      playerVars: Record<string, number | string>;
      events: {
        onReady?: () => void;
        onStateChange?: (e: { data: number }) => void;
        onError?: (e: { data: number }) => void;
      };
    },
  ) => YTPlayer;
}
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const STATE = { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;
const CLOSED_KEY = 'worlds.worship.closed';
const SIZE_KEY = 'worlds.worship.size';
/** If playback hasn't started this long after we asked, show the "찬양 듣기" prompt. */
const AUTOPLAY_GRACE_MS = 3500;
/** Pause before skipping an unplayable video. */
const SKIP_DELAY_MS = 1500;

let apiPromise: Promise<YTNamespace> | null = null;
/** Load the IFrame API early (on the entry screen) so the player can be created right after the 입장 tap. */
export function preloadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      if (window.YT) resolve(window.YT);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      apiPromise = null;
      reject(new Error('YouTube API load failed'));
    };
    document.head.append(script);
    setTimeout(() => reject(new Error('YouTube API timeout')), 15000);
  });
  apiPromise.catch(() => undefined);
  return apiPromise;
}

export type WorshipMode = 'hidden' | 'dock' | 'room';
export type WorshipSize = 'small' | 'large';
/** 펼침 (controls + list), 작게 (video only, keeps playing), 접기 (tab, paused). */
export type WorshipFold = 'open' | 'mini' | 'folded';
const IS_TOUCH = typeof window !== 'undefined' && (window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0);
const FOLD_KEY = `worlds.worship.fold.${IS_TOUCH ? 'touch' : 'desktop'}`;
/** phone / tablet / desktop (tablet = touch with a screen >= 600 px on its short side). */
const DEVICE = !IS_TOUCH ? 'desktop' : typeof screen !== 'undefined' && Math.min(screen.width, screen.height) >= 600 ? 'tablet' : 'phone';
const ROOM_FOLD_KEY = `worlds.worship.roomFold.${DEVICE}`;
const ROOM_SIZE_KEY = `worlds.worship.roomSize.${DEVICE}`;
/** 골방 wall player: 작게 = policy minimum, 보통 ≈ 1/3 of the width, 크게 ≈ 58 %. */
export type RoomSize = 's' | 'm' | 'l';
const SWIPE_PX = 28;

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS: Record<string, string> = {
  prev: 'M6 5h2v14H6zM20 5v14L9 12z',
  next: 'M16 5h2v14h-2zM4 5l11 7-11 7z',
  sound: 'M4 9v6h4l5 4V5L8 9zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z',
  muted: 'M4 9v6h4l5 4V5L8 9zm11.6.6 1.4-1.4 2 2 2-2 1.4 1.4-2 2 2 2-1.4 1.4-2-2-2 2-1.4-1.4 2-2z',
  list: 'M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z',
  large: 'M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 4v-4h2v6h-6v-2z',
  small: 'M8 4h2v6H4V8h4zm6 0h2v4h4v2h-6zM4 14h6v6H8v-4H4zm10 0h6v2h-4v4h-2z',
  mini: 'M3 5h18v14H3zm2 2v10h14V7zm6 4h6v5h-6z',
  fold: 'M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z',
  close: 'M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4L12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z',
};

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name]);
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}

function iconButton(name: string, label: string, onClick: () => void, id?: string): HTMLButtonElement {
  const b = button('', 'icon-btn', onClick);
  b.append(icon(name));
  b.setAttribute('aria-label', label);
  b.title = label;
  if (id) b.id = id;
  return b;
}

/**
 * The one and only worship player (playlist). Follows YouTube's Required
 * Minimum Functionality: official IFrame embed (youtube-nocookie.com),
 * unmodified player, always visible at >= 200x200 while it exists, nothing
 * drawn over it (it sits above every other layer and its own controls are
 * outside the video), never more than one player, no hidden playback.
 *
 * Layout: mode (dock in the world / room in the 골방) x size (작게 / 크게).
 * The same element and iframe move between layouts without reloading.
 */
export class WorshipPlayer {
  readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly listen: HTMLButtonElement;
  private readonly frame: HTMLDivElement;
  private readonly listEl: HTMLOListElement;
  private readonly drawer: HTMLDivElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly sizeBtn: HTMLButtonElement;
  private readonly listBtn: HTMLButtonElement;
  private readonly sliders: HTMLInputElement[] = [];
  private readonly volumeLabels: HTMLOutputElement[] = [];
  private player: YTPlayer | null = null;
  private ready = false;
  private index = 0;
  private state = -1;
  private mode: WorshipMode = 'hidden';
  private size: WorshipSize;
  private volume = 70;
  private muted = false;
  private globalMuted = false;
  private listOpen = false;
  private graceTimer = 0;
  private skipTimer = 0;
  private failures = 0;
  private lastError: string | null = null;
  private playingHandler: (playing: boolean) => void = () => undefined;
  private visibilityHandler: (visible: boolean) => void = () => undefined;
  private volumeHandler: (v: number) => void = () => undefined;
  private muteHandler: (m: boolean) => void = () => undefined;
  private noticeHandler: (text: string) => void = () => undefined;
  private fold: WorshipFold;
  /** The 골방 has its own fold state and size (default 펼침 · 보통). */
  private roomFold: WorshipFold;
  private roomSize: RoomSize;
  private readonly roomSizeBtns: Record<RoomSize, HTMLButtonElement>;
  private effective: WorshipFold = 'open';
  private readonly handle: HTMLButtonElement;
  private readonly tab: HTMLButtonElement;
  private readonly tabTitle: HTMLSpanElement;
  private readonly ytLink: HTMLAnchorElement;
  private readonly ytAlt: HTMLAnchorElement;
  /** Safety record for tests: playback must never run while folded. */
  private playedWhileFolded = false;

  constructor(private readonly videos: WorshipVideo[] = WORSHIP_VIDEOS) {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(SIZE_KEY);
    } catch {
      /* ignore */
    }
    this.size = saved === 'large' ? 'large' : 'small';
    let savedFold: string | null = null;
    try {
      savedFold = localStorage.getItem(FOLD_KEY);
    } catch {
      /* ignore */
    }
    // Phones start small (video only); desktop keeps the full player.
    this.fold = savedFold === 'open' || savedFold === 'mini' || savedFold === 'folded' ? savedFold : IS_TOUCH ? 'mini' : 'open';
    const read = (k: string) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    };
    const rf = read(ROOM_FOLD_KEY);
    this.roomFold = rf === 'mini' || rf === 'folded' ? rf : 'open';
    const rs = read(ROOM_SIZE_KEY);
    this.roomSize = rs === 's' || rs === 'l' ? rs : 'm';

    this.root = el('section', 'worship card size-small');
    this.root.id = 'worship';
    this.root.setAttribute('aria-label', '찬양');
    this.root.hidden = true;

    const head = el('div', 'worship-head');
    const label = el('div', 'worship-label');
    this.title = el('span', 'worship-title');
    label.append(el('strong', '', '찬양'), this.title);
    this.listen = button('▶ 찬양 듣기', 'primary worship-listen', () => this.playFromGesture());
    this.listen.hidden = true;
    const nav = el('div', 'worship-nav');
    nav.append(
      iconButton('prev', '이전 찬양', () => this.skip(-1), 'worship-prev'),
      iconButton('next', '다음 찬양', () => this.skip(1), 'worship-next'),
    );
    this.muteBtn = iconButton('sound', '찬양 음소거', () => this.muteHandler(!this.muted), 'worship-mute');
    this.listBtn = iconButton('list', '찬양 목록', () => this.toggleList(), 'worship-list-toggle');
    this.sizeBtn = iconButton('large', '크게 보기', () => this.setSize(this.size === 'small' ? 'large' : 'small'), 'worship-size');
    const close = iconButton('close', '찬양 닫기', () => this.close(), 'worship-close');
    close.classList.add('worship-close');
    const miniBtn = iconButton('mini', '작게 (영상만)', () => this.setFold('mini'), 'worship-mini');
    const foldBtn = iconButton('fold', '접기 (일시정지)', () => this.setFold('folded'), 'worship-fold');
    if (IS_TOUCH) this.sizeBtn.hidden = true; // 크게 is a desktop option
    head.append(label, this.listen, nav, this.muteBtn, this.listBtn, this.sizeBtn, miniBtn, foldBtn, close);

    // 작게: a slim pull-handle beside the video (never on top of it).
    this.handle = button('◂', 'worship-handle');
    this.handle.id = 'worship-handle';
    this.handle.setAttribute('aria-label', '찬양 펼치기 (오른쪽으로 밀면 접기)');
    this.bindHandle();

    // 접기: a small tab at the screen edge; the iframe stays alive but paused.
    this.tab = button('', 'worship-tab', () => this.unfoldFromTab());
    this.tab.id = 'worship-tab';
    this.tab.setAttribute('aria-label', '찬양 다시 듣기');
    this.tabTitle = el('span', 'worship-tab-title');
    this.tab.append(el('span', 'worship-tab-label', '🎵 찬양 ▶'), this.tabTitle);
    this.tab.hidden = true;
    this.tab.addEventListener('pointerdown', (e) => e.stopPropagation());

    this.frame = el('div', 'worship-frame');
    const volumeRow = this.volumeRow('worship-volume');
    volumeRow.classList.add('worship-volume-main');

    this.drawer = el('div', 'worship-drawer');
    this.drawer.id = 'worship-drawer';
    const drawerVolume = this.volumeRow('worship-volume-2');
    drawerVolume.classList.add('worship-volume-drawer');
    this.listEl = el('ol', 'worship-list');
    this.listEl.id = 'worship-list';
    // 🎧 Listen on YouTube (Music): opens the current song (or the configured playlist) and pauses ours.
    const yt = el('div', 'worship-yt');
    this.ytLink = el('a', 'worship-yt-link', '🎧 YouTube에서 듣기');
    this.ytLink.id = 'worship-yt';
    this.ytAlt = el('a', 'worship-yt-alt', 'youtube.com');
    for (const a of [this.ytLink, this.ytAlt]) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.addEventListener('click', () => this.pauseForOutside());
    }
    yt.append(this.ytLink, this.ytAlt);
    this.drawer.append(yt, drawerVolume, this.listEl);

    // 골방 size steps (shown only in the room).
    const sizes = el('div', 'worship-roomsize');
    sizes.setAttribute('role', 'group');
    sizes.setAttribute('aria-label', '골방 찬양 크기');
    const mk = (k: RoomSize, label: string) => {
      const b = button(label, 'seg', () => this.setRoomSize(k));
      b.id = `worship-room-${k}`;
      sizes.append(b);
      return b;
    };
    this.roomSizeBtns = { s: mk('s', '작게'), m: mk('m', '보통'), l: mk('l', '크게') };
    const body = el('div', 'worship-body');
    const side = el('div', 'worship-side');
    side.append(sizes, volumeRow, this.drawer);
    body.append(this.frame, side);
    this.root.append(head, body, this.handle);
    this.renderList();
    this.applySize();
    // Taps on the player chrome must not turn into camera drags.
    this.root.addEventListener('pointerdown', (e) => e.stopPropagation());
    // While a sheet is open the player always uses its compact layout, so the
    // sheet and the video never overlap.
    window.addEventListener('worlds-modal', () => this.applySize());
    document.getElementById('app')!.append(this.root, this.tab);
    this.updateLinks();
  }

  private volumeRow(id: string): HTMLElement {
    const row = el('label', 'worship-volume');
    const slider = el('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.id = id;
    slider.setAttribute('aria-label', '찬양 음량');
    const out = el('output', 'worship-volume-value', '70%');
    slider.addEventListener('input', () => this.volumeHandler(Number(slider.value)));
    this.sliders.push(slider);
    this.volumeLabels.push(out);
    row.append(el('span', 'worship-volume-label', '음량'), slider, out);
    return row;
  }

  // ---------------------------------------------------------------- wiring

  /** The user closed the player before; don't start it on entry. */
  get userClosed(): boolean {
    try {
      return localStorage.getItem(CLOSED_KEY) === '1';
    } catch {
      return false;
    }
  }

  private setClosedPref(closed: boolean) {
    try {
      if (closed) localStorage.setItem(CLOSED_KEY, '1');
      else localStorage.removeItem(CLOSED_KEY);
    } catch {
      /* ignore */
    }
  }

  onPlayingChange(fn: (playing: boolean) => void) {
    this.playingHandler = fn;
  }

  onVisibilityChange(fn: (visible: boolean) => void) {
    this.visibilityHandler = fn;
  }

  /** The player's own slider moved (wire to the 찬양 setting). */
  onVolumeInput(fn: (volume: number) => void) {
    this.volumeHandler = fn;
  }

  /** The player's mute button (wire to the worship-mute setting). */
  onMuteToggle(fn: (muted: boolean) => void) {
    this.muteHandler = fn;
  }

  /** Small notices (e.g. a skipped video) for the HUD toast. */
  onNotice(fn: (text: string) => void) {
    this.noticeHandler = fn;
  }

  get isOpen(): boolean {
    return this.mode !== 'hidden';
  }

  get isPlaying(): boolean {
    return this.state === STATE.PLAYING;
  }

  private duckFactor = 1;

  /** Voice prayer room: play worship at ~20 % so voices are clear (1 = normal). */
  setDuck(factor: number) {
    this.duckFactor = factor;
    this.setVolume(this.volume, this.muted, this.globalMuted);
  }

  /** Apply volume from settings (also keeps both sliders in sync). */
  setVolume(volume: number, worshipMuted: boolean, globalMuted = false) {
    this.volume = volume;
    this.muted = worshipMuted;
    this.globalMuted = globalMuted;
    for (const s of this.sliders) if (document.activeElement !== s) s.value = String(volume);
    for (const o of this.volumeLabels) o.textContent = `${volume}%`;
    this.muteBtn.replaceChildren(icon(worshipMuted ? 'muted' : 'sound'));
    this.muteBtn.setAttribute('aria-pressed', worshipMuted ? 'true' : 'false');
    this.muteBtn.setAttribute('aria-label', worshipMuted ? '찬양 소리 켜기' : '찬양 음소거');
    this.muteBtn.title = this.muteBtn.getAttribute('aria-label')!;
    if (!this.player || !this.ready) return;
    this.player.setVolume(Math.round(volume * this.duckFactor));
    if (worshipMuted || globalMuted) this.player.mute();
    else this.player.unMute();
  }

  setSize(size: WorshipSize) {
    this.size = size;
    try {
      localStorage.setItem(SIZE_KEY, size);
    } catch {
      /* ignore */
    }
    this.applySize();
  }

  private applySize() {
    const modal = Modal.anyOpen;
    const visible = this.mode !== 'hidden';
    // The 골방 keeps the player on the wall; while a sheet is open the player uses
    // the compact dock (or stays folded) so nothing overlaps.
    const inRoom = this.mode === 'room';
    let eff: WorshipFold = inRoom ? this.roomFold : this.fold;
    if (modal && eff !== 'folded') eff = 'open';
    this.effective = eff;
    const large = !inRoom && eff === 'open' && !modal && this.size === 'large' && !IS_TOUCH;
    for (const k of ['s', 'm', 'l'] as const) {
      this.root.classList.toggle(`room-${k}`, inRoom && this.roomSize === k);
      this.roomSizeBtns[k].setAttribute('aria-pressed', this.roomSize === k ? 'true' : 'false');
    }
    this.root.classList.toggle('mini', eff === 'mini');
    this.root.classList.toggle('folded', eff === 'folded');
    this.root.classList.toggle('size-large', large);
    this.root.classList.toggle('size-small', !large);
    // Phones: 펼침 is the drawer view (list + volume).
    // In the 골방 the list stays behind its button so the wall player stays compact.
    this.root.classList.toggle('list-open', this.listOpen || (IS_TOUCH && eff === 'open' && !modal && !inRoom));
    const body = document.body.classList;
    body.toggle('worship-large', large && visible);
    body.toggle('worship-on', visible && eff !== 'folded');
    body.toggle('worship-mini', visible && eff === 'mini');
    body.toggle('worship-folded', visible && eff === 'folded');
    this.tab.hidden = !(visible && eff === 'folded' && !modal);
    if (eff === 'folded') this.pauseForFold();
    this.sizeBtn.replaceChildren(icon(this.size === 'large' ? 'small' : 'large'));
    const label = this.size === 'large' ? '작게 보기' : '크게 보기';
    this.sizeBtn.setAttribute('aria-label', label);
    this.sizeBtn.title = label;
  }

  // ---------------------------------------------------------------- fold states

  get foldState(): WorshipFold {
    return this.fold;
  }

  setRoomSize(size: RoomSize) {
    this.roomSize = size;
    try {
      localStorage.setItem(ROOM_SIZE_KEY, size);
    } catch {
      /* ignore */
    }
    this.applySize();
  }

  /** Sets the fold state of where the player is now (world dock or 골방). */
  setFold(fold: WorshipFold) {
    const wasFolded = this.effective === 'folded';
    const room = this.mode === 'room';
    if (room) this.roomFold = fold;
    else this.fold = fold;
    try {
      localStorage.setItem(room ? ROOM_FOLD_KEY : FOLD_KEY, fold);
    } catch {
      /* ignore */
    }
    this.applySize();
    // Coming back from 접기: resume only once the video is on screen again.
    if (wasFolded && this.effective !== 'folded') requestAnimationFrame(() => requestAnimationFrame(() => this.resumeVisible()));
  }

  private unfoldFromTab() {
    this.setFold(this.mode === 'room' || !IS_TOUCH ? 'open' : 'mini');
  }

  private resumeVisible() {
    if (this.effective === 'folded' || this.mode === 'hidden') return;
    if (!this.player) {
      if (this.videos.length) void this.create(this.index, true);
      return;
    }
    if (this.ready) {
      this.player.playVideo();
      this.armPrompt();
    }
  }

  /** Folded: pause (never play hidden). The iframe stays, keeping the position. */
  private pauseForFold() {
    window.clearTimeout(this.graceTimer);
    this.listen.hidden = true;
    this.root.classList.remove('prompting');
    if (this.player && this.ready) {
      try {
        this.player.pauseVideo();
      } catch {
        /* ignore */
      }
    }
  }

  /** Opening YouTube elsewhere: pause ours so two never play at once. */
  private pauseForOutside() {
    if (this.player && this.ready) {
      try {
        this.player.pauseVideo();
      } catch {
        /* ignore */
      }
    }
  }

  private updateLinks() {
    const v = this.videos[this.index];
    const id = v ? encodeURIComponent(v.id) : '';
    if (WORSHIP_PLAYLIST_URL) {
      this.ytLink.href = WORSHIP_PLAYLIST_URL;
      this.ytAlt.hidden = true;
    } else {
      this.ytLink.href = `https://music.youtube.com/watch?v=${id}`;
      this.ytAlt.href = `https://www.youtube.com/watch?v=${id}`;
      this.ytAlt.hidden = !v;
    }
    this.ytLink.hidden = !v && !WORSHIP_PLAYLIST_URL;
    this.tabTitle.textContent = v?.title ?? '';
  }

  /** Tap = 펼침; swipe right = 접기; swipe left = 펼침. */
  private bindHandle() {
    let startX: number | null = null;
    let swiped = false;
    this.handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      startX = e.clientX;
      swiped = false;
      try {
        this.handle.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });
    this.handle.addEventListener('pointerup', (e) => {
      if (startX === null) return;
      const dx = e.clientX - startX;
      startX = null;
      if (dx > SWIPE_PX) {
        swiped = true;
        this.setFold('folded');
      } else if (dx < -SWIPE_PX) {
        swiped = true;
        this.setFold('open');
      }
    });
    this.handle.addEventListener('pointercancel', () => (startX = null));
    this.handle.addEventListener('click', (e) => {
      e.preventDefault();
      if (swiped) {
        swiped = false;
        return;
      }
      this.setFold('open');
    });
  }

  private toggleList(open = !this.listOpen) {
    this.listOpen = open;
    this.root.classList.toggle('list-open', open);
    this.listBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  private renderList() {
    this.listEl.replaceChildren();
    this.videos.forEach((v, i) => {
      const li = el('li');
      const b = button('', i === this.index ? 'worship-track on' : 'worship-track', () => this.playIndex(i));
      b.append(el('span', 'worship-track-num', String(i + 1)), el('span', 'worship-track-title', v.title ?? v.id));
      if (i === this.index) b.setAttribute('aria-current', 'true');
      b.dataset.index = String(i);
      li.append(b);
      this.listEl.append(li);
    });
    this.listBtn.hidden = this.videos.length < 2;
    this.root.querySelector('.worship-nav')?.toggleAttribute('hidden', this.videos.length < 2);
  }

  // ---------------------------------------------------------------- show / hide

  /**
   * Show the player and try to start the playlist. Call it from a user gesture
   * (the 입장 tap, the HUD 찬양 button) so browsers are most likely to allow
   * playback with sound; if they don't, the "찬양 듣기" prompt appears.
   */
  open(asRoom = false, unfold = false) {
    this.setClosedPref(false);
    // The HUD 찬양 button brings a folded player back into view; entering the
    // world keeps a remembered 접기 (paused, cued only).
    if (unfold && this.fold === 'folded') this.setFold(IS_TOUCH ? 'mini' : 'open');
    this.show(asRoom ? 'room' : 'dock');
    if (this.videos.length === 0) return this.renderPlaceholder();
    if (this.player) {
      if (this.state !== STATE.PLAYING) this.playFromGesture();
      return;
    }
    void this.create(this.index, true);
  }

  /** In the 골방 the player moves onto the room layout; outside it docks again. */
  setRoom(inRoom: boolean) {
    if (inRoom) {
      if (this.mode === 'hidden') {
        // Closed earlier: show it in the room, but wait for a tap to play.
        this.show('room');
        if (this.videos.length === 0) this.renderPlaceholder();
        else if (!this.player) void this.create(this.index, false);
      } else {
        this.show('room');
      }
    } else if (this.mode === 'room') {
      if (this.userClosed) this.close(false);
      else this.show('dock');
    }
  }

  /** Stop the music and remove the player (persisted unless told otherwise). */
  close(remember = true) {
    if (remember) this.setClosedPref(true);
    this.destroyPlayer();
    this.frame.replaceChildren();
    this.show('hidden');
  }

  private show(mode: WorshipMode) {
    this.mode = mode;
    this.root.hidden = mode === 'hidden';
    this.root.classList.toggle('dock', mode === 'dock');
    this.root.classList.toggle('room', mode === 'room');
    document.body.classList.toggle('worship-on', mode !== 'hidden');
    this.applySize();
    this.visibilityHandler(mode !== 'hidden');
  }

  private renderPlaceholder() {
    this.frame.replaceChildren();
    const box = el('div', 'worship-placeholder');
    box.append(el('p', 'worship-placeholder-title', '찬양 영상을 준비하고 있어요'), el('p', '', '곧 이곳에서 함께 찬양할 수 있어요.'));
    this.frame.append(box);
    this.title.textContent = '';
  }

  private renderMessage(title: string, detail: string, video?: WorshipVideo) {
    this.frame.replaceChildren();
    const box = el('div', 'worship-placeholder');
    box.append(el('p', 'worship-placeholder-title', title), el('p', '', detail));
    if (video) {
      const link = el('a', 'worship-link', 'YouTube에서 보기');
      link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      box.append(link);
    }
    this.frame.append(box);
  }

  // ---------------------------------------------------------------- playlist

  private playIndex(i: number) {
    window.clearTimeout(this.skipTimer);
    this.failures = 0;
    this.goTo(i);
  }

  private skip(delta: number) {
    if (this.videos.length === 0) return;
    this.playIndex((this.index + delta + this.videos.length) % this.videos.length);
  }

  private goTo(i: number) {
    this.index = i;
    this.renderList();
    const v = this.videos[i];
    this.title.textContent = v.title ?? '';
    this.updateLinks();
    if (this.player && this.ready) {
      // Folded: only cue (never start playback while hidden).
      if (this.effective === 'folded') this.player.cueVideoById(v.id);
      else {
        this.player.loadVideoById(v.id);
        this.armPrompt();
      }
    } else {
      void this.create(i, true);
    }
  }

  /** Unplayable/blocked video: tell the user gently and move on. */
  private skipBroken(video: WorshipVideo, reason: string) {
    this.failures++;
    this.lastError = reason;
    if (this.failures >= this.videos.length) {
      this.renderMessage('지금은 찬양을 재생할 수 없어요', '잠시 후 다시 열어 주세요.', video);
      return;
    }
    this.noticeHandler(`재생할 수 없는 찬양은 건너뛰었어요: ${video.title ?? video.id}`);
    window.clearTimeout(this.skipTimer);
    this.skipTimer = window.setTimeout(() => {
      if (this.isOpen) this.goTo((this.index + 1) % this.videos.length);
    }, SKIP_DELAY_MS);
  }

  private async create(index: number, autoplay: boolean) {
    this.destroyPlayer();
    this.index = index;
    const video = this.videos[index];
    this.title.textContent = video.title ?? '';
    this.renderList();
    this.updateLinks();
    this.lastError = null;
    // Never autoplay into a folded (hidden) player.
    if (this.effective === 'folded') autoplay = false;
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(video.id)) {
      this.renderMessage('영상 주소를 확인해 주세요', '설정된 영상 ID가 올바르지 않아요.');
      this.skipBroken(video, 'bad_id');
      return;
    }
    this.frame.replaceChildren(el('div', 'worship-loading', '찬양을 불러오고 있어요…'));
    let YT: YTNamespace;
    try {
      YT = await preloadYouTubeApi();
    } catch {
      this.lastError = 'api';
      this.renderMessage('찬양을 불러오지 못했어요', '인터넷 연결을 확인해 주세요.', video);
      return;
    }
    // Only start once the player is actually on screen (RMF: visible before autoplay).
    if (this.mode === 'hidden') return;
    const mount = el('div');
    this.frame.replaceChildren(mount);
    this.ready = false;
    this.player = new YT.Player(mount, {
      host: 'https://www.youtube-nocookie.com',
      // Passed as data to the official API: "--" prefixed IDs are safe.
      videoId: video.id,
      width: '100%',
      height: '100%',
      playerVars: { autoplay: autoplay ? 1 : 0, playsinline: 1, rel: 0 },
      events: {
        onReady: () => {
          this.ready = true;
          this.setVolume(this.volume, this.muted, this.globalMuted);
          if (autoplay && this.effective !== 'folded') {
            this.player?.playVideo();
            this.armPrompt();
          } else {
            this.listen.hidden = false;
            this.root.classList.add('prompting');
          }
        },
        onStateChange: (e) => this.onState(e.data),
        onError: (e) => {
          this.setState(-1);
          const current = this.videos[this.index];
          this.skipBroken(current, String(e.data));
        },
      },
    });
  }

  /** Autoplay may be refused (iOS, strict autoplay policies): offer a clear tap target. */
  private armPrompt() {
    window.clearTimeout(this.graceTimer);
    this.graceTimer = window.setTimeout(() => {
      if (this.state !== STATE.PLAYING && this.player) {
        this.listen.hidden = false;
        this.root.classList.add('prompting');
      }
    }, AUTOPLAY_GRACE_MS);
  }

  private playFromGesture() {
    if (this.effective === 'folded') return this.unfoldFromTab();
    if (!this.player || !this.ready) {
      if (!this.player && this.videos.length) void this.create(this.index, true);
      return;
    }
    this.player.playVideo();
    this.armPrompt();
  }

  private onState(state: number) {
    if (state === STATE.PLAYING && this.effective === 'folded') {
      // Defensive: should never happen; record it and stop at once.
      this.playedWhileFolded = true;
      this.player?.pauseVideo();
    }
    this.setState(state);
    if (state === STATE.PLAYING) {
      this.failures = 0;
      this.listen.hidden = true;
      this.root.classList.remove('prompting');
    }
    if (state === STATE.ENDED) {
      // Play through in order and loop.
      if (this.videos.length > 1) this.goTo((this.index + 1) % this.videos.length);
      else {
        this.player?.seekTo(0, true);
        this.player?.playVideo();
      }
    }
  }

  private setState(state: number) {
    const was = this.state === STATE.PLAYING;
    this.state = state;
    const now = state === STATE.PLAYING;
    if (was !== now) this.playingHandler(now);
  }

  private destroyPlayer() {
    window.clearTimeout(this.graceTimer);
    window.clearTimeout(this.skipTimer);
    this.listen.hidden = true;
    this.root.classList.remove('prompting');
    if (this.player) {
      try {
        this.player.destroy();
      } catch {
        /* ignore */
      }
    }
    this.player = null;
    this.ready = false;
    this.setState(-1);
  }

  describe() {
    const names: Record<number, string> = { [-1]: 'none', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'cued' };
    return {
      mode: this.mode,
      size: this.size,
      fold: this.fold,
      roomFold: this.roomFold,
      roomSize: this.roomSize,
      device: DEVICE,
      effective: this.effective,
      playedWhileFolded: this.playedWhileFolded,
      tabVisible: !this.tab.hidden,
      state: names[this.state] ?? String(this.state),
      ready: this.ready,
      index: this.index,
      title: this.videos[this.index]?.title ?? null,
      /** What the YouTube player itself reports as loaded. */
      videoId: (this.ready && this.player?.getVideoData?.().video_id) || null,
      tracks: this.videos.length,
      listOpen: this.listOpen,
      volume: this.volume,
      duck: this.duckFactor,
      muted: this.muted,
      promptVisible: !this.listen.hidden,
      iframes: document.querySelectorAll('iframe[src*="youtube"]').length,
      userClosed: this.userClosed,
      error: this.lastError,
      placeholder: !!this.root.querySelector('.worship-placeholder'),
    };
  }
}
