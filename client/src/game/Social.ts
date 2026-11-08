import type * as THREE from 'three';
import { CAMPFIRE, MATS, MAT_COUNT, SIT_REACH, STATE_SEND_HZ, type PlayerSnap } from '../../../shared/protocol';
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
  /** True while the local player is inside the 골방. */
  isInside: () => boolean;
  onWord?: (word: import('../../../shared/protocol').WordPassage) => void;
  /** Our own display name (welcome / live rename). */
  onLocalName?: (name: string, guest: boolean) => void;
  tagView?: () => import('../world/NameTag').TagView;
  /** After a WebSocket reconnect (the server forgot room state). */
  onReconnect?: () => void;
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
  private readonly localBubble: BubbleSlot;
  private sendTimer = 0;
  private lastSent = { x: NaN, z: NaN, yaw: NaN, t: 0 };
  private localId: string;
  private localName: string;
  private localGuest = false;
  private nearFire = false;
  private lastInside = false;
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
        join: (p) => this.remotes.add(p.id, p.name, p.guest === true),
        rename: (id, name) => {
          if (id === this.localId) {
            this.localName = name;
            this.o.onLocalName?.(name, this.localGuest);
          } else this.remotes.rename(id, name);
        },
        leave: (id) => this.remotes.remove(id),
        snapshot: (players: PlayerSnap[]) => this.remotes.applySnapshot(players, this.localId, nowSeconds()),
        chat: (id, name, text) => this.receiveChat(id, name, text),
        mats: (mats) => this.applyMats(mats),
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
    for (const p of w.players) this.remotes.add(p.id, p.name, p.guest === true);
    this.localGuest = w.guest;
    this.o.onLocalName?.(w.name, w.guest);
    this.applyMats(w.mats);
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
    const p = this.o.player;
    const mine = this.mats.indexOf(this.localId);
    if (mine >= 0 && p.seat !== mine) {
      const spot = MATS[mine];
      p.sitAt(mine, spot.x, spot.z, spot.yaw);
    } else if (mine < 0 && p.seat >= 0) {
      p.standUp();
    }
  }

  private nearestFreeMat(): number {
    const p = this.o.player.position;
    let best = -1;
    let bestD = SIT_REACH * 0.92;
    for (const spot of MATS) {
      if (this.mats[spot.index] !== null) continue;
      const d = Math.hypot(p.x - spot.x, p.z - spot.z);
      if (d < bestD) {
        best = spot.index;
        bestD = d;
      }
    }
    return best;
  }

  /** Label for the sit/stand action here, or null when there is none. */
  seatAction(touch: boolean): string | null {
    if (this.o.player.seat >= 0) return touch ? '일어나기' : '일어나기 (E)';
    if (this.nearestFreeMat() >= 0) return touch ? '자리에 앉기' : '자리에 앉기 (E)';
    return null;
  }

  /** E key / action button: sit on the nearest free mat, or stand up. */
  toggleSeat() {
    const p = this.o.player;
    if (p.seat >= 0) {
      const seat = p.seat;
      p.standUp();
      if (this.online) this.o.net!.stand();
      if (this.mats[seat] === this.localId) this.mats[seat] = null;
      this.o.world.landmarks.setMatsOccupied(this.mats.map((m) => m !== null));
      return;
    }
    const mat = this.nearestFreeMat();
    if (mat < 0) return;
    if (this.online) {
      this.sendStateNow(); // make sure the server knows we're next to the mat
      this.o.net!.sit(mat);
    } else if (!this.o.net) {
      const next = [...this.mats];
      next[mat] = this.localId;
      this.applyMats(next);
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

  private sendStateNow() {
    const net = this.o.net;
    if (!net?.online) return;
    const p = this.o.player;
    net.sendState({ x: p.position.x, y: p.position.y, z: p.position.z, yaw: p.yaw, speed: p.speed, inside: this.o.isInside() });
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
    const inside = this.o.isInside();
    this.nearFire = !inside && d <= CAMPFIRE.chatRadius - 0.4;
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
      if (changed || t - this.lastSent.t > 1 || inside !== this.lastInside) {
        this.lastInside = inside;
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
      seat: this.o.player.seat,
      nearCampfire: this.nearFire,
      chatVisible: this.o.chat.isVisible,
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
