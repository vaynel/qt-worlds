import * as THREE from 'three';
import { LANTERN_SLOTS, type LanternInfo } from '../../../shared/protocol';
import type { Heightfield } from './Heightfield';
import { createNameTag, disposeSprite } from './labels';

const CAPACITY = LANTERN_SLOTS.length;

/** Name tag text: anonymous lanterns never show a name in the world. */
export function lanternLabel(info: LanternInfo): string {
  const who = info.anonymous ? '익명의 등불' : `${info.nickname}의 등불`;
  return `${who}${info.group ? ` · ${info.group}` : ''}`;
}
const PUBLIC_COLOR = new THREE.Color(0xffc46b);
const GROUP_COLOR = new THREE.Color(0xf5b3c8);
const MINE_COLOR = new THREE.Color(0xffe39a);

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Placed {
  info: LanternInfo;
  x: number;
  y: number;
  z: number;
  phase: number;
}

/**
 * Shared paper lanterns on 등불 언덕. Positions come from server-assigned
 * slots (stable, never overlapping). Everything is instanced: three draw
 * calls for any number of lanterns, plus one name tag for the nearest one.
 */
export class LanternField {
  readonly group = new THREE.Group();
  private readonly lanterns = new Map<number, Placed>();
  private readonly order: number[] = [];
  private readonly poles: THREE.InstancedMesh;
  private readonly bodies: THREE.InstancedMesh;
  private readonly hits: THREE.InstancedMesh;
  private readonly glow: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();
  private tag: THREE.Sprite | null = null;
  private tagId = -1;
  private night = 0;

  constructor(private readonly field: Heightfield) {
    this.group.name = 'lanterns';
    this.poles = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.035, 0.05, 1.0, 5).translate(0, 0.5, 0),
      new THREE.MeshLambertMaterial({ color: 0x6b4a33, flatShading: true }),
      CAPACITY,
    );
    // Paper bodies glow on their own (unlit), tinted per lantern.
    this.bodies = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.2, 0.24, 0.42, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      CAPACITY,
    );
    this.hits = new THREE.InstancedMesh(new THREE.BoxGeometry(1.1, 1.8, 1.1).translate(0, 0.9, 0), new THREE.MeshBasicMaterial({ visible: false }), CAPACITY);
    for (const m of [this.poles, this.bodies, this.hits]) {
      m.count = 0;
      m.frustumCulled = false;
      this.group.add(m);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CAPACITY * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(CAPACITY * 3), 3));
    geo.setDrawRange(0, 0);
    this.glow = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 1.7,
        map: glowTexture(),
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0.55,
        fog: false,
      }),
    );
    this.glow.frustumCulled = false;
    this.group.add(this.glow);
  }

  get count(): number {
    return this.lanterns.size;
  }

  setAll(list: LanternInfo[]) {
    this.lanterns.clear();
    for (const l of list) this.place(l);
    this.rebuild();
  }

  upsert(info: LanternInfo) {
    this.place(info);
    this.rebuild();
  }

  remove(id: number) {
    if (this.lanterns.delete(id)) this.rebuild();
  }

  info(id: number): LanternInfo | null {
    return this.lanterns.get(id)?.info ?? null;
  }

  private place(info: LanternInfo) {
    const spot = LANTERN_SLOTS[info.slot];
    if (!spot) return;
    const y = this.field.surfaceHeight(spot.x, spot.z);
    this.lanterns.set(info.id, { info, x: spot.x, y, z: spot.z, phase: (info.id * 1.37) % (Math.PI * 2) });
  }

  private rebuild() {
    this.order.length = 0;
    for (const id of this.lanterns.keys()) this.order.push(id);
    const n = this.order.length;
    this.poles.count = this.bodies.count = this.hits.count = n;
    const pos = this.glow.geometry.attributes.position.array as Float32Array;
    const col = this.glow.geometry.attributes.color.array as Float32Array;
    this.order.forEach((id, i) => {
      const l = this.lanterns.get(id)!;
      this.dummy.position.set(l.x, l.y, l.z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      this.poles.setMatrixAt(i, this.dummy.matrix);
      this.hits.setMatrixAt(i, this.dummy.matrix);
      this.color.copy(l.info.mine ? MINE_COLOR : l.info.group ? GROUP_COLOR : PUBLIC_COLOR);
      this.bodies.setColorAt(i, this.color);
      col.set([this.color.r, this.color.g, this.color.b], i * 3);
      pos.set([l.x, l.y + 1.2, l.z], i * 3);
    });
    this.poles.instanceMatrix.needsUpdate = true;
    this.hits.instanceMatrix.needsUpdate = true;
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    this.glow.geometry.setDrawRange(0, n);
    this.glow.geometry.attributes.position.needsUpdate = true;
    this.glow.geometry.attributes.color.needsUpdate = true;
    if (this.tagId >= 0 && !this.lanterns.has(this.tagId)) this.clearTag();
  }

  /** Nearest lantern within maxDist of (x, z), or null. */
  nearest(x: number, z: number, maxDist: number): LanternInfo | null {
    let best: Placed | null = null;
    let bestD = maxDist;
    for (const l of this.lanterns.values()) {
      const d = Math.hypot(l.x - x, l.z - z);
      if (d < bestD) {
        best = l;
        bestD = d;
      }
    }
    return best?.info ?? null;
  }

  distanceTo(id: number, x: number, z: number): number {
    const l = this.lanterns.get(id);
    return l ? Math.hypot(l.x - x, l.z - z) : Infinity;
  }

  /** Lantern under a ray (tap/click), or null. */
  pick(raycaster: THREE.Raycaster): number | null {
    const hit = raycaster.intersectObject(this.hits, false)[0];
    return hit && hit.instanceId !== undefined ? (this.order[hit.instanceId] ?? null) : null;
  }

  setNight(night: number) {
    this.night = night;
  }

  update(elapsed: number, nearId: number | null) {
    // Gentle sway of the paper bodies.
    this.order.forEach((id, i) => {
      const l = this.lanterns.get(id)!;
      const sway = Math.sin(elapsed * 1.3 + l.phase) * 0.05;
      this.dummy.position.set(l.x + sway * 0.4, l.y + 1.18 + Math.sin(elapsed * 0.9 + l.phase) * 0.02, l.z);
      this.dummy.rotation.set(0, l.phase, sway);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      this.bodies.setMatrixAt(i, this.dummy.matrix);
    });
    this.bodies.instanceMatrix.needsUpdate = true;
    this.glow.material.opacity = 0.35 + this.night * 0.5 + Math.sin(elapsed * 2) * 0.04;

    // Name tag over the nearest lantern only.
    if (nearId !== this.tagId) {
      this.clearTag();
      const l = nearId !== null ? this.lanterns.get(nearId) : undefined;
      if (l) {
        this.tag = createNameTag(lanternLabel(l.info), false, true);
        this.tag.position.set(l.x, l.y + 1.65, l.z);
        this.group.add(this.tag);
        this.tagId = nearId!;
      }
    }
  }

  private clearTag() {
    if (this.tag) {
      this.group.remove(this.tag);
      disposeSprite(this.tag);
    }
    this.tag = null;
    this.tagId = -1;
  }

  describe() {
    return [...this.lanterns.values()].map((l) => ({
      id: l.info.id,
      slot: l.info.slot,
      x: +l.x.toFixed(2),
      z: +l.z.toFixed(2),
      group: l.info.group,
      nickname: l.info.nickname,
      anonymous: l.info.anonymous,
      label: lanternLabel(l.info),
      mine: l.info.mine,
      counts: l.info.counts,
    }));
  }
}
