import * as THREE from 'three';
import {
  DESKS,
  DESK_DEPTH,
  DESK_HEIGHT,
  DESK_LENGTH,
  DESK_SEATS,
  DESK_SEAT_HEIGHT,
  LIBRARY_EXIT,
  LIBRARY_ROOM,
  SHELVES,
  TESTIMONY_SHELVES,
  type ShelfCounts,
  type ShelfId,
} from '../../../shared/protocol';
import type { Ground } from '../entities/PlayerController';
import type { CircleCollider } from './ChunkManager';
import { PALETTE } from './config';
import { createLabelSprite, disposeSprite } from './labels';
import { mulberry32 } from './random';

const lam = (color: number, extra: THREE.MeshLambertMaterialParameters = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });

/** Books shown per shelf (4 boards x 18). More books than this still count; the shelf just looks full. */
export const SHELF_CAPACITY = 72;
const ROWS = 4;
const PER_ROW = SHELF_CAPACITY / ROWS;
const CASE_W = 2.4;
const CASE_H = 2.5;
const CASE_D = 0.5;
const SPINE_COLORS = [0x8c3b2e, 0x2f5d7e, 0x4f7f5a, 0xc9a03a, 0x7d4f9e, 0xa0503a, 0x3f4f6e, 0x9a6a3a, 0x5f8f6b, 0xb04050, 0xe0c890, 0x6e4a30];

/** What a tap or the action button can open inside the hall. */
export type LibrarySpot = { kind: 'shelf'; shelf: ShelfId } | { kind: 'today' } | { kind: 'write' } | { kind: 'exit' };

interface ShelfRig {
  id: ShelfId;
  group: THREE.Group;
  books: THREE.InstancedMesh;
  label: THREE.Sprite | null;
  /** Front centre (where you stand to browse). */
  front: THREE.Vector2;
  count: number;
}

/**
 * 이야기 도서관 hall: its own scene (like the 골방) but shared — the local
 * player and everyone else inside walk around in this local frame (floor
 * y = 0, door in the south wall). Seven bookcases (five testimony shelves on
 * the north wall, the 발자취 서가 on the west wall and the 오늘 꽂힌 책 table),
 * two reading tables with chairs (seat kind 'desk'), the 쓰는 책상, warm lamps
 * and windows that follow the time of day. Walls between the camera and the
 * player are hidden (cut-away), so the third-person camera never looks at a wall.
 */
export class LibraryInterior implements Ground {
  readonly scene = new THREE.Scene();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly colliders: CircleCollider[] = [];
  private readonly shelves = new Map<ShelfId, ShelfRig>();
  private readonly walls: { group: THREE.Group; hidden: (c: THREE.Vector3) => boolean }[] = [];
  private readonly windowPanes: THREE.MeshBasicMaterial;
  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly lamps: { light: THREE.PointLight; glow: THREE.MeshLambertMaterial; base: number }[] = [];
  private readonly todayBooks: THREE.InstancedMesh;
  private todayLabel: THREE.Sprite | null = null;
  private readonly writeDesk = new THREE.Vector2(6.6, 4.2);
  private readonly todaySpot = new THREE.Vector2(-5.8, 4.0);
  private readonly pickables: THREE.Object3D[] = [];
  counts: ShelfCounts | null = null;

