import * as THREE from 'three';
import { graphicsQuality, maxPixelRatio, onGraphicsQuality } from './graphics';
import type { WeatherState, WordPassage } from '../../../shared/protocol';
import type { AudioEngine } from '../audio/AudioEngine';
import { PlayerController } from '../entities/PlayerController';
import { CameraRig } from '../systems/CameraRig';
import { Input, type MoveIntent } from '../systems/Input';
import type { NetClient, Welcome } from '../net/NetClient';
import { ApiError } from '../net/api';
import { LocalWordBookStore, ServerWordBookStore, type MeditationPlace, type WordBookStore } from '../storage/WordBook';
import { GroupsView } from '../ui/GroupsView';
import { LanternCard } from '../ui/LanternCard';
import { LoginPrompt } from '../ui/LoginPrompt';
import { button, el } from '../ui/dom';
import { LanternField } from '../world/LanternField';
import { NameTag, type TagView } from '../world/NameTag';
import { PathGlow } from '../world/PathGlow';
import { VoiceClient } from '../voice/VoiceClient';
import { VoicePanel } from '../ui/VoicePanel';
import { MicHelp } from '../ui/MicHelp';
import { EmotePicker } from '../ui/EmotePicker';
import { CampfireVoiceUi } from '../ui/CampfireVoice';
import { Guide } from '../ui/Guide';
import { InstallGuide } from '../ui/InstallGuide';
import { api } from '../net/api';
import { ChatPanel } from '../ui/ChatPanel';
import { Modal } from '../ui/dom';
import { SettingsView, type SettingsPage } from '../ui/SettingsView';
import { Hud } from '../ui/Hud';
import { LANDMARKS, SPAWN } from '../world/config';
import { parseTimeOverride } from '../world/DayNight';
import { Interior } from '../world/Interior';
import { World } from '../world/World';
import { BENCHES, BENCH_SEATS, CAMPFIRE, CAMPFIRE_VOICE_ROOM, LOG_SEATS, type AccountInfo } from '../../../shared/protocol';
import { Devotion } from './Devotion';
import type { Look } from '../../../shared/protocol';
import { Avatar, DEFAULT_AVATAR } from '../entities/Avatar';
import { avatarLook, outfitCache, safeAppearance } from './looks';
import { CustomizeView, hiddenNotice, type MyLook } from '../ui/CustomizeView';
import { ReportView } from '../ui/ReportView';
import { AdminView } from '../ui/AdminView';
import { getMe } from '../net/api';
import { Social } from './Social';
import { ShopClient } from './Shop';
import { PropDock, ShopView } from '../ui/ShopView';
import { PLAZA as PLAZA_CENTRE, PROPS, SHOP_STALL, shopWindowAt } from '../../../shared/protocol';
import { DESK_SEATS, LIBRARY_DOOR, LIBRARY_ROOM, LIBRARY_SPAWN, BOOKCASES, BOOKCASE_IDS, type BookcaseCounts, type Space } from '../../../shared/protocol';
import { LibraryInterior, type LibrarySpot } from '../world/Library';
import { LibraryView } from '../ui/LibraryView';
import { kstStamp, takePhoto } from './Photo';

export interface GameSession {
  /** null = solo mode ("혼자 둘러보기"). */
  net: NetClient | null;
  welcome: Welcome | null;
  audio: AudioEngine;
  /** Where 나의 말씀 책 lives: server (account), guest (nothing saved) or local (offline). */
  store: WordBookStore;
  account: AccountInfo | null;
  /** Show the first-time guide when the world opens. */
  guideDue: boolean;
  /** The server can send Web Push (VAPID configured). */
  pushEnabled: boolean;
}

const GUIDE_KEY = 'worlds.guide.seen';

const LANTERN_READ_REACH = 2.6;
const LANTERN_TAP_REACH = 12;

const DOOR_REACH = 2.6;
/**
 * Render on demand: a sheet covering this share of the screen slows the world to
 * COVERED_FPS. Phone sheets span the full width (portrait) or the left two
 * thirds (landscape) and what's left is mostly the HUD,
 * so half the screen counts there; tablets and desktop need near-full cover.
 */
const COVER_FRACTION = 0.8;
const COVER_FRACTION_PHONE = 0.5;
const COVERED_FPS = 8;

/**
 * Owns the frame: input -> player -> camera -> world streaming -> HUD -> render.
 * Networking (remote players, chat, mats) lives in Social and runs right
 * after the local player moves.
 */

