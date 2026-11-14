import * as THREE from 'three';
import { CAMPFIRE, PRAYER_GARDEN, WEATHER_KINDS, type WeatherKind, type WeatherState } from '../../../shared/protocol';
import type { GraphicsQuality } from '../game/graphics';
import type { CircleCollider } from './ChunkManager';
import { LANDMARKS } from './config';
import type { DayNight } from './DayNight';
import type { Heightfield } from './Heightfield';
import { Particles } from './Particles';
import { SeasonDecor, seasonOf, type SeasonInfo } from './Seasons';
import { surfaceUniforms, windowUniforms } from './surface';

/** 서울 날씨 as words for the HUD clock card (the icon is drawn by the HUD per kind). */
export const WEATHER_LABELS: Record<WeatherKind, { name: string }> = {
  clear: { name: '맑음' },
  partly: { name: '구름 조금' },
  cloudy: { name: '흐림' },
  fog: { name: '안개' },
  drizzle: { name: '이슬비' },
  rain: { name: '비' },
  heavyRain: { name: '큰비' },
  thunder: { name: '뇌우' },
  snow: { name: '눈' },
  heavySnow: { name: '함박눈' },
};

interface Look {
  /** Cloud cover look: dims the sun and greys the sky, 0..1. */
  cloud: number;
  /** Desaturation of sky and fog, 0..1. */
  grey: number;
  fogNear: number;
  fogFar: number;
  /** Sky cloud meshes (max). */
  clouds: number;
  /** Cloud mesh shade (1 white .. 0.45 rain-dark). */
  shade: number;
  rain: number;
  snow: number;
  /** Rain streak speed (m/s) and size. */
  fall: number;
  streak: number;
  lightning: boolean;
}

const BASE = { cloud: 0, grey: 0, fogNear: 40, fogFar: 105, clouds: 0, shade: 1, rain: 0, snow: 0, fall: 0, streak: 0, lightning: false };
const LOOKS: Record<WeatherKind, Look> = {
  clear: { ...BASE },
  partly: { ...BASE, cloud: 0.22, grey: 0.05, clouds: 12 },
  cloudy: { ...BASE, cloud: 0.7, grey: 0.55, fogNear: 34, fogFar: 95, clouds: 26, shade: 0.82 },
  fog: { ...BASE, cloud: 0.6, grey: 0.8, fogNear: 4, fogFar: 40, clouds: 0, shade: 0.8 },
  drizzle: { ...BASE, cloud: 0.72, grey: 0.6, fogNear: 30, fogFar: 88, clouds: 26, shade: 0.72, rain: 520, fall: 9, streak: 0.55 },
  rain: { ...BASE, cloud: 0.85, grey: 0.66, fogNear: 24, fogFar: 78, clouds: 28, shade: 0.62, rain: 1100, fall: 17, streak: 0.95 },
  heavyRain: { ...BASE, cloud: 0.95, grey: 0.72, fogNear: 15, fogFar: 60, clouds: 28, shade: 0.52, rain: 1800, fall: 21, streak: 1.25 },
  thunder: { ...BASE, cloud: 1, grey: 0.75, fogNear: 17, fogFar: 62, clouds: 28, shade: 0.45, rain: 1600, fall: 20, streak: 1.15, lightning: true },
  snow: { ...BASE, cloud: 0.68, grey: 0.6, fogNear: 22, fogFar: 74, clouds: 24, shade: 0.88, snow: 800 },
  heavySnow: { ...BASE, cloud: 0.85, grey: 0.72, fogNear: 11, fogFar: 50, clouds: 28, shade: 0.8, snow: 1500 },
};

const QUALITY_SCALE: Record<GraphicsQuality, number> = { saver: 0.3, normal: 0.6, sharp: 1 };
/** Behind a sheet that covers the screen the world draws at a few fps: fewer, frozen particles. */
const COVERED_SCALE = 0.3;
const PETALS = 170;
const LEAVES = 150;
const FIREFLIES = 90;
const CLOUDS_MAX = 28;
/** Snow settles over ~3 min (heavy) / ~6 min, melts over ~12 min. Wet dries over ~4 min. */
const SNOW_RATE = { snow: 1 / 360, heavySnow: 1 / 180 };
const MELT_RATE = 1 / 720;
const WET_RATE = 1 / 25;
const DRY_RATE = 1 / 240;

