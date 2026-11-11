import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * 나눔 소품 가게 (M9) prop meshes. Every prop is a handful of primitives merged
 * into one geometry with vertex colours, drawn with one shared flat-shaded
 * Lambert material: one draw call per prop, built once per page load.
 */

export interface Part {
  geo: THREE.BufferGeometry;
  color: number;
  pos?: [number, number, number];
  rot?: [number, number, number];
  scale?: [number, number, number];
}

const tmpColor = new THREE.Color();
const tmpEuler = new THREE.Euler();
const tmpQuat = new THREE.Quaternion();
const tmpMat = new THREE.Matrix4();

/** Merge coloured parts into one non-indexed geometry (position, normal, color). */
export function mergeParts(parts: Part[]): THREE.BufferGeometry {
  const geos = parts.map((p) => {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    p.geo.dispose();
    g.deleteAttribute('uv');
    tmpEuler.set(...(p.rot ?? [0, 0, 0]));
    tmpQuat.setFromEuler(tmpEuler);
    tmpMat.compose(new THREE.Vector3(...(p.pos ?? [0, 0, 0])), tmpQuat, new THREE.Vector3(...(p.scale ?? [1, 1, 1])));
    g.applyMatrix4(tmpMat);
    tmpColor.setHex(p.color);
    const n = g.getAttribute('position').count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      c[i * 3] = tmpColor.r;
      c[i * 3 + 1] = tmpColor.g;
      c[i * 3 + 2] = tmpColor.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return g;
  });
  const merged = mergeGeometries(geos)!;
  for (const g of geos) g.dispose();
  merged.computeBoundingSphere();
  return merged;
}

let sharedMat: THREE.MeshLambertMaterial | null = null;
/** The one material every merged prop uses (vertex colours, flat shading). */
export function propMaterial(): THREE.MeshLambertMaterial {
  sharedMat ??= new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  return sharedMat;
}

let glowTex: THREE.CanvasTexture | null = null;
/** Soft round glow (white centre, transparent edge) for halos and light pools. */
export function glowTexture(): THREE.CanvasTexture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

// ------------------------------------------------------------------ colours

export const C = {
  wood: 0xa8744c,
  woodDark: 0x6b4a33,
  woodLight: 0xd2a06a,
  ink: 0x2f2620,
  lanternFrame: 0x5a3e2b,
  brass: 0xc9a03a,
  cover: 0x7a3b2e,
  page: 0xf6efdc,
  gold: 0xd9b26a,
  dove: 0xf6f3ec,
  doveWing: 0xc9c6c0,
  beak: 0xe0a040,
  hat: 0xd9a441,
  hatBrim: 0xeadbbd,
  pom: 0xfbf6ea,
  string: 0xe8e2d0,
} as const;

// ------------------------------------------------------------------ geometries

const cache = new Map<string, THREE.BufferGeometry>();
const once = (key: string, make: () => THREE.BufferGeometry) => {
  let g = cache.get(key);
  if (!g) {
    g = make();
    cache.set(key, g);
  }
  return g;
};

/** Lantern frame (without the glowing core), handle at y = 0, hanging down. */
export const lanternFrameGeo = () =>
  once('lanternFrame', () =>
    mergeParts([
      // handle loop
      { geo: new THREE.TorusGeometry(0.045, 0.01, 4, 8, Math.PI), color: C.lanternFrame, pos: [0, -0.04, 0] },
      // roof
      { geo: new THREE.ConeGeometry(0.1, 0.07, 4), color: C.lanternFrame, pos: [0, -0.075, 0], rot: [0, Math.PI / 4, 0] },
      { geo: new THREE.BoxGeometry(0.15, 0.02, 0.15), color: C.brass, pos: [0, -0.115, 0] },
      // corner posts
      ...[-1, 1].flatMap((sx) =>
        [-1, 1].map((sz) => ({ geo: new THREE.BoxGeometry(0.018, 0.15, 0.018), color: C.lanternFrame, pos: [sx * 0.062, -0.195, sz * 0.062] as [number, number, number] })),
      ),
      // base
      { geo: new THREE.BoxGeometry(0.15, 0.025, 0.15), color: C.brass, pos: [0, -0.28, 0] },
    ]),
  );
/** Glowing core of the lantern (own emissive material). */
export const lanternCoreGeo = () => once('lanternCore', () => new THREE.BoxGeometry(0.11, 0.14, 0.11).translate(0, -0.195, 0));
/** Height from the handle (y=0) down to the lantern's bottom. */
export const LANTERN_DROP = 0.293;

