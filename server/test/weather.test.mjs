// 서울 날씨 (MET Norway): symbol mapping, series parsing, conditional requests (304), User-Agent,
// allow-list, stale fallback and change-only broadcasts. fetch is always mocked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapSymbol, parseSeries, pickStep, seasonDefault, seoulIsDay, USER_AGENT, WeatherService, WEATHER_URL } from '../dist/server/src/weather.js';

test('MET symbol codes map to our kinds', () => {
  const cases = [
    ['clearsky_day', 'clear'], ['clearsky_night', 'clear'], ['clearsky_polartwilight', 'clear'],
    ['fair_day', 'partly'], ['partlycloudy_night', 'partly'], ['cloudy', 'cloudy'], ['fog', 'fog'],
    ['lightrain', 'drizzle'], ['lightrainshowers_day', 'drizzle'], ['rain', 'rain'], ['rainshowers_night', 'rain'],
    ['heavyrain', 'heavyRain'], ['heavyrainshowers_day', 'heavyRain'],
    ['rainandthunder', 'thunder'], ['lightssleetshowersandthunder_day', 'thunder'], ['heavysnowandthunder', 'thunder'],
    ['lightsnow', 'snow'], ['snow', 'snow'], ['snowshowers_night', 'snow'], ['heavysnow', 'heavySnow'], ['heavysnowshowers_day', 'heavySnow'],
    ['sleet', 'rain'], ['lightsleet', 'drizzle'], ['heavysleet', 'heavyRain'],
  ];
  for (const [code, kind] of cases) assert.equal(mapSymbol(code, { tempC: 5 }), kind, code);
  for (const bad of ['', 'sunny', 'Rain', 'rain_evening', '../x', 42, null]) assert.equal(mapSymbol(bad), null, String(bad));
});

test('sleet is snow when it is cold; measured amounts make it heavy', () => {
  assert.equal(mapSymbol('sleet', { tempC: 0.5 }), 'snow');
  assert.equal(mapSymbol('heavysleet', { tempC: -2 }), 'heavySnow');
  assert.equal(mapSymbol('rain', { precip: 9 }), 'heavyRain');
  assert.equal(mapSymbol('snow', { precip: 3.5 }), 'heavySnow');
  assert.equal(mapSymbol('rain', { precip: 1 }), 'rain');
});

const step = (time, symbol, temp = 10.8, extra = {}) => ({
  time,
  data: {
    instant: { details: { air_temperature: temp, cloud_area_fraction: 100, wind_speed: 2.4, relative_humidity: 92 } },
    next_1_hours: { summary: { symbol_code: symbol }, details: { precipitation_amount: 0.4, ...extra } },
    next_6_hours: { summary: { symbol_code: 'cloudy' }, details: { precipitation_amount: 1.6 } },
  },
});
const doc = (...steps) => ({ type: 'Feature', properties: { timeseries: steps } });
const T0 = Date.parse('2026-11-14T08:00:00Z'); // 17:00 KST

test('parse the real compact shape; pick the latest step at or before now', () => {
  const series = parseSeries(doc(step('2026-11-14T08:00:00Z', 'lightrain'), step('2026-11-14T09:00:00Z', 'rain_night', 9.5), step('2026-11-14T07:00:00Z', 'cloudy')));
  assert.equal(series.length, 3);
  assert.deepEqual(series.map((s) => s.kind), ['cloudy', 'drizzle', 'rain']);
  const s = pickStep(series, T0 + 30 * 60_000);
  assert.deepEqual(s, { t: T0, kind: 'drizzle', tempC: 10.8, wind: 2.4, cloud: 100, day: null });
  assert.equal(pickStep(series, T0 + 90 * 60_000).day, false);
  assert.equal(pickStep(series, T0 - 2 * 3600_000).kind, 'cloudy', 'before the first step: the nearest');
  assert.equal(pickStep(series, T0 + 12 * 3600_000), null, 'too far past the series');
  // next_1_hours missing → next_6_hours symbol
  const six = parseSeries(doc({ time: '2026-11-14T08:00:00Z', data: { instant: { details: { air_temperature: 3 } }, next_6_hours: { summary: { symbol_code: 'snow' }, details: { precipitation_amount: 24 } } } }));
  assert.equal(six[0].kind, 'heavySnow', '24 mm over 6 h = 4 mm/h');
  for (const bad of [null, 'x', {}, { properties: {} }, doc({ time: 'nope' }), doc(step('2026-11-14T08:00:00Z', 'sunny')), doc(step('2026-11-14T08:00:00Z', 'rain', 500))]) {
    assert.equal(parseSeries(bad), null);
  }
});

