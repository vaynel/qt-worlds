import * as THREE from 'three';
import type { WordPassage } from '../../../shared/protocol';
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
import { Guide } from '../ui/Guide';
import { InstallGuide } from '../ui/InstallGuide';
import { api } from '../net/api';
import { ChatPanel } from '../ui/ChatPanel';
import { Modal } from '../ui/dom';
import { SettingsView } from '../ui/SettingsView';
import type { WorshipPlayer } from '../ui/WorshipPlayer';
import { Hud } from '../ui/Hud';
import { LANDMARKS, SPAWN } from '../world/config';
import { parseTimeOverride } from '../world/DayNight';
import { Interior } from '../world/Interior';
import { World } from '../world/World';
import { BENCHES, BENCH_SEATS, CAMPFIRE, LOG_SEATS, type AccountInfo } from '../../../shared/protocol';
import { Devotion } from './Devotion';
import type { Look } from '../../../shared/protocol';
import { Avatar, DEFAULT_AVATAR } from '../entities/Avatar';
import { avatarLook, outfitCache, safeAppearance } from './looks';
import { CustomizeView, hiddenNotice, type MyLook } from '../ui/CustomizeView';
import { ReportView } from '../ui/ReportView';
import { AdminView } from '../ui/AdminView';
import { getMe } from '../net/api';
import { Social } from './Social';

