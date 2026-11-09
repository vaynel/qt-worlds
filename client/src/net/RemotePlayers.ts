import * as THREE from 'three';
import type { PlayerSnap, SeatKind } from '../../../shared/protocol';
import { Avatar, colorsForId, seatHeight } from '../entities/Avatar';
import { createBubble, disposeSprite } from '../world/labels';
import { NameTag, type TagView } from '../world/NameTag';

/** Render remote players this far in the past so there are always two samples to blend. */
const INTERP_DELAY = 0.2;
const MAX_SAMPLES = 24;
/** Larger jumps between samples are treated as teleports, not motion. */
const SNAP_DISTANCE = 12;
export const BUBBLE_SECONDS = 7;

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  seat: number;
  kind: SeatKind;
  inside: boolean;
}

interface Remote {
  id: string;
  name: string;
  avatar: Avatar;
  tag: NameTag;
  samples: Sample[];
  seat: number;
  /** What the seat is (meaningful while seat >= 0). */
  kind: SeatKind;
  inside: boolean;
  bubbleSlot: BubbleSlot;
}

const lerpAngle = (a: number, b: number, t: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

/** Speech bubbles for any avatar root (remote or local). */
export class BubbleSlot {
  private sprite: THREE.Sprite | null = null;
  private until = 0;

  constructor(
    private readonly parent: THREE.Object3D,
    private readonly height = 2.45,
  ) {}

  get showing(): boolean {
    return this.sprite !== null;
  }

  show(text: string, now: number): void {
    this.clear();
    this.sprite = createBubble(text);
    this.sprite.position.set(0, this.height, 0);
    this.sprite.renderOrder = 12;
    this.parent.add(this.sprite);
    this.until = now + BUBBLE_SECONDS;
  }

  update(now: number): void {
    if (this.sprite && now > this.until) this.clear();
    else if (this.sprite) this.sprite.material.opacity = Math.min(1, (this.until - now) / 0.6);
  }

  clear(): void {
    if (!this.sprite) return;
    this.parent.remove(this.sprite);
    disposeSprite(this.sprite);
    this.sprite = null;
  }
}

/**
 * Other players: created on join, interpolated between server snapshots,
 * removed on leave or when the session resets after a reconnect.
 */
export class RemotePlayers {
  readonly group = new THREE.Group();
  private readonly players = new Map<string, Remote>();
  private readonly shadows: boolean;

  constructor(shadows: boolean) {
    this.shadows = shadows;
    this.group.name = 'remote-players';
  }

  get count(): number {
    return this.players.size;
  }

  add(id: string, name: string, guest = false): void {
    if (this.players.has(id)) return;
    const avatar = new Avatar(colorsForId(id), this.shadows);
    avatar.root.visible = false; // until the first snapshot places it
    const tag = new NameTag(avatar.root, name, guest);
    this.group.add(avatar.root);
    this.players.set(id, {
      id,
      name,
      avatar,
      tag,
      samples: [],
      seat: -1,
      kind: 'mat',
      inside: false,
      bubbleSlot: new BubbleSlot(avatar.root),
    });
  }

  remove(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    p.bubbleSlot.clear();
    p.tag.dispose();
    this.group.remove(p.avatar.root);
    p.avatar.dispose();
    this.players.delete(id);
  }

  clear(): void {
    for (const id of [...this.players.keys()]) this.remove(id);
  }

  has(id: string): boolean {
    return this.players.has(id);
  }

  setSpeaking(id: string, speaking: boolean): void {
    this.players.get(id)?.tag.setSpeaking(speaking);
  }

  /** Clear every speaking ring (left the room). */
  clearSpeaking(): void {
    for (const p of this.players.values()) p.tag.setSpeaking(false);
  }

  rename(id: string, name: string): void {
    const p = this.players.get(id);
    if (!p) return;
    p.name = name;
    p.tag.set(name);
  }

  nameOf(id: string): string | undefined {
    return this.players.get(id)?.name;
  }

  /** Record a server snapshot (timestamped on arrival, in seconds). */
  applySnapshot(snaps: PlayerSnap[], localId: string, now: number): void {
    for (const s of snaps) {
      if (s.id === localId) continue;
      const p = this.players.get(s.id);
      if (!p) continue;
      p.samples.push({ t: now, x: s.x, y: s.y, z: s.z, yaw: s.yaw, speed: s.speed, seat: s.seat, kind: s.seatKind ?? 'mat', inside: s.inside === true });
      if (p.samples.length > MAX_SAMPLES) p.samples.shift();
    }
  }

  showBubble(id: string, text: string, now: number): boolean {
    const p = this.players.get(id);
    if (!p) return false;
    p.bubbleSlot.show(text, now);
    return true;
  }

  update(dt: number, now: number, elapsed: number, view?: TagView): void {
    const renderTime = now - INTERP_DELAY;
    for (const p of this.players.values()) {
      const s = p.samples;
      if (s.length === 0) continue;

      // Drop samples we've fully passed, keeping one before renderTime.
      while (s.length > 2 && s[1].t <= renderTime) s.shift();

      let x: number, y: number, z: number, yaw: number, speed: number, seat: number, kind: SeatKind;
      const a = s[0];
      const b = s[1];
      const latest = s[s.length - 1];
      if (!b || renderTime <= a.t) {
        ({ x, y, z, yaw, speed, seat, kind } = renderTime <= a.t || !b ? a : b);
      } else if (Math.hypot(b.x - a.x, b.z - a.z) > SNAP_DISTANCE) {
        ({ x, y, z, yaw, speed, seat, kind } = renderTime >= b.t ? b : a);
      } else {
        const t = Math.min(1, (renderTime - a.t) / Math.max(1e-3, b.t - a.t));
        x = a.x + (b.x - a.x) * t;
        y = a.y + (b.y - a.y) * t;
        z = a.z + (b.z - a.z) * t;
        yaw = lerpAngle(a.yaw, b.yaw, t);
        speed = a.speed + (b.speed - a.speed) * t;
        seat = t < 0.5 ? a.seat : b.seat;
        kind = t < 0.5 ? a.kind : b.kind;
      }

      p.avatar.root.position.set(x, y, z);
      p.avatar.root.rotation.y = yaw;
      // Someone in their 골방 has stepped indoors: nobody else sees them.
      p.avatar.root.visible = !latest.inside;
      p.inside = latest.inside;
      p.seat = seat;
      p.kind = kind;
      p.avatar.setSeated(seat >= 0, kind === 'mat' ? 'pray' : 'sit', seatHeight(kind));
      p.avatar.animate(dt, speed, elapsed);
      p.bubbleSlot.update(now);
      if (view && p.avatar.root.visible) p.tag.update(view);
    }
  }

  /** Plain data for the debug/test hook. */
  describe(): {
    id: string;
    name: string;
    x: number;
    z: number;
    seat: number;
    seatKind: SeatKind | null;
    pose: 'pray' | 'sit' | 'stand';
    bubble: boolean;
    visible: boolean;
    inside: boolean;
    tag: string;
    speakingTag: boolean;
    guest: boolean;
    tagVisible: boolean;
  }[] {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      x: +p.avatar.root.position.x.toFixed(2),
      z: +p.avatar.root.position.z.toFixed(2),
      seat: p.seat,
      seatKind: p.seat < 0 ? null : p.kind,
      pose: p.avatar.pose,
      bubble: p.bubbleSlot.showing,
      visible: p.avatar.root.visible,
      inside: p.inside,
      tag: p.tag.text,
      speakingTag: p.tag.isSpeaking,
      guest: p.tag.isGuest,
      tagVisible: p.avatar.root.visible && p.tag.visible,
    }));
  }
}