  constructor() {
    const s = this.scene;
    s.background = new THREE.Color(0x2b2018);
    const { halfW: W, halfD: D } = LIBRARY_ROOM;
    const H = 4.2;

    // Floor: warm planks with a rug down the middle.
    this.mesh(new THREE.BoxGeometry(W * 2, 0.1, D * 2), lam(0xa8744c), 0, -0.05, 0);
    for (let x = -W + 0.6; x < W; x += 1.2) this.mesh(new THREE.BoxGeometry(0.02, 0.102, D * 2), lam(0x8a5a3b), x, -0.049, 0);
    this.mesh(new THREE.BoxGeometry(5.2, 0.02, 9), lam(0x9a4a3c), 0, 0.01, 0.6);
    this.mesh(new THREE.BoxGeometry(4.6, 0.022, 8.4), lam(0xc8945a), 0, 0.012, 0.6);

    // Walls (each its own group so it can be cut away).
    this.windowPanes = new THREE.MeshBasicMaterial({ color: 0xbfe0f0 });
    this.materials.push(this.windowPanes);
    const wallMat = lam(0xf1e6cc);
    const trim = lam(PALETTE.woodDark);
    const wall = (hidden: (c: THREE.Vector3) => boolean) => {
      const g = new THREE.Group();
      s.add(g);
      this.walls.push({ group: g, hidden });
      return g;
    };
    const north = wall((c) => c.z < -D + 0.2);
    this.mesh(new THREE.BoxGeometry(W * 2, H, 0.2), wallMat, 0, H / 2, -D, 0, north);
    const south = wall((c) => c.z > D - 0.2);
    for (const side of [-1, 1]) this.mesh(new THREE.BoxGeometry(W - 0.9, H, 0.2), wallMat, side * (W + 0.9) / 2, H / 2, D, 0, south);
    this.mesh(new THREE.BoxGeometry(1.8, H - 2.6, 0.2), wallMat, 0, 2.6 + (H - 2.6) / 2, D, 0, south);
    // Door (closed leaves, slightly ajar light) and a doormat.
    this.mesh(new THREE.BoxGeometry(1.6, 2.5, 0.08), lam(0x6b4a30), 0, 1.25, D - 0.02, 0, south);
    this.mesh(new THREE.BoxGeometry(0.06, 2.5, 0.1), trim, 0, 1.25, D - 0.06, 0, south);
    this.mesh(new THREE.SphereGeometry(0.06, 6, 4), lam(PALETTE.lantern), 0.25, 1.2, D - 0.1, 0, south);
    this.mesh(new THREE.BoxGeometry(1.6, 0.03, 0.8), lam(0x6f8a5b), 0, 0.02, D - 0.7);
    const west = wall((c) => c.x < -W + 0.2);
    this.mesh(new THREE.BoxGeometry(0.2, H, D * 2), wallMat, -W, H / 2, 0, 0, west);
    const east = wall((c) => c.x > W - 0.2);
    this.mesh(new THREE.BoxGeometry(0.2, H, D * 2), wallMat, W, H / 2, 0, 0, east);
    // Windows: east wall two, west wall one (south part), light follows the sky.
    const windowAt = (g: THREE.Group, x: number, z: number, alongZ: boolean) => {
      const w = alongZ ? [0.12, 1.7, 1.3] : [1.3, 1.7, 0.12];
      this.mesh(new THREE.BoxGeometry(w[0] + 0.04, w[1] + 0.2, w[2] + 0.2), trim, x, 2.3, z, 0, g);
      this.mesh(new THREE.BoxGeometry(alongZ ? 0.14 : w[0], w[1], alongZ ? w[2] : 0.14), this.windowPanes, x, 2.3, z, 0, g);
      this.mesh(new THREE.BoxGeometry(alongZ ? 0.16 : 0.06, w[1], alongZ ? 0.06 : 0.16), trim, x, 2.3, z, 0, g);
    };
    windowAt(east, W - 0.05, -3.2, true);
    windowAt(east, W - 0.05, 0.6, true);
    windowAt(west, -W + 0.05, 4.2, true);
    // Skirting and a top beam all round.
    for (const [g, x, z, alongZ] of [
      [north, 0, -D + 0.12, false],
      [west, -W + 0.12, 0, true],
      [east, W - 0.12, 0, true],
    ] as [THREE.Group, number, number, boolean][]) {
      this.mesh(new THREE.BoxGeometry(alongZ ? 0.06 : W * 2, 0.18, alongZ ? D * 2 : 0.06), trim, x, 0.09, z, 0, g);
      this.mesh(new THREE.BoxGeometry(alongZ ? 0.12 : W * 2, 0.2, alongZ ? D * 2 : 0.12), trim, x, H - 0.1, z, 0, g);
    }

    // Seven shelves: five testimony bookcases on the north wall, 발자취 서가 on the west wall.
    TESTIMONY_SHELVES.forEach((id, i) => this.bookcase(id, (i - 2) * 3.1, -D + 0.38, 0, north));
    this.bookcase('diary', -W + 0.38, -1.4, Math.PI / 2, west);
    // 오늘 꽂힌 책: a slanted display table by the entrance.
    this.todayBooks = this.todayTable();

    // Reading tables with chairs and a green lamp each.
    for (const d of DESKS) this.readingTable(d.x, d.z);
    for (const seat of DESK_SEATS) this.chair(seat.x, seat.z, seat.yaw);

    // ✍️ 쓰는 책상: paper, a quill and a candle.
    this.writingDesk();

    // Plants in the corners.
    for (const [x, z] of [[-W + 0.7, D - 0.7], [W - 0.7, D - 0.7], [W - 0.7, -D + 1.2]]) {
      this.mesh(new THREE.CylinderGeometry(0.26, 0.2, 0.42, 7), lam(0xb06a4a), x, 0.21, z);
      this.mesh(new THREE.IcosahedronGeometry(0.45, 0), lam(PALETTE.leaf), x, 0.75, z);
      this.colliders.push({ x, z, r: 0.35 });
    }

    // Light: sky through the windows, warm pendant lamps.
    this.hemi = new THREE.HemisphereLight(0xfff4e0, 0x7a5a40, 1.15);
    this.sun = new THREE.DirectionalLight(0xfff0d6, 0.7);
    this.sun.position.set(8, 6, -2);
    s.add(this.hemi, this.sun);
    for (const [x, z] of [[-3.2, 0.6], [3.2, 0.6], [0, -4.2], [-6.4, -3.4], [6.4, -3.4]]) this.pendant(x, z, H);
  }

