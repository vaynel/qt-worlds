import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CAMPFIRE, kstDateOf, LOG_RING_RADIUS, PLAZA as PLAZA_CENTRE } from '../../../shared/protocol';
import type { CircleCollider } from './ChunkManager';
import { LANDMARKS, PALETTE } from './config';
import type { Heightfield } from './Heightfield';
import { patchSurface } from './surface';

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

export interface SeasonInfo {
  season: Season;
  month: number;
  day: number;
  christmas: boolean;
}

/** Season by the KST calendar date (independent of the weather). */
export function seasonOf(ms: number): SeasonInfo {
  const date = kstDateOf(ms);
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const season: Season = month >= 3 && month <= 5 ? 'spring' : month >= 6 && month <= 8 ? 'summer' : month >= 9 && month <= 11 ? 'autumn' : 'winter';
  return { season, month, day, christmas: month === 12 && day >= 18 && day <= 26 };
}

const plaza = LANDMARKS.find((l) => l.id === 'plaza')!;
const campfire = LANDMARKS.find((l) => l.id === 'campfire')!;
/** Same spot as the signpost in Landmarks.buildPlaza. */
const SIGNPOST = { x: plaza.x + 3.2, z: plaza.z + 3.2, top: plaza.height + 2.6 };

/**
 * Static seasonal decorations: a few pink blossom trees near the plaza (spring)
 * and the Christmas window's star and warm lights (Dec 18–26). Built once,
 * merged per material, and only shown in their season.
 */
