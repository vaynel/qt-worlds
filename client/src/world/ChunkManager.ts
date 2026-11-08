import * as THREE from 'three';
import { CELL_SIZE, CHUNK_CELLS, CHUNK_SIZE, PALETTE, VIEW_RADIUS, WATER_LEVEL } from './config';
import type { Heightfield } from './Heightfield';
import { hashCoords, mulberry32 } from './random';

export interface CircleCollider {
  x: number;
  z: number;
  r: number;
}

interface Chunk {
  key: string;
  cx: number;
  cz: number;
  group: THREE.Group;
  colliders: CircleCollider[];
}

/** Shared, never-disposed geometry and materials for scattered props. */
class PropKit {
  readonly terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  readonly trunkGeo = new THREE.CylinderGeometry(0.12, 0.2, 1, 5).translate(0, 0.5, 0);
  readonly pineGeo: THREE.BufferGeometry;
  readonly roundGeo = new THREE.IcosahedronGeometry(1, 0);
  readonly rockGeo = new THREE.DodecahedronGeometry(1, 0);
  readonly bushGeo = new THREE.IcosahedronGeometry(1, 0).scale(1, 0.7, 1);
  readonly trunkMat = new THREE.MeshLambertMaterial({ color: PALETTE.trunk, flatShading: true });
  readonly foliageMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  readonly rockMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });

  constructor() {
    // Two stacked cones, merged by hand so a pine is one instanced draw.
    const lower = new THREE.ConeGeometry(1, 1.6, 6).translate(0, 0.8, 0).toNonIndexed();
    const upper = new THREE.ConeGeometry(0.7, 1.3, 6).translate(0, 1.75, 0).toNonIndexed();
    const pos = new Float32Array(lower.attributes.position.count * 3 + upper.attributes.position.count * 3);
    pos.set(lower.attributes.position.array as Float32Array, 0);
    pos.set(upper.attributes.position.array as Float32Array, lower.attributes.position.count * 3);
    this.pineGeo = new THREE.BufferGeometry();
    this.pineGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.pineGeo.computeVertexNormals();
    lower.dispose();
    upper.dispose();
  }
}

interface ScatterItem {
  kind: 'pine' | 'round' | 'rock' | 'bush';
  x: number;
  y: number;
  z: number;
  scale: number;
  rot: number;
  color: THREE.Color;
}

/**
 * Streams terrain chunks around the player. Each chunk is generated purely
 * from (seed, cx, cz) so the world is identical every time and on every client.
 */
export class ChunkManager {
  readonly root = new THREE.Group();
  private readonly chunks = new Map<string, Chunk>();
  private readonly queue: { cx: number; cz: number; d: number }[] = [];
  private readonly kit = new PropKit();
  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();
  private centerKey = '';

  constructor(
    private readonly field: Heightfield,
    private readonly seed: number,
    private readonly shadows: boolean,
  ) {
    this.root.name = 'terrain-chunks';
  }

  get loadedCount(): number {
    return this.chunks.size;
  }

  /** Build every chunk in view immediately (used once at startup). */
  primeAround(x: number, z: number): void {
    this.update(x, z, Infinity);
  }

  update(x: number, z: number, budget = 2): void {
    const pcx = Math.floor(x / CHUNK_SIZE);
    const pcz = Math.floor(z / CHUNK_SIZE);
    const key = `${pcx},${pcz}`;

    if (key !== this.centerKey) {
      this.centerKey = key;
      this.queue.length = 0;
      const r2 = (VIEW_RADIUS + 0.5) ** 2;
      for (let dz = -VIEW_RADIUS; dz <= VIEW_RADIUS; dz++) {
        for (let dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
          const d = dx * dx + dz * dz;
          if (d > r2) continue;
          if (!this.chunks.has(`${pcx + dx},${pcz + dz}`)) {
            this.queue.push({ cx: pcx + dx, cz: pcz + dz, d });
          }
        }
      }
      this.queue.sort((a, b) => b.d - a.d); // pop() takes the nearest

      const drop2 = (VIEW_RADIUS + 1.5) ** 2;
      for (const chunk of this.chunks.values()) {
        const ddx = chunk.cx - pcx;
        const ddz = chunk.cz - pcz;
        if (ddx * ddx + ddz * ddz > drop2) this.unload(chunk);
      }
    }

    let built = 0;
    while (this.queue.length > 0 && built < budget) {
      const next = this.queue.pop()!;
      const k = `${next.cx},${next.cz}`;
      if (!this.chunks.has(k)) {
        this.build(next.cx, next.cz);
        built++;
      }
    }
  }