type AdminTab = 'outfits' | 'shop' | 'library' | 'voice';
type DeepLink = { kind: 'book'; id: number; letter: number | null } | { kind: 'diary' } | { kind: 'inbox' } | { kind: 'admin'; tab: AdminTab };
/** Links from notifications: /?book=<id>[&letter=<id>], /?diary=1, /?letters=1. */
function deepLink(q: URLSearchParams): DeepLink | null {
  const book = Number(q.get('book'));
  if (Number.isInteger(book) && book > 0) {
    const letter = Number(q.get('letter'));
    return { kind: 'book', id: book, letter: Number.isInteger(letter) && letter > 0 ? letter : null };
  }
  if (q.get('diary') === '1') return { kind: 'diary' };
  if (q.get('letters') === '1') return { kind: 'inbox' };
  // From the 운영 통계 dashboard's 관리 대기 links (opened only for admins).
  const admin = q.get('admin');
  if (admin === 'outfits' || admin === 'shop' || admin === 'library' || admin === 'voice') return { kind: 'admin', tab: admin };
  return null;
}

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly world: World;
  private readonly player: PlayerController;
  private readonly rig: CameraRig;
  private readonly input: Input;
  private readonly hud = new Hud();
  private readonly chat = new ChatPanel();
  private readonly social: Social;
  private readonly timer = new THREE.Timer();
  private readonly move: MoveIntent = { x: 0, y: 0, run: false };
  private elapsed = 0;
  private frame = 0;
  private readonly isTouch: boolean;
  /** Touch device with a phone-sized screen (short side < 600 px; tablets are wider). */
  private readonly isPhone: boolean;
  /** ?test=1: test hooks and the __WORLDS_DEBUG__ mirror (never built for real players). */
  private readonly testMode: boolean;
  /** Render-on-demand while a sheet covers the world (see shouldDraw). */
  private coverCheckFrame = -1000;
  private coverModal: Modal | null = null;
  private sheetCovers = false;
  /** ⚙ 🎨 화면 quality, cached (scales the weather particles). */
  private quality = graphicsQuality();
  private lastCoveredDraw = 0;
  private readonly terrainChecksum: number;
  private readonly audio: AudioEngine;
  private readonly devotion: Devotion;
  private readonly interior = new Interior();
  /** 이야기 도서관 hall (shared interior). */
  private readonly library = new LibraryInterior();
  private inLibrary = false;
  private libraryView!: LibraryView;
  private nearSpot: LibrarySpot | null = null;
  private shooting = false;
  private lastShot: Record<string, unknown> | null = null;
  private readonly cameraBtn = document.getElementById('camera-btn') as HTMLButtonElement | null;
  private readonly settings: SettingsView;
  private readonly closetUi = document.getElementById('closet-ui')!;
  private inCloset = false;
  private transitioning = false;
  private tapStart: { x: number; y: number; t: number } | null = null;
  private readonly lanterns: LanternField;
  private readonly lanternCard: LanternCard;
  private readonly groupsView: GroupsView;
  private readonly loginPrompt = new LoginPrompt();
  private readonly store: WordBookStore;
  private account: AccountInfo | null;
  private nearLantern: number | null = null;
  private localTag: NameTag | null = null;
  private readonly guide: Guide;
  private readonly installGuide = new InstallGuide();
  private voice: VoiceClient | null = null;
  private voicePanel: VoicePanel | null = null;
  private readonly micHelp = new MicHelp();
  /** 표현 (emotes): 😊 button + grid, keys 1–8. */
  private emotes!: EmotePicker;
  /** 🔥 모닥불 공개 음성: chat header button, switch prompt, 🚩 음성 신고. */
  private campfireUi!: CampfireVoiceUi;
  private pathGlow: PathGlow | null = null;
  private readonly guideDue: boolean;
  private readonly raycaster = new THREE.Raycaster();
  /** 꾸미기 (M8). */
  private readonly customize = new CustomizeView((mine) => this.applyMine(mine));
  private readonly adminView = new AdminView();
  private reportView!: ReportView;
  private isAdmin = false;
  private localLook: Look | null = null;
  private localOutfit: number | null = null;
  private noticeEl: HTMLElement | null = null;
  private noticeDismissed = new Set<number>();
  /** 나눔 소품 가게 (M9). */
  private readonly shop = new ShopClient(() => !!this.account);
  private shopView!: ShopView;
  private propDock!: PropDock;
  private nearShop = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly session: GameSession,
  ) {
    const params = new URLSearchParams(window.location.search);
    this.isTouch = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
    this.isPhone = this.isTouch && Math.min(screen.width, screen.height) < 600;
    this.testMode = params.get('test') === '1';
    // Shadows are the single most expensive feature; phones and ?shadows=0 skip them.
    const shadows = params.get('shadows') !== null ? params.get('shadows') !== '0' : !this.isTouch;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !this.isTouch, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 900);

    this.world = new World(this.scene, {
      // The server decides the seed so everyone walks the same world.
      seed: session.welcome?.seed ?? params.get('seed') ?? undefined,
      fixedHours: parseTimeOverride(params.get('time')),
      shadows,
    });

    // ?at=<landmark id> starts next to a landmark (QA / sharing a place).
    const at = LANDMARKS.find((l) => l.id === params.get('at'));
    let start = SPAWN;
    if (at && at.id !== 'plaza') {
      // Stand on the plaza-facing side, looking at the landmark.
      const dx = -at.x;
      const dz = -at.z;
      const len = Math.hypot(dx, dz);
      const r = at.radius + 3;
      start = { x: at.x + (dx / len) * r, z: at.z + (dz / len) * r, yaw: Math.atan2(dx, dz) };
    }
    this.player = new PlayerController(this.world, start.x, start.z, Math.PI + start.yaw);
    this.terrainChecksum = this.testMode ? this.world.terrainChecksum() : 0; // QA only
    this.scene.add(this.player.avatar.root);

    this.world.chunks.primeAround(this.player.position.x, this.player.position.z);

    this.rig = new CameraRig(this.camera, (x, z) => this.world.groundHeight(x, z), start.yaw);
    this.rig.setPortrait(canvas.clientWidth / Math.max(1, canvas.clientHeight) < 0.8);
    this.rig.snap(this.player.position);

    this.input = new Input(
      canvas,
      document.getElementById('stick-zone')!,
      document.getElementById('stick-base')!,
      document.getElementById('stick-knob')!,
    );
    this.hud.setTouch(this.input.isTouch);

    this.social = new Social({
      scene: this.scene,
      world: this.world,
      player: this.player,
      hud: this.hud,
      chat: this.chat,
      net: session.net,
      welcome: session.welcome,
      shadows,
      isTouch: () => this.input.isTouch,
      space: () => this.space(),
      onLibrary: (shelves) => this.library.setCounts(shelves),
      onLocalName: (name, guest) => this.setLocalName(name, guest),
      onReconnect: () => this.voice?.rejoinAfterReconnect(),
      tagView: () => this.tagView(),
      onWord: (word: WordPassage) => void this.devotion?.setWord(word),
      onWeather: (w) => this.applyWeather(w),
      onLocalLook: (look) => this.applyLocalLook(look),
    });

    this.audio = session.audio;
    // Group voice prayer rooms (signed-in members only; the server enforces it).
    if (session.net && session.account) {
      const voice = new VoiceClient(session.net, {
        onChange: () => this.onVoiceChange(),
        toast: (text) => this.hud.toast(text, this.elapsed, 5),
        onActive: (on) => session.audio.duckForVoice(on),
        masterVolume: () => session.audio.settings.voice,
        micPrePrompt: () => this.micHelp.prePrompt(),
        micHelp: () => this.micHelp.help(),
      });
      this.voice = voice;
      this.voicePanel = new VoicePanel(
        voice,
        (gid) => (gid === CAMPFIRE_VOICE_ROOM ? this.chat.setFolded(false) : void this.groupsView.open(gid, 'chat')),
        (id, name) => this.campfireUi.openReport(id, name),
      );
      session.audio.onSettingsChange(() => voice.applyAllVolumes());
    }
    this.store = session.store;
    this.account = session.account;
    // After the voice chip exists: the HUD dock sits below it (CSS sibling rule).
    this.setupShop(session);
    this.lanterns = new LanternField(this.world.field);
    this.scene.add(this.lanterns.group);
    const needLogin = (reason: string) => this.loginPrompt.open(reason);
    this.lanternCard = new LanternCard(() => !!this.account, needLogin, () => undefined);
    this.groupsView = new GroupsView({
      onChanged: () => undefined,
      onVoice: (groupId) => void this.joinGroupVoice(groupId),
      onVoiceLeave: () => this.voice?.leave(),
      currentVoice: () => this.voice?.groupId ?? null,
      onUnread: (n) => this.hud.setGroupsUnread(n),
    });
    this.groupsView.setMe(session.account?.id ?? null);
    this.campfireUi = new CampfireVoiceUi({
      voice: () => this.voice,
      signedIn: () => !!this.account,
      needLogin: (reason) => this.loginPrompt.open(reason, ''),
      openPanel: () => this.voicePanel?.open(),
      toast: (text) => this.hud.toast(text, this.elapsed, 4),
    });
    this.emotes = new EmotePicker((e) => this.social.sendEmote(e));
    this.reportView = new ReportView(this.social.remotes, () => !!this.account, (reason) => this.loginPrompt.open(reason, ''));
    if (session.account) {
      void getMe().then((me) => {
        this.isAdmin = (me as { admin?: boolean }).admin === true;
      });
    }
    if (session.account) void this.groupsView.refreshUnread();
    session.net?.on({
      // ✉️ 받은 편지: badge on 말씀; a gentle toast (fixed text) when something arrived.
      letters: (unread, toast, storyId) => {
        this.setLettersUnread(unread);
        const reading = storyId !== null && this.libraryView.isOpen && this.libraryView.describe().story?.id === storyId;
        if (reading && storyId !== null) void this.libraryView.refreshLetters(storyId);
        else if (toast) this.hud.toast(`${toast} · 말씀 → 📬 받은 편지`, this.elapsed, 5);
      },
      groupChat: (m) => this.groupsView.receive(m),
      groupChatUpdate: (m) => this.groupsView.update(m),
      groupRead: (gid) => this.groupsView.readElsewhere(gid),
    });
    session.net?.on({
      lanterns: (list) => this.lanterns.setAll(list),
      lantern: (l) => this.lanterns.upsert(l),
      lanternGone: (id) => this.lanterns.remove(id),
      // The server refused a jump: go back to where it last accepted us.
      correct: (x, _y, z) => {
        // B4: a late correction for the world (sent before we stepped inside) must not
        // drop us at world coordinates inside the hall.
        if (this.inLibrary && (Math.abs(x) > LIBRARY_ROOM.halfW || Math.abs(z) > LIBRARY_ROOM.halfD)) return;
        this.player.teleport(x, z);
        this.rig.snap(this.player.position);
      },
    });
    this.devotion = new Devotion({
      scene: this.scene,
      camera: this.camera,
      player: this.player,
      hud: this.hud,
      audio: this.audio,
      store: this.store,
      meditationPlace: () => this.meditationPlace(),
      cameraYaw: () => this.rig.yaw,
      now: () => this.elapsed,
      needLogin,
      lanternsChanged: () => undefined,
      openInbox: () => this.libraryView.openMine('inbox'),
      lettersUnread: () => this.lettersUnread,
      onLetterOpened: () => {
        if (this.account) void api('POST', '/api/footprints/letter').catch(() => undefined);
      },
      writeDiary: () => this.libraryView.openDiary(),
    });
    if (session.welcome?.word) void this.devotion.setWord(session.welcome.word);

    this.guide = new Guide(() => this.input.isTouch);
    this.guideDue = session.guideDue;
    this.settings = new SettingsView(
      this.audio,
      () => this.account,
      (name) => {
        if (this.account) this.account = { ...this.account, nickname: name };
        this.setLocalName(name, false);
      },
      () => this.guide.open((started) => started && this.showPaths()),
      this.installGuide,
      session.pushEnabled,
      {
        open: (back) => this.openCustomize(undefined, back),
        isAdmin: () => this.isAdmin,
        openAdmin: (tab) => void this.adminView.open(tab ?? 'outfits'),
      },
      {
        writeDiary: () => this.libraryView.openDiary(),
        openMine: () => this.libraryView.openMine(),
      },
    );
    this.libraryView = new LibraryView({
      signedIn: () => !!this.account,
      needLogin: (reason) => this.loginPrompt.open(reason, ''),
      toast: (text) => this.hud.toast(text, this.elapsed, 4),
      changed: () => void this.refreshShelves(),
      lettersUnread: (n) => this.setLettersUnread(n),
    });
    if (this.account) void this.refreshLetters();
    this.pendingLink = deepLink(params);
    this.setupCamera();
    // Tapping a 🕊️ notification while the app is open: show today's word.
    window.addEventListener('worlds-notification-click', (e) => {
      // ⏰ prop reminders just bring the app forward (the HUD chip shows the time left).
      const url = (e as CustomEvent).detail;
      if (typeof url === 'string' && url.includes('props=1')) return;
      // 📚 / ✉️ / 💌 → that book; 📔 → today's diary (L-B).
      const link = typeof url === 'string' ? deepLink(new URL(url, location.origin).searchParams) : null;
      if (link) return this.openLink(link);
      if (!Modal.anyOpen) void this.devotion.openWord();
    });

    this.hud.onAction(() => this.primaryAction());
    this.hud.bind('meditate', () => this.devotion.meditate());
    this.hud.bind('letter', () => void this.devotion.openLetter());
    this.hud.bind('word', () => void this.devotion.openWord());
    this.hud.bind('settings', () => this.settings.open());
    // "함께 N명": who is here (and 🚩 for drawn outfits).
    this.hud.onPeople(() => {
      if (session.net) this.reportView.openList();
    });
    this.hud.bind('groups', () => {
      if (!this.account) return needLogin('로그인하면 모임을 만들고, 모임 사람들과만 등불을 나눌 수 있어요.');
      void this.groupsView.open();
    });
    // First time: the guide, then (signed in, local book present) the import offer.
    const afterGuide = () => {
      if (this.account && this.store instanceof ServerWordBookStore) void this.offerImport(this.store, this.account);
    };
    if (this.guideDue) {
      // Opened right after the world appears (see start()).
      this.pendingGuide = afterGuide;
    } else {
      afterGuide();
    }
    document.getElementById('closet-meditate')!.addEventListener('click', () => this.devotion.meditate());
    document.getElementById('closet-exit')!.addEventListener('click', () => this.leaveCloset());
    // B4: from anywhere in the library, straight out of the door.
    const libExit = document.getElementById('library-exit');
    libExit?.addEventListener('pointerdown', (e) => e.stopPropagation());
    libExit?.addEventListener('click', (e) => {
      e.preventDefault();
      if (!this.transitioning) this.leaveLibrary();
    });

    // Tap/click (not drag) on the canvas: open the letter if it was hit.
    canvas.addEventListener('pointerdown', (e) => {
      this.tapStart = { x: e.clientX, y: e.clientY, t: performance.now() };
      // Tapping the world while typing puts the keyboard away (tablets/phones).
      this.chat.blur();
    });
    canvas.addEventListener('pointerup', (e) => {
      const s0 = this.tapStart;
      this.tapStart = null;
      if (!s0 || this.inCloset || this.transitioning) return;
      if (Math.hypot(e.clientX - s0.x, e.clientY - s0.y) < 8 && performance.now() - s0.t < 450 && this.inLibrary) {
        if (!this.tapLibrary(e.clientX, e.clientY)) this.tapPerson(e.clientX, e.clientY);
        return;
      }
      if (Math.hypot(e.clientX - s0.x, e.clientY - s0.y) < 8 && performance.now() - s0.t < 450) {
        if (!this.devotion.tap(e.clientX, e.clientY, canvas) && !this.tapLantern(e.clientX, e.clientY)) this.tapPerson(e.clientX, e.clientY);
      }
    });
    // Typing must not leave movement keys "held".
    this.chat.onFocusChange(() => this.input.reset());
    window.addEventListener('keydown', this.onKeyDown);

    if (this.testMode) this.installTestHooks();

    this.timer.connect(document);
    window.addEventListener('resize', this.resize);
    onGraphicsQuality(() => {
      this.quality = graphicsQuality();
      this.resize();
    });
    this.resize();

    // 서울 날씨: the server pushes changes; thunder rumbles go through the ambience bus.
    this.world.weather.onRumble = (strength) => this.audio.rumble(strength);
    session.net?.on({ weather: (w) => this.applyWeather(w) });
    if (!session.welcome?.weather) this.applyWeather(this.world.weather.state);
  }

  /** A new 서울 날씨 state: the scene follows over a few seconds, the clock card at once. */
  private applyWeather(next: WeatherState) {
    const wx = this.world.weather;
    wx.setState(next);
    const w = wx.state; // validated
    const label = wx.label;
    const known = !w.stale;
    this.hud.setWeather(
      w.kind === 'clear' ? null : label.name,
      w.kind === 'clear' ? '' : w.kind,
      known ? Math.round(w.tempC) : null,
      known ? `서울 ${label.name} · 날씨 정보: MET Norway (CC BY 4.0)` : '날씨를 아직 불러오지 못했어요 · 날씨 정보: MET Norway (CC BY 4.0)',
    );
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (this.chat.focused || e.repeat || Modal.anyOpen) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
    if (e.code === 'KeyE') {
      e.preventDefault();
      this.primaryAction();
    } else if (e.code === 'KeyP' && !this.inCloset) {
      e.preventDefault();
      void this.capture();
    } else if (e.code === 'Enter' && this.chat.isVisible) {
      e.preventDefault();
      this.chat.focus();
    } else if (/^(Digit|Numpad)[1-8]$/.test(e.code) && !this.inCloset && !this.transitioning && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // 표현: 1–8 fire directly.
      e.preventDefault();
      this.emotes.fire(Number(e.code.slice(-1)) - 1);
    }
  };

  /** One voice room at a time: leaving the campfire's for a group's asks first. */
  private async joinGroupVoice(groupId: number) {
    const v = this.voice;
    if (!v) return;
    if (v.campfire && v.state !== 'idle') {
      const go = await this.campfireUi.confirmSwitch('모닥불 음성에서 나와 모임 음성 기도방에 들어갈까요?', '음성 기도방 들어가기');
      if (!go) return;
    }
    await v.join(groupId);
  }

  /** Voice state changed: panel, chip and speaking rings on name tags. */
  private onVoiceChange() {
    this.voicePanel?.update();
    this.campfireUi?.update();
    const v = this.voice;
    if (!v) return;
    this.social.remotes.clearSpeaking();
    for (const p of v.peerList()) if (p.speaking && !p.localMuted) this.social.remotes.setSpeaking(p.id, true);
    this.localTag?.setSpeaking(v.active && v.speaking && !v.muted);
  }

  /** Our own nickname above our own avatar. */
  private setLocalName(name: string, guest: boolean) {
    if (this.localTag) this.localTag.set(name, guest);
    else this.localTag = new NameTag(this.player.avatar.root, name, guest);
  }

  private tagView(): TagView {
    return {
      camera: this.camera,
      viewportHeight: this.canvas.clientHeight,
      groundAt: this.inLibrary ? () => 0 : (x, z) => this.world.groundHeight(x, z),
      elapsed: this.elapsed,
    };
  }

  private pendingGuide: (() => void) | null = null;

  /** Remember that the guide was seen: on the account (all devices) or on this device. */
  private markGuideSeen() {
    if (this.account) void api('POST', '/api/me/onboarded').catch(() => undefined);
    else {
      try {
        localStorage.setItem(GUIDE_KEY, '1');
      } catch {
        /* ignore */
      }
    }
  }

  private showPaths() {
    this.pathGlow?.dispose();
    this.pathGlow = new PathGlow(this.world.field);
    this.scene.add(this.pathGlow.points);
  }

  private nearDoor(): boolean {
    const door = this.world.landmarks.closetDoor;
    const p = this.player.position;
    return Math.hypot(p.x - door.x, p.z - door.z) < DOOR_REACH;
  }

  private space(): Space {
    return this.inCloset ? 'room' : this.inLibrary ? 'library' : 'world';
  }

  private nearLibraryDoor(): boolean {
    const p = this.player.position;
    return Math.hypot(p.x - LIBRARY_DOOR.x, p.z - LIBRARY_DOOR.z) < DOOR_REACH;
  }

  private meditationPlace(): MeditationPlace | null {
    if (this.inCloset) return '골방';
    if (this.player.seat >= 0 && this.player.seatKind === 'mat') return '기도의 뜰';
    return null;
  }

  /** E key / action button: enter the 골방, sit/stand on a mat, read a lantern, or visit the shop. */
  private primaryAction() {
    if (this.inCloset || this.transitioning) return;
    if (this.inLibrary) return this.libraryAction();
    if (this.player.seat < 0 && this.nearDoor()) return this.enterCloset();
    if (this.player.seat < 0 && this.nearLibraryDoor()) return this.enterLibrary();
    if (this.player.seat < 0 && !this.social.seatAction(false) && this.nearLantern !== null) return void this.openLantern(this.nearLantern);
    if (this.player.seat < 0 && !this.social.seatAction(false) && this.nearShop) return this.openShop();
    this.social.toggleSeat();
  }

  // ------------------------------------------------------------------ 나눔 소품 가게 (M9)

  private setupShop(session: GameSession) {
    const toast = (text: string, seconds = 4) => this.hud.toast(text, this.elapsed, seconds);
    this.scene.add(this.player.avatar.trail);
    this.shopView = new ShopView(this.shop, { toast, needLogin: (reason) => this.loginPrompt.open(reason, '') });
    this.propDock = new PropDock(this.shop, () => this.openShop(), toast);
    this.shop.onChange(() => this.applyShop());
    if (session.net) {
      session.net.on({
        shop: (s) => this.shop.setStatus(s),
        myShop: (mine, ended) => {
          this.shop.setMine(mine);
          for (const item of ended) if (PROPS[item]) toast(`${PROPS[item].emoji} ${PROPS[item].name} 사용 시간이 끝나서 가게로 돌아갔어요.`, 5);
        },
        propReminder: (item, _endsAt, now) => {
          this.shop.syncClock(now);
          if (PROPS[item]) toast(`⏰ ${PROPS[item].name} 사용 시간이 10분 남았어요`, 6);
        },
      });
    } else {
      // 혼자 둘러보기: the stall follows this device's clock, nothing can be borrowed.
      const solo = () => this.shop.setStatus({ ...shopWindowAt(Date.now()), now: Date.now(), stock: {} });
      solo();
      window.setInterval(solo, 30_000);
    }
    this.applyShop();
  }

  private shopOpenShown: boolean | null = null;
  private shopSignText = '';

  /** Our avatar wears what the server says we borrowed; the stall follows the server's window. */
  private applyShop() {
    this.player.avatar.setProps(this.shop.props);
    const open = this.shop.open;
    const sign = this.shop.status ? `${this.shop.nextOpenLabel()}에 문을 열어요` : '';
    if (open !== this.shopOpenShown || sign !== this.shopSignText) {
      this.shopOpenShown = open;
      this.shopSignText = sign;
      this.world.landmarks.setShop(open, sign);
    }
  }

  private openShop() {
    if (this.inCloset) return;
    this.shopView.open();
  }

  private async openLantern(id: number) {
    try {
      await this.lanternCard.open(id);
    } catch (err) {
      this.hud.toast(err instanceof ApiError ? err.message : '등불을 열지 못했어요.', this.elapsed);
    }
  }

  /** Tap on a lantern: read it if close enough. True when a lantern was hit. */
  private tapLantern(clientX: number, clientY: number): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const id = this.lanterns.pick(this.raycaster);
    if (id === null) return false;
    const p = this.player.position;
    if (this.lanterns.distanceTo(id, p.x, p.z) > LANTERN_TAP_REACH) {
      this.hud.toast('등불에 조금 더 가까이 가 주세요.', this.elapsed);
      return true;
    }
    void this.openLantern(id);
    return true;
  }

  /** Tap on another person (avatar or name tag): their card, with 🚩 옷 신고. */
  private tapPerson(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const id = this.social.remotes.pick(this.raycaster);
    if (id) this.reportView.openPlayer(id);
  }

  // ------------------------------------------------------------------ 꾸미기 (M8)

  private openCustomize(tab?: 'color' | 'hair' | 'draw', back?: () => void) {
    if (!this.account) {
      this.loginPrompt.open('로그인하면 내 모습의 색과 머리 모양을 고르고, 옷에 그림을 그려 입을 수 있어요.', '');
      return;
    }
    this.customize.open(tab, back).catch((err) => this.hud.toast(err instanceof ApiError ? err.message : '꾸미기를 열지 못했어요.', this.elapsed));
  }

  /** Right after saving (the server's 'look' message follows with the same data). */
  private applyMine(mine: MyLook) {
    const worn = mine.worn !== null ? mine.slots[mine.worn] : null;
    if (!mine.appearance && !worn) return this.applyLocalLook(null);
    const look: Look = { ...(mine.appearance ?? { r: 0, s: 0, k: 1, h: 0, y: 0 }) };
    if (worn) Object.assign(look, { o: worn.id, oh: worn.hash, ...(worn.hidden ? { hid: true } : {}) });
    this.applyLocalLook(look);
  }

  /** Our own avatar: saved colours/hair and the worn drawing (even when hidden for others). */
  private applyLocalLook(raw: Look | null) {
    const a = raw ? safeAppearance(raw) : null;
    this.localLook = raw && a ? { ...raw, ...a } : null;
    const avatar = this.player.avatar;
    avatar.setLook(a ? avatarLook(a) : DEFAULT_AVATAR);
    const o = this.localLook && Number.isInteger(this.localLook.o) ? (this.localLook.o as number) : null;
    if (o !== this.localOutfit) {
      this.localOutfit = o;
      if (o === null) avatar.setPattern(null);
      else outfitCache.load(o, (px) => this.localOutfit === o && avatar.setPattern(px));
    }
    this.showHiddenNotice(this.localLook?.hid === true && o !== null ? o : null);
  }

  /** "신고가 쌓여 옷 그림이 숨겨졌어요" for the owner (once per drawing, dismissable). */
  private showHiddenNotice(outfitId: number | null) {
    if (outfitId === null || this.noticeDismissed.has(outfitId)) {
      this.noticeEl?.remove();
      this.noticeEl = null;
      return;
    }
    if (this.noticeEl) return;
    const box = el('section', 'card outfit-notice');
    box.id = 'outfit-notice';
    box.setAttribute('role', 'status');
    const actions = el('div', 'outfit-notice-actions');
    const fix = button('그림 고치기', 'primary', () => {
      this.noticeDismissed.add(outfitId);
      this.showHiddenNotice(null);
      this.openCustomize('draw');
    });
    const close = button('닫기', 'ghost', () => {
      this.noticeDismissed.add(outfitId);
      this.showHiddenNotice(null);
    });
    close.id = 'outfit-notice-close';
    actions.append(fix, close);
    box.append(hiddenNotice(), actions);
    box.addEventListener('pointerdown', (e) => e.stopPropagation());
    document.getElementById('app')!.append(box);
    this.noticeEl = box;
  }

  /** First login on a device with an M3 local word book: offer to move it into the account. */
  private async offerImport(server: ServerWordBookStore, account: AccountInfo) {
    const key = `worlds.imported.${account.id}`;
    let flag: string | null = null;
    try {
      flag = localStorage.getItem(key);
    } catch {
      return;
    }
    if (flag) return;
    const local = new LocalWordBookStore();
    const pages = await local.importable();
    if (pages.length === 0) return;
    const count = pages.reduce((n, p) => n + p.meditations.length, 0);
    const mark = (v: string) => {
      try {
        localStorage.setItem(key, v);
      } catch {
        /* ignore */
      }
    };
    const modal = new Modal('import-overlay', '말씀 책 옮기기');
    const body = el('div', 'prompt-body');
    const status = el('p', 'groups-status');
    body.append(
      el('p', 'prompt-title', '이 기기에 적어 둔 묵상이 있어요'),
      el('p', '', `${pages.length}장의 말씀과 ${count}개의 묵상을 ${account.nickname} 님의 계정으로 옮길까요? 옮기면 다른 기기에서도 볼 수 있어요.`),
    );
    const go = button('옮기기', 'primary', async () => {
      go.disabled = true;
      try {
        const r = await server.importLocal(pages);
        mark('done');
        modal.close();
        this.hud.toast(`${r.meditationsAdded}개의 묵상을 내 말씀 책으로 옮겼어요.`, this.elapsed, 5);
      } catch (err) {
        go.disabled = false;
        status.textContent = err instanceof ApiError ? err.message : '옮기지 못했어요. 잠시 후 다시 시도해 주세요.';
      }
    });
    go.id = 'import-confirm';
    const later = button('나중에', 'ghost', () => modal.close());
    const never = button('옮기지 않을게요', 'ghost', () => {
      mark('dismissed');
      modal.close();
    });
    const actions = el('div', 'prompt-actions');
    actions.append(go, later, never);
    body.append(actions, status);
    modal.sheet.className = 'sheet login-prompt';
    modal.sheet.append(body);
    modal.open();
  }

  // ------------------------------------------------------------------ 이야기 도서관 (L-A)

  /** E / action button inside the hall: door, desk chair, a bookcase, 쓰는 책상. */
  private libraryAction() {
    if (this.player.seat >= 0) return this.social.toggleSeat();
    const spot = this.nearSpot;
    if (spot?.kind === 'exit') return this.leaveLibrary();
    if (this.social.seatAction(false)) return this.social.toggleSeat();
    if (spot) this.openSpot(spot);
  }

  private openSpot(spot: LibrarySpot) {
    if (spot.kind === 'bookcase') this.libraryView.openShelf(spot.id);
    else if (spot.kind === 'write') this.libraryView.openDesk();
    else if (spot.kind === 'exit') this.leaveLibrary();
  }

  /** Tap on a bookcase or the writing desk. True when one was hit. */
  private tapLibrary(clientX: number, clientY: number): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    if (this.social.remotes.pick(this.raycaster)) return false;
    const spot = this.library.pick(this.raycaster);
    if (!spot) return false;
    this.openSpot(spot);
    return true;
  }

  /**
   * B4 safety net: holding a direction for ~2 s without moving while not on free
   * floor (inside furniture, off the floor) → step to the nearest free spot.
   */
  private stuckFor = 0;
  private watchStuck(dt: number, bx: number, bz: number) {
    const p = this.player.position;
    const pushing = Math.hypot(this.move.x, this.move.y) > 0.3 && this.player.seat < 0 && !this.transitioning;
    const moved = Math.hypot(p.x - bx, p.z - bz) > 0.002;
    this.stuckFor = pushing && !moved ? this.stuckFor + dt : 0;
    if (this.stuckFor < 2) return;
    this.stuckFor = 0;
    if (!this.library.isFree(p.x, p.z, 0.3)) {
      this.player.recover();
      this.social.forceSend();
      this.hud.toast('길이 막혀서 가까운 빈자리로 옮겼어요. 왼쪽 위 ↩ 문으로 나가기로 언제든 나갈 수 있어요.', this.elapsed, 5);
    }
  }

  /** ✉️ unread letters (badge on 말씀). */
  private lettersUnread = 0;
  private setLettersUnread(n: number) {
    this.lettersUnread = n;
    this.hud.setLettersUnread(n);
  }

  private async refreshLetters() {
    try {
      // Just the badge number; the full 받은 편지 loads when that view opens.
      this.setLettersUnread((await api<{ unread: number }>('GET', '/api/library/letters/unread')).unread);
    } catch {
      /* offline */
    }
  }

  /** ?book=… / ?diary=1 (notification taps, shared links): opened once the world is up. */
  private pendingLink: DeepLink | null = null;
  private openLink(link: DeepLink) {
    if (link.kind === 'book') this.libraryView.openStory(link.id, link.letter);
    else if (link.kind === 'diary') this.libraryView.openDiary();
    else if (link.kind === 'admin') {
      if (this.account)
        void getMe().then((me) => {
          if ((me as { admin?: boolean }).admin === true) void this.adminView.open(link.tab);
        });
    } else this.libraryView.openMine('inbox');
  }

  private async refreshShelves() {
    try {
      const r = await api<{ shelves: BookcaseCounts }>('GET', '/api/library/shelves');
      this.library.setCounts(r.shelves);
    } catch {
      /* offline: keep what we have */
    }
  }

  enterLibrary() {
    if (this.inLibrary || this.inCloset) return;
    this.input.reset();
    this.social.forceSend();
    this.fade(() => {
      this.inLibrary = true;
      document.body.classList.add('in-library');
      // Everyone in the hall shares this scene: our avatar and the other players move in.
      this.library.scene.add(this.player.avatar.root, this.player.avatar.trail, this.social.remotes.group);
      this.player.setGround(this.library);
      this.player.teleport(LIBRARY_SPAWN.x, LIBRARY_SPAWN.z);
      this.player.yaw = LIBRARY_SPAWN.yaw;
      this.rig.setIndoor(true, () => 0);
      this.rig.yaw = 0;
      this.rig.pitch = 0.42;
      this.rig.snap(this.player.position);
      this.social.spaceChanged();
      void this.refreshShelves();
    });
  }

  leaveLibrary() {
    if (!this.inLibrary) return;
    if (this.player.seat >= 0) this.social.toggleSeat();
    this.libraryView.close();
    this.fade(() => {
      this.inLibrary = false;
      document.body.classList.remove('in-library');
      this.scene.add(this.player.avatar.root, this.player.avatar.trail, this.social.remotes.group);
      this.player.setGround(this.world);
      this.rig.setIndoor(false, (x, z) => this.world.groundHeight(x, z));
      // Out of the door, facing the plaza.
      const { fx, fz } = LIBRARY_DOOR;
      this.player.teleport(LIBRARY_DOOR.x + fx * 1.0, LIBRARY_DOOR.z + fz * 1.0);
      this.player.yaw = Math.atan2(fx, fz);
      this.rig.yaw = Math.atan2(-fx, -fz);
      this.rig.snap(this.player.position);
      this.social.spaceChanged();
    });
  }

  // ------------------------------------------------------------------ 📸 photos

  private setupCamera() {
    const b = this.cameraBtn;
    if (!b) return;
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      b.blur();
      void this.capture();
    });
  }

  /** Render the 3D view (no HUD, no sheets), stamp it and keep it in 오늘 앨범. */
  async capture(): Promise<Record<string, unknown> | null> {
    if (this.shooting || this.inCloset || this.transitioning) return null;
    if (!this.account) {
      this.loginPrompt.open('로그인하면 QT 월드의 풍경을 사진으로 남기고 오늘의 일기에 넣을 수 있어요.', '');
      return null;
    }
    this.shooting = true;
    try {
      const place = this.inLibrary ? '이야기 도서관' : (this.world.locate(this.player.position.x, this.player.position.z)?.name ?? '들판');
      const { date, time } = kstStamp();
      const photo = await takePhoto(
        this.canvas,
        () => this.renderer.render(this.inLibrary ? this.library.scene : this.scene, this.camera),
        { date, time, place, nickname: this.account.nickname },
      );
      const flash = document.getElementById('shot-flash');
      if (flash) {
        flash.classList.remove('on');
        void flash.offsetWidth;
        flash.classList.add('on');
      }
      this.lastShot = { bytes: photo.blob.size, type: photo.type, width: photo.width, height: photo.height, quality: photo.quality, stamp: photo.stamp, source: 'webgl-canvas', uploaded: false };
      const res = await fetch(`/api/shots?place=${encodeURIComponent(place)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': photo.type }, body: photo.blob });
      const data = (await res.json().catch(() => ({}))) as { shot?: { id: number }; usedToday?: number; message?: string };
      if (!res.ok) {
        this.hud.toast(data.message ?? '사진을 저장하지 못했어요.', this.elapsed, 4);
        this.lastShot = { ...this.lastShot, error: res.status };
        return this.lastShot;
      }
      this.lastShot = { ...this.lastShot, uploaded: true, id: data.shot?.id ?? null, usedToday: data.usedToday ?? null };
      this.hud.toast(`📸 오늘 앨범에 담았어요 (${data.usedToday ?? 1}/10) · 나의 서재에서 볼 수 있어요`, this.elapsed, 4);
      return this.lastShot;
    } catch (err) {
      this.hud.toast(err instanceof Error ? err.message : '사진을 찍지 못했어요.', this.elapsed);
      return null;
    } finally {
      this.shooting = false;
    }
  }

  private fade(midway: () => void) {
    const fade = document.getElementById('fade')!;
    this.transitioning = true;
    fade.classList.add('on');
    window.setTimeout(() => {
      midway();
      fade.classList.remove('on');
      this.transitioning = false;
    }, 380);
  }

  enterCloset() {
    if (this.inCloset) return;
    this.input.reset();
    this.fade(() => {
      this.inCloset = true;
      document.body.classList.add('closet');
      this.closetUi.hidden = false;
      this.resize();
    });
  }

  leaveCloset() {
    if (!this.inCloset) return;
    this.fade(() => {
      this.inCloset = false;
      document.body.classList.remove('closet');
      this.closetUi.hidden = true;
      // Step out of the door, facing away from the house.
      const door = this.world.landmarks.closetDoor;
      const house = this.world.locate(door.x, door.z);
      const hx = house ? house.x : door.x;
      const hz = house ? house.z : door.z;
      const len = Math.hypot(door.x - hx, door.z - hz) || 1;
      const fx = (door.x - hx) / len;
      const fz = (door.z - hz) / len;
      this.player.teleport(door.x + fx * 1.2, door.z + fz * 1.2);
      this.player.yaw = Math.atan2(fx, fz);
      this.rig.yaw = Math.atan2(-fx, -fz);
      this.rig.snap(this.player.position);
    });
  }

  /** ?test=1 only: lets automated tests place players without walking. */
  private installTestHooks() {
    (window as unknown as { __WORLDS_TEST__: unknown }).__WORLDS_TEST__ = {
      teleport: (x: number, z: number) => {
        this.player.teleport(x, z);
        this.rig.snap(this.player.position);
      },
      voiceJoin: (groupId: number) => this.voice?.join(groupId),
      /** 서울 날씨 (client only; the server override is /api/test/weather). */
      weather: (w: Partial<WeatherState>) => this.applyWeather({ ...this.world.weather.state, ...w }),
      /** Pretend it's this KST date ('2026-12-24'), or null for today: seasons and Christmas. */
      weatherDate: (iso: string | null) => this.world.weather.setDate(iso ? Date.parse(`${iso}T12:00:00+09:00`) : null),
      /** Skip the fade between looks. */
      weatherSnap: () => this.world.weather.snap(),
      weatherFlashSoon: () => this.world.weather.flashSoon(),
      /** Speed up snow cover / melting / drying (1 = real time). */
      weatherRate: (k: number) => (this.world.weather.rate = k),
      snowCover: (v: number) => (this.world.weather.snowCover = v),
      /** 표현 through the real path (server echo shows it). */
      emote: (e: number) => this.emotes.fire(e),
      /** 🔥 campfire voice: the ICE config of every peer connection. */
      voicePcConfig: () => this.voice?.describe().peers.map((p) => ({ id: p.id, iceTransportPolicy: p.iceTransportPolicy })) ?? [],
      voiceLeave: () => this.voice?.leave(),
      voiceMute: (muted: boolean) => this.voice?.setMuted(muted),
      voiceStats: () => this.voice?.stats(),
      voiceReleaseMic: () => this.voice?.releaseMic(),
      dropSocket: () => this.session.net?.debugDrop(),
      /** Screen position of a remote avatar's chest (tap it like a player would). */
      remoteScreen: (id: string) => {
        const v = this.social.remotes.headWorld(id);
        if (!v) return null;
        v.project(this.camera);
        const r = this.canvas.getBoundingClientRect();
        return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height, z: v.z };
      },
      openCustomize: (tab?: 'color' | 'hair' | 'draw') => this.openCustomize(tab),
      /** ⚙ 설정 deep link ('menu', 'sound', 'notify', 'account', 'install', 'admin'). */
      openSettings: (page?: SettingsPage) => this.settings.open(page),
      /** Painter/customize state right now (the debug object lags a few frames). */
      customize: () => this.customize.describe(),
      /** Turn our avatar (screenshots). */
      face: (yaw: number) => {
        this.player.yaw = yaw;
        this.social.forceSend();
      },
      /** Campfire log seats and chat radius (shared protocol numbers). */
      logSeats: () => ({ campfire: CAMPFIRE, seats: LOG_SEATS.map((s) => ({ ...s })) }),
      /** Plaza bench seats (shared protocol numbers). */
      benchSeats: () => ({ benches: BENCHES.map((b) => ({ ...b })), seats: BENCH_SEATS.map((s) => ({ ...s })) }),
      /** 나눔 소품 가게: client state (what the server said) and the sheet. */
      shop: () => ({ ...this.shop.describe(), sheetOpen: this.shopView.isOpen, nearShop: this.nearShop }),
      openShop: () => this.openShop(),
      /** Rent through the real client path (same requestId reused on retries). */
      shopRent: (item: import('../../../shared/protocol').PropId, requestId?: string) => this.shop.rent(item, requestId),
      shopRefresh: () => this.shop.refresh(),
      stall: () => ({ ...SHOP_STALL }),
      /** Point the orbit camera (for screenshots). */
      view: (yaw: number, pitch?: number, zoom?: number) => {
        this.rig.yaw = yaw;
        if (pitch !== undefined) this.rig.pitch = pitch;
        if (zoom) this.rig.applyZoom(zoom);
        this.rig.snap(this.player.position);
      },
      closetDoor: () => {
        const d = this.world.landmarks.closetDoor;
        return { x: d.x, z: d.z };
      },
      /** 이야기 도서관 (L-A). */
      libraryDoor: () => ({ x: LIBRARY_DOOR.x, z: LIBRARY_DOOR.z }),
      enterLibrary: () => this.enterLibrary(),
      leaveLibrary: () => this.leaveLibrary(),
      library: () => ({ desks: DESK_SEATS.map((s) => ({ ...s })), spots: this.library.spots(), fronts: Object.fromEntries(BOOKCASE_IDS.map((id) => [id, this.library.shelfFront(id)])) }),
      libraryOpen: (what: string, arg?: unknown) => {
        const v = this.libraryView;
        if (what === 'shelf') v.openShelf(arg as never);
        else if (what === 'story') v.openStory(arg as number);
        else if (what === 'mine') v.openMine(arg as never);
        else if (what === 'write') v.openWrite((arg as number) ?? null);
        else if (what === 'diary') v.openDiary();
        else if (what === 'desk') v.openDesk();
      },
      /**
       * B4: drive the real PlayerController on the library floor (no rendering):
       * from every free grid point walk a BFS path to the door; push into walls,
       * corners and furniture; stand up from every desk chair.
       */
      libraryWalk: (gridStep = 0.4) => {
        const lib = this.library;
        const pc = new PlayerController(lib, LIBRARY_SPAWN.x, LIBRARY_SPAWN.z, 0);
        const { halfW, halfD } = LIBRARY_ROOM;
        const exit = { x: 0, z: 6.3 };
        const cell = 0.25;
        const nx = Math.round((2 * halfW) / cell);
        const nz = Math.round((2 * halfD) / cell);
        const idx = (i: number, k: number) => k * nx + i;
        const cx = (i: number) => -halfW + (i + 0.5) * cell;
        const cz = (k: number) => -halfD + (k + 0.5) * cell;
        const free = new Uint8Array(nx * nz);
        for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) free[idx(i, k)] = lib.isFree(cx(i), cz(k), 0.36) ? 1 : 0;
        // Distance field from the door over free cells (4-neighbour BFS).
        const dist = new Int32Array(nx * nz).fill(-1);
        const ei = Math.floor((exit.x + halfW) / cell);
        const ek = Math.floor((exit.z + halfD) / cell);
        const q = [idx(ei, ek)];
        dist[q[0]] = 0;
        for (let h = 0; h < q.length; h++) {
          const c = q[h];
          const i = c % nx;
          const k = Math.floor(c / nx);
          for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const ii = i + di;
            const kk = k + dk;
            if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
            const n = idx(ii, kk);
            if (!free[n] || dist[n] >= 0) continue;
            dist[n] = dist[c] + 1;
            q.push(n);
          }
        }
        const cellOf = (x: number, z: number) => idx(Math.max(0, Math.min(nx - 1, Math.floor((x + halfW) / cell))), Math.max(0, Math.min(nz - 1, Math.floor((z + halfD) / cell))));
        const onFloor = () => lib.groundHeight(pc.position.x, pc.position.z) === 0;
        const step = (dx: number, dz: number, run = false) => {
          const len = Math.hypot(dx, dz) || 1;
          pc.update(1 / 60, { x: dx / len, y: -dz / len, run }, 0, 0);
        };
        const out = { starts: 0, reached: 0, unreachable: [] as string[], stuck: [] as string[], offFloor: [] as string[], pushes: 0, pushFails: [] as string[], seats: [] as string[] };
        for (let x = -halfW + 0.3; x <= halfW - 0.3; x += gridStep) {
          for (let z = -halfD + 0.3; z <= halfD - 0.3; z += gridStep) {
            if (!lib.isFree(x, z, 0.36)) continue;
            out.starts++;
            const tag = `${x.toFixed(1)},${z.toFixed(1)}`;
            // The start is free but its grid cell's centre may not be: any reachable cell within ~0.5 m will do.
            let near = false;
            const c0 = cellOf(x, z);
            for (let di = -2; di <= 2 && !near; di++)
              for (let dk = -2; dk <= 2 && !near; dk++) {
                const ii = (c0 % nx) + di;
                const kk = Math.floor(c0 / nx) + dk;
                if (ii >= 0 && kk >= 0 && ii < nx && kk < nz && dist[idx(ii, kk)] >= 0) near = true;
              }
            if (!near) {
              out.unreachable.push(tag);
              continue;
            }
            pc.teleport(x, z);
            let ok = false;
            for (let t = 0; t < 60 * 40; t++) {
              const p = pc.position;
              if (Math.hypot(p.x - exit.x, p.z - exit.z) < 1.0) {
                ok = true;
                break;
              }
              // Steer to the lowest-distance free neighbour cell's centre.
              const c = cellOf(p.x, p.z);
              let best = c;
              const i0 = c % nx;
              const k0 = Math.floor(c / nx);
              for (let di = -1; di <= 1; di++)
                for (let dk = -1; dk <= 1; dk++) {
                  const ii = i0 + di;
                  const kk = k0 + dk;
                  if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
                  const n = idx(ii, kk);
                  if (dist[n] >= 0 && (dist[best] < 0 || dist[n] < dist[best])) best = n;
                }
              if (dist[best] < 0)
                for (let di = -2; di <= 2; di++)
                  for (let dk = -2; dk <= 2; dk++) {
                    const ii = i0 + di;
                    const kk = k0 + dk;
                    if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
                    const n = idx(ii, kk);
                    if (dist[n] >= 0 && (dist[best] < 0 || dist[n] < dist[best])) best = n;
                  }
              const tx = best === c ? exit.x : cx(best % nx);
              const tz = best === c ? exit.z : cz(Math.floor(best / nx));
              step(tx - p.x, tz - p.z);
              if (!onFloor()) {
                out.offFloor.push(tag);
                break;
              }
            }
            if (ok) out.reached++;
            else if (!out.offFloor.includes(tag)) out.stuck.push(`${tag}→${pc.position.x.toFixed(1)},${pc.position.z.toFixed(1)}`);
          }
        }
        // Push hard into every wall, corner and piece of furniture for 3 s, then walk out.
        const targets: { x: number; z: number }[] = [
          ...lib.collidersNear().map((c) => ({ x: c.x, z: c.z })),
          { x: -halfW, z: -halfD },
          { x: halfW, z: -halfD },
          { x: -halfW, z: halfD },
          { x: halfW, z: halfD },
          { x: -halfW, z: 0 },
          { x: halfW, z: 0 },
          { x: 0, z: -halfD },
          { x: 3, z: halfD },
        ];
        for (const t of targets) {
          for (let a = 0; a < 8; a++) {
            const sx = t.x + Math.cos((a / 8) * Math.PI * 2) * 1.6;
            const sz = t.z + Math.sin((a / 8) * Math.PI * 2) * 1.6;
            if (!lib.isFree(sx, sz, 0.36)) continue;
            out.pushes++;
            pc.teleport(sx, sz);
            for (let i = 0; i < 180; i++) step(t.x - pc.position.x, t.z - pc.position.z, i % 2 === 0);
            const tag = `${t.x.toFixed(1)},${t.z.toFixed(1)}#${a}`;
            if (!onFloor()) {
              out.pushFails.push(`${tag} off floor`);
              continue;
            }
            // …and can still walk away from it.
            const before = { x: pc.position.x, z: pc.position.z };
            for (let i = 0; i < 90; i++) step(sx - t.x, sz - t.z);
            if (Math.hypot(pc.position.x - before.x, pc.position.z - before.z) < 0.3) out.pushFails.push(`${tag} can't back off`);
          }
        }
        for (const seat of DESK_SEATS) {
          pc.sitAt(seat.index, seat.x, seat.z, seat.yaw, 'desk');
          pc.standUp();
          if (!lib.isFree(pc.position.x, pc.position.z, 0.34)) out.seats.push(`seat ${seat.index} → ${pc.position.x.toFixed(2)},${pc.position.z.toFixed(2)}`);
        }
        pc.avatar.root.removeFromParent();
        return out;
      },
      libraryFree: (x: number, z: number) => this.library.isFree(x, z),
      playerPos: () => ({ x: this.player.position.x, z: this.player.position.z, inLibrary: this.inLibrary }),
      capture: () => this.capture(),
      /** Screen position of a library spot (to tap it like a player would). */
      libraryScreen: (x: number, y: number, z: number) => {
        const v = new THREE.Vector3(x, y, z).project(this.camera);
        const r = this.canvas.getBoundingClientRect();
        return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
      },
      /** Screen position of the flying letter (to click it like a player would). */
      letterScreen: () => {
        const g = this.scene.getObjectByName('today-letter');
        if (!g) return null;
        const v = new THREE.Vector3();
        g.getWorldPosition(v);
        v.project(this.camera);
        const r = this.canvas.getBoundingClientRect();
        return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
      },
    };
  }

  private readonly resize = () => {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    // Pixel ratio is a fill-rate budget; ⚙ → 🎨 화면 picks it (default 선명).
    const maxDpr = maxPixelRatio(this.isTouch ? 1.5 : 1.75);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxDpr));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Portrait phones get a wider view so the world doesn't feel cramped.
    this.camera.fov = w / h < 0.8 ? 68 : 55;
    this.camera.updateProjectionMatrix();
    this.rig?.setPortrait(w / h < 0.8);
    this.interior?.setAspect(w / h);
  };

  start() {
    this.renderer.setAnimationLoop(this.tick);
  }

  private readonly tick = () => {
    this.timer.update();
    const dt = Math.min(Math.max(this.timer.getDelta(), 0), 0.1);
    this.elapsed += dt;
    this.frame++;

    // 1. Input
    this.input.readMove(this.move);
    if (this.chat.focused || Modal.anyOpen || this.inCloset || this.transitioning) {
      this.move.x = 0;
      this.move.y = 0;
    }
    const look = this.input.consumeLook();
    if (this.inCloset) this.interior.look(look.dx, look.dy);
    else this.rig.applyLook(look.dx, look.dy, this.input.isTouch);
    this.rig.applyZoom(this.input.consumeZoom());
    this.hud.setTouch(this.input.isTouch);

    // 2. Simulation
    const bx = this.player.position.x;
    const bz = this.player.position.z;
    this.player.update(dt, this.move, this.rig.yaw, this.elapsed);
    if (this.inLibrary) this.watchStuck(dt, bx, bz);
    this.social.update(dt, this.elapsed, Math.hypot(this.move.x, this.move.y) > 0.2);

    // 3. Camera (after the player moved)
    this.rig.update(dt, this.player.position);

    // 4. World streaming, sky, landmark ambience (inside the library the world waits at its door)
    this.world.update(this.elapsed, this.camera, this.inLibrary ? this.world.landmarks.libraryDoor : this.player.position);
    this.world.weather.update({
      dt,
      elapsed: this.elapsed,
      camera: this.camera,
      outdoor: !this.inCloset && !this.inLibrary,
      covered: this.sheetCovers,
      quality: this.quality,
    });

    // 5. Today's word, ambience, HUD
    this.devotion.update(dt, this.elapsed, !this.inCloset && !this.inLibrary && !this.transitioning);
    this.lanterns.setNight(this.world.dayNight.night);
    this.player.avatar.setNight(this.world.dayNight.night);
    this.social.remotes.setNight(this.world.dayNight.night);
    if (!this.inCloset) this.localTag?.update(this.tagView());
    this.lanterns.update(this.elapsed, this.inCloset || this.inLibrary ? null : this.nearLantern);
    this.updateAudio();
    this.updateHud();

    if (this.inCloset) {
      this.interior.update(dt, this.elapsed, this.world.dayNight.night, this.world.weather.gloom);
      if (this.shouldDraw(false)) this.renderer.render(this.interior.scene, this.interior.camera);
    } else if (this.inLibrary) {
      this.library.update(this.camera, this.elapsed, this.world.dayNight.night, this.world.weather.gloom);
      if (this.shouldDraw(true)) this.renderer.render(this.library.scene, this.camera);
    } else if (this.shouldDraw(true)) {
      this.renderer.render(this.scene, this.camera);
    }

    if (this.frame === 3) {
      this.hud.ready();
      const link = this.pendingLink;
      if (link) {
        this.pendingLink = null;
        // Tidy the address bar (a reload shouldn't reopen it).
        const q = new URLSearchParams(location.search);
        for (const k of ['book', 'letter', 'diary', 'letters', 'admin']) q.delete(k);
        const qs = q.toString();
        history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
        if (!this.pendingGuide) this.openLink(link);
        else {
          const after = this.pendingGuide;
          this.pendingGuide = () => {
            after();
            this.openLink(link);
          };
        }
      }
      const next = this.pendingGuide;
      if (next) {
        this.pendingGuide = null;
        this.guide.open((started) => {
          this.markGuideSeen();
          if (started) this.showPaths();
          next();
          // Once, gently: "📲 앱으로 설치하기" (only where it applies).
          setTimeout(() => this.installGuide.offerOnce(), 1500);
        });
      }
    }
    if (this.pathGlow && !this.pathGlow.update(dt)) {
      this.pathGlow.dispose();
      this.pathGlow = null;
    }
    if (this.testMode) {
      try {
        this.publishDebug();
      } catch (err) {
        // Debug state is best-effort; never let it stop the animation loop.
        if (this.frame % 600 === 0) console.warn('debug publish failed', err);
      }
    }
  };

  /**
   * Render on demand: the world is still updated every frame, but drawn less
   * often when nobody can see it. The 꾸미기 preview has its own renderer, so the
   * world behind it is drawn every 4th frame; a sheet covering most of the
   * screen (every phone sheet; near-full ones elsewhere) drops it to COVERED_FPS
   * behind the dimmed backdrop (input is paused while a sheet is open anyway).
   * Closing the sheet restores the full rate at once.
   */
  private shouldDraw(customizeApplies: boolean): boolean {
    if (customizeApplies && this.customize.isOpen) return this.frame % 4 === 0;
    const m = Modal.current;
    if (!m) {
      this.coverModal = null;
      this.sheetCovers = false;
      return true;
    }
    // One layout read every 15 frames (the sheet slides in, and phones rotate).
    if (m !== this.coverModal || this.frame - this.coverCheckFrame >= 15) {
      this.coverModal = m;
      this.coverCheckFrame = this.frame;
      const r = m.sheet.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      this.sheetCovers = w * h >= (this.isPhone ? COVER_FRACTION_PHONE : COVER_FRACTION) * vw * vh;
    }
    if (!this.sheetCovers) return true;
    const now = performance.now();
    if (now - this.lastCoveredDraw < 1000 / COVERED_FPS) return false;
    this.lastCoveredDraw = now;
    return true;
  }

  private updateAudio() {
    const p = this.player.position;
    const fireD = Math.hypot(p.x - CAMPFIRE.x, p.z - CAMPFIRE.z);
    const indoor = this.inCloset || this.inLibrary;
    this.audio.setMix({
      wind: indoor ? 0 : 0.6 + 0.4 * (1 - this.world.dayNight.night * 0.5),
      fire: indoor ? 0 : THREE.MathUtils.clamp(1 - (fireD - 3) / 22, 0, 1),
      room: this.inCloset ? 1 : this.inLibrary ? 0.45 : 0,
      // Rain outside; behind the 골방 or library walls it's quieter and duller.
      rain: this.world.weather.rainLevel,
      muffle: indoor ? 1 : 0,
    });
    this.audio.tick();
  }

  private updateHud() {
    const touch = this.input.isTouch;
    const place = this.meditationPlace();
    this.hud.setMeditate(!!place && !this.inCloset && !Modal.anyOpen);
    if (this.inCloset) {
      this.hud.setAction(null);
      this.hud.setPlace('골방');
      this.hud.update(this.elapsed, this.input.hasMoved);
      return;
    }
    if (this.inLibrary) return this.updateLibraryHud(touch);
    const seatLabel = this.social.seatAction(touch);
    const p0 = this.player.position;
    this.nearLantern = this.player.seat < 0 ? (this.lanterns.nearest(p0.x, p0.z, LANTERN_READ_REACH)?.id ?? null) : null;
    this.nearShop = this.player.seat < 0 && Math.hypot(p0.x - SHOP_STALL.x, p0.z - SHOP_STALL.z) < SHOP_STALL.reach;
    const shopLabel = this.shop.open ? '소품 가게 보기' : '가게 안내 보기';
    if (this.player.seat < 0 && this.nearDoor()) this.hud.setAction(touch ? '골방에 들어가기' : '골방에 들어가기 (E)');
    else if (this.player.seat < 0 && this.nearLibraryDoor()) this.hud.setAction(touch ? '도서관에 들어가기' : '도서관에 들어가기 (E)');
    else if (!seatLabel && this.nearLantern !== null) this.hud.setAction(touch ? '등불 읽기' : '등불 읽기 (E)');
    else if (!seatLabel && this.nearShop) this.hud.setAction(touch ? shopLabel : `${shopLabel} (E)`);
    else this.hud.setAction(seatLabel);
    this.propDock.setNearPlaza(Math.hypot(p0.x - PLAZA_CENTRE.x, p0.z - PLAZA_CENTRE.z) < 16);
    this.propDock.update();

    const p = this.player.position;
    const here = this.world.locate(p.x, p.z);
    this.hud.setPlace(here ? here.name : '들판');

    const dn = this.world.dayNight;
    this.hud.setClock(dn.formatClock(), dn.phase, dn.night > 0.5);

    const door = this.world.landmarks.closetDoor;
    if (Math.hypot(p.x - door.x, p.z - door.z) < 3.2) {
      this.hud.showPrompt('closet-door', '골방 문 앞', '문을 열고 들어가면 나만의 조용한 기도 방이에요.', this.elapsed, true);
    } else if (Math.hypot(p.x - LIBRARY_DOOR.x, p.z - LIBRARY_DOOR.z) < 3.4) {
      this.hud.showPrompt('library-door', '이야기 도서관', '들어가면 함께 있는 분들과 조용히 이야기를 읽을 수 있어요.', this.elapsed, true);
    } else if (this.nearShop) {
      this.hud.clearPrompt('closet-door');
      this.hud.clearPrompt('library-door');
      if (this.shop.open) this.hud.showPrompt('shop-open', '나눔 소품 가게', `모두 무료예요 · ${this.shop.closesLabel()}까지 열려 있어요`, this.elapsed);
      else this.hud.showPrompt('shop-closed', '나눔 소품 가게', `지금은 문을 닫았어요 · ${this.shop.nextOpenLabel()}에 다시 열어요`, this.elapsed);
    } else {
      this.hud.clearPrompt('closet-door');
      this.hud.clearPrompt('library-door');
      if (here) this.hud.showPrompt(here.id, here.name, here.blurb, this.elapsed);
      else this.hud.clearPrompt();
    }
    this.hud.update(this.elapsed, this.input.hasMoved);
  }

  private updateLibraryHud(touch: boolean) {
    const p = this.player.position;
    this.nearLantern = null;
    this.nearShop = false;
    this.nearSpot = this.player.seat < 0 ? this.library.near(p.x, p.z) : null;
    const seatLabel = this.social.seatAction(touch);
    const spot = this.nearSpot;
    const key = (label: string) => (touch ? label : `${label} (E)`);
    if (spot?.kind === 'exit') this.hud.setAction(key('밖으로 나가기'));
    else if (seatLabel) this.hud.setAction(seatLabel);
    else if (spot?.kind === 'bookcase') this.hud.setAction(key(`${BOOKCASES[spot.id].name} 책장 보기`));
    else if (spot?.kind === 'write') this.hud.setAction(key('쓰는 책상'));
    else this.hud.setAction(null);
    this.propDock.setNearPlaza(false);
    this.propDock.update();
    this.hud.setPlace('이야기 도서관');
    const dn = this.world.dayNight;
    this.hud.setClock(dn.formatClock(), dn.phase, dn.night > 0.5);
    this.hud.showPrompt('library-in', '이야기 도서관', '🙏 하나님 이야기와 📔 일기 책장을 누르면 책을 꺼내 읽을 수 있어요. 들어온 문으로 나가요.', this.elapsed);
    this.hud.update(this.elapsed, this.input.hasMoved);
  }

  private publishDebug() {
    if (this.frame % 5 !== 0 && this.frame > 3) return;
    const p = this.player.position;
    const dn = this.world.dayNight;
    const info = this.renderer.info.render;
    window.__WORLDS_DEBUG__ = {
      ready: this.frame >= 3,
      frame: this.frame,
      seed: this.world.seedText,
      terrainChecksum: this.terrainChecksum,
      chunks: this.world.chunks.loadedCount,
      player: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) },
      location: this.world.locate(p.x, p.z)?.name ?? '들판',
      timeOfDay: { hours: +dn.hours.toFixed(2), phase: dn.phase, sun: +dn.sunHeight.toFixed(2) },
      renderer: { calls: info.calls, triangles: info.triangles, pixelRatio: this.renderer.getPixelRatio(), sheetCovers: this.sheetCovers },
      net: this.social.describe(),
      m3: {
        ...this.devotion.describe(),
        closet: this.inCloset,
        // Remote avatars actually drawn this frame (0 inside the 골방: separate scene).
        renderedRemotes: this.inCloset ? 0 : this.social.remotes.describe().filter((r) => r.visible).length,
        audio: this.audio.describe(),
      },
      m10: {
        settingsPage: this.settings.currentPage,
        bookTab: this.devotion.bookTab,
      },
      la: {
        space: this.space(),
        inLibrary: this.inLibrary,
        nearSpot: this.nearSpot,
        books: this.library.bookCounts,
        counts: this.library.counts,
        view: this.libraryView.describe(),
        lastShot: this.lastShot,
        renderedRemotes: this.social.remotes.describe().filter((r) => r.visible).map((r) => r.id),
      },
      m4: {
        account: this.account,
        store: this.store.kind,
        lanterns: this.lanterns.describe(),
        nearLantern: this.nearLantern,
        guide: this.guide.describe(),
        voice: this.voice?.describe() ?? null,
        emoteOpen: this.emotes.isOpen,
        voiceReportOpen: this.campfireUi.reportOpen,
        localTag: this.localTag ? { text: this.localTag.text, guest: this.localTag.isGuest, visible: this.localTag.visible } : null,
      },
      m8: {
        look: this.localLook,
        avatar: (() => {
          const l = this.player.avatar.currentLook;
          return { robe: `#${l.robe.toString(16).padStart(6, '0')}`, hairStyle: l.hairStyle, pattern: this.player.avatar.patternInfo };
        })(),
        liveTextures: Avatar.liveTextures,
        outfitRequests: outfitCache.requests,
        notice: !!this.noticeEl,
        admin: this.isAdmin,
        customize: this.customize.describe(),
        report: this.reportView?.isOpen ?? false,
      },
      wx: {
        ...this.world.weather.describe(),
        hud: document.querySelector('.clock-card .eyebrow')?.textContent ?? '',
        icon: document.getElementById('clock-icon')?.textContent ?? '',
      },
      m9: {
        shopOpen: this.shop.open,
        stall: this.world.landmarks.shopVisual,
        props: this.player.avatar.propsInfo,
        rentals: this.shop.rentals.map((r) => ({ id: r.id, item: r.item, endsAt: r.endsAt })),
        usedToday: this.shop.mine?.usedToday ?? null,
        sheet: this.shopView.isOpen,
        nearShop: this.nearShop,
        liveProps: Avatar.liveProps,
      },
    };
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.resize);
    this.input.dispose();
    window.removeEventListener('keydown', this.onKeyDown);
    this.social.dispose();
    this.interior.dispose();
    this.library.dispose();
    this.world.chunks.dispose();
    this.player.avatar.dispose();
    this.timer.dispose();
    this.renderer.dispose();
  }
}
