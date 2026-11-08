import * as THREE from 'three';

const MIN_PITCH = 0.08;
const MAX_PITCH = 1.25;
const MIN_DIST = 3.5;
const MAX_DIST = 16;

/**
 * Third-person orbit camera. Yaw/pitch come from drag input, follow is
 * exponentially smoothed (frame-rate independent), and the arm is pulled in
 * whenever terrain would sit between the player and the lens.
 */
export class CameraRig {
  yaw: number;
  pitch = 0.36;
  distance = 10;
  private targetDistance = 10;
  private readonly focus = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly probe = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly groundAt: (x: number, z: number) => number,
    initialYaw: number,
  ) {
    this.yaw = initialYaw;
  }

  /** Radians per dragged pixel; touch is a little faster on small screens. */
  applyLook(dx: number, dy: number, touch: boolean) {
    const k = touch ? 0.0065 : 0.0045;
    this.yaw -= dx * k;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * k, MIN_PITCH, MAX_PITCH);
  }

  applyZoom(delta: number) {
    this.targetDistance = THREE.MathUtils.clamp(this.targetDistance + delta, MIN_DIST, MAX_DIST);
  }

  /** Portrait screens see less sideways, so back the camera off a little. */
  setPortrait(portrait: boolean) {
    const d = portrait ? 11.5 : 10;
    this.targetDistance = d;
  }

  snap(target: THREE.Vector3) {
    this.distance = this.targetDistance;
    this.focus.copy(target);
    this.place(1);
  }

  update(dt: number, target: THREE.Vector3) {
    this.focus.lerp(target, 1 - Math.exp(-12 * dt));
    this.distance += (this.targetDistance - this.distance) * (1 - Math.exp(-8 * dt));
    this.place(1 - Math.exp(-18 * dt));
  }

  private place(blend: number) {
    const lookAt = this.probe.copy(this.focus);
    lookAt.y += 1.3;
    const cp = Math.cos(this.pitch);
    let dist = this.distance;

    // Pull the arm in if a hill blocks the line of sight (sampled along the arm).
    for (let i = 1; i <= 6; i++) {
      const d = (dist * i) / 6;
      const x = lookAt.x + Math.sin(this.yaw) * cp * d;
      const z = lookAt.z + Math.cos(this.yaw) * cp * d;
      const y = lookAt.y + Math.sin(this.pitch) * d;
      if (y < this.groundAt(x, z) + 0.45) {
        dist = Math.max(MIN_DIST * 0.6, d * 0.85);
        break;
      }
    }

    this.desired.set(
      lookAt.x + Math.sin(this.yaw) * cp * dist,
      lookAt.y + Math.sin(this.pitch) * dist,
      lookAt.z + Math.cos(this.yaw) * cp * dist,
    );
    const floor = this.groundAt(this.desired.x, this.desired.z) + 0.6;
    if (this.desired.y < floor) this.desired.y = floor;

    this.camera.position.lerp(this.desired, blend);
    this.camera.lookAt(lookAt);
  }
}
