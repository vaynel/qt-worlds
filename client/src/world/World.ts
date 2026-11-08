import * as THREE from 'three';
import { ChunkManager, type CircleCollider } from './ChunkManager';
import { DEFAULT_SEED, LANDMARKS, PALETTE, WATER_LEVEL, type LandmarkDef } from './config';
import { DayNight } from './DayNight';
import { Heightfield } from './Heightfield';
import { Landmarks } from './Landmarks';
import { hashString } from './random';

export interface WorldOptions {
  seed?: string;
  fixedHours: number | null;
  shadows: boolean;
}

/**
 * Everything static about the world: terrain, water, landmarks and sky.
 * Players (local now, remote in M2) live outside and query it for ground
 * height and collisions.
 */
export class World {
  readonly seedText: string;
  readonly field: Heightfield;
  readonly chunks: ChunkManager;
  readonly landmarks: Landmarks;
  readonly dayNight: DayNight;
  private readonly water: THREE.Mesh;
  private readonly nearby: CircleCollider[] = [];

  constructor(readonly scene: THREE.Scene, options: WorldOptions) {
    this.seedText = options.seed || DEFAULT_SEED;
    const seed = hashString(this.seedText);
    this.field = new Heightfield(seed);
    this.chunks = new ChunkManager(this.field, seed, options.shadows);
    this.landmarks = new Landmarks(this.field, options.shadows);
    this.dayNight = new DayNight(scene, options.fixedHours, options.shadows);

    const waterGeo = new THREE.PlaneGeometry(280, 280, 1, 1).rotateX(-Math.PI / 2);
    this.water = new THREE.Mesh(
      waterGeo,
      new THREE.MeshLambertMaterial({ color: PALETTE.water, transparent: true, opacity: 0.82 }),
    );
    this.water.position.y = WATER_LEVEL;
    this.water.receiveShadow = options.shadows;
    this.water.name = 'water';

    scene.add(this.chunks.root, this.landmarks.group, this.water);
  }

  /** Hash of sampled heights: equal seeds must give equal values (QA). */
  terrainChecksum(): number {
    let sum = 0;
    for (let z = -200; z <= 200; z += 7) {
      for (let x = -200; x <= 200; x += 7) sum += this.field.rawHeight(x, z) * ((x * 31 + z * 17) % 13);
    }
    return Math.round(sum * 1000) / 1000;
  }

  groundHeight(x: number, z: number): number {
    return this.field.surfaceHeight(x, z);
  }

  /** Static landmark colliders plus scattered props near (x, z). */
  collidersNear(x: number, z: number): CircleCollider[] {
    this.chunks.collidersNear(x, z, this.nearby);
    for (const c of this.landmarks.colliders) {
      if (Math.abs(c.x - x) < 12 && Math.abs(c.z - z) < 12) this.nearby.push(c);
    }
    return this.nearby;
  }

  /** The landmark the player is "at", or null when out in the fields. */
  locate(x: number, z: number): LandmarkDef | null {
    let best: LandmarkDef | null = null;
    let bestD = Infinity;
    for (const l of LANDMARKS) {
      const d = Math.hypot(x - l.x, z - l.z);
      if (d < l.radius + 4 && d < bestD) {
        best = l;
        bestD = d;
      }
    }
    return best;
  }

  update(elapsed: number, camera: THREE.Camera, focus: THREE.Vector3): void {
    this.chunks.update(focus.x, focus.z);
    this.dayNight.update(camera, focus);
    this.landmarks.setNight(this.dayNight.night);
    this.landmarks.update(elapsed, camera);
    this.water.position.x = Math.round(focus.x / 8) * 8;
    this.water.position.z = Math.round(focus.z / 8) * 8;
  }
}