  /** Colliders in the chunk containing (x, z) and its 8 neighbours. */
  collidersNear(x: number, z: number, out: CircleCollider[]): CircleCollider[] {
    out.length = 0;
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const chunk = this.chunks.get(`${cx + dx},${cz + dz}`);
        if (chunk) for (const c of chunk.colliders) out.push(c);
      }
    }
    return out;
  }

  private build(cx: number, cz: number): void {
    const group = new THREE.Group();
    group.name = `chunk ${cx},${cz}`;
    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;

    group.add(this.buildTerrain(ox, oz));

    const colliders: CircleCollider[] = [];
    const items = this.scatter(cx, cz, ox, oz, colliders);
    this.buildInstances(group, items);

    this.root.add(group);
    this.chunks.set(`${cx},${cz}`, { key: `${cx},${cz}`, cx, cz, group, colliders });
  }

  private buildTerrain(ox: number, oz: number): THREE.Mesh {
    const n = CHUNK_CELLS + 1;
    const heights = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        heights[j * n + i] = this.field.rawHeight(ox + i * CELL_SIZE, oz + j * CELL_SIZE);
      }
    }

    const triCount = CHUNK_CELLS * CHUNK_CELLS * 2;
    const positions = new Float32Array(triCount * 9);
    const colors = new Float32Array(triCount * 9);
    let p = 0;

    const pushTri = (
      ax: number, az: number, ah: number,
      bx: number, bz: number, bh: number,
      cx: number, cz: number, ch: number,
    ) => {
      positions.set([ax, ah, az, bx, bh, bz, cx, ch, cz], p);
      const mx = (ax + bx + cx) / 3;
      const mz = (az + bz + cz) / 3;
      const mh = (ah + bh + ch) / 3;
      const slope = (Math.max(ah, bh, ch) - Math.min(ah, bh, ch)) / CELL_SIZE;
      this.field.faceColor(ox + mx, oz + mz, mh, slope, this.color);
      for (let k = 0; k < 3; k++) colors.set([this.color.r, this.color.g, this.color.b], p + k * 3);
      p += 9;
    };

    for (let j = 0; j < CHUNK_CELLS; j++) {
      for (let i = 0; i < CHUNK_CELLS; i++) {
        const x0 = i * CELL_SIZE;
        const z0 = j * CELL_SIZE;
        const x1 = x0 + CELL_SIZE;
        const z1 = z0 + CELL_SIZE;
        const ha = heights[j * n + i];
        const hb = heights[j * n + i + 1];
        const hc = heights[(j + 1) * n + i + 1];
        const hd = heights[(j + 1) * n + i];
        // Must match Heightfield.surfaceHeight(): triangles (a,c,b) and (a,d,c).
        pushTri(x0, z0, ha, x1, z1, hc, x1, z0, hb);
        pushTri(x0, z0, ha, x0, z1, hd, x1, z1, hc);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, this.kit.terrainMat);
    mesh.position.set(ox, 0, oz);
    mesh.receiveShadow = this.shadows;
    mesh.name = 'terrain';
    return mesh;
  }

  private scatter(cx: number, cz: number, ox: number, oz: number, colliders: CircleCollider[]): ScatterItem[] {
    const rng = mulberry32(hashCoords(this.seed, cx, cz));
    const items: ScatterItem[] = [];
    const cells = 8;
    const step = CHUNK_SIZE / cells;
    const pathTmp = { weight: 0, height: 0 };

    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        // Always draw the same number of values per cell so one rejected
        // candidate never shifts the rest of the chunk's layout.
        const rx = rng();
        const rz = rng();
        const roll = rng();
        const kindRoll = rng();
        const scaleRoll = rng();
        const rotRoll = rng();
        const hueRoll = rng();

        const x = ox + (i + 0.15 + rx * 0.7) * step;
        const z = oz + (j + 0.15 + rz * 0.7) * step;
        const forest = this.field.forest(x * 0.012, z * 0.012); // -1..1
        const density = 0.04 + Math.max(0, forest) * 0.55;
        if (roll > density + 0.06) continue;

        if (this.field.landmarkAt(x, z, 8)) continue;
        this.field.pathInfo(x, z, pathTmp);
        if (pathTmp.weight > 0.02) continue;

        const y = this.field.surfaceHeight(x, z);
        if (y < WATER_LEVEL + 0.8) continue;

        let kind: ScatterItem['kind'];
        if (roll > density) kind = kindRoll < 0.5 ? 'rock' : 'bush';
        else kind = forest > 0.25 && kindRoll < 0.7 ? 'pine' : kindRoll < 0.85 ? 'round' : 'bush';

        const scale = 0.8 + scaleRoll * 0.7;
        const color = new THREE.Color();
        switch (kind) {
          case 'pine':
            color.setHex(PALETTE.pine).offsetHSL((hueRoll - 0.5) * 0.04, 0, (hueRoll - 0.5) * 0.08);
            colliders.push({ x, z, r: 0.35 * scale });
            break;
          case 'round':
            color.setHex(hueRoll > 0.82 ? PALETTE.leafWarm : PALETTE.leaf).offsetHSL(0, 0, (hueRoll - 0.5) * 0.08);
            colliders.push({ x, z, r: 0.35 * scale });
            break;
          case 'rock':
            color.setHex(PALETTE.rock).offsetHSL(0, 0, (hueRoll - 0.5) * 0.1);
            colliders.push({ x, z, r: 0.55 * scale });
            break;
          case 'bush':
            color.setHex(PALETTE.grassDeep).offsetHSL(0, 0.05, (hueRoll - 0.5) * 0.08);
            break;
        }
        items.push({ kind, x, y, z, scale, rot: rotRoll * Math.PI * 2, color });
      }
    }
    return items;
  }

  private buildInstances(group: THREE.Group, items: ScatterItem[]): void {
    const kit = this.kit;
    const trees = items.filter((t) => t.kind === 'pine' || t.kind === 'round');
    const pines = items.filter((t) => t.kind === 'pine');
    const rounds = items.filter((t) => t.kind === 'round');
    const rocks = items.filter((t) => t.kind === 'rock');
    const bushes = items.filter((t) => t.kind === 'bush');
    const d = this.dummy;

    const make = (
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      list: ScatterItem[],
      place: (item: ScatterItem) => void,
      tinted: boolean,
      castShadow: boolean,
    ) => {
      if (list.length === 0) return;
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((item, idx) => {
        place(item);
        d.updateMatrix();
        mesh.setMatrixAt(idx, d.matrix);
        if (tinted) mesh.setColorAt(idx, item.color);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = castShadow && this.shadows;
      mesh.receiveShadow = false;
      group.add(mesh);
    };

    make(kit.trunkGeo, kit.trunkMat, trees, (t) => {
      d.position.set(t.x, t.y - 0.1, t.z);
      d.rotation.set(0, t.rot, 0);
      const h = t.kind === 'pine' ? 1.1 : 1.6;
      d.scale.set(t.scale, h * t.scale, t.scale);
    }, false, true);

    make(kit.pineGeo, kit.foliageMat, pines, (t) => {
      d.position.set(t.x, t.y + 0.9 * t.scale, t.z);
      d.rotation.set(0, t.rot, 0);
      d.scale.setScalar(1.25 * t.scale);
    }, true, true);

    make(kit.roundGeo, kit.foliageMat, rounds, (t) => {
      d.position.set(t.x, t.y + 2.1 * t.scale, t.z);
      d.rotation.set(t.rot, t.rot * 0.5, 0);
      d.scale.set(1.15 * t.scale, 1.0 * t.scale, 1.15 * t.scale);
    }, true, true);

    make(kit.rockGeo, kit.rockMat, rocks, (t) => {
      d.position.set(t.x, t.y + 0.1 * t.scale, t.z);
      d.rotation.set(t.rot, t.rot * 1.7, t.rot * 0.3);
      d.scale.set(0.7 * t.scale, 0.45 * t.scale, 0.6 * t.scale);
    }, true, true);

    make(kit.bushGeo, kit.foliageMat, bushes, (t) => {
      d.position.set(t.x, t.y + 0.2 * t.scale, t.z);
      d.rotation.set(0, t.rot, 0);
      d.scale.setScalar(0.55 * t.scale);
    }, true, false);
  }

  private unload(chunk: Chunk): void {
    chunk.group.traverse((obj) => {
      if (obj instanceof THREE.InstancedMesh) obj.dispose();
      else if (obj instanceof THREE.Mesh && obj.name === 'terrain') obj.geometry.dispose();
    });
    this.root.remove(chunk.group);
    this.chunks.delete(chunk.key);
  }

  dispose(): void {
    for (const chunk of [...this.chunks.values()]) this.unload(chunk);
  }
}
