import * as THREE from 'three';
import { LOG_ANGLE0, LOG_COUNT, LOG_LENGTH, LOG_RADIUS, LOG_RING_RADIUS, MATS } from '../../../shared/protocol';
import { LANDMARKS, PALETTE, type LandmarkDef, type LandmarkId } from './config';
import type { CircleCollider } from './ChunkManager';
import type { Heightfield } from './Heightfield';
import { createLabelSprite } from './labels';
import { mulberry32 } from './random';

const matCache = new Map<number, THREE.MeshLambertMaterial>();
function lambert(color: number): THREE.MeshLambertMaterial {
  let m = matCache.get(color);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, flatShading: true });
    matCache.set(color, m);
  }
  return m;
}

/** A glowing material whose brightness follows the night factor. */
interface Glow {
  material: THREE.MeshLambertMaterial;
  day: number;
  night: number;
}

interface Label {
  sprite: THREE.Sprite;
  base: THREE.Vector2;
  x: number;
  z: number;
}

/**
 * Authored placeholder landmarks. Each builder is isolated so a later milestone
 * can swap a landmark for an interactive version (seats, lanterns, room door).
 */
export class Landmarks {
  readonly group = new THREE.Group();
  readonly colliders: CircleCollider[] = [];
  private readonly labels: Label[] = [];
  private readonly glows: Glow[] = [];
  private readonly lights: { light: THREE.PointLight; day: number; night: number }[] = [];
  private readonly flames: THREE.Mesh[] = [];
  private readonly shadows: boolean;
  private night = 0;
  private readonly matCandles: THREE.Group[] = [];
  private fireLight: { light: THREE.PointLight; day: number; night: number } | null = null;

  /** Door position of the private room, used by the proximity prompt. */
  readonly closetDoor = new THREE.Vector3();

  constructor(private readonly field: Heightfield, shadows: boolean) {
    this.shadows = shadows;
    this.group.name = 'landmarks';
    const by = (id: LandmarkId) => LANDMARKS.find((l) => l.id === id)!;
    this.buildPlaza(by('plaza'));
    this.buildPrayerGarden(by('prayerGarden'));
    this.buildCampfire(by('campfire'));
    this.buildLanternHill(by('lanternHill'));
    this.buildCloset(by('closet'));
  }

  // ---------------------------------------------------------------- helpers

  private add(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    opts: { ry?: number; rx?: number; rz?: number; cast?: boolean; parent?: THREE.Object3D } = {},
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.set(opts.rx ?? 0, opts.ry ?? 0, opts.rz ?? 0);
    mesh.castShadow = this.shadows && (opts.cast ?? true);
    mesh.receiveShadow = this.shadows;
    (opts.parent ?? this.group).add(mesh);
    return mesh;
  }

