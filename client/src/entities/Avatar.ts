import * as THREE from 'three';
import {
  BENCH_SEAT_HEIGHT,
  OUTFIT_CELLS,
  OUTFIT_PALETTE,
  OUTFIT_SIZE,
  type HairStyle,
  type PropId,
  type PropWear,
  type SeatKind,
} from '../../../shared/protocol';
import {
  bookClosedGeo,
  bookOpenGeo,
  doveBodyGeo,
  doveHeadGeo,
  FootTrail,
  glowTexture,
  guitarGeo,
  hatGeo,
  lanternCoreGeo,
  lanternFrameGeo,
  LANTERN_DROP,
  propMaterial,
} from './Props';

/** Footprints: one print per this many metres walked, alternating feet. */
const PRINT_STEP = 0.55;
let poolGeo: THREE.BufferGeometry | null = null;

interface LanternRig {
  group: THREE.Group;
  coreMat: THREE.MeshLambertMaterial;
  haloMat: THREE.SpriteMaterial;
  halo: THREE.Sprite;
  pool: THREE.Mesh;
  poolMat: THREE.MeshBasicMaterial;
}
interface PropRig {
  lantern?: LanternRig;
  guitar?: THREE.Mesh;
  bible?: { closed: THREE.Mesh; open: THREE.Mesh };
  dove?: { group: THREE.Group; head: THREE.Mesh };
  hat?: THREE.Mesh;
  feet?: FootTrail;
}

/** Hip pivot height when standing (top of the leg pivots). */
const HIP = 0.32;
/** Robe (torso + skirt) cylinder: centre and height, body-local. */
const ROBE_MID = 0.72;
const ROBE_H = 0.95;
const ROBE_TOP = ROBE_MID + ROBE_H / 2;
/** Sitting folds the skirt away: the robe keeps its top and loses a quarter of its height. */
const SIT_ROBE = 0.75;
const SIT_ROBE_BOTTOM = ROBE_TOP - ROBE_H * SIT_ROBE;
/** Where the hips rest for each seat (m above the ground); 0 = kneel on a mat. */
export function seatHeight(kind: SeatKind): number {
  return kind === 'log' ? 0.61 : kind === 'bench' ? BENCH_SEAT_HEIGHT + 0.02 : 0;
}

export interface AvatarColors {
  robe: number;
  scarf: number;
  skin: number;
  hair: number;
}

/** Colours plus hair style (M8 꾸미기). */
export interface AvatarLook extends AvatarColors {
  hairStyle: HairStyle;
}

export const DEFAULT_AVATAR: AvatarLook = {
  robe: 0xf1e4c8,
  scarf: 0xc8644a,
  skin: 0xf0c9a4,
  hair: 0x5a3e2b,
  hairStyle: 'short',
};

/**
 * Robe texture for a 16×16 pixel drawing: transparent cells take the robe
 * colour. The drawing spans half the robe's circumference and repeats, so it
 * shows on the front and on the back (see the robe's UV setup below).
 */
function patternData(pixels: string, robe: number, out: Uint8Array) {
  const n = OUTFIT_SIZE;
  for (let row = 0; row < n; row++) {
    // DataTexture row 0 is the bottom of the robe (v = 0); the drawing starts at the top.
    const texRow = n - 1 - row;
    for (let col = 0; col < n; col++) {
      const ch = pixels.charCodeAt(row * n + col);
      // '0'-'9' = 48-57, 'a'-'f' = 97-102, '.' = transparent.
      const idx = ch >= 48 && ch <= 57 ? ch - 48 : ch >= 97 && ch <= 102 ? ch - 87 : -1;
      const c = idx >= 0 ? OUTFIT_PALETTE[idx] : robe;
      const o = (texRow * n + col) * 4;
      out[o] = (c >> 16) & 255;
      out[o + 1] = (c >> 8) & 255;
      out[o + 2] = c & 255;
      out[o + 3] = 255;
    }
  }
}

