import * as THREE from 'three';
import { createLabelSprite, disposeSprite } from './labels';

const FLIGHT_SECONDS = 6.5;

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255, 236, 190, 0.95)');
  grad.addColorStop(0.35, 'rgba(255, 210, 140, 0.35)');
  grad.addColorStop(1, 'rgba(255, 200, 120, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The "오늘의 말씀" envelope: drifts down from the sky like a leaf, then hovers
 * gently in front of the player until it is tapped.
 */
export class Letter {
  readonly group = new THREE.Group();
  /** Generous invisible hit box so the envelope is easy to tap on a phone. */
  readonly hitTarget: THREE.Mesh;
  private readonly body = new THREE.Group();
  private readonly label: THREE.Sprite;
  private readonly glow: THREE.Sprite;
  private readonly sparkles: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly start = new THREE.Vector3();
  private readonly hover = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private t = 0;
  private readonly disposables: { dispose(): void }[] = [];
  state: 'flying' | 'waiting' = 'flying';

  constructor(from: THREE.Vector3) {
    const mat = (color: number) => {
      const m = new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.25, side: THREE.DoubleSide });
      this.disposables.push(m);
      return m;
    };
    const geo = <T extends THREE.BufferGeometry>(g: T) => {
      this.disposables.push(g);
      return g;
    };

    const paper = new THREE.Mesh(geo(new THREE.BoxGeometry(0.9, 0.04, 0.62)), mat(0xfbf1dc));
    const flapShape = new THREE.Shape();
    flapShape.moveTo(-0.45, 0);
    flapShape.lineTo(0.45, 0);
    flapShape.lineTo(0, -0.34);
    flapShape.closePath();
    const flap = new THREE.Mesh(geo(new THREE.ShapeGeometry(flapShape)), mat(0xf0dfbd));
    flap.rotation.x = -Math.PI / 2;
    flap.position.set(0, 0.022, -0.31);
    const seal = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.07, 0.07, 0.03, 12)), mat(0xb8473a));
    seal.position.set(0, 0.035, 0.0);
    this.body.add(paper, flap, seal);
    this.group.add(this.body);

    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    this.glow.scale.setScalar(2.4);
    this.disposables.push(this.glow.material.map!, this.glow.material);
    this.group.add(this.glow);

    this.label = createLabelSprite('오늘의 말씀');
    this.label.scale.multiplyScalar(0.55);
    this.label.position.y = 0.55;
    this.group.add(this.label);

    const count = 24;
    const pos = new Float32Array(count * 3);
    const sparkleGeo = geo(new THREE.BufferGeometry());
    sparkleGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.sparkles = new THREE.Points(
      sparkleGeo,
      new THREE.PointsMaterial({ color: 0xfff0c8, size: 0.08, transparent: true, opacity: 0.85, depthWrite: false, fog: false }),
    );
    this.disposables.push(this.sparkles.material);
    this.group.add(this.sparkles);

    this.hitTarget = new THREE.Mesh(geo(new THREE.BoxGeometry(1.8, 1.4, 1.8)), new THREE.MeshBasicMaterial({ visible: false }));
    this.group.add(this.hitTarget);

    this.group.name = 'today-letter';
    this.start.copy(from);
    this.group.position.copy(from);
  }

  /** target: point the letter should come to rest at (in front of the player). */
  update(dt: number, elapsed: number, target: THREE.Vector3) {
    this.t += dt;
    this.hover.lerp(target, this.t < 0.05 ? 1 : 1 - Math.exp(-2.5 * dt));
    const p = Math.min(1, this.t / FLIGHT_SECONDS);
    const ease = 1 - Math.pow(1 - p, 3);
    // Leaf-like drift: wide sway early, settling as it arrives.
    const sway = (1 - ease) * 3.2;
    this.tmp.lerpVectors(this.start, this.hover, ease);
    this.tmp.x += Math.sin(this.t * 1.7) * sway;
    this.tmp.z += Math.cos(this.t * 1.3) * sway * 0.6;
    this.tmp.y += Math.sin(elapsed * 1.6) * 0.08 * ease;
    this.group.position.copy(this.tmp);
    this.body.rotation.set(
      0.9 + Math.sin(this.t * 2.1) * 0.5 * (1 - ease) - 0.4 * ease,
      this.t * 0.6,
      Math.sin(this.t * 1.7) * 0.6 * (1 - ease),
    );
    this.glow.material.opacity = 0.55 + Math.sin(elapsed * 2.4) * 0.2;
    this.label.material.opacity = ease;

    const arr = this.sparkles.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < arr.length / 3; i++) {
      const a = elapsed * (0.6 + (i % 5) * 0.12) + i * 2.4;
      const r = 0.45 + ((i * 37) % 10) * 0.05;
      arr[i * 3] = Math.cos(a) * r;
      arr[i * 3 + 1] = Math.sin(a * 1.3 + i) * 0.35;
      arr[i * 3 + 2] = Math.sin(a) * r;
    }
    this.sparkles.geometry.attributes.position.needsUpdate = true;
    if (p >= 1) this.state = 'waiting';
  }

  dispose() {
    disposeSprite(this.label);
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}
