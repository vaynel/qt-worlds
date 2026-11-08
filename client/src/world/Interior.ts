import * as THREE from 'three';
import { Avatar } from '../entities/Avatar';
import { PALETTE } from './config';

const lam = (color: number, extra: THREE.MeshLambertMaterialParameters = {}) =>
  new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });

/**
 * 골방: a small private room rendered as its own scene, so nobody else is in
 * it. The player sits on a cushion facing a small wall screen (the worship
 * panel is the DOM overlay); a candle and the window follow the time of day.
 */
export class Interior {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.05, 60);
  readonly avatar = new Avatar();
  private readonly candle: THREE.PointLight;
  private readonly flame: THREE.Mesh;
  private readonly windowPane: THREE.MeshBasicMaterial;
  private readonly sunLight: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private yaw = 0;
  private pitch = 0.32;
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor() {
    const s = this.scene;
    s.background = new THREE.Color(0x2a1f18);
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, ry = 0) => {
      this.geometries.push(geo);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      s.add(m);
      return m;
    };

    // Room 6 x 3 x 6, screen wall at -z.
    add(new THREE.BoxGeometry(6, 0.1, 6), lam(0xb88a5c), 0, -0.05, 0);
    for (let i = -2; i < 3; i++) add(new THREE.BoxGeometry(0.02, 0.101, 6), lam(0x9a6f48), i * 1.2 + 0.6, -0.049, 0);
    add(new THREE.BoxGeometry(6, 3.2, 0.1), lam(PALETTE.cream), 0, 1.6, -3);
    add(new THREE.BoxGeometry(6, 3.2, 0.1), lam(PALETTE.cream), 0, 1.6, 3);
    add(new THREE.BoxGeometry(0.1, 3.2, 6), lam(0xefe2c8), -3, 1.6, 0);
    add(new THREE.BoxGeometry(0.1, 3.2, 6), lam(0xefe2c8), 3, 1.6, 0);
    add(new THREE.BoxGeometry(6, 0.1, 6), lam(0xd9c4a0), 0, 3.2, 0);
    add(new THREE.BoxGeometry(6, 0.18, 0.12), lam(PALETTE.woodDark), 0, 0.09, -2.94);

    // Window on the right wall: colour follows day/night.
    this.windowPane = new THREE.MeshBasicMaterial({ color: 0xbfe0f0 });
    add(new THREE.BoxGeometry(0.06, 1.1, 1.4), lam(PALETTE.woodDark), 2.95, 1.75, -0.6);
    add(new THREE.BoxGeometry(0.04, 0.95, 1.25), this.windowPane, 2.93, 1.75, -0.6);
    add(new THREE.BoxGeometry(0.05, 0.95, 0.05), lam(PALETTE.woodDark), 2.92, 1.75, -0.6);

    // Wall screen (the actual video lives in the DOM panel).
    add(new THREE.BoxGeometry(2.3, 1.4, 0.08), lam(0x3b2c22), 0, 1.75, -2.93);
    add(new THREE.BoxGeometry(2.1, 1.2, 0.02), new THREE.MeshBasicMaterial({ color: 0x1f2a33 }), 0, 1.75, -2.88);

    // Low table with candle and an open Bible.
    add(new THREE.BoxGeometry(1.2, 0.08, 0.6), lam(PALETTE.wood), 0, 0.42, -1.2);
    for (const [x, z] of [[-0.5, -1.4], [0.5, -1.4], [-0.5, -1.0], [0.5, -1.0]]) {
      add(new THREE.BoxGeometry(0.06, 0.4, 0.06), lam(PALETTE.woodDark), x, 0.2, z);
    }
    add(new THREE.BoxGeometry(0.5, 0.04, 0.34), lam(0x6b2f2a), -0.15, 0.48, -1.2, 0.1);
    add(new THREE.BoxGeometry(0.46, 0.02, 0.3), lam(0xfbf3e0), -0.15, 0.51, -1.2, 0.1);
    add(new THREE.CylinderGeometry(0.05, 0.06, 0.2, 8), lam(PALETTE.cream), 0.35, 0.56, -1.2);
    this.flame = add(new THREE.ConeGeometry(0.035, 0.09, 6), new THREE.MeshBasicMaterial({ color: 0xffc46b }), 0.35, 0.71, -1.2);
    this.candle = new THREE.PointLight(0xffb060, 2.2, 7, 1.5);
    this.candle.position.set(0.35, 0.85, -1.2);
    s.add(this.candle);

    // Cushion, a small plant and a shelf.
    add(new THREE.CylinderGeometry(0.42, 0.46, 0.14, 10), lam(PALETTE.terracotta), 0, 0.07, 0.2);
    add(new THREE.CylinderGeometry(0.18, 0.14, 0.3, 7), lam(0xb06a4a), -2.4, 0.15, -2.4);
    add(new THREE.IcosahedronGeometry(0.35, 0), lam(PALETTE.leaf), -2.4, 0.55, -2.4);
    add(new THREE.BoxGeometry(1.4, 0.06, 0.3), lam(PALETTE.wood), -2.85, 1.5, 1.2, Math.PI / 2);
    add(new THREE.BoxGeometry(0.12, 0.3, 0.22), lam(0x5f8f6b), -2.85, 1.68, 0.8);
    add(new THREE.BoxGeometry(0.12, 0.26, 0.22), lam(0xc8644a), -2.85, 1.66, 1.0);

    this.hemi = new THREE.HemisphereLight(0xffe8c8, 0x5a4030, 0.9);
    this.sunLight = new THREE.DirectionalLight(0xfff0d6, 0.8);
    this.sunLight.position.set(5, 3, -1);
    s.add(this.hemi, this.sunLight);

    this.avatar.root.position.set(0, 0.1, 0.2);
    this.avatar.root.rotation.y = Math.PI; // face the screen (-z)
    this.avatar.setSeated(true);
    s.add(this.avatar.root);
  }

  setAspect(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.fov = aspect < 0.8 ? 66 : 50;
    this.camera.updateProjectionMatrix();
  }

  /** Small look-around from behind the cushion; drag rotates within limits. */
  look(dx: number, dy: number) {
    this.yaw = THREE.MathUtils.clamp(this.yaw - dx * 0.004, -0.8, 0.8);
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.003, 0.05, 0.7);
  }

  /** night: 0 day .. 1 night. */
  update(dt: number, elapsed: number, night: number) {
    const f = 1 + Math.sin(elapsed * 8.3) * 0.08 + Math.sin(elapsed * 13.1) * 0.05;
    this.flame.scale.set(1, f, 1);
    this.candle.intensity = (1.6 + night * 1.6) * f;
    this.windowPane.color.setHex(night > 0.5 ? 0x1c2747 : 0xbfe0f0);
    this.sunLight.intensity = 0.9 * (1 - night) + 0.08;
    this.hemi.intensity = 0.95 - night * 0.45;
    this.avatar.animate(dt, 0, elapsed);

    const dist = 2.4;
    const target = new THREE.Vector3(0, 1.1, -1.4);
    this.camera.position.set(
      Math.sin(this.yaw) * Math.cos(this.pitch) * dist,
      1.0 + Math.sin(this.pitch) * dist,
      0.2 + Math.cos(this.yaw) * Math.cos(this.pitch) * dist,
    );
    this.camera.lookAt(target);
  }

  dispose() {
    for (const g of this.geometries) g.dispose();
    this.avatar.dispose();
  }
}