export interface GameSession {
  /** null = solo mode ("혼자 둘러보기"). */
  net: NetClient | null;
  welcome: Welcome | null;
  audio: AudioEngine;
  /** The single persistent worship player (created before entry). */
  worship: WorshipPlayer;
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
 * Owns the frame: input -> player -> camera -> world streaming -> HUD -> render.
 * Networking (remote players, chat, mats) lives in Social and runs right
 * after the local player moves.
 */
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
  private readonly terrainChecksum: number;
  private readonly audio: AudioEngine;
  private readonly devotion: Devotion;
  private readonly interior = new Interior();
  private readonly worship: WorshipPlayer;
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

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly session: GameSession,
  ) {
    const params = new URLSearchParams(window.location.search);
    this.isTouch = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
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
    this.terrainChecksum = this.world.terrainChecksum();
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
      isInside: () => this.inCloset,
      onLocalName: (name, guest) => this.setLocalName(name, guest),
      onReconnect: () => this.voice?.rejoinAfterReconnect(),
      tagView: () => this.tagView(),
      onWord: (word: WordPassage) => void this.devotion?.setWord(word),
      onLocalLook: (look) => this.applyLocalLook(look),
    });

    this.audio = session.audio;
    // Group voice prayer rooms (signed-in members only; the server enforces it).
    if (session.net && session.account) {
      const voice = new VoiceClient(session.net, {
        onChange: () => this.onVoiceChange(),
        toast: (text) => this.hud.toast(text, this.elapsed, 5),
        onActive: (on) => {
          session.worship.setDuck(on ? 0.2 : 1);
          session.audio.duckForVoice(on);
        },
        masterVolume: () => session.audio.settings.voice,
        micPrePrompt: () => this.micHelp.prePrompt(),
        micHelp: () => this.micHelp.help(),
      });
      this.voice = voice;
      this.voicePanel = new VoicePanel(voice, (gid) => void this.groupsView.open(gid, 'chat'));
      session.audio.onSettingsChange(() => voice.applyAllVolumes());
    }
    this.store = session.store;
    this.account = session.account;
    this.lanterns = new LanternField(this.world.field);
    this.scene.add(this.lanterns.group);
    const needLogin = (reason: string) => this.loginPrompt.open(reason);
    this.lanternCard = new LanternCard(() => !!this.account, needLogin, () => undefined);
    this.groupsView = new GroupsView({
      onChanged: () => undefined,
      onVoice: (groupId) => void this.voice?.join(groupId),
      onVoiceLeave: () => this.voice?.leave(),
      currentVoice: () => this.voice?.groupId ?? null,
      onUnread: (n) => this.hud.setGroupsUnread(n),
    });
    this.groupsView.setMe(session.account?.id ?? null);
    this.reportView = new ReportView(this.social.remotes, () => !!this.account, (reason) => this.loginPrompt.open(reason, ''));
    if (session.account) {
      void getMe().then((me) => {
        this.isAdmin = (me as { admin?: boolean }).admin === true;
      });
    }
    if (session.account) void this.groupsView.refreshUnread();
    session.net?.on({
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
    });
    if (session.welcome?.word) void this.devotion.setWord(session.welcome.word);

    this.worship = session.worship;
    this.worship.onPlayingChange((playing) => this.audio.duck(playing));
    this.worship.onNotice((text) => this.hud.toast(text, this.elapsed, 4));
    this.worship.onVisibilityChange((open) => this.hud.setWorshipOpen(open));
    this.hud.setWorshipOpen(this.worship.isOpen);
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
        open: () => this.openCustomize(),
        isAdmin: () => this.isAdmin,
        openAdmin: () => void this.adminView.open(),
      },
    );
    // Tapping a 🕊️ notification while the app is open: show today's word.
    window.addEventListener('worlds-notification-click', () => {
      if (!Modal.anyOpen) void this.devotion.openWord();
    });

    this.hud.onAction(() => this.primaryAction());
    this.hud.bind('meditate', () => this.devotion.meditate());
    this.hud.bind('letter', () => void this.devotion.openLetter());
    this.hud.bind('word', () => void this.devotion.openWord());
    this.hud.bind('book', () => void this.devotion.openBook());
    this.hud.bind('worship', () => {
      // Folded (paused tab) → bring it back; open → close; closed → open.
      if (this.worship.isOpen && !this.inCloset && this.worship.foldState !== 'folded') this.worship.close();
      else this.worship.open(this.inCloset, true);
    });
    this.hud.bind('settings', () => this.settings.open());
    this.hud.bind('look', () => this.openCustomize());
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

    // Tap/click (not drag) on the canvas: open the letter if it was hit.
    canvas.addEventListener('pointerdown', (e) => {
      this.tapStart = { x: e.clientX, y: e.clientY, t: performance.now() };
      // Tapping the world while typing puts the keyboard away (tablets/phones).
      this.chat.blur();
    });
    canvas.addEventListener('pointerup', (e) => {
      const s0 = this.tapStart;
      this.tapStart = null;
      if (!s0 || this.inCloset) return;
      if (Math.hypot(e.clientX - s0.x, e.clientY - s0.y) < 8 && performance.now() - s0.t < 450) {
        if (!this.devotion.tap(e.clientX, e.clientY, canvas) && !this.tapLantern(e.clientX, e.clientY)) this.tapPerson(e.clientX, e.clientY);
      }
    });
    // Typing must not leave movement keys "held".
    this.chat.onFocusChange(() => this.input.reset());
    window.addEventListener('keydown', this.onKeyDown);

    if (params.get('test') === '1') this.installTestHooks();

    this.timer.connect(document);
    window.addEventListener('resize', this.resize);
    this.resize();
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (this.chat.focused || e.repeat || Modal.anyOpen) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
    if (e.code === 'KeyE') {
      e.preventDefault();
      this.primaryAction();
    } else if (e.code === 'Enter' && this.chat.isVisible) {
      e.preventDefault();
      this.chat.focus();
    }
  };

  /** Voice state changed: panel, chip and speaking rings on name tags. */
  private onVoiceChange() {
    this.voicePanel?.update();
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
      groundAt: (x, z) => this.world.groundHeight(x, z),
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

  private meditationPlace(): MeditationPlace | null {
    if (this.inCloset) return '골방';
    if (this.player.seat >= 0 && this.player.seatKind === 'mat') return '기도의 뜰';
    return null;
  }

  /** E key / action button: enter the 골방, sit/stand on a mat, or read a lantern. */
  private primaryAction() {
    if (this.inCloset || this.transitioning) return;
    if (this.player.seat < 0 && this.nearDoor()) return this.enterCloset();
    if (this.player.seat < 0 && !this.social.seatAction(false) && this.nearLantern !== null) return void this.openLantern(this.nearLantern);
    this.social.toggleSeat();
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

  private openCustomize(tab?: 'color' | 'hair' | 'draw') {
    if (!this.account) {
      this.loginPrompt.open('로그인하면 내 모습의 색과 머리 모양을 고르고, 옷에 그림을 그려 입을 수 있어요.', '');
      return;
    }
    this.customize.open(tab).catch((err) => this.hud.toast(err instanceof ApiError ? err.message : '꾸미기를 열지 못했어요.', this.elapsed));
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
      this.worship.setRoom(true);
      this.resize();
    });
  }

  leaveCloset() {
    if (!this.inCloset) return;
    this.fade(() => {
      this.inCloset = false;
      document.body.classList.remove('closet');
      this.closetUi.hidden = true;
      this.worship.setRoom(false);
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
      /** Worship player fold state in the world dock (layout tests). */
      worshipFold: (fold: 'open' | 'mini' | 'folded') => this.worship.setFold(fold),
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
    // Pixel ratio is a fill-rate budget: capped lower on touch devices.
    const maxDpr = this.isTouch ? 1.5 : 1.75;
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
    this.player.update(dt, this.move, this.rig.yaw, this.elapsed);
    this.social.update(dt, this.elapsed, Math.hypot(this.move.x, this.move.y) > 0.2);

    // 3. Camera (after the player moved)
    this.rig.update(dt, this.player.position);

    // 4. World streaming, sky, landmark ambience
    this.world.update(this.elapsed, this.camera, this.player.position);

    // 5. Today's word, ambience, HUD
    this.devotion.update(dt, this.elapsed, !this.inCloset && !this.transitioning);
    this.lanterns.setNight(this.world.dayNight.night);
    if (!this.inCloset) this.localTag?.update(this.tagView());
    this.lanterns.update(this.elapsed, this.inCloset ? null : this.nearLantern);
    this.updateAudio();
    this.updateHud();

    if (this.inCloset) {
      this.interior.update(dt, this.elapsed, this.world.dayNight.night);
      this.renderer.render(this.interior.scene, this.interior.camera);
    } else if (!this.customize.isOpen || this.frame % 4 === 0) {
      // The 꾸미기 preview has its own renderer: draw the world behind it less often.
      this.renderer.render(this.scene, this.camera);
    }

    if (this.frame === 3) {
      this.hud.ready();
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
    this.publishDebug();
  };

  private updateAudio() {
    const p = this.player.position;
    const fireD = Math.hypot(p.x - CAMPFIRE.x, p.z - CAMPFIRE.z);
    this.audio.setMix({
      wind: this.inCloset ? 0 : 0.6 + 0.4 * (1 - this.world.dayNight.night * 0.5),
      fire: this.inCloset ? 0 : THREE.MathUtils.clamp(1 - (fireD - 3) / 22, 0, 1),
      room: this.inCloset ? 1 : 0,
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
    const seatLabel = this.social.seatAction(touch);
    const p0 = this.player.position;
    this.nearLantern = this.player.seat < 0 ? (this.lanterns.nearest(p0.x, p0.z, LANTERN_READ_REACH)?.id ?? null) : null;
    if (this.player.seat < 0 && this.nearDoor()) this.hud.setAction(touch ? '골방에 들어가기' : '골방에 들어가기 (E)');
    else if (!seatLabel && this.nearLantern !== null) this.hud.setAction(touch ? '등불 읽기' : '등불 읽기 (E)');
    else this.hud.setAction(seatLabel);

    const p = this.player.position;
    const here = this.world.locate(p.x, p.z);
    this.hud.setPlace(here ? here.name : '들판');

    const dn = this.world.dayNight;
    this.hud.setClock(dn.formatClock(), dn.phase, dn.night > 0.5);

    const door = this.world.landmarks.closetDoor;
    if (Math.hypot(p.x - door.x, p.z - door.z) < 3.2) {
      this.hud.showPrompt('closet-door', '골방 문 앞', '문을 열고 들어가면 나만의 조용한 기도 방이에요.', this.elapsed, true);
    } else {
      this.hud.clearPrompt('closet-door');
      if (here) this.hud.showPrompt(here.id, here.name, here.blurb, this.elapsed);
      else this.hud.clearPrompt();
    }
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
      renderer: { calls: info.calls, triangles: info.triangles },
      net: this.social.describe(),
      m3: {
        ...this.devotion.describe(),
        closet: this.inCloset,
        // Remote avatars actually drawn this frame (0 inside the 골방: separate scene).
        renderedRemotes: this.inCloset ? 0 : this.social.remotes.describe().filter((r) => r.visible).length,
        worship: this.worship.describe(),
        audio: this.audio.describe(),
      },
      m4: {
        account: this.account,
        store: this.store.kind,
        lanterns: this.lanterns.describe(),
        nearLantern: this.nearLantern,
        guide: this.guide.describe(),
        voice: this.voice?.describe() ?? null,
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
    };
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.resize);
    this.input.dispose();
    window.removeEventListener('keydown', this.onKeyDown);
    this.social.dispose();
    this.interior.dispose();
    this.world.chunks.dispose();
    this.player.avatar.dispose();
    this.timer.dispose();
    this.renderer.dispose();
  }
}
