import * as THREE from 'three';
import { createNoise2D, type NoiseFunction2D } from 'simplex-noise';
import { CELL_SIZE, LANDMARKS, PALETTE, PLAZA, WATER_LEVEL, type LandmarkDef } from './config';
import { mulberry32 } from './random';

interface PathSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  ah: number;
  bh: number;
  lenSq: number;
}

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * The single source of truth for ground height. Both the chunk meshes and the
 * player/camera collision read from here, so what you see is what you stand on.
 *
 * rawHeight() is the continuous function; surfaceHeight() reproduces the exact
 * triangulated mesh surface (grid of CELL_SIZE, split along the a-c diagonal).
 */
export class Heightfield {
  private readonly hills: NoiseFunction2D;
  private readonly detail: NoiseFunction2D;
  private readonly tint: NoiseFunction2D;
  readonly forest: NoiseFunction2D;
  private readonly paths: PathSegment[];
  private readonly tmpColor = new THREE.Color();

  constructor(seed: number) {
    // Separate streams per field so they don't line up with each other.
    this.hills = createNoise2D(mulberry32(seed ^ 0x1234567));
    this.detail = createNoise2D(mulberry32(seed ^ 0x2345678));
    this.tint = createNoise2D(mulberry32(seed ^ 0x3456789));
    this.forest = createNoise2D(mulberry32(seed ^ 0x456789a));

    this.paths = LANDMARKS.filter((l) => l.id !== 'plaza').map((l) => {
      const dx = l.x - PLAZA.x;
      const dz = l.z - PLAZA.z;
      return {
        ax: PLAZA.x,
        az: PLAZA.z,
        bx: l.x,
        bz: l.z,
        ah: PLAZA.height,
        bh: l.height,
        lenSq: dx * dx + dz * dz,
      };
    });
  }

  /** Natural terrain before landmarks/paths are carved in. */
  private natural(x: number, z: number): number {
    let total = 0;
    let amp = 1;
    let freq = 0.0075;
    let norm = 0;
    for (let i = 0; i < 4; i++) {
      total += amp * this.hills(x * freq, z * freq);
      norm += amp;
      amp *= 0.5;
      freq *= 2.1;
    }
    const n = total / norm; // ~[-1, 1]
    // Soft redistribution: broad gentle lowlands, rounded hilltops.
    const shaped = Math.sign(n) * Math.pow(Math.abs(n), 1.25);
    return 2.4 + shaped * 9 + this.detail(x * 0.045, z * 0.045) * 0.5;
  }

  /** 0..1 how strongly a point belongs to a path, plus the path's target height. */
  pathInfo(x: number, z: number, out: { weight: number; height: number }): void {
    out.weight = 0;
    out.height = 0;
    for (const p of this.paths) {
      const t = Math.min(
        1,
        Math.max(0, ((x - p.ax) * (p.bx - p.ax) + (z - p.az) * (p.bz - p.az)) / p.lenSq),
      );
      const px = p.ax + (p.bx - p.ax) * t;
      const pz = p.az + (p.bz - p.az) * t;
      const d = Math.hypot(x - px, z - pz);
      const w = 1 - smoothstep(1.6, 5.5, d);
      if (w > out.weight) {
        out.weight = w;
        out.height = p.ah + (p.bh - p.ah) * smoothstep(0, 1, t);
      }
    }
  }

  private readonly pathTmp = { weight: 0, height: 0 };

  rawHeight(x: number, z: number): number {
    let h = this.natural(x, z);

    // Paths: a smooth, always-dry ramp between the plaza and each landmark.
    this.pathInfo(x, z, this.pathTmp);
    if (this.pathTmp.weight > 0) {
      const target = Math.max(this.pathTmp.height, WATER_LEVEL + 0.9);
      h += (target - h) * this.pathTmp.weight * 0.85;
    }

    // Landmarks: flatten to their authored height.
    for (const l of LANDMARKS) {
      const d = Math.hypot(x - l.x, z - l.z);
      const t = 1 - smoothstep(l.radius, l.radius + l.falloff, d);
      if (t > 0) {
        // Lantern hill gets a gentle dome on top instead of a table.
        const target = l.id === 'lanternHill' ? l.height - d * 0.06 : l.height;
        h += (target - h) * t;
      }
    }
    return h;
  }

  /** Height of the rendered (triangulated) surface at any point. */
  surfaceHeight(x: number, z: number): number {
    const gx = x / CELL_SIZE;
    const gz = z / CELL_SIZE;
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const x0 = ix * CELL_SIZE;
    const z0 = iz * CELL_SIZE;
    const x1 = x0 + CELL_SIZE;
    const z1 = z0 + CELL_SIZE;
    const ha = this.rawHeight(x0, z0);
    const hc = this.rawHeight(x1, z1);
    if (fx >= fz) {
      const hb = this.rawHeight(x1, z0);
      return ha + (hb - ha) * fx + (hc - hb) * fz;
    }
    const hd = this.rawHeight(x0, z1);
    return ha + (hd - ha) * fz + (hc - hd) * fx;
  }

  /** Which landmark (if any) owns this point, for UI and scatter exclusion. */
  landmarkAt(x: number, z: number, extra = 0): LandmarkDef | null {
    for (const l of LANDMARKS) {
      if (Math.hypot(x - l.x, z - l.z) < l.radius + extra) return l;
    }
    return null;
  }

  /** Flat low-poly face colour for a triangle centred at (x, z). */
  faceColor(x: number, z: number, h: number, slope: number, out: THREE.Color): THREE.Color {
    const tint = this.tint(x * 0.02, z * 0.02);
    if (h < WATER_LEVEL - 0.2) return out.setHex(PALETTE.underwater);
    if (h < WATER_LEVEL + 0.35) return out.setHex(PALETTE.sandWet);
    if (h < WATER_LEVEL + 0.9) return out.setHex(PALETTE.sand);

    this.pathInfo(x, z, this.pathTmp);
    if (this.pathTmp.weight > 0.55) return out.setHex(PALETTE.path);

    if (slope > 0.55) return out.setHex(PALETTE.slope);
    if (tint > 0.25) out.setHex(PALETTE.grassLight);
    else if (tint > -0.3) out.setHex(PALETTE.grassMid);
    else out.setHex(PALETTE.grassDeep);
    // Very subtle per-face variation keeps the facets readable.
    const jitter = (this.detail(x * 0.7, z * 0.7) * 0.5 + 0.5) * 0.06 - 0.03;
    this.tmpColor.copy(out).offsetHSL(0, 0, jitter);
    return out.copy(this.tmpColor);
  }
}