/** Guitar, flat in the local XY plane, neck along +y, front facing +z, centre of the lower bout at the origin. */
export const guitarGeo = () =>
  once('guitar', () => {
    const flat: [number, number, number] = [Math.PI / 2, 0, 0];
    return mergeParts([
      { geo: new THREE.CylinderGeometry(0.17, 0.17, 0.08, 10), color: C.woodLight, rot: flat },
      { geo: new THREE.CylinderGeometry(0.13, 0.13, 0.08, 10), color: C.woodLight, pos: [0, 0.19, 0], rot: flat },
      // sides
      { geo: new THREE.CylinderGeometry(0.175, 0.175, 0.06, 10), color: C.wood, rot: flat, pos: [0, 0, -0.005] },
      { geo: new THREE.CylinderGeometry(0.135, 0.135, 0.06, 10), color: C.wood, pos: [0, 0.19, -0.005], rot: flat },
      // sound hole and bridge
      { geo: new THREE.CylinderGeometry(0.05, 0.05, 0.01, 10), color: C.ink, pos: [0, 0.14, 0.04], rot: flat },
      { geo: new THREE.BoxGeometry(0.12, 0.025, 0.02), color: C.woodDark, pos: [0, -0.06, 0.045] },
      // neck, fretboard, head
      { geo: new THREE.BoxGeometry(0.055, 0.42, 0.04), color: C.woodDark, pos: [0, 0.5, 0] },
      { geo: new THREE.BoxGeometry(0.075, 0.13, 0.035), color: C.woodDark, pos: [0, 0.77, -0.005], rot: [-0.15, 0, 0] },
      { geo: new THREE.BoxGeometry(0.012, 0.6, 0.005), color: C.string, pos: [0, 0.3, 0.045] },
      // strap across (seen on the back)
      { geo: new THREE.BoxGeometry(0.03, 0.03, 0.02), color: C.ink, pos: [0, 0.71, -0.03] },
    ]);
  });

/** Closed book, upright (spine along -x, cover facing ±z), centre at the origin. */
export const bookClosedGeo = () =>
  once('bookClosed', () =>
    mergeParts([
      { geo: new THREE.BoxGeometry(0.16, 0.21, 0.055), color: C.cover },
      { geo: new THREE.BoxGeometry(0.145, 0.195, 0.06), color: C.page, pos: [0.012, 0, 0] },
      { geo: new THREE.BoxGeometry(0.02, 0.03, 0.058), color: C.gold, pos: [0, 0.04, 0.0005], scale: [1, 1, 1.01] },
      { geo: new THREE.BoxGeometry(0.06, 0.012, 0.004), color: C.gold, pos: [0, 0.04, 0.029] },
    ]),
  );

/** Open book: two pages in a shallow V facing +y (the reader looks down at it), spine along z. */
export const bookOpenGeo = () =>
  once('bookOpen', () => {
    const tilt = 0.18;
    return mergeParts([
      { geo: new THREE.BoxGeometry(0.17, 0.012, 0.22), color: C.cover, pos: [-0.085, -0.004, 0], rot: [0, 0, tilt] },
      { geo: new THREE.BoxGeometry(0.17, 0.012, 0.22), color: C.cover, pos: [0.085, -0.004, 0], rot: [0, 0, -tilt] },
      { geo: new THREE.BoxGeometry(0.155, 0.02, 0.2), color: C.page, pos: [-0.08, 0.01, 0], rot: [0, 0, tilt] },
      { geo: new THREE.BoxGeometry(0.155, 0.02, 0.2), color: C.page, pos: [0.08, 0.01, 0], rot: [0, 0, -tilt] },
      // a ribbon
      { geo: new THREE.BoxGeometry(0.012, 0.004, 0.16), color: 0xb04050, pos: [0.02, 0.022, -0.03] },
      // text lines (faint)
      ...[-0.05, -0.01, 0.03, 0.07].flatMap((z) => [
        { geo: new THREE.BoxGeometry(0.1, 0.003, 0.008), color: 0xc9bca0, pos: [-0.08, 0.022, z] as [number, number, number], rot: [0, 0, tilt] as [number, number, number] },
        { geo: new THREE.BoxGeometry(0.1, 0.003, 0.008), color: 0xc9bca0, pos: [0.08, 0.022, z] as [number, number, number], rot: [0, 0, -tilt] as [number, number, number] },
      ]),
    ]);
  });

/** Dove body (facing +z), feet at y = 0. Head is separate so it can peck. */
export const doveBodyGeo = () =>
  once('doveBody', () =>
    mergeParts([
      { geo: new THREE.IcosahedronGeometry(0.075, 1), color: C.dove, pos: [0, 0.07, 0], scale: [0.85, 0.8, 1.3] },
      // folded wings
      { geo: new THREE.IcosahedronGeometry(0.06, 0), color: C.doveWing, pos: [-0.052, 0.08, -0.02], scale: [0.4, 0.75, 1.45], rot: [0.15, 0, 0] },
      { geo: new THREE.IcosahedronGeometry(0.06, 0), color: C.doveWing, pos: [0.052, 0.08, -0.02], scale: [0.4, 0.75, 1.45], rot: [0.15, 0, 0] },
      // tail
      { geo: new THREE.BoxGeometry(0.07, 0.015, 0.09), color: C.doveWing, pos: [0, 0.075, -0.12], rot: [-0.35, 0, 0] },
      // feet
      { geo: new THREE.BoxGeometry(0.012, 0.03, 0.012), color: C.beak, pos: [-0.02, 0.012, 0.01] },
      { geo: new THREE.BoxGeometry(0.012, 0.03, 0.012), color: C.beak, pos: [0.02, 0.012, 0.01] },
    ]),
  );
