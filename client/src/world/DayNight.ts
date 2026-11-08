import * as THREE from 'three';

export type DayPhase = '새벽' | '아침' | '낮' | '해질녘' | '밤';

export interface SeoulTime {
  hours: number; // 0..24 fractional
  dayOfYear: number;
}

const seoulFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hourCycle: 'h23',
});

/** Current wall-clock time in Korea, regardless of the device's own time zone. */
export function getSeoulTime(now = new Date()): SeoulTime {
  const parts: Record<string, number> = {};
  for (const p of seoulFormatter.formatToParts(now)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const start = Date.UTC(parts.year, 0, 1);
  const today = Date.UTC(parts.year, parts.month - 1, parts.day);
  return {
    hours: (parts.hour % 24) + parts.minute / 60 + parts.second / 3600,
    dayOfYear: Math.floor((today - start) / 86_400_000) + 1,
  };
}

/** Parse a "?time=HH:MM" override for testing day/night. */
export function parseTimeOverride(value: string | null): number | null {
  if (!value) return null;
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (h > 23 || min > 59) return null;
  return h + min / 60;
}

interface Palette {
  skyTop: THREE.Color;
  skyHorizon: THREE.Color;
  fog: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  sun: THREE.Color;
  sunIntensity: number;
}

const c = (hex: number) => new THREE.Color(hex);
const NIGHT: Palette = {
  skyTop: c(0x0b1430),
  skyHorizon: c(0x2a3560),
  fog: c(0x1f2a4d),
  hemiSky: c(0x6a7ab8),
  hemiGround: c(0x2a2838),
  hemiIntensity: 0.95,
  sun: c(0xa9bcff),
  sunIntensity: 0.45,
};
const TWILIGHT: Palette = {
  skyTop: c(0x6f7fb8),
  skyHorizon: c(0xf6b18a),
  fog: c(0xe8b394),
  hemiSky: c(0xffd6b8),
  hemiGround: c(0x5a4a52),
  hemiIntensity: 1.0,
  sun: c(0xffa868),
  sunIntensity: 1.3,
};
const DAY: Palette = {
  skyTop: c(0x7fb8dd),
  skyHorizon: c(0xf2e6cf),
  fog: c(0xe4e2cf),
  hemiSky: c(0xfff3dc),
  hemiGround: c(0x7a8a52),
  hemiIntensity: 1.25,
  sun: c(0xfff0d6),
  sunIntensity: 2.4,
};

function mixPalette(a: Palette, b: Palette, t: number, out: Palette): void {
  out.skyTop.copy(a.skyTop).lerp(b.skyTop, t);
  out.skyHorizon.copy(a.skyHorizon).lerp(b.skyHorizon, t);
  out.fog.copy(a.fog).lerp(b.fog, t);
  out.hemiSky.copy(a.hemiSky).lerp(b.hemiSky, t);
  out.hemiGround.copy(a.hemiGround).lerp(b.hemiGround, t);
  out.hemiIntensity = a.hemiIntensity + (b.hemiIntensity - a.hemiIntensity) * t;
  out.sun.copy(a.sun).lerp(b.sun, t);
  out.sunIntensity = a.sunIntensity + (b.sunIntensity - a.sunIntensity) * t;
}

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SKY_FRAGMENT = /* glsl */ `
  uniform vec3 topColor;
  uniform vec3 horizonColor;
  varying vec3 vDir;
  void main() {
    float h = clamp(vDir.y, -0.2, 1.0);
    float t = pow(max(h, 0.0), 0.55);
    gl_FragColor = vec4(mix(horizonColor, topColor, t), 1.0);
    #include <colorspace_fragment>
  }
`;

/**
 * Sky, sun/moon, stars and global lights, driven by real Korean time.
 * Approximates Seoul's sunrise/sunset across the year (37.5°N, solar noon ~12:30 KST).
 */
export class DayNight {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private readonly sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly stars: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly sunDisc: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  private readonly moonDisc: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  private readonly palette: Palette = {
    skyTop: new THREE.Color(),
    skyHorizon: new THREE.Color(),
    fog: new THREE.Color(),
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    hemiIntensity: 1,
    sun: new THREE.Color(),
    sunIntensity: 1,
  };
  private readonly sunDir = new THREE.Vector3();
  private readonly lightDir = new THREE.Vector3();
  private lastCompute = -Infinity;

  /** 0 = full day, 1 = full night. Read by lamps and UI. */
  night = 0;
  /** Sine of the sun's elevation, -1..1. */
  sunHeight = 0;
  hours = 12;
  phase: DayPhase = '낮';

  constructor(
    private readonly scene: THREE.Scene,
    private readonly fixedHours: number | null,
    shadows: boolean,
  ) {
    this.group.name = 'sky';

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.sun = new THREE.DirectionalLight(0xffffff, 2);
    this.sun.castShadow = shadows;
    if (shadows) {
      this.sun.shadow.mapSize.set(1024, 1024);
      const cam = this.sun.shadow.camera;
      cam.left = -28;
      cam.right = 28;
      cam.top = 28;
      cam.bottom = -28;
      cam.near = 1;
      cam.far = 140;
      this.sun.shadow.bias = -0.0008;
      this.sun.shadow.normalBias = 0.04;
    }
    scene.add(this.hemi, this.sun, this.sun.target);

    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(450, 24, 12),
      new THREE.ShaderMaterial({
        uniforms: { topColor: { value: new THREE.Color() }, horizonColor: { value: new THREE.Color() } },
        vertexShader: SKY_VERTEX,
        fragmentShader: SKY_FRAGMENT,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    );
    this.sky.renderOrder = -10;
    this.group.add(this.sky);

    this.sunDisc = new THREE.Mesh(
      new THREE.CircleGeometry(16, 20),
      new THREE.MeshBasicMaterial({ color: 0xfff1cf, fog: false, transparent: true, depthWrite: false }),
    );
    this.moonDisc = new THREE.Mesh(
      new THREE.CircleGeometry(9, 20),
      new THREE.MeshBasicMaterial({ color: 0xeef0ff, fog: false, transparent: true, depthWrite: false }),
    );
    this.sunDisc.renderOrder = -9;
    this.moonDisc.renderOrder = -9;
    this.group.add(this.sunDisc, this.moonDisc);

    // Stars: fixed pattern (seeded by index, not Math.random) on the upper dome.
    const count = 700;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const u = ((i * 0.618034) % 1) * Math.PI * 2;
      const v = ((i * 0.381966 * 7.13) % 1) * 0.92 + 0.06;
      const r = 420;
      const y = v;
      const s = Math.sqrt(1 - y * y);
      pos[i * 3] = Math.cos(u) * s * r;
      pos[i * 3 + 1] = y * r;
      pos[i * 3 + 2] = Math.sin(u) * s * r;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: 0xfff6e0, size: 1.8, sizeAttenuation: false, transparent: true, fog: false, depthWrite: false }),
    );
    this.stars.renderOrder = -9;
    this.group.add(this.stars);

    scene.fog = new THREE.Fog(0xffffff, 40, 105);
    scene.add(this.group);
    this.compute(true);
  }

  private compute(force = false): void {
    const nowMs = performance.now();
    if (!force && nowMs - this.lastCompute < 1000) return;
    this.lastCompute = nowMs;

    const t = getSeoulTime();
    const hours = this.fixedHours ?? t.hours;
    this.hours = hours;

    const dayLength = 12.15 + 2.55 * Math.sin((2 * Math.PI * (t.dayOfYear - 80)) / 365);
    const noon = 12.5;
    const sunrise = noon - dayLength / 2;
    const sunset = noon + dayLength / 2;
    const maxElev = THREE.MathUtils.degToRad(52.5 + 23.4 * Math.sin((2 * Math.PI * (t.dayOfYear - 80)) / 365));

    // Arc parameter: 0 at sunrise -> PI at sunset, continuing under the horizon at night.
    let arc: number;
    if (hours >= sunrise && hours <= sunset) {
      arc = (Math.PI * (hours - sunrise)) / dayLength;
    } else {
      const sinceSunset = (hours - sunset + 24) % 24;
      arc = Math.PI + (Math.PI * sinceSunset) / (24 - dayLength);
    }
    // East = +x, south = +z, north = -z.
    const elev = Math.sin(arc);
    this.sunDir.set(Math.cos(arc), elev * Math.sin(maxElev), elev * Math.cos(maxElev) * 0.6 + 0.35).normalize();
    this.sunHeight = this.sunDir.y;

    const s = this.sunHeight;
    if (s <= -0.22) mixPalette(NIGHT, NIGHT, 0, this.palette);
    else if (s < 0.02) mixPalette(NIGHT, TWILIGHT, (s + 0.22) / 0.24, this.palette);
    else if (s < 0.32) mixPalette(TWILIGHT, DAY, (s - 0.02) / 0.3, this.palette);
    else mixPalette(DAY, DAY, 0, this.palette);
    this.night = THREE.MathUtils.clamp((0.08 - s) / 0.25, 0, 1);

    if (this.night > 0.85) this.phase = '밤';
    else if (s < 0.18) this.phase = hours < 12 ? '새벽' : '해질녘';
    else if (hours < 10) this.phase = '아침';
    else this.phase = '낮';

    const p = this.palette;
    this.sky.material.uniforms.topColor.value.copy(p.skyTop);
    this.sky.material.uniforms.horizonColor.value.copy(p.skyHorizon);
    (this.scene.fog as THREE.Fog).color.copy(p.fog);
    this.scene.background = p.fog;
    this.hemi.color.copy(p.hemiSky);
    this.hemi.groundColor.copy(p.hemiGround);
    this.hemi.intensity = p.hemiIntensity;
    this.sun.color.copy(p.sun);
    this.sun.intensity = p.sunIntensity;

    // Light comes from the sun by day and from the moon (opposite side) by night.
    if (s > -0.05) this.lightDir.copy(this.sunDir);
    else this.lightDir.set(-this.sunDir.x, Math.max(0.35, -this.sunDir.y), -this.sunDir.z).normalize();
    if (this.lightDir.y < 0.12) this.lightDir.y = 0.12;
    this.lightDir.normalize();

    this.stars.material.opacity = THREE.MathUtils.clamp((this.night - 0.3) / 0.6, 0, 1);
    this.sunDisc.material.opacity = THREE.MathUtils.clamp((s + 0.05) / 0.1, 0, 1);
    this.moonDisc.material.opacity = THREE.MathUtils.clamp(this.night * 1.2 - 0.2, 0, 1);
  }

  /** Keep sky elements centred on the camera and the shadow frustum on the player. */
  update(camera: THREE.Camera, focus: THREE.Vector3): void {
    this.compute();
    this.group.position.copy(camera.position);
    this.sunDisc.position.copy(this.sunDir).multiplyScalar(400);
    this.sunDisc.lookAt(camera.position);
    this.moonDisc.position.set(-this.sunDir.x, Math.abs(this.sunDir.y) * 0.8 + 0.25, -this.sunDir.z).normalize().multiplyScalar(400);
    this.moonDisc.lookAt(camera.position);

    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.lightDir, 70);
  }

  /** "오후 3:24" style label in Korean. */
  formatClock(): string {
    const h = Math.floor(this.hours);
    const m = Math.floor((this.hours - h) * 60);
    const ampm = h < 12 ? '오전' : '오후';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${ampm} ${h12}:${m.toString().padStart(2, '0')}`;
  }
}