/** Robe faces: 8 sides, a flat face centred on the front (+z). */
const ROBE_SIDES = 8;
const ROBE_THETA0 = -Math.PI / ROBE_SIDES;

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
  private readonly robe: THREE.Mesh;
  private readonly shinL: THREE.Object3D;
  private readonly shinR: THREE.Object3D;
  private phase = 0;
  private seatedTarget = 0;
  private seated = 0;
  /** Relaxed sitting on a campfire log (separate from the prayer pose). */
  private sitTarget = 0;
  private sit = 0;
  /** Hip height of the current sitting seat (log ~0.61, bench ~0.53). */
  private sitHeight = 0.61;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly castShadow: boolean;
  private readonly robeMat: THREE.MeshLambertMaterial;
  private readonly scarfMat: THREE.MeshLambertMaterial;
  private readonly skinMat: THREE.MeshLambertMaterial;
  private readonly hairMat: THREE.MeshLambertMaterial;
  private readonly hairGroup = new THREE.Group();
  private hairGeos: THREE.BufferGeometry[] = [];
  private look: AvatarLook;
  /** Worn drawing (M8): texture on the robe's side, or null for the plain robe. */
  private pattern: { pixels: string; texture: THREE.DataTexture; material: THREE.MeshLambertMaterial } | null = null;
  /** Pattern textures alive across all avatars (tests check they are disposed on leave). */
  static liveTextures = 0;
  /** Borrowed props (M9) alive across all avatars (tests check they are disposed on leave). */
  static liveProps = 0;
  /** ✨ footprints live here, in world space: the owner adds this group to the scene. */
  readonly trail = new THREE.Group();
  private props: PropRig = {};
  private propKey = '';
  private propItems: PropId[] = [];
  private night = 0;
  /** Guitar playing (seated on a log) and reading (open book on a bench) blends. */
  private play = 0;
  private read = 0;
  /** Hand prop set down beside the seat while the guitar is played. */
  private handDown = false;
  private readonly lastPrint = new THREE.Vector3(NaN, 0, NaN);
  private printSide = 1;
  private readonly tmpV = new THREE.Vector3();

  constructor(colors: AvatarColors | AvatarLook = DEFAULT_AVATAR, castShadow = true) {
    this.castShadow = castShadow;
    this.look = { hairStyle: 'short', ...colors };
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
    this.robeMat = robe;
    const dark = mat(0x6b4a33);

    this.trail.name = 'prop-trail';
    this.root.add(this.body);
    this.robe = part(new THREE.CylinderGeometry(0.26, 0.44, ROBE_H, ROBE_SIDES, 1, false, ROBE_THETA0), robe, 0, ROBE_MID, 0, this.body);
    this.scarfMat = mat(colors.scarf);
    part(new THREE.CylinderGeometry(0.3, 0.3, 0.14, 7), this.scarfMat, 0, 1.2, 0, this.body);

    // Head pivots at the neck so it can bow in prayer.
    this.head.position.set(0, 1.25, 0);
    this.body.add(this.head);
    this.skinMat = mat(colors.skin);
    part(new THREE.IcosahedronGeometry(0.27, 1), this.skinMat, 0, 0.23, 0, this.head);
    this.hairMat = mat(colors.hair);
    this.hairMat.side = THREE.DoubleSide;
    this.head.add(this.hairGroup);
    this.buildHair(this.look.hairStyle);
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
   * Hair styles from a few cheap primitives, all inside the head group so they
   * follow every pose (bowing in prayer, sitting). Fronts stay open for the face.
   */
  private buildHair(style: HairStyle) {
    for (const g of this.hairGeos) g.dispose();
    this.hairGeos = [];
    this.hairGroup.clear();
    const add = (geo: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0) => {
      this.hairGeos.push(geo);
      const m = new THREE.Mesh(geo, this.hairMat);
      m.position.set(x, y, z);
      m.rotation.x = rx;
      m.castShadow = this.castShadow;
      this.hairGroup.add(m);
      return m;
    };
    if (style === 'bald') return;
    const hat = !!this.props?.hat;
    // The cap every style starts from (today's 짧은 머리). Under a 털모자 it
    // would poke through the crown: hide it and leave a band of hair below the brim.
    const cap = add(new THREE.SphereGeometry(0.29, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.55), 0, 0.27, -0.04, -0.35);
    cap.visible = !hat;
    cap.userData.cap = true;
    if (hat && (style === 'short' || style === 'tied')) {
      add(new THREE.CylinderGeometry(0.288, 0.298, 0.09, 9, 1, true, Math.PI * 0.42, Math.PI * 1.16), 0, 0.27, -0.025);
    }
    // Open cylinders: theta 0 is the face (+z), so start past it and leave a gap there.
    if (style === 'bob') {
      add(new THREE.CylinderGeometry(0.29, 0.315, 0.24, 9, 1, true, Math.PI * 0.3, Math.PI * 1.4), 0, 0.17, -0.02);
    } else if (style === 'long') {
      add(new THREE.CylinderGeometry(0.29, 0.34, 0.5, 9, 1, true, Math.PI * 0.34, Math.PI * 1.32), 0, 0.04, -0.03);
    } else if (style === 'tied') {
      // A bun at the back with a short tail hanging from it.
      // Under a hat the bun drops below the brim.
      if (hat) add(new THREE.IcosahedronGeometry(0.1, 0), 0, 0.2, -0.3);
      else add(new THREE.IcosahedronGeometry(0.115, 0), 0, 0.31, -0.28);
      add(new THREE.ConeGeometry(0.08, 0.3, 6), 0, 0.12, -0.32, 0.25);
    }
  }

  /** Colours and hair style (꾸미기). Cheap: material colours, and hair rebuilt only if the style changed. */
  setLook(look: AvatarLook) {
    const prev = this.look;
    this.look = { ...look };
    this.robeMat.color.setHex(look.robe);
    this.scarfMat.color.setHex(look.scarf);
    this.skinMat.color.setHex(look.skin);
    this.hairMat.color.setHex(look.hair);
    if (prev.hairStyle !== look.hairStyle) this.buildHair(look.hairStyle);
    if (this.pattern && prev.robe !== look.robe) {
      patternData(this.pattern.pixels, look.robe, this.pattern.texture.image.data as Uint8Array);
      this.pattern.texture.needsUpdate = true;
    }
  }

  get currentLook(): AvatarLook {
    return { ...this.look };
  }

  /** Worn drawing on the robe (16×16 palette string), or null for the plain robe. */
  setPattern(pixels: string | null) {
    if (pixels !== null && pixels.length !== OUTFIT_CELLS) pixels = null;
    if (pixels === null) {
      if (!this.pattern) return;
      this.robe.material = this.robeMat;
      this.pattern.texture.dispose();
      this.pattern.material.dispose();
      this.pattern = null;
      Avatar.liveTextures--;
      return;
    }
    if (!this.pattern) {
      const data = new Uint8Array(OUTFIT_CELLS * 4);
      const texture = new THREE.DataTexture(data, OUTFIT_SIZE, OUTFIT_SIZE, THREE.RGBAFormat);
      texture.colorSpace = THREE.SRGBColorSpace;
      // Crisp pixels: no smoothing, no mipmaps.
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      // The drawing covers half the circumference and repeats (front + back),
      // centred on the front face: geometry u at the front is 1/(2·sides).
      texture.wrapS = THREE.RepeatWrapping;
      texture.repeat.set(2, 1);
      texture.offset.set(0.5 - 2 * (0.5 / ROBE_SIDES), 0);
      const material = new THREE.MeshLambertMaterial({ map: texture, flatShading: true });
      this.pattern = { pixels, texture, material };
      Avatar.liveTextures++;
    }
    this.pattern.pixels = pixels;
    patternData(pixels, this.look.robe, this.pattern.texture.image.data as Uint8Array);
    this.pattern.texture.needsUpdate = true;
    // Side gets the drawing; the top and bottom caps keep the plain robe colour.
    this.robe.material = [this.pattern.material, this.robeMat, this.robeMat];
  }

  /** For tests: what is drawn on the robe (pixels and a checksum of the texture bytes). */
  get patternInfo(): { pixels: string; checksum: number; filter: string } | null {
    if (!this.pattern) return null;
    const d = this.pattern.texture.image.data as Uint8Array;
    let h = 0;
    for (let i = 0; i < d.length; i++) h = (Math.imul(h, 31) + d[i]) >>> 0;
    return { pixels: this.pattern.pixels, checksum: h, filter: this.pattern.texture.magFilter === THREE.NearestFilter ? 'nearest' : 'linear' };
  }


  // ------------------------------------------------------------------ 소품 (M9)

  /** Borrowed props to wear. Cheap when unchanged; removed props are freed. */
  setProps(list: readonly PropWear[]): void {
    const items = [...new Set(list.map((p) => p.item))].sort();
    const key = items.join(',');
    if (key === this.propKey) return;
    this.propKey = key;
    this.propItems = items;
    const want = new Set(items);
    const r = this.props;
    const hadHat = !!r.hat;
    if (r.lantern && !want.has('lantern')) {
      const l = r.lantern;
      l.group.removeFromParent();
      l.pool.removeFromParent();
      l.coreMat.dispose();
      l.haloMat.dispose();
      l.poolMat.dispose();
      delete r.lantern;
      Avatar.liveProps--;
    }
    if (r.guitar && !want.has('guitar')) {
      r.guitar.removeFromParent();
      delete r.guitar;
      Avatar.liveProps--;
    }
    if (r.bible && !want.has('bible')) {
      r.bible.closed.removeFromParent();
      r.bible.open.removeFromParent();
      delete r.bible;
      Avatar.liveProps--;
    }
    if (r.dove && !want.has('dove')) {
      r.dove.group.removeFromParent();
      delete r.dove;
      Avatar.liveProps--;
    }
    if (r.hat && !want.has('hat')) {
      r.hat.removeFromParent();
      delete r.hat;
      Avatar.liveProps--;
    }
    if (r.feet && !want.has('footprints')) {
      r.feet.dispose();
      delete r.feet;
      Avatar.liveProps--;
    }
    const mesh = (geo: THREE.BufferGeometry, parent: THREE.Object3D) => {
      const m = new THREE.Mesh(geo, propMaterial());
      m.castShadow = this.castShadow;
      parent.add(m);
      return m;
    };
    if (want.has('lantern') && !r.lantern) {
      const group = new THREE.Group();
      group.name = 'prop-lantern';
      mesh(lanternFrameGeo(), group);
      const coreMat = new THREE.MeshLambertMaterial({ color: 0xffd58a, emissive: 0xffb04a, emissiveIntensity: 0.5, flatShading: true });
      group.add(new THREE.Mesh(lanternCoreGeo(), coreMat));
      const haloMat = new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffc070, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false, opacity: 0.2 });
      const halo = new THREE.Sprite(haloMat);
      halo.position.y = -0.195;
      halo.scale.setScalar(0.85);
      halo.renderOrder = 3;
      group.add(halo);
      poolGeo ??= new THREE.PlaneGeometry(2.6, 2.6).rotateX(-Math.PI / 2);
      const poolMat = new THREE.MeshBasicMaterial({
        map: glowTexture(),
        color: 0xffa850,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        fog: false,
        opacity: 0,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      });
      const pool = new THREE.Mesh(poolGeo, poolMat);
      pool.renderOrder = 1;
      pool.position.set(0.3, 0.06, 0.1);
      this.root.add(pool);
      this.armR.add(group);
      group.position.set(0, -0.55, 0.03);
      r.lantern = { group, coreMat, haloMat, halo, pool, poolMat };
      Avatar.liveProps++;
    }
    if (want.has('guitar') && !r.guitar) {
      r.guitar = mesh(guitarGeo(), this.body);
      r.guitar.name = 'prop-guitar';
      Avatar.liveProps++;
    }
    if (want.has('bible') && !r.bible) {
      const closed = mesh(bookClosedGeo(), this.armR);
      closed.name = 'prop-bible';
      closed.position.set(0.0, -0.55, 0.1);
      closed.rotation.set(0.15, 0.25, 0);
      const open = mesh(bookOpenGeo(), this.body);
      open.scale.setScalar(1.2);
      open.visible = false;
      r.bible = { closed, open };
      Avatar.liveProps++;
    }
    if (want.has('dove') && !r.dove) {
      const group = new THREE.Group();
      group.name = 'prop-dove';
      group.position.set(-0.31, 1.265, 0.0);
      group.scale.setScalar(1.25);
      mesh(doveBodyGeo(), group);
      const head = mesh(doveHeadGeo(), group);
      head.position.set(0, 0.1, 0.07);
      this.body.add(group);
      r.dove = { group, head };
      Avatar.liveProps++;
    }
    if (want.has('hat') && !r.hat) {
      r.hat = mesh(hatGeo(), this.head);
      r.hat.name = 'prop-hat';
      // Tipped back a touch so the brim clears the eyes.
      r.hat.rotation.x = -0.14;
      r.hat.position.set(0, 0.03, 0.02);
      Avatar.liveProps++;
    }
    if (want.has('footprints') && !r.feet) {
      r.feet = new FootTrail();
      this.trail.add(r.feet.mesh);
      this.lastPrint.set(NaN, 0, NaN);
      Avatar.liveProps++;
    }
    if (hadHat !== !!r.hat) this.buildHair(this.look.hairStyle);
    if (!r.guitar) this.play = 0;
    if (!r.bible) this.read = 0;
    if (!key) this.head.rotation.z = 0;
    this.handDown = false;
    this.placeProps();
  }

  /** Night factor 0..1: the hand lantern glows brighter after dark. */
  setNight(night: number): void {
    this.night = night;
  }

  /** For tests: what is worn and how it is shown right now. */
  get propsInfo(): { items: PropId[]; guitar: 'back' | 'playing' | null; bible: 'closed' | 'open' | null; lanternGlow: number; trail: number; hairHidden: boolean } {
    const r = this.props;
    const cap = this.hairGroup.children.find((c) => c.userData.cap);
    return {
      items: [...this.propItems],
      guitar: r.guitar ? (this.play > 0.5 ? 'playing' : 'back') : null,
      bible: r.bible ? (r.bible.open.visible ? 'open' : 'closed') : null,
      lanternGlow: r.lantern ? +r.lantern.coreMat.emissiveIntensity.toFixed(2) : 0,
      trail: r.feet?.visibleCount ?? 0,
      hairHidden: !!cap && !cap.visible,
    };
  }

  /** Where each prop sits for the current pose (called when a pose flips). */
  private placeProps() {
    const r = this.props;
    const playing = this.play > 0.5;
    const reading = this.read > 0.5;
    if (r.guitar) {
      if (playing) {
        // Across the lap, front out, neck to the left hand.
        r.guitar.position.set(0.14, 0.68, 0.48);
        r.guitar.rotation.set(-0.12, 0, 1.2);
        r.guitar.scale.setScalar(1.2);
      } else {
        // Slung on the back, neck up over the right shoulder.
        r.guitar.position.set(-0.08, 0.66, -0.41);
        r.guitar.rotation.set(0.1, Math.PI, 0.6);
        r.guitar.scale.setScalar(1.15);
      }
    }
    // While playing, a hand prop is set down beside the seat.
    const down = playing && (!!r.lantern || !!r.bible);
    if (down !== this.handDown) {
      this.handDown = down;
      if (r.lantern) {
        const g = r.lantern.group;
        if (down) {
          this.root.add(g);
          g.position.set(0.42, LANTERN_DROP, 0.66);
          g.rotation.set(0, 0.4, 0);
          r.lantern.pool.position.set(0.42, 0.06, 0.66);
        } else {
          this.armR.add(g);
          g.position.set(0, -0.55, 0.03);
          r.lantern.pool.position.set(0.3, 0.06, 0.1);
        }
      }
      if (r.bible) {
        const b = r.bible.closed;
        if (down) {
          this.root.add(b);
          b.position.set(-0.42, 0.03, 0.66);
          b.rotation.set(Math.PI / 2, 0, 0.5);
        } else {
          this.armR.add(b);
          b.position.set(0.0, -0.55, 0.1);
          b.rotation.set(0.15, 0.25, 0);
        }
      }
    }
    if (r.bible) {
      r.bible.open.visible = reading;
      r.bible.closed.visible = !reading;
      // Open on the lap, tipped toward the reader's eyes.
      r.bible.open.position.set(0, 0.8, 0.44);
      r.bible.open.rotation.set(-0.75, 0, 0);
    }
  }

  /** Per-frame prop motion: pose blends, lantern hanging, dove, glow, footprints. */
  private animateProps(dt: number, speed: number, elapsed: number, moving: number) {
    const r = this.props;
    const k = 1 - Math.exp(-6 * dt);
    const seated = this.sitTarget === 1;
    const playTarget = r.guitar && seated && this.sitHeight >= 0.58 ? 1 : 0;
    const readTarget = r.bible && seated && this.sitHeight < 0.58 ? 1 : 0;
    const wasPlay = this.play > 0.5;
    const wasRead = this.read > 0.5;
    this.play += (playTarget - this.play) * k;
    this.read += (readTarget - this.read) * k;
    if (wasPlay !== this.play > 0.5 || wasRead !== this.read > 0.5) this.placeProps();
    const p = this.play;
    const q = this.read;
    if (p > 0.001) {
      // Right hand strums over the sound hole, left hand on the neck.
      const strum = Math.sin(elapsed * 7.5) * 0.09 + Math.sin(elapsed * 3.1) * 0.03;
      this.armR.rotation.x += (-1.0 + strum - this.armR.rotation.x) * p;
      this.armR.rotation.z += (-0.42 - this.armR.rotation.z) * p;
      this.armL.rotation.x += (-1.32 - this.armL.rotation.x) * p;
      this.armL.rotation.z += (-0.12 - this.armL.rotation.z) * p;
      this.head.rotation.x += (0.2 + Math.sin(elapsed * 1.5) * 0.04 - this.head.rotation.x) * p;
      this.head.rotation.z = Math.sin(elapsed * 1.5) * 0.06 * p;
    } else {
      this.head.rotation.z = 0;
    }
    if (q > 0.001) {
      // Both hands hold the open book; head bowed to read.
      this.armL.rotation.x += (-1.08 - this.armL.rotation.x) * q;
      this.armR.rotation.x += (-1.08 - this.armR.rotation.x) * q;
      this.armL.rotation.z += (0.32 - this.armL.rotation.z) * q;
      this.armR.rotation.z += (-0.32 - this.armR.rotation.z) * q;
      this.head.rotation.x += (0.42 - this.head.rotation.x) * q;
    }
    const l = r.lantern;
    if (l) {
      if (!this.handDown) {
        // Hang straight down from the hand, swinging a little while walking.
        l.group.rotation.x = -this.armR.rotation.x - this.body.rotation.x + Math.sin(this.phase + 0.6) * 0.18 * moving;
        l.group.rotation.z = -this.armR.rotation.z;
      }
      const n = this.night;
      const flicker = 1 + Math.sin(elapsed * 11.3) * 0.04 + Math.sin(elapsed * 7.1) * 0.03;
      l.coreMat.emissiveIntensity = (0.45 + 1.9 * n) * flicker;
      l.haloMat.opacity = (0.12 + 0.78 * n) * flicker;
      l.halo.scale.setScalar(0.7 + 0.45 * n);
      l.poolMat.opacity = 0.55 * n * flicker;
      l.pool.visible = n > 0.02;
    }
    const d = r.dove;
    if (d) {
      d.group.position.y = 1.255 + Math.abs(Math.sin(elapsed * 2.2)) * 0.012 + Math.abs(Math.sin(this.phase)) * 0.01 * moving;
      // A peck now and then, otherwise looking about.
      const cycle = elapsed % 4.2;
      const peck = cycle < 0.35 ? Math.sin((cycle / 0.35) * Math.PI) * 0.7 : 0;
      d.head.rotation.x = peck;
      d.head.rotation.y = Math.sin(elapsed * 0.9) * 0.5 * (peck === 0 ? 1 : 0.2);
    }
    const f = r.feet;
    if (f) {
      f.update(dt);
      if (this.root.visible) {
        const v = this.root.getWorldPosition(this.tmpV);
        const lp = this.lastPrint;
        const dist = Number.isNaN(lp.x) ? Infinity : Math.hypot(v.x - lp.x, v.z - lp.z);
        if (dist > 3 || speed < 0.3) {
          // Teleport or standing still: start counting again from here.
          if (dist > 3) lp.copy(v);
        } else if (dist >= PRINT_STEP) {
          lp.copy(v);
          this.printSide = -this.printSide;
          const yaw = this.root.rotation.y;
          const side = 0.11 * this.printSide;
          f.spawn(v.x + Math.cos(yaw) * side, v.y, v.z - Math.sin(yaw) * side, yaw);
        }
      }
    }
  }

  /**
   * Seated pose, blended in smoothly: 'pray' kneels with hands joined (mats),
   * 'sit' sits relaxed on a seat whose top is `height` m up (a campfire log
   * ~0.6 m, a plaza bench ~0.5 m), hands on the knees, shins hanging down.
   */
  setSeated(seated: boolean, pose: 'pray' | 'sit' = 'pray', height = 0.61): void {
    if (seated && pose === 'sit') this.sitHeight = height;
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
    // Shins hang down over the front of the seat: a little forward on a log;
    // on the lower bench straight down so the feet rest on the ground.
    const low = this.sitHeight < 0.58;
    this.shinL.visible = this.shinR.visible = q > 0.05;
    this.shinL.rotation.x = (low ? 1.42 : 1.25) * q;
    this.shinR.rotation.x = (low ? 1.34 : 1.15) * q;
    this.legL.rotation.z = 0.08 * q;
    this.legR.rotation.z = -0.08 * q;
    this.armL.rotation.x = -swing * 0.8 * free - 1.05 * s - 0.62 * q;
    this.armR.rotation.x = swing * 0.8 * free - 1.05 * s - 0.55 * q;
    this.armL.rotation.z = -0.12 * free + 0.5 * s - 0.05 * q;
    this.armR.rotation.z = 0.12 * free - 0.5 * s + 0.05 * q;
    // Looking a little down at the fire, nodding gently while listening.
    this.head.rotation.x = 0.38 * s + breathe * 2 * s + ((low ? 0.04 : 0.12) + Math.sin(elapsed * 0.7) * 0.03) * q;

    const bob = Math.abs(Math.sin(this.phase)) * 0.06 * moving;
    // Sitting: fold the skirt (shorter robe, same top), move the hips (leg
    // pivots) to the robe's new bottom and put that on the seat, so a seated
    // person is clearly lower than a standing one. Lean back less on a bench.
    const f = 1 - (1 - SIT_ROBE) * q;
    this.robe.scale.y = f;
    this.robe.position.y = ROBE_TOP - (ROBE_H * f) / 2;
    const hipY = HIP + (SIT_ROBE_BOTTOM - HIP) * q;
    this.legL.position.y = this.legR.position.y = hipY;
    this.body.position.y = bob + breathe - 0.4 * s + (this.sitHeight - SIT_ROBE_BOTTOM) * q;
    this.body.rotation.x = 0.06 * moving + 0.08 * s + (low ? 0.02 : 0.1) * q;
    if (this.propKey) this.animateProps(dt, speed, elapsed, moving);
  }

  dispose(): void {
    this.setProps([]);
    this.trail.removeFromParent();
    this.setPattern(null);
    for (const g of this.geometries) g.dispose();
    for (const g of this.hairGeos) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