const smooth = (cur: number, target: number, dt: number, tau: number) => cur + (target - cur) * (1 - Math.exp(-dt / tau));

export interface WeatherFrame {
  dt: number;
  elapsed: number;
  camera: THREE.Camera;
  /** The world scene is what is drawn (not the 골방 or the library). */
  outdoor: boolean;
  /** A sheet covers the screen (render on demand). */
  covered: boolean;
  quality: GraphicsQuality;
}

/**
 * Real Seoul weather (from the server) and the KST season, drawn into the
 * world: sky and light blend in DayNight, GPU particles around the camera,
 * instanced clouds, lightning, snow cover and wet ground through the shared
 * surface uniforms, seasonal decorations, and the interior window panes.
 */
export class Weather {
  readonly group = new THREE.Group();
  state: WeatherState;
  season: SeasonInfo;
  private dateOverride: number | null = null;
  private readonly rain: Particles;
  private readonly snow: Particles;
  private readonly petals: Particles;
  private readonly leaves: Particles;
  private readonly fireflies: Particles;
  private readonly clouds: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  private readonly cloudGroup = new THREE.Group();
  private readonly decor: SeasonDecor;
  /** Smoothed look (fades between kinds over a few seconds). */
  private readonly look: Look = { ...BASE };
  private target: Look = LOOKS.clear;
  private time = 0;
  private flash = 0;
  private nextFlash = 8;
  private flashPulses: number[] = [];
  private pendingRumble = -1;
  flashes = 0;
  /** 0..1 snow lying on the ground and tree tops. */
  snowCover = 0;
  /** 0..1 rain-wet ground. */
  wet = 0;
  /** Test hook: speed up accumulation/melting. */
  rate = 1;
  private quality: GraphicsQuality = 'sharp';
  private covered = false;
  private readonly fwd = new THREE.Vector3();
  private readonly centre = new THREE.Vector3();
  private seasonCheck = -Infinity;
  /** Rain loudness for the ambience (0..1, heavier is louder). */
  rainLevel = 0;
  onRumble: ((strength: number) => void) | null = null;