  private glow(color: number, day: number, night: number): THREE.MeshLambertMaterial {
    const material = new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: day });
    this.glows.push({ material, day, night });
    return material;
  }

  private pointLight(color: number, x: number, y: number, z: number, distance: number, day: number, night: number) {
    const light = new THREE.PointLight(color, day, distance, 1.6);
    light.position.set(x, y, z);
    this.group.add(light);
    const entry = { light, day, night };
    this.lights.push(entry);
    return entry;
  }

  private label(l: LandmarkDef, title: string, subtitle: string | undefined, y: number, x = l.x, z = l.z) {
    const sprite = createLabelSprite(title, subtitle);
    sprite.position.set(x, y, z);
    this.group.add(sprite);
    this.labels.push({ sprite, base: new THREE.Vector2(sprite.scale.x, sprite.scale.y), x, z });
  }

  private lampPost(x: number, z: number, ground: number, height = 2.6) {
    this.add(new THREE.CylinderGeometry(0.07, 0.1, height, 6), lambert(PALETTE.woodDark), x, ground + height / 2, z);
    this.add(new THREE.BoxGeometry(0.36, 0.42, 0.36), this.glow(PALETTE.lantern, 0.25, 1.6), x, ground + height + 0.2, z, { cast: false });
    this.add(new THREE.ConeGeometry(0.32, 0.25, 4), lambert(PALETTE.woodDark), x, ground + height + 0.53, z, { ry: Math.PI / 4 });
    this.colliders.push({ x, z, r: 0.25 });
  }

  private bench(x: number, z: number, ground: number, facing: number) {
    const g = new THREE.Group();
    g.position.set(x, ground, z);
    g.rotation.y = facing;
    this.add(new THREE.BoxGeometry(1.8, 0.12, 0.5), lambert(PALETTE.wood), 0, 0.45, 0, { parent: g });
    this.add(new THREE.BoxGeometry(1.8, 0.4, 0.1), lambert(PALETTE.wood), 0, 0.75, -0.22, { parent: g, rx: -0.12 });
    for (const sx of [-0.75, 0.75]) {
      this.add(new THREE.BoxGeometry(0.1, 0.45, 0.45), lambert(PALETTE.woodDark), sx, 0.22, 0, { parent: g });
    }
    this.group.add(g);
    this.colliders.push({ x, z, r: 0.8 });
  }

  // ---------------------------------------------------------------- landmarks

  /** 중앙 광장: stone circle, central basin where the daily verse will land. */
  private buildPlaza(l: LandmarkDef) {
    const h = l.height;
    this.add(new THREE.CylinderGeometry(12, 12.3, 0.3, 28), lambert(PALETTE.stone), l.x, h - 0.1, l.z, { cast: false });
    this.add(new THREE.CylinderGeometry(7.5, 7.5, 0.32, 28), lambert(PALETTE.stoneDark), l.x, h - 0.09, l.z, { cast: false });
    this.add(new THREE.CylinderGeometry(6.9, 6.9, 0.34, 28), lambert(PALETTE.stone), l.x, h - 0.08, l.z, { cast: false });

    // Central basin: the landing spot for the M3 "오늘의 말씀" letter.
    this.add(new THREE.CylinderGeometry(1.9, 2.2, 0.7, 10), lambert(PALETTE.stoneDark), l.x, h + 0.3, l.z);
    this.add(new THREE.CylinderGeometry(1.55, 1.55, 0.1, 10), lambert(PALETTE.water), l.x, h + 0.62, l.z, { cast: false });
    this.add(new THREE.OctahedronGeometry(0.35, 0), this.glow(0xfff1c8, 0.6, 1.4), l.x, h + 1.4, l.z, { cast: false });
    this.colliders.push({ x: l.x, z: l.z, r: 2.4 });
    // A soft warm pool of light over the plaza after dark.
    this.pointLight(0xffc98a, l.x, h + 5, l.z, 26, 0, 9);

    // Ring of lamps and four benches facing the centre.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      this.lampPost(l.x + Math.cos(a) * 10.8, l.z + Math.sin(a) * 10.8, h);
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const x = l.x + Math.cos(a) * 5;
      const z = l.z + Math.sin(a) * 5;
      this.bench(x, z, h, Math.atan2(l.x - x, l.z - z));
    }

    // Signpost pointing toward each landmark (arrows only; names float above them).
    const post = new THREE.Group();
    post.position.set(l.x + 3.2, h, l.z + 3.2);
    this.add(new THREE.CylinderGeometry(0.09, 0.11, 2.6, 6), lambert(PALETTE.woodDark), 0, 1.3, 0, { parent: post });
    let y = 2.3;
    for (const target of LANDMARKS) {
      if (target.id === 'plaza') continue;
      const ang = Math.atan2(target.x - post.position.x, target.z - post.position.z);
      const arm = new THREE.Group();
      arm.position.y = y;
      arm.rotation.y = ang - Math.PI / 2;
      this.add(new THREE.BoxGeometry(1.0, 0.22, 0.06), lambert(PALETTE.wood), 0.55, 0, 0, { parent: arm });
      this.add(new THREE.ConeGeometry(0.16, 0.22, 3), lambert(PALETTE.wood), 1.15, 0, 0, { parent: arm, rz: -Math.PI / 2 });
      post.add(arm);
      y -= 0.32;
    }
    this.group.add(post);
    this.colliders.push({ x: post.position.x, z: post.position.z, r: 0.25 });

    this.label(l, l.name, '처음 오신 곳', h + 3.4);
  }

  /** 기도의 뜰: an open hedge ring with mats laid toward the centre. */
  private buildPrayerGarden(l: LandmarkDef) {
    const h = l.height;
    const rng = mulberry32(7);
    const toPlaza = Math.atan2(-l.z, -l.x);
    const ringR = 10;
    const segments = 28;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      // Leave four gaps; one faces the plaza.
      const rel = Math.abs(Math.atan2(Math.sin(a - toPlaza), Math.cos(a - toPlaza)));
      if (rel < 0.22 || Math.abs(rel - Math.PI / 2) < 0.16 || Math.abs(rel - Math.PI) < 0.16) continue;
      const x = l.x + Math.cos(a) * ringR;
      const z = l.z + Math.sin(a) * ringR;
      this.add(new THREE.BoxGeometry(2.4, 0.9, 0.9), lambert(PALETTE.grassDeep), x, h + 0.42, z, { ry: -a + Math.PI / 2 });
      this.colliders.push({ x, z, r: 1.0 });
    }

    // Entrance arch on the plaza side.
    const ax = l.x + Math.cos(toPlaza) * ringR;
    const az = l.z + Math.sin(toPlaza) * ringR;
    const arch = new THREE.Group();
    arch.position.set(ax, h, az);
    arch.rotation.y = -toPlaza + Math.PI / 2;
    for (const sx of [-1.4, 1.4]) {
      this.add(new THREE.BoxGeometry(0.22, 2.8, 0.22), lambert(PALETTE.wood), sx, 1.4, 0, { parent: arch });
      this.colliders.push({ x: ax + Math.cos(toPlaza + Math.PI / 2) * sx, z: az + Math.sin(toPlaza + Math.PI / 2) * sx, r: 0.2 });
    }
    this.add(new THREE.BoxGeometry(3.4, 0.24, 0.34), lambert(PALETTE.woodDark), 0, 2.9, 0, { parent: arch });
    this.group.add(arch);

    // Mats (돗자리) in a soft circle, each turned toward the centre tree.
    // Positions come from the shared protocol so the server can validate seats.
    // A small candle lights up beside a mat while someone prays on it.
    const matColors = [0xe9cf9c, 0xd9b483, 0xeedcb5, 0xcfa776];
    const candleGlow = this.glow(0xffc46b, 1.2, 2.4);
    for (const spot of MATS) {
      this.add(new THREE.BoxGeometry(1.1, 0.05, 1.7), lambert(matColors[spot.index % 4]), spot.x, h + 0.03, spot.z, {
        ry: spot.yaw,
        cast: false,
      });
      const candle = new THREE.Group();
      const side = new THREE.Vector3(0.75, 0, 0.55).applyAxisAngle(new THREE.Vector3(0, 1, 0), spot.yaw);
      candle.position.set(spot.x + side.x, h, spot.z + side.z);
      this.add(new THREE.CylinderGeometry(0.07, 0.08, 0.26, 6), lambert(PALETTE.cream), 0, 0.13, 0, { parent: candle, cast: false });
      this.add(new THREE.ConeGeometry(0.05, 0.14, 5), candleGlow, 0, 0.33, 0, { parent: candle, cast: false });
      candle.visible = false;
      this.group.add(candle);
      this.matCandles.push(candle);
    }

    // Quiet centre: an olive-like tree on a low stone ring.
    this.add(new THREE.CylinderGeometry(1.4, 1.5, 0.35, 10), lambert(PALETTE.stoneDark), l.x, h + 0.17, l.z);
    this.add(new THREE.CylinderGeometry(0.18, 0.3, 2.2, 6), lambert(PALETTE.trunk), l.x, h + 1.3, l.z);
    this.add(new THREE.IcosahedronGeometry(1.6, 0), lambert(0x93a867), l.x, h + 3.0, l.z);
    this.add(new THREE.IcosahedronGeometry(1.1, 0), lambert(0xa6b878), l.x + 0.8, h + 2.6, l.z + 0.4);
    this.colliders.push({ x: l.x, z: l.z, r: 1.6 });

    // Flower clusters scattered inside the ring.
    const flowerColors = [0xf4b6b6, 0xfff2d8, 0xf6d27a, 0xd7b8e8];
    const flowerGeo = new THREE.IcosahedronGeometry(0.16, 0);
    for (let i = 0; i < 46; i++) {
      const a = rng() * Math.PI * 2;
      const r = 2 + rng() * 7.2;
      if (Math.abs(r - 5.2) < 1.1) continue; // keep the mats clear
      this.add(flowerGeo, lambert(flowerColors[i % 4]), l.x + Math.cos(a) * r, h + 0.12, l.z + Math.sin(a) * r, { cast: false });
    }

    this.label(l, l.name, '함께 조용히 기도해요', h + 4.6);
  }

  /** 모닥불 모임터: stone fire ring, log benches, flickering warm light. */
  private buildCampfire(l: LandmarkDef) {
    const h = l.height;
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      this.add(new THREE.DodecahedronGeometry(0.32, 0), lambert(PALETTE.rock), l.x + Math.cos(a) * 1.1, h + 0.15, l.z + Math.sin(a) * 1.1, { ry: a });
    }
    for (let i = 0; i < 3; i++) {
      this.add(new THREE.CylinderGeometry(0.1, 0.12, 1.5, 5), lambert(PALETTE.woodDark), l.x, h + 0.25, l.z, {
        rz: Math.PI / 2 - 0.35,
        ry: (i / 3) * Math.PI,
      });
    }
    const flameOuter = this.add(new THREE.ConeGeometry(0.55, 1.4, 6), this.glow(0xff8a3d, 1.2, 2.2), l.x, h + 0.85, l.z, { cast: false });
    const flameInner = this.add(new THREE.ConeGeometry(0.3, 0.95, 5), this.glow(0xffd36b, 1.4, 2.6), l.x, h + 0.7, l.z, { cast: false });
    this.flames.push(flameOuter, flameInner);
    this.fireLight = this.pointLight(0xffa056, l.x, h + 1.4, l.z, 18, 2, 18);
    this.colliders.push({ x: l.x, z: l.z, r: 1.5 });

    // Log benches around the fire. Geometry comes from the shared protocol so
    // the server-validated seats (LOG_SEATS, two per log) sit right on them.
    for (let i = 0; i < LOG_COUNT; i++) {
      const a = (i / LOG_COUNT) * Math.PI * 2 + LOG_ANGLE0;
      const x = l.x + Math.cos(a) * LOG_RING_RADIUS;
      const z = l.z + Math.sin(a) * LOG_RING_RADIUS;
      this.add(new THREE.CylinderGeometry(LOG_RADIUS, LOG_RADIUS, LOG_LENGTH, 7), lambert(PALETTE.wood), x, h + 0.3, z, {
        rz: Math.PI / 2,
        ry: -a - Math.PI / 2, // lie tangent to the circle, facing the fire
      });
      // Three small colliders along the log (a single big circle used to
      // shove people sideways when they got up from a seat).
      for (const t of [-0.6, 0, 0.6]) this.colliders.push({ x: x - Math.sin(a) * t, z: z + Math.cos(a) * t, r: 0.4 });
    }

    this.label(l, l.name, '둘러앉아 이야기해요', h + 3.6);
  }

  /** 등불 언덕: lantern posts winding up a rounded hill, empty pedestals waiting. */
  private buildLanternHill(l: LandmarkDef) {
    const top = this.field.surfaceHeight(l.x, l.z);

    // Large stone lantern at the summit.
    this.add(new THREE.CylinderGeometry(0.9, 1.1, 0.5, 8), lambert(PALETTE.stoneDark), l.x, top + 0.25, l.z);
    this.add(new THREE.CylinderGeometry(0.25, 0.3, 1.4, 6), lambert(PALETTE.stone), l.x, top + 1.2, l.z);
    this.add(new THREE.BoxGeometry(0.9, 0.8, 0.9), this.glow(PALETTE.lantern, 0.5, 2.2), l.x, top + 2.3, l.z, { cast: false });
    this.add(new THREE.ConeGeometry(0.95, 0.6, 4), lambert(PALETTE.stoneDark), l.x, top + 3.0, l.z, { ry: Math.PI / 4 });
    this.pointLight(0xffc06b, l.x, top + 2.4, l.z, 22, 0, 10);
    this.colliders.push({ x: l.x, z: l.z, r: 1.2 });

    // Shared lanterns (LanternField) fill the slope; slots come from the server.

    // Lamp posts along the path from the plaza.
    for (let i = 1; i <= 4; i++) {
      const t = i / 5;
      const x = l.x * t + 2.4;
      const z = l.z * t;
      this.lampPost(x, z, this.field.surfaceHeight(x, z), 2.2);
    }

    this.label(l, l.name, '묵상을 등불로 밝혀요', top + 3.8);
  }

  /** 골방: a small cottage whose door will lead into the private room. */
  private buildCloset(l: LandmarkDef) {
    const h = l.height;
    const house = new THREE.Group();
    house.position.set(l.x, h, l.z);
    const facing = Math.atan2(-l.x, -l.z); // door faces the plaza
    house.rotation.y = facing;

    this.add(new THREE.BoxGeometry(4.2, 0.3, 4.2), lambert(PALETTE.stoneDark), 0, 0.15, 0, { parent: house });
    this.add(new THREE.BoxGeometry(3.6, 2.6, 3.6), lambert(PALETTE.cream), 0, 1.6, 0, { parent: house });
    this.add(new THREE.ConeGeometry(3.3, 1.8, 4), lambert(PALETTE.terracotta), 0, 3.8, 0, { parent: house, ry: Math.PI / 4 });
    this.add(new THREE.BoxGeometry(0.4, 1.2, 0.4), lambert(PALETTE.stoneDark), 1.0, 4.0, -0.6, { parent: house });
    // Door (front = +z in local space) with a warm window beside it.
    this.add(new THREE.BoxGeometry(1.0, 1.8, 0.1), lambert(PALETTE.woodDark), 0, 1.2, 1.82, { parent: house });
    this.add(new THREE.SphereGeometry(0.06, 6, 4), lambert(PALETTE.lantern), 0.35, 1.2, 1.9, { parent: house, cast: false });
    const windowMat = this.glow(0xffd28a, 0.3, 1.5);
    this.add(new THREE.BoxGeometry(0.7, 0.6, 0.08), windowMat, 1.2, 1.9, 1.82, { parent: house, cast: false });
    this.add(new THREE.BoxGeometry(0.08, 0.6, 3.0), windowMat, 1.82, 1.9, 0, { parent: house, cast: false });
    // Step stones to the door.
    for (let i = 0; i < 4; i++) {
      this.add(new THREE.CylinderGeometry(0.4, 0.45, 0.1, 7), lambert(PALETTE.stone), (i % 2) * 0.3 - 0.15, 0.05, 2.6 + i * 1.0, { parent: house, cast: false });
    }
    this.group.add(house);

    // Lantern by the door so it reads at night.
    const side = new THREE.Vector3(-1.6, 0, 2.4).applyAxisAngle(new THREE.Vector3(0, 1, 0), facing);
    this.lampPost(l.x + side.x, l.z + side.z, h, 1.8);

    // Box-ish collision from a few circles.
    for (const [ox, oz] of [[0, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const v = new THREE.Vector3(ox * 0.9, 0, oz * 0.9).applyAxisAngle(new THREE.Vector3(0, 1, 0), facing);
      this.colliders.push({ x: l.x + v.x, z: l.z + v.z, r: 1.55 });
    }
    const door = new THREE.Vector3(0, 0, 2.4).applyAxisAngle(new THREE.Vector3(0, 1, 0), facing);
    this.closetDoor.set(l.x + door.x, h, l.z + door.z);

    this.label(l, l.name, '나만의 기도 방 (입구)', h + 5.0);
  }

  // ---------------------------------------------------------------- runtime

  /** Show which prayer mats are taken (true = occupied). */
  setMatsOccupied(occupied: readonly boolean[]) {
    this.matCandles.forEach((candle, i) => (candle.visible = !!occupied[i]));
  }

  setNight(night: number) {
    this.night = night;
    for (const g of this.glows) g.material.emissiveIntensity = g.day + (g.night - g.day) * night;
    for (const l of this.lights) l.light.intensity = l.day + (l.night - l.day) * night;
  }

  update(elapsed: number, camera: THREE.Camera) {
    // Flame flicker.
    const f = 1 + Math.sin(elapsed * 9.1) * 0.06 + Math.sin(elapsed * 13.7) * 0.04;
    for (const flame of this.flames) flame.scale.set(1, f, 1);
    const fire = this.fireLight;
    if (fire) fire.light.intensity = (fire.day + (fire.night - fire.day) * this.night) * (0.9 + (f - 1) * 1.5);

    // Far labels grow a little so they stay readable as waypoints, then fade
    // out beyond the fog so the horizon stays calm.
    for (const label of this.labels) {
      const d = Math.hypot(camera.position.x - label.x, camera.position.z - label.z);
      const grow = THREE.MathUtils.clamp(d / 30, 1, 2.4);
      label.sprite.scale.set(label.base.x * grow, label.base.y * grow, 1);
      const opacity = d < 95 ? 1 : Math.max(0, 1 - (d - 95) / 40);
      const mat = label.sprite.material;
      mat.opacity = opacity;
      label.sprite.visible = opacity > 0.01;
    }
  }
}