  // ------------------------------------------------------------------ building blocks

  private mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, ry = 0, parent: THREE.Object3D = this.scene): THREE.Mesh {
    this.geometries.push(geo);
    if (!this.materials.includes(mat)) this.materials.push(mat);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    parent.add(m);
    return m;
  }

  private bookcase(id: ShelfId, x: number, z: number, yaw: number, parent: THREE.Group) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = yaw;
    g.userData.spot = { kind: 'shelf', shelf: id } satisfies LibrarySpot;
    const wood = lam(0x7b5236);
    const board = lam(0x9a6a40);
    this.mesh(new THREE.BoxGeometry(CASE_W, CASE_H, 0.06), wood, 0, CASE_H / 2, -CASE_D / 2 + 0.03, 0, g);
    for (const sx of [-1, 1]) this.mesh(new THREE.BoxGeometry(0.08, CASE_H, CASE_D), wood, (sx * (CASE_W - 0.08)) / 2, CASE_H / 2, 0, 0, g);
    this.mesh(new THREE.BoxGeometry(CASE_W + 0.12, 0.1, CASE_D + 0.06), wood, 0, CASE_H + 0.05, 0, 0, g);
    for (let r = 0; r <= ROWS; r++) this.mesh(new THREE.BoxGeometry(CASE_W - 0.1, 0.05, CASE_D - 0.04), board, 0, 0.12 + r * 0.58, 0, 0, g);
    // A small coloured plaque per shelf.
    const plaque = [0x8bbf4a, 0xc9a03a, 0x5f7fa6, 0xd9a3a3, 0xf2c94c, 0xa0503a][[...TESTIMONY_SHELVES, 'diary'].indexOf(id)] ?? 0xc9a03a;
    this.mesh(new THREE.BoxGeometry(0.7, 0.16, 0.03), lam(plaque), 0, CASE_H + 0.2, CASE_D / 2 - 0.05, 0, g);
    // Instanced spines, filled in setCounts().
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const mat = lam(0xffffff);
    const books = new THREE.InstancedMesh(geo, mat, SHELF_CAPACITY);
    this.geometries.push(geo);
    this.materials.push(mat);
    books.count = 0;
    books.name = `books-${id}`;
    g.add(books);
    parent.add(g);
    this.pickables.push(g);
    // Stand-in-front spot and colliders along the case.
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    for (const t of [-0.9, -0.3, 0.3, 0.9]) this.colliders.push({ x: x + rx * t, z: z + rz * t, r: 0.36 });
    this.shelves.set(id, { id, group: g, books, label: null, front: new THREE.Vector2(x + fx * 1.2, z + fz * 1.2), count: 0 });
  }

  private todayTable(): THREE.InstancedMesh {
    const { x, y: z } = this.todaySpot;
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = Math.PI * 0.75;
    g.userData.spot = { kind: 'today' } satisfies LibrarySpot;
    const wood = lam(0x8a5a3b);
    for (const [lx, lz] of [[-0.7, -0.35], [0.7, -0.35], [-0.7, 0.35], [0.7, 0.35]]) this.mesh(new THREE.BoxGeometry(0.08, 0.8, 0.08), wood, lx, 0.4, lz, 0, g);
    const top = this.mesh(new THREE.BoxGeometry(1.7, 0.08, 0.95), lam(0xa8744c), 0, 0.85, 0, 0, g);
    top.rotation.x = 0.22;
    const geo = new THREE.BoxGeometry(0.26, 0.04, 0.34);
    const mat = lam(0xffffff);
    this.geometries.push(geo);
    this.materials.push(mat);
    const books = new THREE.InstancedMesh(geo, mat, 6);
    books.count = 0;
    books.name = 'books-today';
    g.add(books);
    this.scene.add(g);
    this.pickables.push(g);
    this.colliders.push({ x, z, r: 0.75 });
    return books;
  }

  private readingTable(x: number, z: number) {
    const wood = lam(0x8a5a3b);
    this.mesh(new THREE.BoxGeometry(DESK_LENGTH, 0.08, DESK_DEPTH), lam(0xa8744c), x, DESK_HEIGHT, z);
    for (const [dx, dz] of [[-1.05, -0.4], [1.05, -0.4], [-1.05, 0.4], [1.05, 0.4]]) this.mesh(new THREE.BoxGeometry(0.08, DESK_HEIGHT, 0.08), wood, x + dx, DESK_HEIGHT / 2, z + dz);
    // Green reading lamp and a couple of books on the table.
    this.mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.04, 8), lam(0xc9a03a), x, DESK_HEIGHT + 0.06, z);
    this.mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.32, 5), lam(0xc9a03a), x, DESK_HEIGHT + 0.22, z);
    const glow = lam(0x3f8f5a, { emissive: 0x2f6f40, emissiveIntensity: 0.4 });
    this.mesh(new THREE.CylinderGeometry(0.05, 0.16, 0.12, 8), glow, x, DESK_HEIGHT + 0.4, z);
    const light = new THREE.PointLight(0xffd59a, 0.8, 4.5, 1.6);
    light.position.set(x, DESK_HEIGHT + 0.35, z);
    this.scene.add(light);
    this.lamps.push({ light, glow, base: 0.8 });
    this.mesh(new THREE.BoxGeometry(0.3, 0.06, 0.22), lam(0x2f5d7e), x - 0.7, DESK_HEIGHT + 0.07, z + 0.1, 0.3);
    this.mesh(new THREE.BoxGeometry(0.28, 0.05, 0.2), lam(0x8c3b2e), x + 0.75, DESK_HEIGHT + 0.07, z - 0.12, -0.2);
    for (const dx of [-0.6, 0, 0.6]) this.colliders.push({ x: x + dx, z, r: 0.5 });
  }

  private chair(x: number, z: number, yaw: number) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = yaw;
    const wood = lam(0x7b5236);
    this.mesh(new THREE.BoxGeometry(0.46, 0.05, 0.44), lam(0x9a6a40), 0, DESK_SEAT_HEIGHT - 0.03, -0.02, 0, g);
    for (const [lx, lz] of [[-0.19, -0.19], [0.19, -0.19], [-0.19, 0.17], [0.19, 0.17]]) this.mesh(new THREE.BoxGeometry(0.05, DESK_SEAT_HEIGHT, 0.05), wood, lx, DESK_SEAT_HEIGHT / 2, lz, 0, g);
    // Backrest on the side away from the table.
    this.mesh(new THREE.BoxGeometry(0.46, 0.5, 0.05), wood, 0, DESK_SEAT_HEIGHT + 0.27, -0.24, 0, g);
    this.scene.add(g);
  }

  private writingDesk() {
    const { x, y: z } = this.writeDesk;
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = -Math.PI / 2;
    g.userData.spot = { kind: 'write' } satisfies LibrarySpot;
    const wood = lam(0x6b4a30);
    this.mesh(new THREE.BoxGeometry(1.5, 0.08, 0.8), lam(0x8a5a3b), 0, 0.8, 0, 0, g);
    for (const sx of [-0.65, 0.65]) this.mesh(new THREE.BoxGeometry(0.1, 0.8, 0.7), wood, sx, 0.4, 0, 0, g);
    this.mesh(new THREE.BoxGeometry(0.42, 0.01, 0.3), lam(0xfbf3e0), -0.15, 0.85, 0.05, 0.1, g);
    this.mesh(new THREE.BoxGeometry(0.42, 0.01, 0.3), lam(0xf4ead5), -0.1, 0.852, 0.02, -0.15, g);
    const quill = this.mesh(new THREE.ConeGeometry(0.025, 0.36, 5), lam(0xf7f1e3), 0.25, 0.98, 0.0, 0, g);
    quill.rotation.z = -0.7;
    this.mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.08, 8), lam(0x1f1a1c), 0.4, 0.88, -0.15, 0, g);
    this.mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.16, 8), lam(PALETTE.cream), -0.55, 0.92, -0.2, 0, g);
    const flame = lam(0xffc46b, { emissive: 0xffa040, emissiveIntensity: 1 });
    this.mesh(new THREE.ConeGeometry(0.03, 0.07, 6), flame, -0.55, 1.04, -0.2, 0, g);
    const light = new THREE.PointLight(0xffb060, 0.9, 4, 1.6);
    light.position.set(x - 0.2, 1.2, z + 0.55);
    this.scene.add(light);
    this.lamps.push({ light, glow: flame, base: 0.9 });
    // A stool.
    this.mesh(new THREE.CylinderGeometry(0.22, 0.2, 0.46, 8), lam(0x9a6a40), -0.0, 0.23, 0.75, 0, g);
    this.scene.add(g);
    this.pickables.push(g);
    this.colliders.push({ x, z, r: 0.75 });
  }

  private pendant(x: number, z: number, h: number) {
    this.mesh(new THREE.CylinderGeometry(0.01, 0.01, 1.2, 4), lam(0x3a3a44), x, h - 0.6, z);
    const glow = lam(0xffe2a8, { emissive: 0xffc46b, emissiveIntensity: 0.6 });
    this.mesh(new THREE.ConeGeometry(0.32, 0.26, 10, 1, true), lam(0x5f4a3a, { side: THREE.DoubleSide }), x, h - 1.25, z);
    this.mesh(new THREE.SphereGeometry(0.11, 8, 6), glow, x, h - 1.32, z);
    const light = new THREE.PointLight(0xffc98a, 1.2, 9, 1.4);
    light.position.set(x, h - 1.45, z);
    this.scene.add(light);
    this.lamps.push({ light, glow, base: 1.2 });
  }

  // ------------------------------------------------------------------ Ground

  groundHeight(x: number, z: number): number {
    const { halfW, halfD } = LIBRARY_ROOM;
    return Math.abs(x) < halfW - 0.35 && Math.abs(z) < halfD - 0.35 ? 0 : -10;
  }

  collidersNear(): CircleCollider[] {
    return this.colliders;
  }

  // ------------------------------------------------------------------ books

  /** One spine per visible story (capped at SHELF_CAPACITY), stable per shelf. */
  setCounts(counts: ShelfCounts) {
    this.counts = counts;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const color = new THREE.Color();
    for (const rig of this.shelves.values()) {
      const n = Math.max(0, Math.min(SHELF_CAPACITY, counts[rig.id] ?? 0));
      const rand = mulberry32(0x5eed + rig.id.length * 977 + rig.id.charCodeAt(0));
      let col = 0;
      let x = -CASE_W / 2 + 0.1;
      let row = 0;
      for (let i = 0; i < n; i++) {
        const w = 0.07 + rand() * 0.045;
        const h = 0.3 + rand() * 0.16;
        if (col >= PER_ROW || x + w > CASE_W / 2 - 0.1) {
          row++;
          col = 0;
          x = -CASE_W / 2 + 0.1;
        }
        const lean = col === 0 && rand() < 0.3 ? 0.12 : 0;
        q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -lean);
        pos.set(x + w / 2, 0.145 + row * 0.58, 0.02);
        scl.set(w, h, 0.32 + rand() * 0.06);
        m.compose(pos, q, scl);
        rig.books.setMatrixAt(i, m);
        rig.books.setColorAt(i, color.setHex(SPINE_COLORS[Math.floor(rand() * SPINE_COLORS.length)]));
        x += w + 0.008;
        col++;
      }
      rig.books.count = n;
      rig.books.instanceMatrix.needsUpdate = true;
      if (rig.books.instanceColor) rig.books.instanceColor.needsUpdate = true;
      rig.books.computeBoundingSphere();
      if (rig.label && rig.count === n) continue;
      rig.count = n;
      if (rig.label) {
        rig.label.removeFromParent();
        disposeSprite(rig.label);
      }
      const total = counts[rig.id] ?? 0;
      rig.label = createLabelSprite(SHELVES[rig.id].name, total ? `${total}권` : '아직 비어 있어요');
      rig.label.scale.multiplyScalar(0.3);
      rig.label.position.set(0, CASE_H + 0.5, 0.1);
      rig.group.add(rig.label);
    }
    const t = Math.max(0, Math.min(6, counts.today ?? 0));
    for (let i = 0; i < t; i++) {
      pos.set(-0.55 + (i % 3) * 0.55, 0.92 + Math.floor(i / 3) * 0.02, -0.2 + Math.floor(i / 3) * 0.4);
      q.setFromEuler(new THREE.Euler(0.22, (i * 0.37) % 0.4, 0));
      scl.set(1, 1, 1);
      m.compose(pos, q, scl);
      this.todayBooks.setMatrixAt(i, m);
      this.todayBooks.setColorAt(i, color.setHex(SPINE_COLORS[(i * 5) % SPINE_COLORS.length]));
    }
    this.todayBooks.count = t;
    this.todayBooks.instanceMatrix.needsUpdate = true;
    if (this.todayBooks.instanceColor) this.todayBooks.instanceColor.needsUpdate = true;
    this.todayBooks.computeBoundingSphere();
    if (!this.todayLabel) {
      this.todayLabel = createLabelSprite('오늘 꽂힌 책', '새로 꽂힌 이야기');
      this.todayLabel.scale.multiplyScalar(0.3);
      this.todayLabel.position.set(this.todaySpot.x, 1.9, this.todaySpot.y);
      this.scene.add(this.todayLabel);
      const w = createLabelSprite('쓰는 책상', '이야기와 일기 쓰기');
      w.scale.multiplyScalar(0.3);
      w.position.set(this.writeDesk.x, 1.9, this.writeDesk.y);
      this.scene.add(w);
    }
  }

  /** Spines drawn per shelf (tests). */
  get bookCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.shelves.values()) out[r.id] = r.books.count;
    out.today = this.todayBooks.count;
    return out;
  }

  // ------------------------------------------------------------------ interaction

  /** What is under a screen ray (a bookcase, the today table, the writing desk). */
  pick(raycaster: THREE.Raycaster): LibrarySpot | null {
    for (const hit of raycaster.intersectObjects(this.pickables, true)) {
      let o: THREE.Object3D | null = hit.object;
      while (o && !o.userData.spot) o = o.parent;
      if (o && this.visibleInScene(o)) return o.userData.spot as LibrarySpot;
    }
    return null;
  }

  private visibleInScene(o: THREE.Object3D): boolean {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
    return true;
  }

  /** The spot whose stand-in-front point is within reach of (x, z), if any. */
  near(x: number, z: number): LibrarySpot | null {
    if (Math.hypot(x - LIBRARY_EXIT.x, z - LIBRARY_EXIT.z) < LIBRARY_EXIT.reach) return { kind: 'exit' };
    if (Math.hypot(x - this.writeDesk.x, z - this.writeDesk.y) < 1.9) return { kind: 'write' };
    if (Math.hypot(x - this.todaySpot.x, z - this.todaySpot.y) < 1.9) return { kind: 'today' };
    let best: LibrarySpot | null = null;
    let bestD = 1.6;
    for (const r of this.shelves.values()) {
      const d = Math.hypot(x - r.front.x, z - r.front.y);
      if (d < bestD) {
        bestD = d;
        best = { kind: 'shelf', shelf: r.id };
      }
    }
    return best;
  }

  /** Where to stand to browse a shelf (tests, screenshots). */
  shelfFront(id: ShelfId): { x: number; z: number } | null {
    const r = this.shelves.get(id);
    return r ? { x: r.front.x, z: r.front.y } : null;
  }

  spots() {
    return { write: { x: this.writeDesk.x, z: this.writeDesk.y }, today: { x: this.todaySpot.x, z: this.todaySpot.y }, exit: { ...LIBRARY_EXIT } };
  }

  /** Hide the walls between the camera and the room; light follows the time of day. */
  update(camera: THREE.Camera, elapsed: number, night: number) {
    for (const w of this.walls) w.group.visible = !w.hidden(camera.position);
    this.windowPanes.color.setHex(night > 0.5 ? 0x1c2747 : night > 0.2 ? 0xf0b878 : 0xbfe0f0);
    this.sun.intensity = 0.85 * (1 - night) + 0.05;
    this.hemi.intensity = 1.2 - night * 0.5;
    const f = 1 + Math.sin(elapsed * 9.1) * 0.04;
    for (const l of this.lamps) {
      l.light.intensity = l.base * (0.75 + night * 0.9) * f;
      l.glow.emissiveIntensity = 0.4 + night * 0.9;
    }
  }

  dispose() {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const r of this.shelves.values()) if (r.label) disposeSprite(r.label);
  }
}
