import { kstDateOf, kstTimeOf, WEATHER_KINDS, type WeatherKind, type WeatherState } from '../../shared/protocol.js';

/**
 * 서울 날씨 from MET Norway Locationforecast 2.0 (free, CC BY 4.0, attribution in
 * ⚙ 화면, the HUD tip and /terms). Only the server calls it, with fixed
 * coordinates, an identifying User-Agent (their terms) and nothing about any
 * user. Requests are conditional (If-Modified-Since) and scheduled at
 * max(15 min, Expires). Clients get the compact state over /ws.
 */

/** Seoul City Hall (MET allows at most 4 decimals). */
const LAT = 37.5665;
const LON = 126.978;
/** Outbound requests may only go to these hosts, over https. */
const ALLOWED_HOSTS = new Set(['api.met.no']);
export const WEATHER_URL = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${LAT}&lon=${LON}`;
/** MET requires an identifying User-Agent (no e-mail address here: the repo is public). */
export const USER_AGENT = 'qt-worlds/1.0 https://qt.log2u.me';
const REFRESH_MS = 15 * 60_000;
const JITTER_MS = 60_000;
const RETRY_MS = 5 * 60_000;
const MAX_WAIT_MS = 2 * 3600_000;
const TIMEOUT_MS = 10_000;
/** The compact forecast is ~40 KB; leave plenty of room, refuse anything absurd. */
const MAX_BODY = 512 * 1024;
/** No successful (200 or 304) answer for this long: still shown, but flagged stale. */
const STALE_AFTER_MS = 3 * 3600_000;
/** A forecast step further than this from now is too far to describe "now". */
const MAX_STEP_GAP_MS = 6 * 3600_000;
/** mm in the next hour that make plain rain or snow "heavy". */
const HEAVY_RAIN_MM = 8;
const HEAVY_SNOW_MM = 3;

/** Rough Seoul monthly means (°C), for the startup default only. */
const SEASON_TEMP = [-2, 1, 7, 13, 18, 23, 26, 27, 22, 15, 7, 0];

export interface SymbolExtras {
  /** mm in the next hour (or 6 hours / 6). */
  precip?: number;
  tempC?: number;
}

/** MET symbol_code (with or without _day/_night/_polartwilight) → our kinds. */
export function mapSymbol(symbol: string, extras: SymbolExtras = {}): WeatherKind | null {
  if (typeof symbol !== 'string') return null;
  const s = symbol.replace(/_(day|night|polartwilight)$/, '');
  if (!/^[a-z]+$/.test(s)) return null;
  const precip = extras.precip ?? 0;
  if (s.includes('thunder')) return 'thunder';
  if (s === 'clearsky') return 'clear';
  if (s === 'fair' || s === 'partlycloudy') return 'partly';
  if (s === 'cloudy') return 'cloudy';
  if (s === 'fog') return 'fog';
  if (s.includes('sleet')) {
    const cold = extras.tempC !== undefined && extras.tempC <= 1;
    if (cold) return s.startsWith('heavy') ? 'heavySnow' : 'snow';
    return s.startsWith('heavy') ? 'heavyRain' : s.startsWith('light') ? 'drizzle' : 'rain';
  }
  if (s.includes('snow')) return s.startsWith('heavy') || precip >= HEAVY_SNOW_MM ? 'heavySnow' : 'snow';
  if (s.includes('rain')) {
    if (s.startsWith('heavy') || precip >= HEAVY_RAIN_MM) return 'heavyRain';
    return s.startsWith('light') ? 'drizzle' : 'rain';
  }
  return null;
}

/** Seoul daylight (same approximation as the client's DayNight): solar noon ~12:30 KST. */
export function seoulIsDay(ms: number): boolean {
  const date = kstDateOf(ms);
  const start = Date.UTC(Number(date.slice(0, 4)), 0, 1);
  const doy = Math.floor((Date.parse(`${date}T00:00:00Z`) - start) / 86_400_000) + 1;
  const dayLength = 12.15 + 2.55 * Math.sin((2 * Math.PI * (doy - 80)) / 365);
  const [h, m] = kstTimeOf(ms).split(':').map(Number);
  const hours = h + m / 60;
  return hours >= 12.5 - dayLength / 2 && hours <= 12.5 + dayLength / 2;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r1 = (v: number) => Math.round(v * 10) / 10;

/** One forecast step, kept small (we hold the whole series between requests). */
export interface Step {
  t: number;
  kind: WeatherKind;
  tempC: number;
  wind: number;
  cloud: number;
  /** From the symbol's _day/_night suffix; null when it has none. */
  day: boolean | null;
}

/** Locationforecast JSON → steps (sorted), or null when the shape is wrong. */
export function parseSeries(json: unknown): Step[] | null {
  const ts = (json as { properties?: { timeseries?: unknown } } | null)?.properties?.timeseries;
  if (!Array.isArray(ts)) return null;
  const out: Step[] = [];
  for (const e of ts.slice(0, 200)) {
    const t = typeof e?.time === 'string' ? Date.parse(e.time) : NaN;
    const d = e?.data;
    const inst = d?.instant?.details;
    const temp = num(inst?.air_temperature);
    if (!Number.isFinite(t) || temp === null || temp < -60 || temp > 60) continue;
    const n1 = d?.next_1_hours;
    const n6 = d?.next_6_hours;
    const symbol = n1?.summary?.symbol_code ?? n6?.summary?.symbol_code;
    if (typeof symbol !== 'string') continue;
    const p1 = num(n1?.details?.precipitation_amount);
    const p6 = num(n6?.details?.precipitation_amount);
    const precip = p1 ?? (p6 !== null ? p6 / 6 : 0);
    const kind = mapSymbol(symbol, { precip, tempC: temp });
    if (!kind) continue;
    const suffix = /_(day|night|polartwilight)$/.exec(symbol)?.[1];
    out.push({
      t,
      kind,
      tempC: r1(temp),
      wind: r1(clamp(num(inst?.wind_speed) ?? 0, 0, 80)),
      cloud: Math.round(clamp(num(inst?.cloud_area_fraction) ?? 0, 0, 100)),
      day: suffix === 'day' || suffix === 'polartwilight' ? true : suffix === 'night' ? false : null,
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out.length ? out : null;
}

/** The step describing `now`: the latest one at or before now, else the nearest. */
export function pickStep(series: Step[], now: number): Step | null {
  let best: Step | null = null;
  for (const s of series) if (s.t <= now) best = s;
  if (!best) best = series[0] ?? null;
  if (!best || Math.abs(now - best.t) > MAX_STEP_GAP_MS) return null;
  return best;
}

/** No reading since startup: a calm, clear day for the season (flagged stale). */
export function seasonDefault(now: number): WeatherState {
  const month = Number(kstDateOf(now).slice(5, 7)) - 1;
  return { kind: 'clear', tempC: SEASON_TEMP[month] ?? 12, wind: 2, cloud: 0, isDay: seoulIsDay(now), updatedAt: now, source: 'met-no', stale: true };
}

/** What clients would see differently (updatedAt alone never re-broadcasts). */
function signature(s: WeatherState): string {
  return `${s.kind}|${Math.round(s.tempC)}|${Math.round(s.wind)}|${Math.round(s.cloud / 10)}|${s.isDay ? 1 : 0}|${s.stale ? 1 : 0}`;
}

export interface WeatherOptions {
  /** Injected in unit tests; defaults to global fetch. */
  fetch?: typeof fetch;
  now?: () => number;
  /** Called only when the visible state changed. */
  onChange?: (s: WeatherState) => void;
  log?: (msg: string) => void;
  /** false: never call out (tests); only the test override sets the weather. */
  live?: boolean;
  url?: string;
}

export class WeatherService {
  now: () => number;
  private readonly doFetch: typeof fetch;
  private readonly url: string;
  private series: Step[] | null = null;
  /** Last 200 or 304 from MET. */
  private okAt = 0;
  private lastModified: string | null = null;
  private expiresAt = 0;
  private override: WeatherState | null = null;
  private lastSig = '';
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Counters for logs and tests. */
  fetches = 0;
  failures = 0;
  notModified = 0;
  broadcasts = 0;

  constructor(private readonly o: WeatherOptions = {}) {
    this.now = o.now ?? (() => Date.now());
    this.doFetch = o.fetch ?? ((...a) => fetch(...a));
    this.url = o.url ?? WEATHER_URL;
    if (!WeatherService.allowed(this.url)) throw new Error('weather url not allowed');
    this.lastSig = signature(this.current());
  }

  static allowed(url: string): boolean {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname) && !u.username && !u.password && !u.port;
    } catch {
      return false;
    }
  }

  /** The state clients see right now. */
  current(): WeatherState {
    if (this.override) return this.override;
    const now = this.now();
    const step = this.series ? pickStep(this.series, now) : null;
    if (!step) return seasonDefault(now);
    const state: WeatherState = {
      kind: step.kind,
      tempC: step.tempC,
      wind: step.wind,
      cloud: step.cloud,
      isDay: step.day ?? seoulIsDay(now),
      updatedAt: this.okAt,
      source: 'met-no',
    };
    if (now - this.okAt > STALE_AFTER_MS) state.stale = true;
    return state;
  }

  private publish() {
    const s = this.current();
    const sig = signature(s);
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.broadcasts++;
    this.o.onChange?.(s);
  }

  /** One (conditional) request. Keeps the current data on 304 or any failure. */
  async refresh(): Promise<boolean> {
    this.fetches++;
    try {
      const headers: Record<string, string> = { accept: 'application/json', 'user-agent': USER_AGENT };
      if (this.lastModified && this.series) headers['if-modified-since'] = this.lastModified;
      const res = await this.doFetch(this.url, { headers, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
      const expires = Date.parse(res.headers?.get?.('expires') ?? '');
      if (Number.isFinite(expires)) this.expiresAt = expires;
      if (res.status === 304) {
        this.notModified++;
        this.okAt = this.now();
        this.publish();
        return true;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = Number(res.headers?.get?.('content-length') ?? 0);
      if (declared > MAX_BODY) throw new Error('response too large');
      const text = await res.text();
      if (text.length > MAX_BODY) throw new Error('response too large');
      const series = parseSeries(JSON.parse(text));
      if (!series) throw new Error('unexpected response');
      this.series = series;
      this.lastModified = res.headers?.get?.('last-modified') ?? null;
      this.okAt = this.now();
      this.publish();
      return true;
    } catch (err) {
      this.failures++;
      if (this.failures <= 3 || this.failures % 20 === 0) this.o.log?.(`weather: MET Norway request failed (${(err as Error).message}); keeping the last value`);
      this.publish(); // a reading may have just gone stale
      return false;
    }
  }

  /** Next request: max(15 min, Expires) plus jitter; 5 min after a failure. */
  nextDelay(ok: boolean): number {
    if (!ok) return RETRY_MS + Math.floor(Math.random() * JITTER_MS);
    const untilExpiry = this.expiresAt - this.now();
    return Math.min(MAX_WAIT_MS, Math.max(REFRESH_MS, untilExpiry)) + Math.floor(Math.random() * JITTER_MS);
  }

  start() {
    if (this.o.live === false) return;
    const loop = async () => {
      if (this.stopped) return;
      const ok = await this.refresh();
      if (this.stopped) return;
      this.timer = setTimeout(() => void loop(), this.nextDelay(ok));
      this.timer.unref?.();
    };
    this.timer = setTimeout(() => void loop(), 500 + Math.floor(Math.random() * 4000));
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /**
   * Test hook (test servers only): pin the weather (partial fields over the
   * current state) or clear the pin with null.
   */
  setOverride(patch: Partial<WeatherState> | null) {
    if (patch === null) this.override = null;
    else {
      const base = this.current();
      const kind = WEATHER_KINDS.includes(patch.kind as WeatherKind) ? (patch.kind as WeatherKind) : base.kind;
      this.override = {
        kind,
        tempC: num(patch.tempC) !== null ? r1(clamp(patch.tempC!, -60, 60)) : base.tempC,
        wind: num(patch.wind) !== null ? r1(clamp(patch.wind!, 0, 80)) : base.wind,
        cloud: num(patch.cloud) !== null ? Math.round(clamp(patch.cloud!, 0, 100)) : base.cloud,
        isDay: typeof patch.isDay === 'boolean' ? patch.isDay : base.isDay,
        updatedAt: this.now(),
        source: 'met-no',
        ...(patch.stale ? { stale: true } : {}),
      };
    }
    this.publish();
  }
}
