import type * as THREE from 'three';
import {
  BENCH_SEATS,
  BENCH_SEAT_COUNT,
  CAMPFIRE,
  DESK_SEATS,
  DESK_SEAT_COUNT,
  LOG_SEATS,
  LOG_SEAT_COUNT,
  MATS,
  MAT_COUNT,
  SIT_REACH,
  STATE_SEND_HZ,
  seatSpot,
  type PlayerSnap,
  type SeatKind,
  type ShelfCounts,
  type Space,
} from '../../../shared/protocol';
import type { PlayerController } from '../entities/PlayerController';
import type { NetClient, NetStatus, Welcome } from '../net/NetClient';
import { BubbleSlot, RemotePlayers } from '../net/RemotePlayers';
import type { ChatPanel } from '../ui/ChatPanel';
import type { Hud } from '../ui/Hud';
import type { World } from '../world/World';

const nowSeconds = () => performance.now() / 1000;

export interface SocialOptions {
  scene: THREE.Scene;
  world: World;
  player: PlayerController;
  hud: Hud;
  chat: ChatPanel;
  net: NetClient | null;
  welcome: Welcome | null;
  shadows: boolean;
  isTouch: () => boolean;
  /** Where the local player is: the open world, the 골방 ('room') or the library. */
  space: () => Space;
  /** 이야기 도서관 shelf counts pushed by the server. */
  onLibrary?: (shelves: ShelfCounts) => void;
  onWord?: (word: import('../../../shared/protocol').WordPassage) => void;
  /** Our own display name (welcome / live rename). */
  onLocalName?: (name: string, guest: boolean) => void;
  tagView?: () => import('../world/NameTag').TagView;
  /** After a WebSocket reconnect (the server forgot room state). */
  onReconnect?: () => void;
  /** Our own appearance (welcome, live after saving, hidden after reports). */
  onLocalLook?: (look: import('../../../shared/protocol').Look | null) => void;
}

/**
 * Everything shared with other people: remote avatars, campfire chat and
 * prayer-garden mats. Works without a server too ("혼자 둘러보기"): mats are
 * then local-only and chat stays closed.
 */
export class Social {
  readonly remotes: RemotePlayers;
  private readonly o: SocialOptions;
  private mats: (string | null)[] = Array(MAT_COUNT).fill(null);
  /** Campfire log seats (LOG_SEATS order). */
  private logs: (string | null)[] = Array(LOG_SEAT_COUNT).fill(null);
  /** 중앙 광장 bench seats (BENCH_SEATS order). */
  private benches: (string | null)[] = Array(BENCH_SEAT_COUNT).fill(null);
  /** 이야기 도서관 reading desk seats (DESK_SEATS order). */
  private desks: (string | null)[] = Array(DESK_SEAT_COUNT).fill(null);
  private readonly localBubble: BubbleSlot;
  private sendTimer = 0;
  private lastSent = { x: NaN, z: NaN, yaw: NaN, t: 0 };
  private localId: string;
  private localName: string;
  private localGuest = false;
  private nearFire = false;
  private lastSpace: Space = 'world';
  private chatLog: string[] = [];