export class SeasonDecor {
  readonly group = new THREE.Group();
  private readonly blossoms = new THREE.Group();
  private readonly xmas = new THREE.Group();
  private readonly star: THREE.Mesh;
  private readonly bulbs: THREE.InstancedMesh;
  private readonly bulbMat: THREE.MeshBasicMaterial;
  private readonly treeColliders: CircleCollider[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  /** Blossom tree spots (debug and screenshots). */
  readonly blossomSpots: { x: number; z: number }[] = [];
  private bulbCount = 0;

  constructor(
    private readonly field: Heightfield,
    private readonly colliders: CircleCollider[],
  ) {
    this.group.name = 'season-decor';
    this.blossoms.visible = false;
    this.xmas.visible = false;
    this.group.add(this.blossoms, this.xmas);
    this.buildBlossoms();
    const { star, bulbs, bulbMat } = this.buildChristmas();
    this.star = star;
    this.bulbs = bulbs;
    this.bulbMat = bulbMat;
  }

  private keep<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  /** Five blossom trees just outside the plaza ring, off the paths and the water. */
  private buildBlossoms() {
    const out = { weight: 0, height: 0 };
    const trunks: THREE.BufferGeometry[] = [];
    const crowns: THREE.BufferGeometry[] = [];
    const crowns2: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 40 && this.blossomSpots.length < 5; i++) {
      const a = i * 2.39996 + 0.4; // golden-angle walk around the plaza
      const r = 18 + (i % 3) * 1.6;
      const x = PLAZA_CENTRE.x + Math.cos(a) * r;
      const z = PLAZA_CENTRE.z + Math.sin(a) * r;
      this.field.pathInfo(x, z, out);
      const y = this.field.surfaceHeight(x, z);
      if (out.weight > 0.02 || y < 0.6) continue;
      if (this.blossomSpots.some((s) => Math.hypot(s.x - x, s.z - z) < 7)) continue;
      this.blossomSpots.push({ x, z });
      const s = 0.9 + ((i * 37) % 10) / 25;
      trunks.push(new THREE.CylinderGeometry(0.13 * s, 0.22 * s, 2.2 * s, 6).translate(x, y + 1.1 * s - 0.1, z));
      const blob = (dx: number, dy: number, dz: number, rr: number, list: THREE.BufferGeometry[]) =>
        list.push(new THREE.IcosahedronGeometry(rr * s, 0).translate(x + dx * s, y + dy * s, z + dz * s));
      blob(0, 2.6, 0, 1.25, crowns);
      blob(0.85, 2.2, 0.3, 0.85, crowns2);
      blob(-0.7, 2.3, -0.45, 0.9, crowns);
      blob(0.1, 3.25, -0.2, 0.75, crowns2);
      this.treeColliders.push({ x, z, r: 0.35 * s });
    }
    const add = (list: THREE.BufferGeometry[], mat: THREE.Material) => {
      if (!list.length) return;
      const g = this.keep(mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)))!);
      g.computeVertexNormals();
      for (const x of list) x.dispose();
      const m = new THREE.Mesh(g, mat);
      m.castShadow = true;
      this.blossoms.add(m);
    };
    add(trunks, patchSurface(new THREE.MeshLambertMaterial({ color: 0x7a4e3a, flatShading: true }), 'solid'));
    add(crowns, patchSurface(new THREE.MeshLambertMaterial({ color: 0xf6b9cb, flatShading: true }), 'solid'));
    add(crowns2, patchSurface(new THREE.MeshLambertMaterial({ color: 0xfbd5e0, flatShading: true }), 'solid'));
  }

  /** A star on the plaza signpost, bulbs wound round it, and string lights around the campfire. */
  private buildChristmas() {
    // Five-point star, a little thick so it reads from the side too.
    const shape = new THREE.Shape();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 0.46 : 0.19;
      const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
      if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    const starGeo = this.keep(new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false }).translate(0, 0, -0.04));
    const star = new THREE.Mesh(starGeo, new THREE.MeshBasicMaterial({ color: 0xffd76a }));
    star.position.set(SIGNPOST.x, SIGNPOST.top + 0.5, SIGNPOST.z);
    this.xmas.add(star);

    // Bulb positions: a spiral round the signpost, then sagging strings between four posts at the campfire.
    const spots: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < 18; i++) {
      const t = i / 17;
      const a = t * Math.PI * 7;
      spots.push({ x: SIGNPOST.x + Math.cos(a) * 0.17, y: plaza.height + 0.5 + t * 1.9, z: SIGNPOST.z + Math.sin(a) * 0.17 });
    }
    const postR = LOG_RING_RADIUS + 1.7;
    const postH = 2.1;
    const posts: { x: number; z: number; y: number }[] = [];
    const postGeos: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.26;
      const x = CAMPFIRE.x + Math.cos(a) * postR;
      const z = CAMPFIRE.z + Math.sin(a) * postR;
      const y = Math.max(campfire.height, this.field.surfaceHeight(x, z));
      posts.push({ x, z, y });
      postGeos.push(new THREE.CylinderGeometry(0.05, 0.07, postH, 5).translate(x, y + postH / 2, z));
    }
    const postGeo = this.keep(mergeGeometries(postGeos)!);
    for (const g of postGeos) g.dispose();
    this.xmas.add(new THREE.Mesh(postGeo, patchSurface(new THREE.MeshLambertMaterial({ color: PALETTE.woodDark, flatShading: true }), 'solid')));
    for (let i = 0; i < posts.length; i++) {
      const a = posts[i];
      const b = posts[(i + 1) % posts.length];
      const n = 9;
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const sag = Math.sin(t * Math.PI) * 0.45;
        spots.push({ x: a.x + (b.x - a.x) * t, y: a.y + postH - 0.05 + (b.y - a.y) * t - sag, z: a.z + (b.z - a.z) * t });
      }
    }
    const bulbGeo = this.keep(new THREE.SphereGeometry(0.085, 6, 4));
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const bulbs = new THREE.InstancedMesh(bulbGeo, bulbMat, spots.length);
    const m = new THREE.Matrix4();
    const colors = [0xffd27a, 0xff6b5a, 0xfff1cf, 0x7fd18b, 0xffb35c];
    const c = new THREE.Color();
    spots.forEach((p, i) => {
      bulbs.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z));
      bulbs.setColorAt(i, c.setHex(colors[i % colors.length]));
    });
    bulbs.computeBoundingSphere();
    this.bulbCount = spots.length;
    this.xmas.add(bulbs);
    return { star, bulbs, bulbMat };
  }

  apply(info: SeasonInfo) {
    const spring = info.season === 'spring';
    if (spring !== this.blossoms.visible) {
      this.blossoms.visible = spring;
      for (const t of this.treeColliders) {
        const i = this.colliders.indexOf(t);
        if (spring && i < 0) this.colliders.push(t);
        else if (!spring && i >= 0) this.colliders.splice(i, 1);
      }
    }
    this.xmas.visible = info.christmas;
  }

  update(elapsed: number, night: number, reducedMotion: boolean) {
    if (!this.xmas.visible) return;
    if (!reducedMotion) this.star.rotation.y = elapsed * 0.6;
    // Gentle twinkle: the whole string breathes (no per-bulb work).
    const tw = reducedMotion ? 1 : 0.85 + 0.15 * Math.sin(elapsed * 2.2);
    this.bulbMat.color.setScalar((0.75 + 0.45 * night) * tw);
  }

  describe() {
    return { blossoms: this.blossoms.visible ? this.blossomSpots.length : 0, christmas: this.xmas.visible, bulbs: this.xmas.visible ? this.bulbCount : 0 };
  }

  dispose() {
    for (const g of this.geometries) g.dispose();
    this.bulbs.dispose();
  }
}
