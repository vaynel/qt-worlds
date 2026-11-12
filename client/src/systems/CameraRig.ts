import * as THREE from 'three';

const MIN_PITCH = 0.08;
const MAX_PITCH = 1.25;
const MIN_DIST = 3.5;
const MAX_DIST = 16;
/** Inside the library hall: closer, so the camera stays within the room. */
const INDOOR = { min: 2.4, max: 8, normal: 5.6, portrait: 6.4 };

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

  private minDist = MIN_DIST;
  private maxDist = MAX_DIST;
  private indoor = false;
  private portrait = false;
  private outdoorDistance = 10;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private groundAt: (x: number, z: number) => number,
    initialYaw: number,
  ) {
    this.yaw = initialYaw;
  }

  /** Indoors (the library) or out: what the arm avoids and how far it may reach. */
  setIndoor(indoor: boolean, groundAt: (x: number, z: number) => number) {
    if (indoor === this.indoor) return;
    this.groundAt = groundAt;
    this.indoor = indoor;
    if (indoor) {
      this.outdoorDistance = this.targetDistance;
      this.minDist = INDOOR.min;
      this.maxDist = INDOOR.max;
      this.targetDistance = this.portrait ? INDOOR.portrait : INDOOR.normal;
    } else {
      this.minDist = MIN_DIST;
      this.maxDist = MAX_DIST;
      this.targetDistance = this.outdoorDistance;
    }
  }

  /** Radians per dragged pixel; touch is a little faster on small screens. */
  applyLook(dx: number, dy: number, touch: boolean) {
    const k = touch ? 0.0065 : 0.0045;
    this.yaw -= dx * k;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * k, MIN_PITCH, MAX_PITCH);
  }

  applyZoom(delta: number) {
    this.targetDistance = THREE.MathUtils.clamp(this.targetDistance + delta, this.minDist, this.maxDist);
  }

  /** Portrait screens see less sideways, so back the camera off a little. */
  setPortrait(portrait: boolean) {
    this.portrait = portrait;
    if (this.indoor) this.targetDistance = portrait ? INDOOR.portrait : INDOOR.normal;
    else this.targetDistance = portrait ? 11.5 : 10;
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
        dist = Math.max(this.minDist * 0.6, d * 0.85);
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
