import * as THREE from 'three';
import { LANDMARKS } from './config';
import type { Heightfield } from './Heightfield';

const DURATION = 10;

/**
 * After the guide: soft lights drift along the paths from the plaza to each
 * landmark for ~10 s, then fade away. One Points object, one draw call.
 */
export class PathGlow {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly params: Float32Array;
  private readonly base: Float32Array;
  private t = 0;

  constructor(field: Heightfield) {
    const pos: number[] = [];
    const par: number[] = [];
    const plaza = LANDMARKS[0];
    for (const l of LANDMARKS.slice(1)) {
      const len = Math.hypot(l.x - plaza.x, l.z - plaza.z);
      const n = Math.floor(len / 2.5);
      for (let i = 2; i <= n; i++) {
        const k = i / n;
        const x = plaza.x + (l.x - plaza.x) * k;
        const z = plaza.z + (l.z - plaza.z) * k;
        pos.push(x, field.surfaceHeight(x, z) + 0.5, z);
        par.push(k);
      }
    }
    this.base = new Float32Array(pos);
    this.params = new Float32Array(par);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,240,200,1)');
    grad.addColorStop(1, 'rgba(255,200,120,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    const tex = new THREE.CanvasTexture(c);
    this.points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ size: 0.9, map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffd38a }),
    );
    this.points.frustumCulled = false;
  }

  /** Returns false once finished (caller removes it). */
  update(dt: number): boolean {
    this.t += dt;
    const pos = this.points.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < this.params.length; i++) {
      pos[i * 3 + 1] = this.base[i * 3 + 1] + Math.sin(this.t * 2.2 - this.params[i] * 12) * 0.18;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    const fadeIn = Math.min(1, this.t / 0.8);
    const fadeOut = Math.min(1, (DURATION - this.t) / 2);
    this.points.material.opacity = Math.max(0, Math.min(fadeIn, fadeOut)) * 0.9;
    return this.t < DURATION;
  }

  dispose() {
    this.points.removeFromParent();
    this.points.geometry.dispose();
    this.points.material.map?.dispose();
    this.points.material.dispose();
  }
}