  constructor(
    private readonly dayNight: DayNight,
    field: Heightfield,
    colliders: CircleCollider[],
    readonly reducedMotion: boolean,
  ) {
    this.group.name = 'weather';
    this.state = { kind: 'clear', tempC: 15, wind: 2, cloud: 0, isDay: true, updatedAt: Date.now(), source: 'met-no', stale: true };
    this.season = seasonOf(Date.now());

    this.rain = new Particles({ mode: 'rain', max: 1800, box: [34, 20, 34], size: [0.03, 0.9], color: 0xc6d4e4, opacity: 0.42, seed: 1 });
    this.snow = new Particles({ mode: 'flake', max: 1500, box: [34, 18, 34], size: [0.11, 0.11], color: 0xffffff, opacity: 0.95, seed: 2 });
    this.petals = new Particles({ mode: 'petal', max: PETALS, box: [36, 14, 36], size: [0.13, 0.1], color: 0xf7b7c9, color2: 0xffe1ea, opacity: 0.95, seed: 3 });
    this.leaves = new Particles({ mode: 'petal', max: LEAVES, box: [36, 14, 36], size: [0.2, 0.15], color: 0xd9732b, color2: 0xc8402e, opacity: 0.95, seed: 4 });
    this.fireflies = new Particles({ mode: 'firefly', max: FIREFLIES, box: [18, 2.2, 18], size: [0.32, 0.32], color: 0xd8ff8a, opacity: 1, seed: 5 });
    const garden = LANDMARKS.find((l) => l.id === 'prayerGarden')!;
    const fire = LANDMARKS.find((l) => l.id === 'campfire')!;
    this.fireflies.uniforms.uCenter.value.set(PRAYER_GARDEN.x, garden.height + 1.3, PRAYER_GARDEN.z);
    this.fireflies.uniforms.uCenter2.value.set(CAMPFIRE.x, fire.height + 1.5, CAMPFIRE.z);
    this.fireflies.uniforms.uSway.value = 1.4;
    for (const p of [this.rain, this.snow, this.petals, this.leaves, this.fireflies]) this.group.add(p.mesh);

    // Low-poly cloud puffs: four merged icosahedrons, instanced on a ring high in the sky dome.
    const puff = (r: number, x: number, y: number, z: number) => new THREE.IcosahedronGeometry(r, 0).translate(x, y, z);
    const parts = [puff(1, 0, 0, 0), puff(0.75, 0.95, -0.12, 0.15), puff(0.7, -0.9, -0.15, -0.1), puff(0.55, 0.3, 0.45, -0.2)];
    const total = parts.reduce((n, g) => n + g.attributes.position.count, 0);
    const pos = new Float32Array(total * 3);
    let off = 0;
    for (const g of parts) {
      pos.set(g.attributes.position.array as Float32Array, off);
      off += g.attributes.position.count * 3;
      g.dispose();
    }
    const cloudGeo = new THREE.BufferGeometry();
    cloudGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    cloudGeo.computeVertexNormals();
    this.clouds = new THREE.InstancedMesh(cloudGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true, fog: false, emissive: 0xc4ccd8, emissiveIntensity: 0.5 }), CLOUDS_MAX);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (let i = 0; i < CLOUDS_MAX; i++) {
      const a = i * 2.39996;
      const r = 150 + ((i * 53) % 90);
      p.set(Math.cos(a) * r, 34 + ((i * 29) % 30), Math.sin(a) * r);
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, a * 1.7);
      const w = 16 + ((i * 17) % 14);
      s.set(w, w * 0.36, w * 0.62);
      this.clouds.setMatrixAt(i, m.compose(p, q, s));
    }
    this.clouds.count = 0;
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = -8;
    this.cloudGroup.add(this.clouds);
    this.group.add(this.cloudGroup);

    this.decor = new SeasonDecor(field, colliders);
    this.group.add(this.decor.group);
    this.applySeason();
  }

  /** From welcome or a live `weather` message. */
  setState(s: WeatherState) {
    const kind = WEATHER_KINDS.includes(s.kind) ? s.kind : 'clear';
    const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    this.state = { ...s, kind, tempC: n(s.tempC, 15), wind: n(s.wind, 2), cloud: n(s.cloud, 0) };
    s = this.state;
    this.target = LOOKS[s.kind] ?? LOOKS.clear;
    if (!this.target.lightning) this.flashPulses.length = 0;
  }

  /** Test hook: pretend it's this KST date (null: the real clock). */
  setDate(ms: number | null) {
    this.dateOverride = ms;
    this.seasonCheck = -Infinity;
  }

  /** Test hook: the next lightning comes now. */
  flashSoon() {
    this.nextFlash = 0;
  }

  /** Test hook: jump to the target look at once (no fade). */
  snap() {
    Object.assign(this.look, this.target);
    this.wet = this.target.rain ? 1 : 0;
  }

  private applySeason() {
    const info = seasonOf(this.dateOverride ?? Date.now());
    this.season = info;
    this.decor.apply(info);
    const u = surfaceUniforms;
    const m = info.month;
    if (info.season === 'autumn') {
      u.uSeason.value = 1;
      u.uSeasonAmt.value = m === 9 ? 0.35 : m === 10 ? 0.75 : 0.85;
    } else if (info.season === 'winter') {
      u.uSeason.value = 2;
      u.uSeasonAmt.value = 0.6;
    } else if (info.season === 'spring') {
      u.uSeason.value = 3;
      u.uSeasonAmt.value = 0.5;
    } else {
      u.uSeason.value = 0;
      u.uSeasonAmt.value = 0;
    }
  }

  get label(): { name: string } {
    return WEATHER_LABELS[this.state.kind] ?? WEATHER_LABELS.clear;
  }

  /** How grey the daylight is (interiors dim their window light by it). */
  get gloom(): number {
    return this.look.cloud;
  }

  update(f: WeatherFrame) {
    const dt = f.dt;
    this.quality = f.quality;
    this.covered = f.covered;
    // Frozen behind a covering sheet: nobody sees the motion, the GPU draws a few fps.
    if (!f.covered) this.time = (this.time + dt) % 2000;
    if (f.elapsed - this.seasonCheck > 60) {
      this.seasonCheck = f.elapsed;
      this.applySeason();
    }

    const t = this.target;
    const L = this.look;
    const tau = 4;
    L.cloud = smooth(L.cloud, t.cloud, dt, tau);
    L.grey = smooth(L.grey, t.grey, dt, tau);
    L.fogNear = smooth(L.fogNear, t.fogNear, dt, tau);
    L.fogFar = smooth(L.fogFar, t.fogFar, dt, tau);
    L.shade = smooth(L.shade, t.shade, dt, tau);
    L.rain = smooth(L.rain, t.rain, dt, 2.5);
    L.snow = smooth(L.snow, t.snow, dt, 2.5);
    L.fall = t.fall || L.fall;
    L.streak = t.streak || L.streak;
    L.clouds = t.clouds;

    // Ground: wet with rain (dries slowly), snow settles while snowing and melts after.
    const raining = t.rain > 0;
    const snowing = t.snow > 0;
    const k = dt * this.rate;
    this.wet = raining ? Math.min(1, this.wet + k * WET_RATE) : Math.max(0, this.wet - k * DRY_RATE);
    if (snowing) this.snowCover = Math.min(1, this.snowCover + k * (this.state.kind === 'heavySnow' ? SNOW_RATE.heavySnow : SNOW_RATE.snow));
    else this.snowCover = Math.max(0, this.snowCover - k * MELT_RATE * (raining || this.state.tempC > 4 ? 2 : 1));
    const su = surfaceUniforms;
    su.uSnow.value = this.snowCover;
    su.uWet.value = this.wet * (1 - this.snowCover);
    su.uTime.value = this.time;
    const wind = Math.max(0, this.state.wind);
    su.uWind.value = this.reducedMotion ? 0 : THREE.MathUtils.clamp(0.15 + wind / 10, 0.15, 1.2);

    // Lightning: a double pulse every 6–18 s, the rumble a moment later.
    this.flash = 0;
    if (t.lightning && !f.covered) {
      if (f.elapsed > this.nextFlash) {
        this.nextFlash = f.elapsed + 6 + Math.random() * 12;
        this.flashes++;
        if (!this.reducedMotion) this.flashPulses = [f.elapsed, f.elapsed + 0.18 + Math.random() * 0.12];
        this.pendingRumble = f.elapsed + 1 + Math.random() * 0.8;
      }
      for (const p0 of this.flashPulses) {
        const age = f.elapsed - p0;
        if (age >= 0 && age < 0.35) this.flash = Math.max(this.flash, 1 - age / 0.35);
      }
    }
    if (this.pendingRumble > 0 && f.elapsed >= this.pendingRumble) {
      this.pendingRumble = -1;
      this.onRumble?.(this.state.kind === 'thunder' ? 1 : 0.6);
    }

    // Sky and light blend (DayNight keeps its colours and applies these on top).
    const dn = this.dayNight.weather;
    dn.cloud = L.cloud;
    dn.grey = L.grey;
    dn.fogNear = L.fogNear;
    dn.fogFar = L.fogFar;
    dn.flash = this.flash;
    dn.crisp = this.state.kind === 'clear' ? 1 : 0;

    // Particles follow a point a little ahead of the camera.
    const cam = f.camera;
    cam.getWorldDirection(this.fwd);
    this.fwd.y = 0;
    this.fwd.normalize();
    this.centre.copy(cam.position).addScaledVector(this.fwd, 9);
    this.centre.y = cam.position.y - 2;
    const night = this.dayNight.night;
    const bright = 1 - night * 0.6 - L.cloud * 0.15;
    const scale = QUALITY_SCALE[f.quality] * (f.covered ? COVERED_SCALE : 1);
    const outdoor = f.outdoor;

    const r = this.rain.uniforms;
    r.uTime.value = this.time;
    r.uCenter.value.copy(this.centre);
    r.uVel.value.set(wind * 0.35, -L.fall, wind * 0.15);
    r.uSize.value.y = L.streak;
    r.uBright.value = bright * (1 + this.flash * 1.5);
    this.rain.setCount(outdoor ? L.rain * scale : 0);

    const sn = this.snow.uniforms;
    sn.uTime.value = this.time;
    sn.uCenter.value.copy(this.centre);
    sn.uVel.value.set(wind * 0.18, this.state.kind === 'heavySnow' ? -2.1 : -1.3, wind * 0.08);
    sn.uSway.value = this.reducedMotion ? 0.2 : 0.7;
    sn.uBright.value = Math.max(0.55, bright + 0.15);
    this.snow.setCount(outdoor ? L.snow * scale : 0);

    // Season particles: fewer under rain or snow (and none in heavy weather).
    const calm = t.rain === 0 && t.snow === 0 ? 1 : t.rain > 1000 || t.snow > 1000 ? 0 : 0.4;
    const s = this.season;
    const petalAmt = s.season === 'spring' ? (s.month === 4 ? 1 : 0.55) : 0;
    const leafAmt = s.season === 'autumn' ? (s.month === 10 ? 1 : s.month === 11 ? 0.8 : 0.4) : 0;
    for (const [sys, amt] of [[this.petals, petalAmt], [this.leaves, leafAmt]] as [Particles, number][]) {
      const u = sys.uniforms;
      u.uTime.value = this.time;
      u.uCenter.value.copy(this.centre);
      u.uVel.value.set(0.5 + wind * 0.25, -0.85, 0.25 + wind * 0.1);
      u.uSway.value = this.reducedMotion ? 0.2 : 1.1;
      u.uBright.value = Math.max(0.35, bright);
      sys.setCount(outdoor ? sys.max * amt * calm * scale : 0);
    }
    const ff = this.fireflies.uniforms;
    ff.uTime.value = this.time;
    const ffNight = THREE.MathUtils.clamp((night - 0.55) / 0.3, 0, 1);
    ff.uOpacity.value = ffNight;
    this.fireflies.setCount(outdoor && s.season === 'summer' && ffNight > 0.01 && t.rain === 0 ? FIREFLIES * scale : 0);

    // Clouds: count by kind (quality-scaled a little), drifting slowly round the dome.
    this.cloudGroup.position.set(cam.position.x, 0, cam.position.z);
    if (!this.reducedMotion) this.cloudGroup.rotation.y += dt * 0.006 * (0.5 + wind / 6);
    this.clouds.count = outdoor ? Math.round(L.clouds * (0.6 + 0.4 * QUALITY_SCALE[f.quality])) : 0;
    const shade = L.shade * (1 - night * 0.55);
    this.clouds.material.color.setScalar(shade);
    this.clouds.material.emissiveIntensity = 0.5 * L.shade * (1 - night * 0.8) + this.flash * 0.8;

    this.decor.update(f.elapsed, night, this.reducedMotion);

    // Interiors: the window panes show the same weather.
    const w = windowUniforms;
    w.uTime.value = this.time;
    w.uRain.value = Math.min(1, L.rain / 1100);
    w.uSnow.value = Math.min(1, L.snow / 800);
    w.uGrey.value = L.grey;
    w.uFlash.value = this.flash;
    this.rainLevel = Math.min(1, L.rain / 1400);
  }

  /** Flame lean for the campfire, -1..1 (wind from the west pushes east). */
  get flameLean(): number {
    return this.reducedMotion ? 0 : THREE.MathUtils.clamp(this.state.wind / 12, 0, 0.35);
  }

  describe() {
    const L = this.look;
    const scene = this.dayNight.weather;
    return {
      kind: this.state.kind,
      tempC: this.state.tempC,
      wind: this.state.wind,
      stale: !!this.state.stale,
      season: this.season.season,
      date: `${this.season.month}/${this.season.day}`,
      christmas: this.season.christmas,
      quality: this.quality,
      covered: this.covered,
      counts: {
        rain: this.rain.count,
        snow: this.snow.count,
        petals: this.petals.count,
        leaves: this.leaves.count,
        fireflies: this.fireflies.count,
        clouds: this.clouds.count,
      },
      max: { rain: this.target.rain, snow: this.target.snow },
      fog: { near: +L.fogNear.toFixed(1), far: +L.fogFar.toFixed(1), density: +(1 / Math.max(1, L.fogFar - L.fogNear)).toFixed(4), target: { near: this.target.fogNear, far: this.target.fogFar } },
      cloud: +L.cloud.toFixed(3),
      grey: +L.grey.toFixed(3),
      snowCover: +this.snowCover.toFixed(3),
      wet: +this.wet.toFixed(3),
      flashes: this.flashes,
      flash: +this.flash.toFixed(2),
      sunIntensity: +scene.sunOut.toFixed(3),
      seasonTint: { season: surfaceUniforms.uSeason.value, amount: surfaceUniforms.uSeasonAmt.value },
      decor: this.decor.describe(),
      window: { rain: +windowUniforms.uRain.value.toFixed(2), snow: +windowUniforms.uSnow.value.toFixed(2), grey: +windowUniforms.uGrey.value.toFixed(2) },
      rainLevel: +this.rainLevel.toFixed(2),
    };
  }

  dispose() {
    for (const p of [this.rain, this.snow, this.petals, this.leaves, this.fireflies]) p.dispose();
    this.clouds.geometry.dispose();
    this.clouds.material.dispose();
    this.clouds.dispose();
    this.decor.dispose();
  }
}
