import * as THREE from 'three';
import { PROP_IDS, PROPS, type PropId } from '../../../shared/protocol';
import { bookClosedGeo, doveBodyGeo, doveHeadGeo, guitarGeo, hatGeo, lanternCoreGeo, lanternFrameGeo, propMaterial } from '../entities/Props';

const SIZE = 128;
let icons: Partial<Record<PropId, string>> | null = null;

/** Two glowing footprints (the effect prop has no mesh of its own). */
function footprintsIcon(): string {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d')!;
  const foot = (x: number, y: number, rot: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.shadowColor = 'rgba(255, 200, 90, 0.9)';
    ctx.shadowBlur = 14;
    ctx.fillStyle = '#ffd36b';
    ctx.beginPath();
    ctx.ellipse(0, 6, 11, 19, 0, 0, Math.PI * 2);
    ctx.fill();
    for (const [tx, ty, r] of [
      [-8, -18, 4.2],
      [-1, -22, 4.6],
      [6, -20, 4],
      [11, -15, 3.4],
    ]) {
      ctx.beginPath();
      ctx.arc(tx, ty, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };
  foot(46, 78, -0.25);
  foot(82, 50, 0.2);
  return c.toDataURL('image/png');
}

/** The props' own low-poly meshes, rendered once into small images for the shop sheet and HUD. */
function render(): Partial<Record<PropId, string>> {
  const out: Partial<Record<PropId, string>> = { footprints: footprintsIcon() };
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  } catch {
    return out;
  }
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfff6e4, 0x8a6a50, 2.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(2, 3, 4);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 20);
  const glow = new THREE.MeshLambertMaterial({ color: 0xffd27a, emissive: 0xffb84a, emissiveIntensity: 1.2 });
  const mat = propMaterial();
  const build: Record<Exclude<PropId, 'footprints'>, () => THREE.Object3D> = {
    lantern: () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(lanternFrameGeo(), mat), new THREE.Mesh(lanternCoreGeo(), glow));
      g.rotation.y = 0.5;
      return g;
    },
    guitar: () => {
      const m = new THREE.Mesh(guitarGeo(), mat);
      m.rotation.set(0, 0.35, -0.75);
      return m;
    },
    bible: () => {
      const m = new THREE.Mesh(bookClosedGeo(), mat);
      m.rotation.set(0.35, -0.6, 0);
      return m;
    },
    dove: () => {
      const g = new THREE.Group();
      const head = new THREE.Mesh(doveHeadGeo(), mat);
      head.position.set(0, 0.1, 0.08);
      g.add(new THREE.Mesh(doveBodyGeo(), mat), head);
      g.rotation.y = 0.9;
      return g;
    },
    hat: () => {
      const m = new THREE.Mesh(hatGeo(), mat);
      m.rotation.set(0.25, 0.4, 0);
      return m;
    },
  };
  for (const id of PROP_IDS) {
    if (id === 'footprints') continue;
    const obj = build[id]();
    scene.add(obj);
    obj.updateMatrixWorld(true);
    const sphere = new THREE.Box3().setFromObject(obj).getBoundingSphere(new THREE.Sphere());
    // Long or flat shapes fill less of a bounding sphere: frame them tighter.
    const fit = id === 'guitar' ? 0.72 : id === 'hat' ? 0.68 : id === 'dove' ? 0.85 : 1;
    const dist = (sphere.radius / Math.sin(THREE.MathUtils.degToRad(15))) * fit;
    camera.position.set(sphere.center.x, sphere.center.y + dist * 0.25, sphere.center.z + dist * 0.97);
    camera.lookAt(sphere.center);
    renderer.render(scene, camera);
    out[id] = canvas.toDataURL('image/png');
    scene.remove(obj);
  }
  glow.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
  return out;
}

/** An <img> of the prop (falls back to its emoji when WebGL isn't there). */
export function propIcon(id: PropId, className: string): HTMLElement {
  icons ??= render();
  const src = icons[id];
  if (!src) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = PROPS[id].emoji;
    return span;
  }
  const img = document.createElement('img');
  img.className = className;
  img.src = src;
  img.alt = '';
  img.draggable = false;
  return img;
}