/** Dove head; pivot at the neck. */
export const doveHeadGeo = () =>
  once('doveHead', () =>
    mergeParts([
      { geo: new THREE.IcosahedronGeometry(0.045, 1), color: C.dove, pos: [0, 0.04, 0.02] },
      { geo: new THREE.ConeGeometry(0.014, 0.04, 4), color: C.beak, pos: [0, 0.035, 0.075], rot: [Math.PI / 2, 0, 0] },
      { geo: new THREE.SphereGeometry(0.009, 4, 3), color: C.ink, pos: [-0.032, 0.05, 0.035] },
      { geo: new THREE.SphereGeometry(0.009, 4, 3), color: C.ink, pos: [0.032, 0.05, 0.035] },
    ]),
  );

/** Knit beanie for the head group (head sphere centre at y = 0.23, radius 0.27). */
export const hatGeo = () =>
  once('hat', () => {
    const parts: Part[] = [
      // crown
      { geo: new THREE.SphereGeometry(0.305, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), color: C.hat, pos: [0, 0.29, -0.01], scale: [1, 0.95, 1] },
      // fold-up brim
      { geo: new THREE.CylinderGeometry(0.318, 0.322, 0.1, 12), color: C.hatBrim, pos: [0, 0.32, -0.01] },
      // pom-pom
      { geo: new THREE.IcosahedronGeometry(0.085, 1), color: C.pom, pos: [0, 0.6, -0.03] },
    ];
    // a darker knit stripe round the crown
    parts.push({ geo: new THREE.CylinderGeometry(0.262, 0.284, 0.055, 12), color: 0xb98a2e, pos: [0, 0.42, -0.01] });
    return mergeParts(parts);
  });

// ------------------------------------------------------------------ footprints

const TRAIL_SIZE = 16;
const TRAIL_LIFE = 2.6;
let footGeo: THREE.BufferGeometry | null = null;
let footTex: THREE.CanvasTexture | null = null;

function footTexture(): THREE.CanvasTexture {
  if (footTex) return footTex;
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.filter = 'blur(2px)';
  ctx.fillStyle = '#fff';
  // sole and heel
  ctx.beginPath();
  ctx.ellipse(16, 22, 10, 16, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(16, 48, 8, 10, 0, 0, Math.PI * 2);
  ctx.fill();
  footTex = new THREE.CanvasTexture(c);
  footTex.colorSpace = THREE.SRGBColorSpace;
  return footTex;
}

/**
 * ✨ 빛나는 발자국: a fixed pool of glowing golden prints (one instanced draw
 * call per walker). Each print fades through a per-instance alpha.
 */
export class FootTrail {
  readonly mesh: THREE.InstancedMesh;
  private readonly life = new Float32Array(TRAIL_SIZE);
  private readonly alpha: THREE.InstancedBufferAttribute;
  private readonly geometry: THREE.BufferGeometry;
  private next = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly zero = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly material: THREE.MeshBasicMaterial;

  constructor() {
    footGeo ??= new THREE.PlaneGeometry(0.2, 0.38).rotateX(-Math.PI / 2);
    this.geometry = footGeo.clone();
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(TRAIL_SIZE), 1);
    this.geometry.setAttribute('aAlpha', this.alpha);
    this.material = new THREE.MeshBasicMaterial({
      map: footTexture(),
      color: 0xffcf5e,
      transparent: true,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlpha = aAlpha;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
        .replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\ndiffuseColor.a *= vAlpha;');
    };
    this.material.customProgramCacheKey = () => 'foot-trail';
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, TRAIL_SIZE);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'foot-trail';
    for (let i = 0; i < TRAIL_SIZE; i++) this.mesh.setMatrixAt(i, this.zero);
  }

  spawn(x: number, y: number, z: number, yaw: number) {
    const i = this.next;
    this.next = (this.next + 1) % TRAIL_SIZE;
    this.life[i] = TRAIL_LIFE;
    this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
    this.p.set(x, y + 0.04, z);
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(i, this.m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number) {
    let dirty = false;
    const a = this.alpha.array as Float32Array;
    for (let i = 0; i < TRAIL_SIZE; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] = Math.max(0, this.life[i] - dt);
      const t = this.life[i] / TRAIL_LIFE;
      // bright at first, then a slow fade
      a[i] = Math.min(1, t * 1.8) * (0.45 + 0.55 * t);
      if (this.life[i] === 0) {
        this.mesh.setMatrixAt(i, this.zero);
        this.mesh.instanceMatrix.needsUpdate = true;
      }
      dirty = true;
    }
    if (dirty) this.alpha.needsUpdate = true;
  }

  get visibleCount(): number {
    let n = 0;
    for (let i = 0; i < TRAIL_SIZE; i++) if (this.life[i] > 0) n++;
    return n;
  }

  clear() {
    this.life.fill(0);
    for (let i = 0; i < TRAIL_SIZE; i++) this.mesh.setMatrixAt(i, this.zero);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
