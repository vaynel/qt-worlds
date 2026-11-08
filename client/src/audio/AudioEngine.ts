/**
 * Procedural ambience with Web Audio only (no audio files):
 *   wind (outdoors), campfire crackle, quiet room tone (골방), and small UI cues.
 *
 * Bus layout:  [wind|fire|room] -> ambience ┐
 *                        [chime|page] -> ui ├-> master -> destination
 * The context is created on the first user gesture (browser autoplay rules).
 */

const SETTINGS_KEY = 'worlds.audioSettings.v1';
/** Bus gains at 100 %. Sliders scale these. */
const MASTER_MAX = 0.9;
const AMBIENCE_MAX = 0.5;
const UI_MAX = 0.6;
/** Ambience is multiplied by this while worship plays. */
const DUCK_FACTOR = 0.3;

/** User-facing levels, 0..100, persisted in localStorage. */
export interface AudioSettings {
  master: number;
  /** 환경음 */
  ambience: number;
  /** 찬양 (YouTube setVolume) */
  worship: number;
  /** 효과음 */
  ui: number;
  muted: boolean;
  /** Mute only the worship video (player's own mute button). */
  worshipMuted: boolean;
  /** 음성: voices in a voice prayer room. */
  voice: number;
}

/**
 * Defaults: ambience at 35 % of AMBIENCE_MAX = 0.175, about a third of the
 * M3 level (0.55), which users found too loud.
 */
export const DEFAULT_AUDIO_SETTINGS: AudioSettings = { master: 80, ambience: 35, worship: 70, ui: 60, muted: false, worshipMuted: false, voice: 90 };

const clamp100 = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : fallback;

function loadSettings(): AudioSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<AudioSettings> | null;
    if (raw && typeof raw === 'object') {
      const d = DEFAULT_AUDIO_SETTINGS;
      return {
        master: clamp100(raw.master, d.master),
        ambience: clamp100(raw.ambience, d.ambience),
        worship: clamp100(raw.worship, d.worship),
        ui: clamp100(raw.ui, d.ui),
        muted: raw.muted === true,
        worshipMuted: raw.worshipMuted === true,
        voice: clamp100(raw.voice, d.voice),
      };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_AUDIO_SETTINGS };
}

export interface AmbienceMix {
  /** 0..1 outdoor wind. */
  wind: number;
  /** 0..1 campfire nearness. */
  fire: number;
  /** 0..1 inside the private room. */
  room: number;
}

