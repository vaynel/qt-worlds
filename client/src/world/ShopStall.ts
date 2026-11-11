import * as THREE from 'three';
import { SHOP_STALL } from '../../../shared/protocol';
import { bookClosedGeo, guitarGeo, hatGeo, lanternCoreGeo, lanternFrameGeo, LANTERN_DROP, mergeParts, type Part } from '../entities/Props';
import type { CircleCollider } from './ChunkManager';
import { createLabelSprite, disposeSprite, UI_FONT } from './labels';
import { PALETTE } from './config';

const FADE_SECONDS = 0.8;
const LABEL_SCALE = 0.62;

type V3 = [number, number, number];

/** Stall body: counter, posts, back shelf and the striped awning, as one coloured geometry. */
function stallGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [];
  const box = (w: number, h: number, d: number, color: number, pos: V3, rot?: V3) => parts.push({ geo: new THREE.BoxGeometry(w, h, d), color, pos, rot });
  // Counter: planked front, lighter top board.
  box(2.3, 0.86, 0.55, PALETTE.woodDark, [0, 0.43, 0.3]);
  for (let i = 0; i < 6; i++) box(0.36, 0.8, 0.04, i % 2 ? PALETTE.wood : 0xb98257, [-0.95 + i * 0.38, 0.43, 0.59]);
  box(2.55, 0.07, 0.72, PALETTE.wood, [0, 0.895, 0.32]);
  box(2.55, 0.05, 0.05, PALETTE.woodDark, [0, 0.86, 0.69]);
  // Posts (back taller so the awning slopes toward the plaza).
  for (const x of [-1.2, 1.2]) {
    box(0.11, 2.45, 0.11, PALETTE.woodDark, [x, 1.225, -0.5]);
    box(0.11, 2.12, 0.11, PALETTE.woodDark, [x, 1.06, 0.66]);
  }
  // Back wall with two shelves.
  box(2.3, 1.5, 0.06, 0xc9a77c, [0, 1.25, -0.52]);
  box(2.3, 0.05, 0.3, PALETTE.wood, [0, 1.25, -0.37]);
  box(2.3, 0.05, 0.3, PALETTE.wood, [0, 1.75, -0.37]);
  // Striped awning: cream and terracotta, with a scalloped front edge.
  const stripes = 7;
  const w = 2.8 / stripes;
  const slope = Math.atan2(2.5 - 2.12, 1.55);
  for (let i = 0; i < stripes; i++) {
    const color = i % 2 ? PALETTE.cream : PALETTE.terracotta;
    const x = -1.4 + w * (i + 0.5);
    box(w + 0.002, 0.05, 1.7, color, [x, 2.33, 0.1], [slope, 0, 0]);
    parts.push({
      geo: new THREE.CylinderGeometry(w / 2, w / 2, 0.05, 8, 1, false, Math.PI / 2, Math.PI),
      color,
      pos: [x, 2.13, 0.93],
      rot: [0, 0, 0],
      scale: [1, 1, 0.9],
    });
  }
  // Ridge board and a little crate beside the counter.
  box(2.9, 0.08, 0.1, PALETTE.woodDark, [0, 2.5, -0.62]);
  box(0.5, 0.36, 0.42, 0xb98257, [1.55, 0.18, 0.35], [0, 0.25, 0]);
  box(0.52, 0.05, 0.44, PALETTE.woodDark, [1.55, 0.35, 0.35], [0, 0.25, 0]);
  // Shelf goods: folded cloths and a row of books.
  const cloths = [0xd9a441, 0x9fb39a, 0x5f7fa6, 0xc77a8a];
  cloths.forEach((c, i) => box(0.26, 0.09, 0.22, c, [-0.85 + i * 0.32, 1.32, -0.37]));
  [0x7a3b2e, 0x3f4f6e, 0x6f8a5b, 0x7a3b2e, 0x9a6a8e].forEach((c, i) => box(0.06, 0.22, 0.18, c, [0.35 + i * 0.075, 1.89, -0.37]));
  return mergeParts(parts);
}