test('Seoul daylight approximation', () => {
  assert.equal(seoulIsDay(Date.parse('2026-11-14T03:00:00Z')), true); // 12:00 KST
  assert.equal(seoulIsDay(Date.parse('2026-11-14T12:00:00Z')), false); // 21:00 KST
  assert.equal(seoulIsDay(Date.parse('2026-06-21T10:30:00Z')), true); // 19:30 KST in June
});

test('only https to api.met.no', () => {
  assert.ok(WeatherService.allowed(WEATHER_URL));
  assert.match(WEATHER_URL, /lat=37\.5665&lon=126\.978$/);
  for (const u of ['http://api.met.no/weatherapi', 'https://api.open-meteo.com/v1/forecast', 'https://api.met.no.evil.example/', 'https://user:pw@api.met.no/', 'https://api.met.no:8443/', 'not a url']) {
    assert.equal(WeatherService.allowed(u), false, u);
  }
  assert.throws(() => new WeatherService({ url: 'https://example.com/', live: false }));
});

/** A fake fetch that records requests and answers from a queue. */
function fakeMet(now) {
  const calls = [];
  const queue = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: { ...init.headers }, redirect: init.redirect, signal: !!init.signal });
    const r = queue.shift() ?? { status: 503 };
    if (r.throw) throw new Error(r.throw);
    const headers = new Headers(r.headers ?? {});
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})) };
  };
  return { fn, calls, queue, now };
}
const ok200 = (body, extra = {}) => ({ status: 200, body, headers: { 'last-modified': 'Sat, 14 Nov 2026 08:42:15 GMT', expires: new Date(T0 + 40 * 60_000).toUTCString(), ...extra } });

test('identifying User-Agent, If-Modified-Since, 304 keeps the data, Expires schedules the next request', async () => {
  let now = T0 + 10 * 60_000;
  const m = fakeMet();
  const changes = [];
  const w = new WeatherService({ fetch: m.fn, now: () => now, onChange: (s) => changes.push(s), live: false });
  m.queue.push(ok200(doc(step('2026-11-14T08:00:00Z', 'lightrain'), step('2026-11-14T09:00:00Z', 'heavyrain'))));
  assert.equal(await w.refresh(), true);
  assert.equal(m.calls[0].headers['user-agent'], USER_AGENT);
  assert.equal(USER_AGENT, 'qt-worlds/1.0 https://qt.log2u.me');
  assert.ok(!/@/.test(USER_AGENT), 'no e-mail address');
  assert.equal(m.calls[0].redirect, 'error');
  assert.ok(m.calls[0].signal, 'timeout signal');
  assert.equal(m.calls[0].headers['if-modified-since'], undefined, 'first request is unconditional');
  assert.equal(w.current().kind, 'drizzle');
  assert.equal(w.current().source, 'met-no');
  // Expires is 30 min away (> 15 min): the next request waits for it (plus up to 1 min jitter).
  const d = w.nextDelay(true);
  assert.ok(d >= 30 * 60_000 && d <= 31 * 60_000, `${d}`);
  now = T0 + 70 * 60_000; // past Expires
  assert.ok(w.nextDelay(true) >= 15 * 60_000, 'never sooner than 15 min');
  // 304: the cached series moves on to the 09:00 step by itself.
  m.queue.push({ status: 304, headers: { expires: new Date(T0 + 100 * 60_000).toUTCString() } });
  assert.equal(await w.refresh(), true);
  assert.equal(m.calls[1].headers['if-modified-since'], 'Sat, 14 Nov 2026 08:42:15 GMT');
  assert.equal(w.notModified, 1);
  assert.equal(w.current().kind, 'heavyRain');
  assert.deepEqual(changes.map((c) => c.kind), ['drizzle', 'heavyRain']);
});