function noiseBuffer(ctx: AudioContext, seconds: number, kind: 'white' | 'pink' | 'brown'): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, last = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    if (kind === 'white') data[i] = white;
    else if (kind === 'pink') {
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.16;
    } else {
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2;
    }
  }
  // Fade the loop seam.
  const fade = Math.min(2048, length / 4);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    data[i] *= t;
    data[length - 1 - i] *= t;
  }
  return buffer;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private ambience!: GainNode;
  private ui!: GainNode;
  private windGain!: GainNode;
  private fireGain!: GainNode;
  private roomGain!: GainNode;
  private crackleBus!: GainNode;
  private whiteBuffer!: AudioBuffer;
  private nextCrackle = 0;
  private mix: AmbienceMix = { wind: 1, fire: 0, room: 0 };
  private ducked = false;
  private voiceDucked = false;
  settings: AudioSettings = loadSettings();
  private readonly listeners = new Set<(s: AudioSettings) => void>();

  constructor() {
    const unlock = () => {
      this.unlock();
      if (this.ctx) {
        window.removeEventListener('pointerdown', unlock, true);
        window.removeEventListener('keydown', unlock, true);
      }
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  get muted(): boolean {
    return this.settings.muted;
  }

  /** Called whenever a setting changes (also used for the YouTube volume). */
  onSettingsChange(fn: (s: AudioSettings) => void) {
    this.listeners.add(fn);
  }

  /** Target bus gains for the current settings. */
  private targets() {
    const s = this.settings;
    return {
      master: s.muted ? 0 : (MASTER_MAX * s.master) / 100,
      ambience: ((AMBIENCE_MAX * s.ambience) / 100) * (this.ducked ? DUCK_FACTOR : 1) * (this.voiceDucked ? DUCK_FACTOR : 1),
      ui: (UI_MAX * s.ui) / 100,
    };
  }

  private applyBuses(seconds = 0.15) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = this.targets();
    this.master.gain.setTargetAtTime(t.master, ctx.currentTime, seconds);
    this.ambience.gain.setTargetAtTime(t.ambience, ctx.currentTime, seconds);
    this.ui.gain.setTargetAtTime(t.ui, ctx.currentTime, seconds);
  }

  update(patch: Partial<AudioSettings>) {
    const s = this.settings;
    this.settings = {
      master: patch.master !== undefined ? clamp100(patch.master, s.master) : s.master,
      ambience: patch.ambience !== undefined ? clamp100(patch.ambience, s.ambience) : s.ambience,
      worship: patch.worship !== undefined ? clamp100(patch.worship, s.worship) : s.worship,
      ui: patch.ui !== undefined ? clamp100(patch.ui, s.ui) : s.ui,
      muted: patch.muted !== undefined ? patch.muted === true : s.muted,
      worshipMuted: patch.worshipMuted !== undefined ? patch.worshipMuted === true : s.worshipMuted,
      voice: patch.voice !== undefined ? clamp100(patch.voice, s.voice) : s.voice,
    };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
    this.applyBuses();
    for (const fn of this.listeners) fn(this.settings);
  }

  /** Must run inside a user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;

    const t = this.targets();
    this.master = ctx.createGain();
    this.master.gain.value = t.master;
    this.master.connect(ctx.destination);
    this.ambience = ctx.createGain();
    this.ambience.gain.value = t.ambience;
    this.ambience.connect(this.master);
    this.ui = ctx.createGain();
    this.ui.gain.value = t.ui;
    this.ui.connect(this.master);

    this.whiteBuffer = noiseBuffer(ctx, 1, 'white');
    this.buildWind(ctx);
    this.buildFire(ctx);
    this.buildRoom(ctx);
    this.applyMix(0.1);
    void ctx.resume();
  }

  private loop(ctx: AudioContext, buffer: AudioBuffer): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.start();
    return src;
  }

  private lfo(ctx: AudioContext, freq: number, depth: number, target: AudioParam) {
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.value = depth;
    osc.connect(gain).connect(target);
    osc.start();
  }

  /** Soft wind: pink noise through a slowly wandering band-pass. */
  private buildWind(ctx: AudioContext) {
    const src = this.loop(ctx, noiseBuffer(ctx, 4, 'pink'));
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 420;
    band.Q.value = 0.7;
    const swell = ctx.createGain();
    swell.gain.value = 0.55;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    src.connect(band).connect(swell).connect(this.windGain).connect(this.ambience);
    this.lfo(ctx, 0.06, 220, band.frequency);
    this.lfo(ctx, 0.11, 0.3, swell.gain);
  }

  /** Campfire: low brown-noise roar plus random crackles (see tick()). */
  private buildFire(ctx: AudioContext) {
    this.fireGain = ctx.createGain();
    this.fireGain.gain.value = 0;
    this.fireGain.connect(this.ambience);
    const roar = this.loop(ctx, noiseBuffer(ctx, 3, 'brown'));
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 380;
    const roarGain = ctx.createGain();
    roarGain.gain.value = 0.5;
    roar.connect(low).connect(roarGain).connect(this.fireGain);
    this.crackleBus = ctx.createGain();
    this.crackleBus.gain.value = 0.8;
    this.crackleBus.connect(this.fireGain);
  }

  /** 골방: a very quiet, warm room tone. */
  private buildRoom(ctx: AudioContext) {
    const src = this.loop(ctx, noiseBuffer(ctx, 3, 'brown'));
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 220;
    this.roomGain = ctx.createGain();
    this.roomGain.gain.value = 0;
    const level = ctx.createGain();
    level.gain.value = 0.35;
    src.connect(low).connect(level).connect(this.roomGain).connect(this.ambience);
  }

  private crackle(ctx: AudioContext, when: number) {
    const src = ctx.createBufferSource();
    src.buffer = this.whiteBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 1800 + Math.random() * 2600;
    hp.Q.value = 1.2;
    const g = ctx.createGain();
    const peak = 0.25 + Math.random() * 0.6;
    const len = 0.012 + Math.random() * 0.05;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, when + len);
    src.connect(hp).connect(g).connect(this.crackleBus);
    src.start(when, Math.random() * 0.8, len + 0.02);
  }

  setMix(mix: AmbienceMix) {
    const changed =
      Math.abs(mix.wind - this.mix.wind) > 0.02 || Math.abs(mix.fire - this.mix.fire) > 0.02 || Math.abs(mix.room - this.mix.room) > 0.02;
    this.mix = mix;
    if (changed) this.applyMix(0.6);
  }

  private applyMix(seconds: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.windGain.gain.setTargetAtTime(this.mix.wind * 0.6, t, seconds / 3);
    this.fireGain.gain.setTargetAtTime(this.mix.fire * 0.9, t, seconds / 3);
    this.roomGain.gain.setTargetAtTime(this.mix.room * 0.8, t, seconds / 3);
  }

  /** Call every frame: schedules campfire crackles. */
  tick() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.mix.fire < 0.05) return;
    const now = ctx.currentTime;
    if (this.nextCrackle < now) this.nextCrackle = now;
    while (this.nextCrackle < now + 0.25) {
      this.crackle(ctx, this.nextCrackle);
      // Bursty spacing: mostly sparse pops with occasional clusters.
      this.nextCrackle += Math.random() < 0.25 ? 0.02 + Math.random() * 0.05 : 0.08 + Math.random() * 0.45;
    }
  }

  /** Lower ambience while worship video plays. */
  duck(on: boolean) {
    if (on === this.ducked) return;
    this.ducked = on;
    this.applyBuses(0.4);
  }

  /** In a voice room: keep ambience quiet so voices are clear. */
  duckForVoice(on: boolean) {
    if (on === this.voiceDucked) return;
    this.voiceDucked = on;
    this.applyBuses(0.4);
  }

  get isDucked(): boolean {
    return this.ducked;
  }

  setMuted(muted: boolean) {
    this.update({ muted });
  }

  /** Two soft bell tones: the letter has arrived. */
  chime() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    [659.25, 987.77, 1318.5].forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      const start = t + i * 0.18;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(0.18 / (i + 1), start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0005, start + 2.2);
      osc.connect(g).connect(this.ui);
      osc.start(start);
      osc.stop(start + 2.3);
    });
  }

  /** Paper rustle when a page unfolds. */
  page() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.whiteBuffer;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 0.8;
    band.frequency.setValueAtTime(900, t);
    band.frequency.linearRampToValueAtTime(3200, t + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    src.connect(band).connect(g).connect(this.ui);
    src.start(t, 0, 0.5);
  }

  describe() {
    const r = (v: number) => Math.round(v * 1000) / 1000;
    const t = this.targets();
    return {
      running: this.running,
      muted: this.muted,
      ducked: this.ducked,
      mix: { ...this.mix },
      settings: { ...this.settings },
      targets: { master: r(t.master), ambience: r(t.ambience), ui: r(t.ui) },
      // Live AudioParam values (they glide toward the targets).
      gains: this.ctx ? { master: r(this.master.gain.value), ambience: r(this.ambience.gain.value), ui: r(this.ui.gain.value) } : null,
    };
  }
}