/** Hanging wooden sign face (canvas text). */
function signTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 144;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#f4e3c2';
  ctx.fillRect(0, 0, 512, 144);
  ctx.strokeStyle = '#7b5236';
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, 502, 134);
  ctx.fillStyle = '#5a3e2b';
  ctx.font = `700 64px ${UI_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('나눔 소품 가게', 256, 76);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 2;
  return t;
}

/**
 * 나눔 소품 가게 (M9): a small market stall on the 중앙 광장 that appears only
 * during opening hours (fading in and out). Closed, only a little A-frame sign
 * stays, telling when it opens next.
 */
export class ShopStall {
  readonly group = new THREE.Group();
  private readonly stall = new THREE.Group();
  private readonly closedSign = new THREE.Group();
  private readonly materials: THREE.Material[] = [];
  private readonly fadeMats: { m: THREE.Material; base: number }[] = [];
  private readonly closedMats: THREE.Material[] = [];
  private readonly glowMat: THREE.MeshLambertMaterial;
  private readonly label: THREE.Sprite;
  private closedLabel: THREE.Sprite | null = null;
  private closedText = '';
  private open = false;
  private t = 0;
  private lastElapsed = -1;

  constructor(ground: number, colliders: CircleCollider[], shadows: boolean) {
    const s = SHOP_STALL;
    this.group.name = 'shop-stall';
    this.group.position.set(s.x, ground, s.z);
    this.group.rotation.y = s.yaw;
    this.group.add(this.stall, this.closedSign);

    const fade = <T extends THREE.Material>(m: T, base = 1): T => {
      m.transparent = true;
      this.materials.push(m);
      this.fadeMats.push({ m, base });
      return m;
    };
    const body = fade(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    this.glowMat = fade(new THREE.MeshLambertMaterial({ color: 0xffd58a, emissive: 0xffb04a, emissiveIntensity: 0.5, flatShading: true }));
    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, pos: V3, rot: V3 = [0, 0, 0], scale = 1) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(...pos);
      m.rotation.set(...rot);
      m.scale.setScalar(scale);
      m.castShadow = shadows;
      m.receiveShadow = shadows;
      this.stall.add(m);
      return m;
    };
    mesh(stallGeometry(), body, [0, 0, 0]);
    // Props on show: a lantern hanging from the awning, one on the counter, a book, a hat, a guitar leaning on the crate.
    mesh(lanternFrameGeo(), body, [1.12, 2.08, 0.82]);
    mesh(lanternCoreGeo(), this.glowMat, [1.12, 2.08, 0.82]);
    mesh(lanternFrameGeo(), body, [-0.75, 0.93 + LANTERN_DROP, 0.35], [0, 0.5, 0]);
    mesh(lanternCoreGeo(), this.glowMat, [-0.75, 0.93 + LANTERN_DROP, 0.35], [0, 0.5, 0]);
    mesh(bookClosedGeo(), body, [-0.25, 0.96, 0.4], [-Math.PI / 2, 0, 0.3]);
    mesh(bookClosedGeo(), body, [-0.22, 1.02, 0.38], [-Math.PI / 2, 0, -0.1]);
    mesh(hatGeo(), body, [0.4, 0.73, 0.35], [0, -0.4, 0], 0.55);
    mesh(guitarGeo(), body, [1.62, 0.45, 0.62], [-0.28, -0.3, 0.12]);
    // Hanging sign under the awning's front edge.
    const sign = fade(new THREE.MeshBasicMaterial({ map: signTexture(), fog: true }));
    const strings = new THREE.BoxGeometry(0.02, 0.22, 0.02);
    mesh(strings, body, [-0.42, 1.98, 0.9]);
    mesh(strings, body, [0.42, 1.98, 0.9]);
    mesh(new THREE.BoxGeometry(1.12, 0.34, 0.04), fade(new THREE.MeshLambertMaterial({ color: PALETTE.woodDark, flatShading: true })), [0, 1.73, 0.9]);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(1.04, 0.29), sign);
    face.position.set(0, 1.73, 0.925);
    this.stall.add(face);

    this.label = createLabelSprite('나눔 소품 가게', '무료로 빌려 쓰는 소품');
    this.label.scale.multiplyScalar(LABEL_SCALE);
    this.label.position.set(0, 3.0, 0.2);
    this.fadeMats.push({ m: this.label.material, base: 1 });
    this.stall.add(this.label);

    // Closed: a small A-frame sign where the counter stood.
    const wood = new THREE.MeshLambertMaterial({ color: PALETTE.wood, flatShading: true });
    const dark = new THREE.MeshLambertMaterial({ color: PALETTE.woodDark, flatShading: true });
    this.closedMats.push(wood, dark);
    for (const sz of [-1, 1]) {
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.72, 0.04), sz > 0 ? wood : dark);
      board.position.set(0, 0.35, sz * 0.1);
      board.rotation.x = sz * -0.26;
      board.castShadow = shadows;
      this.closedSign.add(board);
    }
    const closedFace = new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.14), new THREE.MeshBasicMaterial({ map: signTexture() }));
    closedFace.position.set(0, 0.5, 0.15);
    closedFace.rotation.x = -0.26;
    this.closedMats.push(closedFace.material as THREE.Material);
    this.closedSign.add(closedFace);
    this.closedSign.position.set(0, 0, 0.75);
    this.closedSign.visible = false;

    // Counter and posts block walking through; the front (toward the basin) stays open.
    const cos = Math.cos(s.yaw);
    const sin = Math.sin(s.yaw);
    const toWorld = (lx: number, lz: number) => ({ x: s.x + lx * cos + lz * sin, z: s.z - lx * sin + lz * cos });
    for (const [lx, lz, r] of [
      [-0.8, 0.15, 0.45],
      [0, 0.15, 0.45],
      [0.8, 0.15, 0.45],
      [-1.2, -0.5, 0.2],
      [1.2, -0.5, 0.2],
      [1.55, 0.35, 0.35],
    ] as const) colliders.push({ ...toWorld(lx, lz), r });
    this.apply();
  }

  /** Open/closed from the server; the text is the closed sign's subtitle (next opening). */
  setShop(open: boolean, nextOpenText: string) {
    this.open = open;
    if (nextOpenText !== this.closedText) {
      this.closedText = nextOpenText;
      if (this.closedLabel) {
        this.closedSign.remove(this.closedLabel);
        disposeSprite(this.closedLabel);
      }
      this.closedLabel = createLabelSprite('나눔 소품 가게', nextOpenText || '지금은 쉬는 시간이에요');
      this.closedLabel.scale.multiplyScalar(0.5);
      this.closedLabel.position.set(0, 0.95, 0);
      this.closedSign.add(this.closedLabel);
    }
  }

  setNight(night: number) {
    this.glowMat.emissiveIntensity = 0.5 + 1.8 * night;
  }

  update(elapsed: number) {
    const dt = this.lastElapsed < 0 ? 0 : Math.min(0.1, Math.max(0, elapsed - this.lastElapsed));
    this.lastElapsed = elapsed;
    const target = this.open ? 1 : 0;
    if (this.t === target) return;
    this.t = target > this.t ? Math.min(1, this.t + dt / FADE_SECONDS) : Math.max(0, this.t - dt / FADE_SECONDS);
    this.apply();
  }

  private apply() {
    const t = this.t;
    const e = t * t * (3 - 2 * t);
    for (const { m, base } of this.fadeMats) m.opacity = base * e;
    this.stall.visible = t > 0.001;
    // A small rise as it appears.
    this.stall.scale.set(1, 0.85 + 0.15 * e, 1);
    this.stall.position.y = -0.15 * (1 - e);
    this.closedSign.visible = t < 0.999 && !this.open;
    this.closedSign.scale.setScalar(Math.max(0.001, 1 - e));
    // Opaque again once fully shown (keeps sorting and shadows simple).
    const solid = t >= 1;
    for (const { m } of this.fadeMats) {
      if (m === this.label.material) continue;
      if (m.transparent === solid) {
        m.transparent = !solid;
        m.needsUpdate = true;
      }
    }
  }

  get visual(): { open: boolean; opacity: number } {
    return { open: this.open, opacity: +this.t.toFixed(3) };
  }

  dispose() {
    for (const m of [...this.materials, ...this.closedMats]) m.dispose();
    disposeSprite(this.label);
    if (this.closedLabel) disposeSprite(this.closedLabel);
  }
}
