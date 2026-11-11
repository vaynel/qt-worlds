import * as THREE from 'three';
import { Avatar, DEFAULT_AVATAR, type AvatarLook } from '../entities/Avatar';

/**
 * Small live 3D preview of the avatar for the 꾸미기 sheet: one renderer for
 * one canvas, drag to turn, ~30 fps, everything disposed on close.
 */
export class AvatarPreview {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  readonly avatar = new Avatar(DEFAULT_AVATAR, false);
  private readonly turn = new THREE.Group();
  private yaw = 0.35;
  private raf = 0;
  private last = 0;
  private elapsed = 0;
  private drag: { id: number; x: number } | null = null;
  private disposed = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.scene.background = new THREE.Color(0xf3e7cf);
    this.scene.add(new THREE.HemisphereLight(0xfff3dc, 0x9a8466, 1.5));
    const sun = new THREE.DirectionalLight(0xfff0d8, 1.9);
    sun.position.set(2.5, 4, 3.5);
    this.scene.add(sun);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(0.75, 20), new THREE.MeshLambertMaterial({ color: 0xd9c49c }));
    ground.rotation.x = -Math.PI / 2;
    this.turn.add(this.avatar.root, ground);
    this.scene.add(this.turn);
    this.camera.position.set(0, 1.0, 3.5);
    this.camera.lookAt(0, 0.85, 0);

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    this.resize();
    this.raf = requestAnimationFrame(this.tick);
  }

  private readonly onDown = (e: PointerEvent) => {
    if (this.drag) return;
    this.drag = { id: e.pointerId, x: e.clientX };
    this.canvas.setPointerCapture?.(e.pointerId);
  };
  private readonly onMove = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.yaw += (e.clientX - this.drag.x) * 0.012;
    this.drag.x = e.clientX;
  };
  private readonly onUp = (e: PointerEvent) => {
    if (this.drag?.id === e.pointerId) this.drag = null;
  };

  /** Show the back (or any angle) — used by the painter so the drawing is in view. */
  face(yaw: number) {
    this.yaw = yaw;
  }

  get angle(): number {
    return this.yaw;
  }

  setLook(look: AvatarLook, pixels: string | null) {
    this.avatar.setLook(look);
    this.avatar.setPattern(pixels);
  }

  private size = '';

  resize() {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.size = `${w}x${h}`;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private readonly tick = (t: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    if (t - this.last < 32) return; // ~30 fps is plenty for a preview
    const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 0.016;
    this.last = t;
    this.elapsed += dt;
    if (`${this.canvas.clientWidth}x${this.canvas.clientHeight}` !== this.size) this.resize();
    this.turn.rotation.y = this.yaw;
    this.avatar.animate(dt, 0, this.elapsed);
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.avatar.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh && o.parent === this.turn) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