  constructor(options: SocialOptions) {
    this.o = options;
    this.remotes = new RemotePlayers(options.shadows);
    options.scene.add(this.remotes.group);
    this.localBubble = new BubbleSlot(options.player.avatar.root);
    this.localId = options.welcome?.id ?? 'local';
    this.localName = options.welcome?.name ?? '나';

    options.chat.onSend((text) => this.sendChat(text));

    const net = options.net;
    if (net && options.welcome) {
      this.applyWelcome(options.welcome, false);
      net.on({
        welcome: (w) => this.applyWelcome(w, true),
        join: (p) => this.remotes.add(p.id, p.name, p.guest === true, p.look ?? null, p.props ?? []),
        // Our own props come with myShop (the shop client); others' live here.
        props: (id, props) => {
          if (id !== this.localId) this.remotes.setProps(id, props);
        },
        look: (id, look) => {
          if (id === this.localId) this.o.onLocalLook?.(look);
          else this.remotes.setLook(id, look);
        },
        rename: (id, name) => {
          if (id === this.localId) {
            this.localName = name;
            this.o.onLocalName?.(name, this.localGuest);
          } else this.remotes.rename(id, name);
        },
        leave: (id) => this.remotes.remove(id),
        snapshot: (players: PlayerSnap[]) => {
          // Right after a space switch the server may still describe the old space.
          if (nowSeconds() < this.ignoreSnapsUntil) return;
          this.remotes.applySnapshot(players, this.localId, nowSeconds());
        },
        chat: (id, name, text) => this.receiveChat(id, name, text),
        mats: (mats) => this.applyMats(mats),
        logs: (logs) => this.applyLogs(logs),
        benches: (benches) => this.applyBenches(benches),
        desks: (desks) => this.applyDesks(desks),
        library: (shelves) => this.o.onLibrary?.(shelves),
        error: (_code, message) => this.o.hud.toast(message, nowSeconds()),
        status: (status) => this.onStatus(status),
        word: (word) => this.o.onWord?.(word),
      });
      document.addEventListener('visibilitychange', this.onVisibility);
    }
    this.refreshNetLine();
  }

  private readonly onVisibility = () => {
    if (document.visibilityState === 'visible') this.o.net?.nudge();
  };

  private get online(): boolean {
    return !!this.o.net?.online;
  }

  private applyWelcome(w: Welcome, isReconnect: boolean) {
    this.localId = w.id;
    this.localName = w.name;
    this.remotes.clear();
    for (const p of w.players) this.remotes.add(p.id, p.name, p.guest === true, p.look ?? null, p.props ?? []);
    this.localGuest = w.guest;
    this.o.onLocalLook?.(w.look);
    this.o.onLocalName?.(w.name, w.guest);
    this.applyMats(w.mats);
    this.applyLogs(w.logs);
    this.applyBenches(w.benches);
    this.applyDesks(w.desks);
    if (w.word) this.o.onWord?.(w.word);
    // Force a fresh state send so others see us where we really are.
    this.lastSent.t = 0;
    if (isReconnect) {
      this.o.hud.toast('다시 연결됐어요.', nowSeconds());
      this.o.onReconnect?.();
    }
    this.refreshNetLine();
  }

  private onStatus(status: NetStatus) {
    if (status === 'reconnecting') {
      // Others can no longer see us; clear stale avatars until we're back.
      this.remotes.clear();
    }
    this.refreshNetLine();
  }

  private refreshNetLine() {
    const net = this.o.net;
    if (!net) return this.o.hud.setNet('혼자 둘러보는 중', 'solo');
    switch (net.status) {
      case 'online':
        return this.o.hud.setNet(`함께 ${this.remotes.count + 1}명 · ${this.localName}`, 'online');
      case 'connecting':
      case 'reconnecting':
        return this.o.hud.setNet('다시 연결하는 중…', 'waiting');
      case 'closed':
        return this.o.hud.setNet('연결이 끊겼어요', 'solo');
    }
  }

  // ------------------------------------------------------------------ mats

  private applyMats(mats: (string | null)[]) {
    this.mats = Array.from({ length: MAT_COUNT }, (_, i) => (typeof mats[i] === 'string' ? mats[i] : null));
    this.o.world.landmarks.setMatsOccupied(this.mats.map((m) => m !== null));
    this.syncLocalSeat('mat');
  }

  private applyLogs(logs: (string | null)[]) {
    this.logs = Array.from({ length: LOG_SEAT_COUNT }, (_, i) => (typeof logs[i] === 'string' ? logs[i] : null));
    this.syncLocalSeat('log');
  }

  private applyBenches(benches: (string | null)[]) {
    this.benches = Array.from({ length: BENCH_SEAT_COUNT }, (_, i) => (typeof benches[i] === 'string' ? benches[i] : null));
    this.syncLocalSeat('bench');
  }

