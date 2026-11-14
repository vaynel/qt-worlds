// 서울 날씨 + seasons: the server's weather (test override, never MET Norway in tests) reaches every
// client in welcome and live; each kind changes the scene (particles, fog, clouds, light, snow cover,
// wet ground), the HUD clock card ("서울 비 · 12°C") and the 골방/도서관 windows; particle counts follow
// ⚙ 🎨 화면 quality and render-on-demand; seasons and the Christmas window follow the (fake) KST date;
// reduced motion has no lightning flashes; the phone HUD (portrait and landscape) doesn't overlap.
// Screenshots: docs/screenshots/wx-*.png.
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/wx-test.mjs
// Port: TEST_SERVER_PORT (default 5196; one server serving the built client).
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { check, clientDir, debug, dropDb, freshDb, join, launch, rawClient, of, serverDir, shotDir, sleep, startServer, step, stopAll, summary, teleport, until, waitHttp } from './lib/harness.mjs';
import { overlaps } from './lib/tablet.mjs';

const PORT = Number(process.env.TEST_SERVER_PORT ?? 5196);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/`;
const DB = freshDb('wx');
const DIST = resolve(clientDir, 'dist');
for (const f of [resolve(DIST, 'index.html'), resolve(serverDir, 'dist/server/src/index.js')]) {
  if (!existsSync(f)) {
    console.error(`missing ${f}: build first`);
    process.exit(1);
  }
}
const KINDS = ['clear', 'partly', 'cloudy', 'fog', 'drizzle', 'rain', 'heavyRain', 'thunder', 'snow', 'heavySnow'];
const NAMES = { clear: '맑음', partly: '구름 조금', cloudy: '흐림', fog: '안개', drizzle: '이슬비', rain: '비', heavyRain: '큰비', thunder: '뇌우', snow: '눈', heavySnow: '함박눈' };
const RAIN = { drizzle: 520, rain: 1100, heavyRain: 1800, thunder: 1600 };
const SNOW = { snow: 800, heavySnow: 1500 };
const PLAZA_VIEW = { x: 0, z: 9 };
const CAMPFIRE_VIEW = { x: 44, z: -5 };
const GARDEN_VIEW = { x: -45, z: -10 };


/** Console noise that has nothing to do with this feature (headless Chromium, SwiftShader). */
const BENIGN = /web-share|No available adapters|GPU stall|WebGL/i;
const errors = [];
const watch = (page, tag) => {
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !BENIGN.test(m.text())) errors.push(`${tag}: ${m.text()}`);
  });
};
const setWeather = async (body) => {
  const r = await fetch(`${BASE}api/test/weather`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
};
const wx = async (p) => (await debug(p)).wx;
const kindIs = (p, k) => until(p, (kind) => window.__WORLDS_DEBUG__?.wx?.kind === kind && !window.__WORLDS_DEBUG__.wx.stale, k, 15000);
/** Skip the fade, then let a dozen frames run (SwiftShader is slow; debug is published every 5th frame). */
const frames = async (p, n = 12) => {
  const f0 = (await debug(p)).frame;
  await until(p, (f) => window.__WORLDS_DEBUG__.frame >= f, f0 + n, 30000);
};
const settle = async (p) => {
  await p.evaluate(() => window.__WORLDS_TEST__.weatherSnap());
  await frames(p);
};
const waitOk = (p, fn, arg, ms = 15000) => until(p, fn, arg, ms).then(() => true, () => false);
const shot = async (p, name) => {
  await sleep(1200);
  await p.screenshot({ path: resolve(shotDir, `wx-${name}.png`) });
};
const quality = (p, q) =>
  p.evaluate((v) => {
    localStorage.setItem('worlds.graphics.quality', v);
    window.dispatchEvent(new CustomEvent('worlds:graphics', { detail: v }));
  }, q);
const hudBoxes = (p) =>
  p.evaluate(() => {
    const vis = (el) => {
      if (!el) return null;
      const s = getComputedStyle(el);
      if (el.hidden || s.display === 'none' || s.visibility === 'hidden') return null;
      const r = el.getBoundingClientRect();
      return r.width > 1 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    };
    return {
      vw: innerWidth,
      docW: document.documentElement.scrollWidth,
      place: vis(document.querySelector('.place-card')),
      clock: vis(document.querySelector('.clock-card')),
      tools: vis(document.querySelector('#tools')),
      eyebrow: document.querySelector('.clock-card .eyebrow').getBoundingClientRect().width,
      eyebrowScroll: document.querySelector('.clock-card .eyebrow').scrollWidth,
    };
  });

let browser;
try {
  step('server');
  startServer(PORT, DB, { SERVE_CLIENT: '1', WORLDS_CLIENT_DIST: DIST, MAX_CONN_PER_IP: '60' });
  await waitHttp(`${BASE}health`);
  browser = await launch();

  // ------------------------------------------------------------------ protocol
  step('welcome and broadcasts');
  const raw = await rawClient(`ws://127.0.0.1:${PORT}/ws`, { nickname: '날씨원시', test: true });
  await sleep(400);
  const w0 = of(raw, 'welcome')[0]?.weather;
  check('welcome carries the weather (no reading yet: clear, stale, source met-no)', w0?.kind === 'clear' && w0.stale === true && w0.source === 'met-no', JSON.stringify(w0));
  const r1 = await setWeather({ kind: 'rain', tempC: 12, wind: 4, now: Date.parse('2026-11-14T05:00:00Z') });
  const r2 = await setWeather({ kind: 'rain', tempC: 12, wind: 4 });
  await sleep(300);
  const live = of(raw, 'weather');
  check('a change is pushed to everyone as {t:"weather"}', live.length === 1 && live[0].weather.kind === 'rain' && live[0].weather.tempC === 12, JSON.stringify(live));
  check('the same weather again is not re-broadcast', r2.broadcasts === r1.broadcasts && of(raw, 'weather').length === 1);
  check('the fake clock stamps updatedAt', r1.weather.updatedAt === Date.parse('2026-11-14T05:00:00Z'));
  raw.ws.close();
  await setWeather({ reset: true, now: null });

  // ------------------------------------------------------------------ desktop: every kind
  step('desktop kinds');
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const D = await dctx.newPage();
  watch(D, 'desktop');
  await join(D, BASE, '날씨', '?test=1&shadows=0&time=14:00&noguide=1');
  let d = await wx(D);
  check('HUD before any reading: 서울 낮 with no temperature', d.hud === '서울 낮' && d.stale, d.hud);
  await D.click('.clock-card');
  check('tapping the clock shows the source tip (MET Norway)', await waitOk(D, () => !document.getElementById('clock-tip').hidden && document.getElementById('clock-tip').textContent.includes('MET Norway'), null, 3000));
  await D.click('.clock-card');

  await teleport(D, PLAZA_VIEW);
  let clearSun = 0;
  for (const kind of KINDS) {
    await setWeather({ kind, tempC: 12, wind: 4 });
    await kindIs(D, kind);
    await settle(D);
    d = await wx(D);
    const hud = kind === 'clear' ? '서울 낮 · 12°C' : `서울 ${NAMES[kind]} · 12°C`;
    check(`${kind}: HUD reads "${hud}" with ${kind === 'clear' ? 'the drawn sun' : 'a weather icon'}`, d.hud === hud && (kind === 'clear' ? true : (await D.$('#clock-icon svg')) !== null), d.hud);
    if (kind === 'clear') clearSun = d.sunIntensity;
    const rain = RAIN[kind] ?? 0;
    const snow = SNOW[kind] ?? 0;
    check(`${kind}: rain ${rain}, snow ${snow} particles (sharp quality)`, d.counts.rain === rain && d.counts.snow === snow, JSON.stringify(d.counts));
    if (kind === 'clear') check('clear: no clouds, open fog, full sun', d.counts.clouds === 0 && d.fog.far >= 100 && d.cloud === 0);
    if (kind === 'partly' || kind === 'cloudy') check(`${kind}: instanced clouds in the sky`, d.counts.clouds > 0, `${d.counts.clouds}`);
    if (kind === 'cloudy') check('cloudy: the sun is dimmed and the sky greyed', d.sunIntensity < clearSun * 0.6 && d.grey > 0.4, `${d.sunIntensity} vs ${clearSun}`);
    if (kind === 'fog') check('fog: dense fog (far ≤ 45 m) and a desaturated sky', d.fog.far <= 45 && d.fog.near <= 6 && d.grey > 0.7, JSON.stringify(d.fog));
    if (rain) check(`${kind}: darker light and wet ground`, d.sunIntensity < clearSun * 0.5 && d.wet === 1 && d.rainLevel > 0, `${d.sunIntensity} wet ${d.wet}`);
    if (kind === 'thunder') {
      await D.evaluate(() => window.__WORLDS_TEST__.weatherFlashSoon());
      check('thunder: lightning flashes come', await waitOk(D, () => window.__WORLDS_DEBUG__.wx.flashes > 0, null, 25000));
    }
    if (kind === 'clear') await shot(D, 'clear-day');
    if (kind === 'cloudy') {
      await D.evaluate(() => window.__WORLDS_TEST__.view(Math.PI, 0.02));
      await shot(D, 'cloudy');
      await D.evaluate(() => window.__WORLDS_TEST__.view(Math.PI, 0.35));
    }
    if (kind === 'fog') await shot(D, 'fog');
  }

  step('quality scaling');
  await setWeather({ kind: 'rain' });
  await kindIs(D, 'rain');
  await settle(D);
  const counts = {};
  for (const q of ['saver', 'normal', 'sharp']) {
    await quality(D, q);
    await frames(D);
    counts[q] = (await wx(D)).counts.rain;
  }
  check('rain particles follow 화면 quality (30 % / 60 % / 100 %)', counts.saver === 330 && counts.normal === 660 && counts.sharp === 1100, JSON.stringify(counts));
  const calls = (await debug(D)).renderer.calls;
  check('one draw call per particle system (draw calls stay modest)', calls < 400, `${calls}`);

  step('snow cover');
  await setWeather({ kind: 'snow', tempC: -1 });
  await kindIs(D, 'snow');
  await D.evaluate(() => window.__WORLDS_TEST__.weatherRate(120));
  check('snow settles on the ground over time (cover → 1)', await waitOk(D, () => window.__WORLDS_DEBUG__.wx.snowCover > 0.98, null, 20000));
  await D.evaluate(() => window.__WORLDS_TEST__.weatherRate(1));
  await D.evaluate(() => window.__WORLDS_TEST__.view(Math.PI + 0.5, 0.42));
  await shot(D, 'snow-plaza');
  await setWeather({ kind: 'clear', tempC: 2 });
  await kindIs(D, 'clear');
  await D.evaluate(() => window.__WORLDS_TEST__.weatherRate(120));
  const melting = await waitOk(D, () => window.__WORLDS_DEBUG__.wx.snowCover < 0.9, null, 10000);
  check('after the snow stops it melts back slowly', melting && (await wx(D)).snowCover > 0, `${(await wx(D)).snowCover}`);
  await D.evaluate(() => window.__WORLDS_TEST__.snowCover(0));
  await D.evaluate(() => window.__WORLDS_TEST__.weatherRate(1));

  step('seasons');
  const season = async (date) => {
    await D.evaluate((v) => window.__WORLDS_TEST__.weatherDate(v), date);
    await frames(D);
    return wx(D);
  };
  d = await season('2026-04-10');
  check('spring: cherry petals fall and blossom trees stand near the plaza', d.season === 'spring' && d.counts.petals > 0 && d.decor.blossoms >= 3, JSON.stringify({ p: d.counts.petals, b: d.decor.blossoms }));
  await D.evaluate(() => window.__WORLDS_TEST__.view(Math.PI - 0.6, 0.3));
  await shot(D, 'spring-petals');
  d = await season('2026-10-20');
  check('autumn: warm foliage tint and falling leaves (no blossoms)', d.season === 'autumn' && d.seasonTint.season === 1 && d.counts.leaves > 0 && d.decor.blossoms === 0);
  await shot(D, 'autumn-leaves');
  d = await season('2026-01-20');
  check('winter: bare-ish tint, no petals or leaves', d.season === 'winter' && d.seasonTint.season === 2 && d.counts.petals === 0 && d.counts.leaves === 0);
  d = await season('2026-07-20');
  check('summer: no tint; fireflies wait for the night', d.season === 'summer' && d.seasonTint.amount === 0 && d.counts.fireflies === 0);
  const xmas = [];
  for (const date of ['2026-12-17', '2026-12-18', '2026-12-25', '2026-12-26', '2026-12-27']) xmas.push((await season(date)).christmas);
  check('Christmas window is Dec 18–26 (KST)', JSON.stringify(xmas) === '[false,true,true,true,false]', JSON.stringify(xmas));
  d = await season('2026-12-24');
  check('Christmas: a star and lights on the signpost and around the campfire', d.decor.christmas && d.decor.bulbs > 40);
  await D.evaluate(() => window.__WORLDS_TEST__.weatherDate(null));

  step('interiors');
  await setWeather({ kind: 'heavyRain' });
  await kindIs(D, 'heavyRain');
  const door = await D.evaluate(() => window.__WORLDS_TEST__.closetDoor());
  await teleport(D, door);
  await until(D, () => document.getElementById('action-btn').textContent.includes('골방'));
  await D.keyboard.press('KeyE');
  await until(D, () => window.__WORLDS_DEBUG__.m3.closet === true);
  await settle(D);
  d = await debug(D);
  check('골방: rain on the window, none of the outdoor particles', d.wx.window.rain === 1 && d.wx.counts.rain === 0 && d.wx.window.grey > 0.3, JSON.stringify(d.wx.window));
  check('골방: the rain ambience is muffled', d.m3.audio.mix.muffle === 1 && d.m3.audio.mix.rain > 0, JSON.stringify(d.m3.audio.mix));
  check('골방: HUD still shows the weather', /^서울 큰비 · -?\d+°C$/.test(d.wx.hud), d.wx.hud);
  await D.mouse.move(640, 360);
  await D.mouse.down();
  await D.mouse.move(980, 380, { steps: 10 });
  await D.mouse.up();
  await shot(D, 'closet-rain');
  await D.click('#closet-exit');
  await waitOk(D, () => window.__WORLDS_DEBUG__.m3.closet === false, null, 10000);
  await setWeather({ kind: 'snow' });
  await kindIs(D, 'snow');
  await D.evaluate(() => window.__WORLDS_TEST__.enterLibrary());
  await until(D, () => window.__WORLDS_DEBUG__.la.inLibrary === true);
  await settle(D);
  d = await wx(D);
  check('도서관: snow falls past the windows', d.window.snow === 1 && d.counts.snow === 0);
  await D.evaluate(() => window.__WORLDS_TEST__.view(-Math.PI / 2 + 0.35, 0.25));
  await shot(D, 'library-snow');
  await D.evaluate(() => window.__WORLDS_TEST__.leaveLibrary());
  await until(D, () => window.__WORLDS_DEBUG__.la.inLibrary === false);

  step('settings credit');
  await D.evaluate(() => window.__WORLDS_TEST__.openSettings('display'));
  check('⚙ 🎨 화면 credits MET Norway (CC BY 4.0)', await waitOk(D, () => [...document.querySelectorAll('.wx-credit')].some((e) => e.textContent.includes('MET Norway (CC BY 4.0)')), null, 5000));
  await D.keyboard.press('Escape');
  const terms = await (await fetch(`${BASE}terms`)).text();
  const privacy = await (await fetch(`${BASE}privacy`)).text();
  check('/terms credits MET Norway, /privacy says no personal data is sent', terms.includes('MET Norway') && terms.includes('CC BY 4.0') && privacy.includes('MET Norway') && privacy.includes('보내지 않으며'));

  // ------------------------------------------------------------------ dusk at the campfire (reduced motion)
  step('dusk, reduced motion');
  const rctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const R = await rctx.newPage();
  watch(R, 'dusk');
  await setWeather({ kind: 'thunder', tempC: 9, wind: 6 });
  await join(R, BASE, '해질녘', '?test=1&shadows=0&time=17:25&noguide=1');
  check('a late joiner gets the current weather in welcome', (await wx(R)).kind === 'thunder');
  await teleport(R, CAMPFIRE_VIEW);
  await settle(R);
  let maxFlash = 0;
  await R.evaluate(() => window.__WORLDS_TEST__.weatherFlashSoon());
  await waitOk(R, () => window.__WORLDS_DEBUG__.wx.flashes > 0, null, 20000);
  for (let i = 0; i < 6; i++) {
    maxFlash = Math.max(maxFlash, (await wx(R)).flash);
    await sleep(100);
  }
  d = await wx(R);
  check('reduced motion: thunder without lightning flashes', d.flashes > 0 && maxFlash === 0 && d.flash === 0, `flashes ${d.flashes} max ${maxFlash}`);
  await setWeather({ kind: 'rain', tempC: 9, wind: 6 });
  await kindIs(R, 'rain');
  await settle(R);
  await R.evaluate(() => window.__WORLDS_TEST__.view(-0.9, 0.2));
  await shot(R, 'rain-campfire-dusk');
  await R.evaluate(() => window.__WORLDS_TEST__.weatherDate('2026-12-24'));
  await setWeather({ kind: 'clear', tempC: -3, wind: 2 });
  await kindIs(R, 'clear');
  await settle(R);
  await teleport(R, { x: 7, z: 9 });
  await R.evaluate(() => window.__WORLDS_TEST__.view(-0.75, 0.22));
  await shot(R, 'christmas-plaza');
  await teleport(R, { x: 43, z: -3 });
  await R.evaluate(() => window.__WORLDS_TEST__.view(-0.6, 0.3));
  await shot(R, 'christmas-campfire');

  // ------------------------------------------------------------------ phone: HUD, render on demand, fireflies
  step('phone HUD');
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const P = await pctx.newPage();
  watch(P, 'phone');
  await setWeather({ kind: 'partly', tempC: -12, wind: 3 });
  await join(P, BASE, '폰날씨', '?test=1&shadows=0&time=21:40&noguide=1');
  for (const kind of ['partly', 'heavySnow', 'thunder']) {
    await setWeather({ kind, tempC: -12 });
    await kindIs(P, kind);
    await frames(P, 6);
    const b = await hudBoxes(P);
    check(`phone portrait (${NAMES[kind]} · -12°C): clock fits, no overlap, no sideways scroll`, !!b.clock && !overlaps(b.clock, b.place) && !overlaps(b.clock, b.tools) && b.clock.x + b.clock.width <= b.vw && b.docW <= b.vw && b.eyebrowScroll <= b.eyebrow + 1, JSON.stringify(b));
  }
  await setWeather({ kind: 'rain', tempC: 12 });
  await kindIs(P, 'rain');
  await settle(P);
  await shot(P, 'hud-phone');
  const full = (await wx(P)).counts.rain;
  await P.tap('#btn-settings');
  await P.waitForSelector('.settings-menu');
  const covered = await waitOk(P, () => window.__WORLDS_DEBUG__.wx.covered === true && window.__WORLDS_DEBUG__.renderer.sheetCovers, null, 8000);
  const under = (await wx(P)).counts.rain;
  check('under a covering phone sheet the particles drop (render on demand)', covered && under > 0 && under <= Math.ceil(full * 0.3), `${full} → ${under}`);
  await P.evaluate(() => document.querySelector('.overlay.shown .sheet-close, .overlay.shown [aria-label="닫기"]')?.click());
  await P.keyboard.press('Escape').catch(() => {});
  await waitOk(P, () => window.__WORLDS_DEBUG__.wx.covered === false, null, 8000);
  await P.evaluate(() => window.__WORLDS_TEST__.weatherDate('2026-07-20'));
  await setWeather({ kind: 'clear', tempC: 24 });
  await kindIs(P, 'clear');
  await teleport(P, GARDEN_VIEW);
  await settle(P);
  d = await wx(P);
  check('summer night: fireflies near 기도의 뜰 and the campfire', d.season === 'summer' && d.counts.fireflies > 0, `${d.counts.fireflies}`);
  await P.evaluate(() => window.__WORLDS_TEST__.view(Math.PI * 0.75, 0.3));
  await shot(P, 'summer-fireflies');

  step('phone landscape HUD');
  const lctx = await browser.newContext({ viewport: { width: 844, height: 390 }, screen: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const L = await lctx.newPage();
  watch(L, 'landscape');
  await join(L, BASE, '가로날씨', '?test=1&shadows=0&time=14:00&noguide=1');
  for (const kind of ['partly', 'heavySnow']) {
    await setWeather({ kind, tempC: -12 });
    await kindIs(L, kind);
    await frames(L, 6);
    const b = await hudBoxes(L);
    check(`phone landscape (${NAMES[kind]}): clock fits, no overlap`, !!b.clock && !overlaps(b.clock, b.place) && !overlaps(b.clock, b.tools) && b.clock.x + b.clock.width <= b.vw && b.docW <= b.vw, JSON.stringify(b));
  }
  await shot(L, 'hud-phone-landscape');

  check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
} catch (err) {
  check(`unexpected error`, false, err?.stack ?? String(err));
} finally {
  await browser?.close();
  await stopAll();
  dropDb(DB);
}
process.exit(summary());