test('no reading since startup: season default, clear and stale', async () => {
  const now = Date.parse('2026-11-14T03:00:00Z');
  const changes = [];
  const w = new WeatherService({ fetch: async () => { throw new Error('offline'); }, now: () => now, onChange: (s) => changes.push(s), live: false });
  const s = w.current();
  assert.equal(s.kind, 'clear');
  assert.equal(s.stale, true);
  assert.equal(s.tempC, 7); // November mean
  assert.equal(s.isDay, true);
  assert.equal(await w.refresh(), false);
  assert.equal(w.failures, 1);
  assert.equal(changes.length, 0, 'a failure with nothing to keep changes nothing');
  assert.equal(seasonDefault(Date.parse('2026-07-01T03:00:00Z')).tempC, 26);
});

test('failures and oversized or junk bodies keep the last good value; a long outage turns it stale', async () => {
  let now = T0 + 5 * 60_000;
  const m = fakeMet();
  const changes = [];
  const w = new WeatherService({ fetch: m.fn, now: () => now, onChange: (s) => changes.push(s), live: false });
  const steps = [];
  for (let h = 0; h < 12; h++) steps.push(step(new Date(T0 + h * 3600_000).toISOString(), 'snow', -1));
  m.queue.push(ok200(doc(...steps)));
  assert.equal(await w.refresh(), true);
  assert.equal(w.current().kind, 'snow');
  m.queue.push({ status: 503 }, { status: 200, body: '{"properties":{"timeseries":"nope"}}' }, { status: 200, body: 'x'.repeat(600 * 1024) }, { status: 200, body: '{}', headers: { 'content-length': String(2 * 1024 * 1024) } }, { throw: 'timeout' });
  for (let i = 0; i < 5; i++) assert.equal(await w.refresh(), false);
  assert.equal(w.current().kind, 'snow', 'kept');
  assert.equal(w.current().stale, undefined);
  now += 4 * 3600_000;
  m.queue.push({ status: 503 });
  await w.refresh();
  assert.equal(w.current().kind, 'snow');
  assert.equal(w.current().stale, true);
  assert.deepEqual(changes.map((c) => [c.kind, !!c.stale]), [['snow', false], ['snow', true]]);
});

test('a real-size (~40 KB) forecast parses under the cap', async () => {
  const steps = [];
  for (let h = 0; h < 91; h++) steps.push(step(new Date(T0 + h * 3600_000).toISOString(), h % 2 ? 'partlycloudy_day' : 'cloudy'));
  const body = JSON.stringify(doc(...steps));
  assert.ok(body.length > 30_000, `${body.length}`);
  const m = fakeMet();
  const w = new WeatherService({ fetch: m.fn, now: () => T0 + 60_000, live: false });
  m.queue.push(ok200(body));
  assert.equal(await w.refresh(), true);
  assert.equal(w.current().kind, 'cloudy');
});

test('broadcasts only on a visible change; the test override too', async () => {
  let now = T0 + 60_000;
  const m = fakeMet();
  const changes = [];
  const w = new WeatherService({ fetch: m.fn, now: () => now, onChange: (s) => changes.push(s), live: false });
  m.queue.push(ok200(doc(step('2026-11-14T08:00:00Z', 'clearsky_day', 12.1))));
  await w.refresh(); // default (stale clear) → fresh clear: stale flag differs
  assert.equal(changes.length, 1);
  now += 15 * 60_000;
  m.queue.push(ok200(doc(step('2026-11-14T08:00:00Z', 'clearsky_day', 12.3))));
  await w.refresh();
  assert.equal(changes.length, 1, 'same look, new data: no broadcast');
  m.queue.push(ok200(doc(step('2026-11-14T08:00:00Z', 'rain_day', 12.3))));
  await w.refresh();
  assert.equal(changes.length, 2);
  assert.equal(changes[1].kind, 'rain');
  m.queue.push({ status: 304 });
  await w.refresh();
  assert.equal(changes.length, 2, '304 changes nothing');
  w.setOverride({ kind: 'thunder' });
  assert.equal(changes.length, 3);
  w.setOverride({ kind: 'thunder' });
  assert.equal(changes.length, 3, 'same override twice');
  w.setOverride({ kind: 'nonsense', tempC: 'x' });
  assert.equal(w.current().kind, 'thunder', 'invalid fields ignored');
  w.setOverride(null);
  assert.equal(w.current().kind, 'rain');
  assert.equal(w.broadcasts, changes.length);
});
