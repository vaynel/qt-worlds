import * as THREE from 'three';
import { validProps, type Look, type PlayerSnap, type PropWear, type SeatKind } from '../../../shared/protocol';
import { Avatar, colorsForId, seatHeight, type AvatarLook } from '../entities/Avatar';
import { avatarLook, outfitCache, safeAppearance } from '../game/looks';
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
  guest: boolean;
  /** Saved appearance (null = hashed default colours). */
  look: Look | null;
  /** Worn drawing id while it is (being) shown. */
  outfitId: number | null;
  /** Borrowed props (M9). */
  props: PropWear[];
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

  add(id: string, name: string, guest = false, look: Look | null = null, props: PropWear[] = []): void {
    if (this.players.has(id)) return;
    const avatar = new Avatar(colorsForId(id), this.shadows);
    avatar.root.visible = false; // until the first snapshot places it
    avatar.root.userData.remoteId = id;
    const tag = new NameTag(avatar.root, name, guest);
    this.group.add(avatar.root);
    // Footprint trail (빛나는 발자국) lives in world space next to the avatars.
    this.group.add(avatar.trail);
    avatar.setNight(this.night);
    const p: Remote = {
      id,
      name,
      avatar,
      tag,
      samples: [],
      seat: -1,
      kind: 'mat',
      inside: false,
      bubbleSlot: new BubbleSlot(avatar.root),
      guest,
      look: null,
      outfitId: null,
      props: [],
    };
    this.players.set(id, p);
    if (look) this.setLook(id, look);
    if (props.length) this.setProps(id, props);
  }

  /** Live prop change (rented, returned, expired). Re-validated: known items, one per slot. */
  setProps(id: string, raw: unknown): void {
    const p = this.players.get(id);
    if (!p) return;
    p.props = validProps(raw);
    p.avatar.setProps(p.props);
  }

  private night = 0;

  /** Lantern glow follows the night. */
  setNight(night: number): void {
    if (Math.abs(night - this.night) < 0.01) return;
    this.night = night;
    for (const p of this.players.values()) p.avatar.setNight(night);
  }

  /** Live appearance change (꾸미기). Players without a saved look keep their hashed colours. */
  setLook(id: string, raw: Look | null): void {
    const p = this.players.get(id);
    if (!p) return;
    const a = raw ? safeAppearance(raw) : null;
    p.look = a && raw ? { ...a, ...(Number.isInteger(raw.o) && (raw.o as number) > 0 ? { o: raw.o, oh: String(raw.oh ?? '') } : {}) } : null;
    const colors: AvatarLook = a ? avatarLook(a) : { ...colorsForId(id), hairStyle: 'short' };
    p.avatar.setLook(colors);
    const want = p.look?.o ?? null;
    if (want === p.outfitId) return;
    p.outfitId = want;
    if (want === null) return p.avatar.setPattern(null);
    outfitCache.load(want, (pixels) => {
      // Still the same person wearing the same drawing?
      if (this.players.get(id) === p && p.outfitId === want) p.avatar.setPattern(pixels);
    });
  }

  /** Who is wearing what (players list, report). */
  info(id: string): { name: string; guest: boolean; outfitId: number | null; patterned: boolean } | null {
    const p = this.players.get(id);
    return p ? { name: p.name, guest: p.guest, outfitId: p.outfitId, patterned: !!p.avatar.patternInfo } : null;
  }

  list(): { id: string; name: string; guest: boolean; outfitId: number | null }[] {
    return [...this.players.values()].map((p) => ({ id: p.id, name: p.name, guest: p.guest, outfitId: p.outfitId }));
  }

  /** Remote avatar under a ray (tap on a person), nearest first. */
  pick(raycaster: THREE.Raycaster): string | null {
    const roots = [...this.players.values()].filter((p) => p.avatar.root.visible).map((p) => p.avatar.root);
    for (const hit of raycaster.intersectObjects(roots, true)) {
      let o: THREE.Object3D | null = hit.object;
      while (o && o.userData.remoteId === undefined) o = o.parent;
      if (o) return o.userData.remoteId as string;
    }
    return null;
  }

  /** Screen position of a remote's head (tests click it like a player would). */
  headWorld(id: string): THREE.Vector3 | null {
    const p = this.players.get(id);
    if (!p) return null;
    return p.avatar.root.localToWorld(new THREE.Vector3(0, 1.1, 0));
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

  /** We stepped into another space: forget where everyone was until fresh snapshots arrive. */
  hideAll(): void {
    for (const p of this.players.values()) {
      p.samples.length = 0;
      p.avatar.root.visible = false;
      p.bubbleSlot.clear();
    }
  }

  /** Record a server snapshot (timestamped on arrival, in seconds). */
  applySnapshot(snaps: PlayerSnap[], localId: string, now: number): void {
    for (const s of snaps) {
      if (s.id === localId) continue;
      const p = this.players.get(s.id);
      if (!p) continue;
      const inside = s.inside === true;
      // Stepping out of (or into) another space: start fresh there, don't glide across.
      const last = p.samples[p.samples.length - 1];
      if (last && last.inside !== inside) p.samples.length = 0;
      p.samples.push({ t: now, x: s.x, y: s.y, z: s.z, yaw: s.yaw, speed: s.speed, seat: s.seat, kind: s.seatKind ?? 'mat', inside });
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
      p.avatar.setDeskReading(seat >= 0 && kind === 'desk');
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
    reading: boolean;
    bubble: boolean;
    visible: boolean;
    inside: boolean;
    tag: string;
    speakingTag: boolean;
    guest: boolean;
    tagVisible: boolean;
    look: { robe: string; scarf: string; skin: string; hair: string; hairStyle: string; saved: boolean; outfitId: number | null; pattern: { checksum: number; pixels: string; filter: string } | null };
    props: PropWear[];
    propsInfo: Avatar['propsInfo'];
  }[] {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      x: +p.avatar.root.position.x.toFixed(2),
      z: +p.avatar.root.position.z.toFixed(2),
      seat: p.seat,
      seatKind: p.seat < 0 ? null : p.kind,
      pose: p.avatar.pose,
      reading: p.avatar.reading,
      bubble: p.bubbleSlot.showing,
      visible: p.avatar.root.visible,
      inside: p.inside,
      tag: p.tag.text,
      speakingTag: p.tag.isSpeaking,
      guest: p.tag.isGuest,
      tagVisible: p.avatar.root.visible && p.tag.visible,
      props: p.props,
      propsInfo: p.avatar.propsInfo,
      look: (() => {
        const l = p.avatar.currentLook;
        const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
        return {
          robe: hex(l.robe),
          scarf: hex(l.scarf),
          skin: hex(l.skin),
          hair: hex(l.hair),
          hairStyle: l.hairStyle,
          saved: p.look !== null,
          outfitId: p.outfitId,
          pattern: p.avatar.patternInfo,
        };
      })(),
    }));
  }
}
