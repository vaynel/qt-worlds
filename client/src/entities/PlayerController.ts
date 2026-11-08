import * as THREE from 'three';
import { MAX_WADE_DEPTH, WATER_LEVEL } from '../world/config';
import type { World } from '../world/World';
import type { MoveIntent } from '../systems/Input';
import type { AvatarState } from '../game/types';
import { Avatar } from './Avatar';

const WALK_SPEED = 4.2;
const RUN_SPEED = 7.5;
const ACCEL = 12;
const TURN_RATE = 12;
const BODY_RADIUS = 0.35;
/** Steepest rise per metre the player can walk up. */
const MAX_CLIMB = 1.1;

/**
 * The local player: camera-relative movement, ground snapping, water and prop
 * collision. Rendering lives in Avatar so remote players can reuse it.
 */
export class PlayerController {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly avatar = new Avatar();
  yaw = 0;
  /** Prayer mat index while seated, else -1. */
  seat = -1;
  private readonly wish = new THREE.Vector3();

  constructor(private readonly world: World, x: number, z: number, yaw: number) {
    this.position.set(x, world.groundHeight(x, z), z);
    this.yaw = yaw;
    this.syncAvatar();
  }

  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** Sit on a mat: snap onto it, face the garden centre, take the prayer pose. */
  sitAt(seat: number, x: number, z: number, yaw: number) {
    this.seat = seat;
    this.position.set(x, this.world.groundHeight(x, z), z);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.avatar.setSeated(true);
    this.syncAvatar();
  }

  standUp() {
    if (this.seat < 0) return;
    this.seat = -1;
    this.avatar.setSeated(false);
  }

  /** Instant move (QA hook / respawn). */
  teleport(x: number, z: number) {
    this.standUp();
    this.position.set(x, this.world.groundHeight(x, z), z);
    this.velocity.set(0, 0, 0);
    this.syncAvatar();
  }

  update(dt: number, move: MoveIntent, cameraYaw: number, elapsed: number) {
    if (this.seat >= 0) {
      this.avatar.animate(dt, 0, elapsed);
      this.syncAvatar();
      return;
    }

    // Camera-relative: forward is away from the camera along the ground.
    const fx = -Math.sin(cameraYaw);
    const fz = -Math.cos(cameraYaw);
    const rx = -fz;
    const rz = fx;
    const max = move.run ? RUN_SPEED : WALK_SPEED;
    this.wish.set((fx * move.y + rx * move.x) * max, 0, (fz * move.y + rz * move.x) * max);

    const k = 1 - Math.exp(-ACCEL * dt);
    this.velocity.x += (this.wish.x - this.velocity.x) * k;
    this.velocity.z += (this.wish.z - this.velocity.z) * k;

    this.tryMove(this.velocity.x * dt, this.velocity.z * dt);

    if (this.wish.lengthSq() > 0.01) {
      const target = Math.atan2(this.wish.x, this.wish.z);
      let delta = target - this.yaw;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      this.yaw += delta * (1 - Math.exp(-TURN_RATE * dt));
    }

    this.position.y = this.world.groundHeight(this.position.x, this.position.z);
    this.avatar.animate(dt, this.speed, elapsed);
    this.syncAvatar();
  }

  private walkable(x: number, z: number, fromY: number, step: number): boolean {
    const h = this.world.groundHeight(x, z);
    if (h < WATER_LEVEL - MAX_WADE_DEPTH) return false;
    if (step > 0 && (h - fromY) / step > MAX_CLIMB) return false;
    return true;
  }

  /** Axis-separated move so the player slides along shorelines and steep banks. */
  private tryMove(dx: number, dz: number) {
    const p = this.position;
    const y = this.world.groundHeight(p.x, p.z);
    const step = Math.hypot(dx, dz);
    if (step < 1e-6) return;
    if (this.walkable(p.x + dx, p.z + dz, y, step)) {
      p.x += dx;
      p.z += dz;
    } else if (this.walkable(p.x + dx, p.z, y, Math.abs(dx))) {
      p.x += dx;
      this.velocity.z *= 0.5;
    } else if (this.walkable(p.x, p.z + dz, y, Math.abs(dz))) {
      p.z += dz;
      this.velocity.x *= 0.5;
    } else {
      this.velocity.x = 0;
      this.velocity.z = 0;
    }

    // Push out of trees, rocks and landmark props.
    for (const c of this.world.collidersNear(p.x, p.z)) {
      const ox = p.x - c.x;
      const oz = p.z - c.z;
      const min = c.r + BODY_RADIUS;
      const d2 = ox * ox + oz * oz;
      if (d2 < min * min && d2 > 1e-8) {
        const d = Math.sqrt(d2);
        const push = (min - d) / d;
        p.x += ox * push;
        p.z += oz * push;
      }
    }
  }

  private syncAvatar() {
    this.avatar.root.position.copy(this.position);
    this.avatar.root.rotation.y = this.yaw;
  }

  getState(id: string, nickname: string): AvatarState {
    return { id, nickname, x: this.position.x, y: this.position.y, z: this.position.z, yaw: this.yaw, speed: this.speed };
  }
}