  private applyDesks(desks: (string | null)[]) {
    this.desks = Array.from({ length: DESK_SEAT_COUNT }, (_, i) => (typeof desks[i] === 'string' ? desks[i] : null));
    this.syncLocalSeat('desk');
  }

  private seatList(kind: SeatKind): (string | null)[] {
    return kind === 'log' ? this.logs : kind === 'bench' ? this.benches : kind === 'desk' ? this.desks : this.mats;
  }

  /** Follow the server's word on where we sit (one list of seats changed). */
  private syncLocalSeat(kind: SeatKind) {
    const p = this.o.player;
    const mine = this.seatList(kind).indexOf(this.localId);
    if (mine >= 0 && (p.seat !== mine || p.seatKind !== kind)) {
      const spot = seatSpot(kind, mine)!;
      p.sitAt(mine, spot.x, spot.z, spot.yaw, kind);
    } else if (mine < 0 && p.seat >= 0 && p.seatKind === kind) {
      p.standUp();
    }
  }

  /** Nearest free mat, log or bench seat within reach (a little inside the server's). */
  private nearestFreeSeat(): { kind: SeatKind; index: number } | null {
    const p = this.o.player.position;
    let best: { kind: SeatKind; index: number } | null = null;
    let bestD = SIT_REACH * 0.92;
    const scan = (kind: SeatKind, spots: readonly { index: number; x: number; z: number }[], taken: (string | null)[]) => {
      for (const spot of spots) {
        if (taken[spot.index] !== null) continue;
        const d = Math.hypot(p.x - spot.x, p.z - spot.z);
        if (d < bestD) {
          best = { kind, index: spot.index };
          bestD = d;
        }
      }
    };
    const space = this.o.space();
    if (space === 'library') scan('desk', DESK_SEATS, this.desks);
    else if (space === 'world') {
      scan('mat', MATS, this.mats);
      scan('log', LOG_SEATS, this.logs);
      scan('bench', BENCH_SEATS, this.benches);
    }
    return best;
  }

  /** Label for the sit/stand action here, or null when there is none. */
  seatAction(touch: boolean): string | null {
    if (this.o.player.seat >= 0) return touch ? '일어나기' : '일어나기 (E)';
    const seat = this.nearestFreeSeat();
    if (!seat) return null;
    const label = seat.kind === 'log' ? '통나무에 앉기' : seat.kind === 'bench' ? '벤치에 앉기' : seat.kind === 'desk' ? '책상에 앉아 읽기' : '자리에 앉기';
    return touch ? label : `${label} (E)`;
  }

  /** E key / action button: sit on the nearest free mat, log or bench seat, or stand up. */
  toggleSeat() {
    const p = this.o.player;
    if (p.seat >= 0) {
      const seat = p.seat;
      const kind = p.seatKind;
      p.standUp();
      if (this.online) this.o.net!.stand();
      const list = this.seatList(kind);
      if (list[seat] === this.localId) list[seat] = null;
      if (kind === 'mat') this.o.world.landmarks.setMatsOccupied(this.mats.map((m) => m !== null));
      // Tell the server where we stepped to right away.
      this.lastSent.t = 0;
      return;
    }
    const seat = this.nearestFreeSeat();
    if (!seat) return;
    if (this.online) {
      this.sendStateNow(); // make sure the server knows we're next to the seat
      this.o.net!.sit(seat.kind, seat.index);
    } else if (!this.o.net) {
      const next = [...this.seatList(seat.kind)];
      next[seat.index] = this.localId;
      if (seat.kind === 'log') this.applyLogs(next);
      else if (seat.kind === 'desk') this.applyDesks(next);
      else if (seat.kind === 'bench') this.applyBenches(next);
      else this.applyMats(next);
    } else {
      this.o.hud.toast('연결이 돌아오면 앉을 수 있어요.', nowSeconds());
    }
  }

  // ------------------------------------------------------------------ chat

