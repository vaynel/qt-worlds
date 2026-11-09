import * as THREE from 'three';

export interface AvatarColors {
  robe: number;
  scarf: number;
  skin: number;
  hair: number;
}

export const DEFAULT_AVATAR: AvatarColors = {
  robe: 0xf1e4c8,
  scarf: 0xc8644a,
  skin: 0xf0c9a4,
  hair: 0x5a3e2b,
};

/** Gentle, warm variations so remote players are easy to tell apart. */
const SCARVES = [0xc8644a, 0x5f8f6b, 0x4f78a6, 0xd2a03c, 0x9a5fa0, 0xc77a8a, 0x3f8f8f, 0x8a6a4a];
const ROBES = [0xf1e4c8, 0xe8dcc8, 0xf3e9d6, 0xe6d6bb];
const HAIRS = [0x5a3e2b, 0x2f2620, 0x7a5236, 0x3d2c22];

export function colorsForId(id: string): AvatarColors {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0;
  return {
    robe: ROBES[h % ROBES.length],
    scarf: SCARVES[(h >>> 3) % SCARVES.length],
    skin: DEFAULT_AVATAR.skin,
    hair: HAIRS[(h >>> 7) % HAIRS.length],
  };
}

/**
 * A small low-poly pilgrim built from primitives. Purely visual: it poses
 * itself from speed and a seated flag, so the same class renders the local
 * player and remote players. Local front is +z.
 */
export class Avatar {
  readonly root = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly legL: THREE.Object3D;
  private readonly legR: THREE.Object3D;
  private readonly armL: THREE.Object3D;
  private readonly armR: THREE.Object3D;
  /** Lower legs, only shown while sitting on a log (knees bent over its front). */
  private readonly shinL: THREE.Object3D;
  private readonly shinR: THREE.Object3D;
  private phase = 0;
  private seatedTarget = 0;
  private seated = 0;
  /** Relaxed sitting on a campfire log (separate from the prayer pose). */
  private sitTarget = 0;
  private sit = 0;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(colors: AvatarColors = DEFAULT_AVATAR, castShadow = true) {
    const mat = (color: number) => {
      const m = new THREE.MeshLambertMaterial({ color, flatShading: true });
      this.materials.push(m);
      return m;
    };
    const part = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D) => {
      this.geometries.push(geo);
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = castShadow;
      parent.add(mesh);
      return mesh;
    };

    const robe = mat(colors.robe);
    const dark = mat(0x6b4a33);

    this.root.add(this.body);
    part(new THREE.CylinderGeometry(0.26, 0.44, 0.95, 7), robe, 0, 0.72, 0, this.body);
    part(new THREE.CylinderGeometry(0.3, 0.3, 0.14, 7), mat(colors.scarf), 0, 1.2, 0, this.body);

    // Head pivots at the neck so it can bow in prayer.
    this.head.position.set(0, 1.25, 0);
    this.body.add(this.head);
    part(new THREE.IcosahedronGeometry(0.27, 1), mat(colors.skin), 0, 0.23, 0, this.head);
    const hair = part(new THREE.SphereGeometry(0.29, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.55), mat(colors.hair), 0, 0.27, -0.04, this.head);
    hair.rotation.x = -0.35;
    const eye = mat(0x3a2a20);
    part(new THREE.SphereGeometry(0.035, 5, 4), eye, -0.09, 0.25, 0.245, this.head);
    part(new THREE.SphereGeometry(0.035, 5, 4), eye, 0.09, 0.25, 0.245, this.head);

    const limb = (x: number, y: number, len: number, radius: number, m: THREE.Material) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      part(new THREE.CylinderGeometry(radius, radius * 0.85, len, 5), m, 0, -len / 2, 0, pivot);
      this.body.add(pivot);
      return pivot;
    };
    this.armL = limb(-0.33, 1.12, 0.55, 0.075, robe);
    this.armR = limb(0.33, 1.12, 0.55, 0.075, robe);
    this.legL = limb(-0.13, 0.32, 0.32, 0.08, dark);
    this.legR = limb(0.13, 0.32, 0.32, 0.08, dark);
    const shin = (leg: THREE.Object3D) => {
      const pivot = new THREE.Group();
      pivot.position.set(0, -0.32, 0);
      part(new THREE.CylinderGeometry(0.075, 0.07, 0.5, 5), dark, 0, -0.25, 0, pivot);
      part(new THREE.BoxGeometry(0.15, 0.08, 0.22), dark, 0, -0.5, 0.05, pivot);
      pivot.visible = false;
      leg.add(pivot);
      return pivot;
    };
    this.shinL = shin(this.legL);
    this.shinR = shin(this.legR);
  }

  /**
   * Seated pose, blended in smoothly: 'pray' kneels with hands joined (mats),
   * 'sit' sits relaxed on a log about 0.6 m high, hands on the knees.
   */
  setSeated(seated: boolean, pose: 'pray' | 'sit' = 'pray'): void {
    this.seatedTarget = seated && pose === 'pray' ? 1 : 0;
    this.sitTarget = seated && pose === 'sit' ? 1 : 0;
  }

  /** Current pose for tests: 'pray', 'sit' or 'stand'. */
  get pose(): 'pray' | 'sit' | 'stand' {
    return this.sitTarget ? 'sit' : this.seatedTarget ? 'pray' : 'stand';
  }

  /** speed in m/s; drives walk cycle, idle breathing and the prayer pose. */
  animate(dt: number, speed: number, elapsed: number): void {
    const k = 1 - Math.exp(-6 * dt);
    this.seated += (this.seatedTarget - this.seated) * k;
    this.sit += (this.sitTarget - this.sit) * k;
    const s = this.seated;
    const q = this.sit;
    const moving = Math.min(1, speed / 4) * (1 - s) * (1 - q);
    this.phase += dt * (3 + speed * 1.9);
    const swing = Math.sin(this.phase) * 0.7 * moving;
    const breathe = Math.sin(elapsed * 1.6) * 0.012 * (1 - moving);

    // Walk swing, blended toward folded legs and hands joined in prayer, or
    // toward thighs forward over the log with hands resting on the knees.
    const free = 1 - s - q;
    this.legL.rotation.x = swing * free - 1.45 * s - 1.45 * q;
    this.legR.rotation.x = -swing * free - 1.45 * s - 1.4 * q;
    // Shins hang down over the front of the log, a little forward.
    this.shinL.visible = this.shinR.visible = q > 0.05;
    this.shinL.rotation.x = 1.25 * q;
    this.shinR.rotation.x = 1.15 * q;
    this.legL.rotation.z = 0.08 * q;
    this.legR.rotation.z = -0.08 * q;
    this.armL.rotation.x = -swing * 0.8 * free - 1.05 * s - 0.62 * q;
    this.armR.rotation.x = swing * 0.8 * free - 1.05 * s - 0.55 * q;
    this.armL.rotation.z = -0.12 * free + 0.5 * s - 0.05 * q;
    this.armR.rotation.z = 0.12 * free - 0.5 * s + 0.05 * q;
    // Looking a little down at the fire, nodding gently while listening.
    this.head.rotation.x = 0.38 * s + breathe * 2 * s + (0.12 + Math.sin(elapsed * 0.7) * 0.03) * q;

    const bob = Math.abs(Math.sin(this.phase)) * 0.06 * moving;
    // Log top is ~0.6 m: lift the hips (leg pivots, 0.32 m) up onto it.
    this.body.position.y = bob + breathe - 0.4 * s + 0.29 * q;
    this.body.rotation.x = 0.06 * moving + 0.08 * s + 0.1 * q;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
