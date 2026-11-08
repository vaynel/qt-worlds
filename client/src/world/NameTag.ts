import * as THREE from 'three';
import { createNameTag, disposeSprite } from './labels';

const BASE_HEIGHT = 0.42;
/** Never smaller than this many CSS pixels on screen (phones). */
const MIN_PIXELS = 17;
const FADE_START = 30;
const FADE_END = 40;
const OCCLUSION_INTERVAL = 0.25;

const tmp = new THREE.Vector3();
const cam = new THREE.Vector3();

export interface TagView {
  camera: THREE.PerspectiveCamera;
  viewportHeight: number;
  groundAt: (x: number, z: number) => number;
  elapsed: number;
}

/**
 * Nickname above an avatar: readable at any distance (minimum on-screen
 * size), fades out beyond ~40 m, and hides when a hill is in the way.
 */
export class NameTag {
  private sprite: THREE.Sprite;
  private occluded = false;
  private nextCheck = 0;
  private name: string;
  private guest: boolean;

  constructor(
    private readonly parent: THREE.Object3D,
    name: string,
    guest: boolean,
    private readonly height = 2.0,
  ) {
    this.name = name;
    this.guest = guest;
    this.sprite = this.build();
  }

  private build(): THREE.Sprite {
    const s = createNameTag(this.name, this.guest);
    s.position.set(0, this.height, 0);
    s.renderOrder = 11;
    this.parent.add(s);
    return s;
  }

  get text(): string {
    return this.name;
  }

  get isGuest(): boolean {
    return this.guest;
  }

  get visible(): boolean {
    return this.sprite.visible && this.sprite.material.opacity > 0.05;
  }

  set(name: string, guest = this.guest) {
    if (name === this.name && guest === this.guest) return;
    this.name = name;
    this.guest = guest;
    this.parent.remove(this.sprite);
    disposeSprite(this.sprite);
    this.sprite = this.build();
  }

  update(view: TagView) {
    const s = this.sprite;
    s.getWorldPosition(tmp);
    view.camera.getWorldPosition(cam);
    const d = tmp.distanceTo(cam);
    // Scale up with distance so the label keeps a minimum pixel height.
    const worldPerPixel = (2 * d * Math.tan(THREE.MathUtils.degToRad(view.camera.fov) / 2)) / Math.max(1, view.viewportHeight);
    const k = Math.max(1, (MIN_PIXELS * worldPerPixel) / BASE_HEIGHT);
    const base = s.userData.base ?? (s.userData.base = { x: s.scale.x, y: s.scale.y });
    s.scale.set(base.x * k, base.y * k, 1);

    if (view.elapsed >= this.nextCheck) {
      this.nextCheck = view.elapsed + OCCLUSION_INTERVAL;
      this.occluded = false;
      // Cheap terrain occlusion: sample the ground along the camera->tag line.
      for (let i = 1; i < 6 && !this.occluded; i++) {
        const t = i / 6;
        const x = cam.x + (tmp.x - cam.x) * t;
        const z = cam.z + (tmp.z - cam.z) * t;
        const y = cam.y + (tmp.y - cam.y) * t;
        if (view.groundAt(x, z) > y + 0.15) this.occluded = true;
      }
    }
    const fade = d <= FADE_START ? 1 : Math.max(0, 1 - (d - FADE_START) / (FADE_END - FADE_START));
    const target = this.occluded ? 0 : fade;
    s.material.opacity += (target - s.material.opacity) * 0.25;
    s.visible = s.material.opacity > 0.02;
  }

  dispose() {
    this.parent.remove(this.sprite);
    disposeSprite(this.sprite);
  }
}