  private sendChat(text: string) {
    if (!this.online) {
      this.o.hud.toast('연결이 끊겨서 보낼 수 없어요.', nowSeconds());
      return;
    }
    this.sendStateNow();
    this.o.net!.sendChat(text);
  }

  private receiveChat(id: string, name: string, text: string) {
    const mine = id === this.localId;
    this.o.chat.append(name, text, mine);
    this.chatLog.push(`${name}: ${text}`);
    if (this.chatLog.length > 50) this.chatLog.shift();
    const t = nowSeconds();
    if (mine) this.localBubble.show(text, t);
    else this.remotes.showBubble(id, text, t);
  }

  // ------------------------------------------------------------------ frame

  private ignoreSnapsUntil = 0;

  /** Entered or left an interior: hide everyone until snapshots of the new space arrive. */
  spaceChanged() {
    this.remotes.hideAll();
    this.ignoreSnapsUntil = nowSeconds() + 0.45;
    this.forceSend();
  }

  /** Send our state on the next frame (tests turning the avatar). */
  forceSend() {
    this.lastSent.t = 0;
    this.lastSent.yaw = NaN;
  }

  private sendStateNow() {
    const net = this.o.net;
    if (!net?.online) return;
    const p = this.o.player;
    const space = this.o.space();
    net.sendState({ x: p.position.x, y: p.position.y, z: p.position.z, yaw: p.yaw, speed: p.speed, ...(space !== 'world' ? { inside: space } : {}) });
    this.lastSent = { x: p.position.x, z: p.position.z, yaw: p.yaw, t: nowSeconds() };
  }

  update(dt: number, elapsed: number, moving: boolean) {
    const t = nowSeconds();
    const p = this.o.player;

    if (p.seat >= 0 && moving) this.toggleSeat();

    this.remotes.update(dt, t, elapsed, this.o.tagView?.());
    this.localBubble.update(t);

    // Campfire zone (a little inside the server's radius so both agree).
    const d = Math.hypot(p.position.x - CAMPFIRE.x, p.position.z - CAMPFIRE.z);
    const space = this.o.space();
    const inside = space !== 'world';
    // Sitting on a campfire log always counts (every seat is well inside).
    this.nearFire = !inside && (d <= CAMPFIRE.chatRadius - 0.4 || (p.seat >= 0 && p.seatKind === 'log'));
    this.o.chat.setVisible(this.nearFire && !!this.o.net);

    // State to the server at STATE_SEND_HZ, only when something changed
    // (plus a 1 s keep-alive so late joiners place us correctly).
    this.sendTimer += dt;
    if (this.online && this.sendTimer >= 1 / STATE_SEND_HZ && p.seat < 0) {
      this.sendTimer = 0;
      const changed =
        Math.abs(p.position.x - this.lastSent.x) > 0.02 ||
        Math.abs(p.position.z - this.lastSent.z) > 0.02 ||
        Math.abs(p.yaw - this.lastSent.yaw) > 0.03;
      if (changed || t - this.lastSent.t > 1 || space !== this.lastSpace) {
        this.lastSpace = space;
        this.sendStateNow();
      }
    }

    this.refreshNetLine();
  }

  describe() {
    return {
      status: this.o.net?.status ?? 'solo',
      id: this.localId,
      name: this.localName,
      remotes: this.remotes.describe(),
      mats: [...this.mats],
      logs: [...this.logs],
      benches: [...this.benches],
      desks: [...this.desks],
      space: this.o.space(),
      reading: this.o.player.avatar.reading,
      seat: this.o.player.seat,
      seatKind: this.o.player.seat >= 0 ? this.o.player.seatKind : null,
      pose: this.o.player.avatar.pose,
      nearCampfire: this.nearFire,
      chatVisible: this.o.chat.isVisible,
      chatFolded: this.o.chat.isFolded,
      chatUnread: this.o.chat.unreadCount,
      chatLog: [...this.chatLog],
    };
  }

  dispose() {
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.remotes.clear();
    this.localBubble.clear();
    this.o.net?.close();
  }
}
