// Picture guide images: real in-game screenshots for the first-time guide (ui/Guide.ts).
// Re-run whenever the look of the world changes (landmarks, lighting, avatars, sheets):
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/make-guide-shots.mjs
// What it does: one production-like server (SERVE_CLIENT, mock login, test mode, throwaway DB)
// on port 5196, fixed time of day (?time=), clear weather (/api/test/weather + the client hook),
// a fixed season date, posed raw-protocol bots, HUD hidden, then each scene is captured at
// 960×720 and downscaled to 640×480 WebP (quality stepped down until ≤ 40 KB) into
// client/public/guide/. Nothing in the frames shows emoji (headless Chromium has no emoji font).
// Port: GUIDE_SHOTS_PORT (default 5196). VERBOSE=1 prints server logs. KEEP_PNG=1 also writes PNGs to docs/screenshots.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clientDir, debug, dropDb, freshDb, launch, of, rawClient, serverDir, shotDir, sleep, startServer, stopAll, teleport, until, waitHttp } from './lib/harness.mjs';

const PORT = Number(process.env.GUIDE_SHOTS_PORT ?? 5196);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const OUT = resolve(clientDir, 'public/guide');
const DB = freshDb('guide-shots');
const SEASON_DATE = '2026-10-12'; // warm autumn colours, no snow, no Christmas lights
const W = 640;
const H = 480;
const MAX_BYTES = 40 * 1024;
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = (n) => !ONLY || ONLY.includes(n);
const P = await import(pathToFileURL(resolve(serverDir, 'dist/shared/protocol.js')).href);
mkdirSync(OUT, { recursive: true });

const Q = (time, extra = '') => `?test=1&noguide=1&shadows=1&time=${time}${extra}`;
/** Hide every HUD element; only the world canvas (and, when asked, one sheet) stays. */
const HIDE_HUD = `
  #app > *:not(#world-canvas):not(.overlay) { visibility: hidden !important; }
  .overlay:not(.keep-shot) { visibility: hidden !important; }
  .overlay.keep-shot { background: rgba(30, 20, 12, 0.18) !important; }
`;

async function encode(browser, png) {
  const page = await browser.newPage();
  const out = await page.evaluate(
    async ({ b64, w, h, max }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      // Cover-crop to the target aspect.
      const s = Math.max(w / img.width, h / img.height);
      const sw = w / s;
      const sh = h / s;
      ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, w, h);
      for (let q = 0.9; q >= 0.3; q -= 0.05) {
        const url = c.toDataURL('image/webp', q);
        const bytes = Math.floor(((url.length - url.indexOf(',') - 1) * 3) / 4);
        if (bytes <= max || q < 0.35) return { url, q: +q.toFixed(2), bytes };
      }
      return null;
    },
    { b64: png.toString('base64'), w: W, h: H, max: MAX_BYTES },
  );
  await page.close();
  return { buf: Buffer.from(out.url.split(',')[1], 'base64'), q: out.q };
}

async function shoot(browser, page, name, clip) {
  await page.addStyleTag({ content: HIDE_HUD });
  await sleep(900);
  const png = await page.screenshot(clip ? { clip } : {});
  if (process.env.KEEP_PNG) writeFileSync(resolve(shotDir, `guide-src-${name}.png`), png);
  const { buf, q } = await encode(browser, png);
  writeFileSync(resolve(OUT, `${name}.webp`), buf);
  console.log(`${name}.webp  ${(buf.length / 1024).toFixed(1)} KB  (q ${q})`);
  return buf.length;
}

class Agent {
  jar = new Map();
  cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async json(method, path, body) {
    const res = await fetch(new URL(path, BASE), {
      method,
      redirect: 'manual',
      headers: { ...(this.jar.size ? { cookie: this.cookie() } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (pair.slice(i + 1)) this.jar.set(pair.slice(0, i), pair.slice(i + 1));
      else this.jar.delete(pair.slice(0, i));
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* none */
    }
    return { status: res.status, data, location: res.headers.get('location') };
  }
  async login(hint, nickname) {
    let url = `${BASE}api/auth/google/start?hint=${hint}&remember=1`;
    for (let i = 0; i < 6; i++) {
      const r = await this.json('GET', url);
      if (!r.location || !r.location.includes('/api/')) break;
      url = new URL(r.location, url).toString();
    }
    await this.json('POST', '/api/me/nickname', { nickname, agree: true });
    return this;
  }
}

/** A page that has entered as a guest, world ready, weather clear, season fixed. */
async function enter(browser, time, extra = '') {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(BASE + Q(time, extra));
  await page.waitForSelector('#entry-signed-out:not([hidden])');
  await page.fill('#nickname', '은혜');
  await page.click('#entry-submit');
  await until(page, () => window.__WORLDS_DEBUG__?.ready && window.__WORLDS_DEBUG__.net?.status === 'online', null, 120000);
  await page.evaluate((d) => {
    const t = window.__WORLDS_TEST__;
    t.weather({ kind: 'clear', cloud: 0.1, wind: 1, stale: false });
    t.weatherDate(d);
    t.weatherSnap();
    t.ownTag(false);
  }, SEASON_DATE);
  return { ctx, page };
}

const bots = [];
async function bot(nickname, x, z, yaw = 0) {
  const c = await rawClient(WS, { nickname, test: true });
  bots.push(c);
  c.send({ t: 'state', x, y: 3, z, yaw, speed: 0 });
  await sleep(150);
  return c;
}

let browser;
let total = 0;
try {
  startServer(PORT, DB, { WORLDS_AUTH_MOCK: '1', SERVE_CLIENT: '1', WORLDS_CLIENT_DIST: resolve(clientDir, 'dist'), MAX_CONN_PER_IP: '80', AUTH_RATE_LIMIT: '300' });
  await waitHttp(`${BASE}health`);
  await fetch(`${BASE}api/test/weather`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'clear', tempC: 18, wind: 1, cloud: 0.1, isDay: true }) });
  browser = await launch();

  // 1. The letter flying in (a fresh guest: today's letter is still pending).
  if (want('letter')) {
    const { ctx, page } = await enter(browser, '16:40');
    // Away from the plaza signs, on the path toward the campfire.
    await teleport(page, { x: 22, z: 10 });
    await page.evaluate(() => window.__WORLDS_TEST__.view(0.25, 0.12, -2));
    await until(page, () => ['flying', 'waiting'].includes(window.__WORLDS_DEBUG__.m3.letter), null, 30000);
    await until(page, () => window.__WORLDS_DEBUG__.m3.letter === 'waiting', null, 30000);
    await page.evaluate(() => window.__WORLDS_TEST__.view(0.25, 0.14, -6));
    await sleep(1500);
    total += await shoot(browser, page, 'letter', { x: 140, y: 75, width: 800, height: 600 });
    await ctx.close();
  }

  // 2. The 골방: cross, candle, and the meditation sheet open.
  if (want('closet')) {
    const { ctx, page } = await enter(browser, '19:30');
    const door = await page.evaluate(() => window.__WORLDS_TEST__.closetDoor());
    await teleport(page, { x: door.x, z: door.z + 1.2 });
    await sleep(500);
    await page.keyboard.press('KeyE');
    await until(page, () => window.__WORLDS_DEBUG__.m3.closet === true, null, 20000);
    await sleep(2500);
    await page.click('#closet-meditate');
    await until(page, () => window.__WORLDS_DEBUG__.m3.modal !== null, null, 10000);
    await page.evaluate(() => document.querySelector('.overlay')?.classList.add('keep-shot'));
    total += await shoot(browser, page, 'closet');
    await ctx.close();
  }

  // 3. Lantern hill at dusk with lit lanterns (shared by a few accounts), plus books for the library.
  if (want('lanterns') || want('library')) {
    const today = P.seoulDate();
    const names = ['소망', '믿음', '사랑', '빛나', '온유'];
    const texts = ['오늘도 함께하시는 주님께 감사해요', '두려움 대신 평안을 주셨어요', '이웃을 먼저 사랑하겠습니다', '말씀이 내 발의 등이에요', '작은 일에 충성하기'];
    for (let i = 0; i < names.length; i++) {
      const a = await new Agent().login(`guide-l${i}`, names[i]);
      for (let k = 0; k < 2; k++) {
        const m = await a.json('POST', '/api/wordbook/meditations', { date: today, place: '골방', meditation: texts[(i + k) % texts.length], feeling: '감사', application: '' });
        if (m.data?.id) await a.json('POST', '/api/lanterns', { meditationId: m.data.id, visibility: 'public' });
        // Books for the library shot.
        await a.json('POST', '/api/library/stories', { title: `${names[i]}의 감사 ${k + 1}`, parts: ['힘든 시간에 말씀을 붙들었어요.', '기도하며 조금씩 회복되었어요.', '이제는 매일 감사로 시작해요.'], visibility: 'public' });
      }
      await a.json('POST', '/api/diary', { lines: ['오늘도 감사한 하루였어요'], photoIds: [], visibility: 'public' });
    }
    // Fuller bookcases: extra accounts each add a few testimonies (STORIES_PER_DAY) and today's diary.
    for (let k = 0; k < 24; k++) {
      const a = await new Agent().login(`guide-d${k}`, `책벗${k + 1}`);
      for (let j = 0; j < P.STORIES_PER_DAY - (k % 2); j++) await a.json('POST', '/api/library/stories', { title: `은혜의 기록 ${k + 1}-${j + 1}`, parts: ['말씀을 읽다가 마음이 따뜻해졌어요.', '함께 기도해 준 분들께 감사해요.', '오늘도 한 걸음씩 걸어가요.'], visibility: 'public' });
      await a.json('POST', '/api/diary', { lines: ['오늘도 감사한 하루였어요'], photoIds: [], visibility: 'public' });
    }
  }
  if (want('lanterns')) {
    const { ctx, page } = await enter(browser, '19:15', '&at=lanternHill');
    await until(page, () => window.__WORLDS_DEBUG__.m4.lanterns.length >= 8, null, 20000);
    const ls = (await debug(page)).m4.lanterns;
    const cx = ls.reduce((s, l) => s + l.x, 0) / ls.length;
    const cz = ls.reduce((s, l) => s + l.z, 0) / ls.length;
    // Just south of the ring of lanterns, looking down over it.
    await teleport(page, { x: cx, z: cz + 5.5 });
    await page.evaluate(() => window.__WORLDS_TEST__.view(0, 0.45, -2));
    await sleep(1500);
    total += await shoot(browser, page, 'lanterns', { x: 120, y: 85, width: 720, height: 540 });
    await ctx.close();
  }

  // 4. The campfire in the evening: people on the logs, chat bubbles.
  if (want('campfire')) {
    const seats = P.LOG_SEATS;
    const people = [
      ['요셉', 1, '오늘 말씀 참 좋았어요'],
      ['마리아', 3, null],
      ['다윗', 5, null],
      ['한나', 7, '함께 기도해요'],
    ];
    const clients = [];
    for (const [name, i] of people) {
      const s = seats[i % seats.length];
      const c = await bot(name, s.x, s.z, s.yaw);
      c.send({ t: 'sit', kind: 'log', seat: i % seats.length });
      clients.push(c);
    }
    const { ctx, page } = await enter(browser, '19:50', '&at=campfire');
    const s0 = seats[0];
    await teleport(page, { x: s0.x, z: s0.z });
    await sleep(400);
    await until(page, () => window.__WORLDS_DEBUG__.net.logs?.filter(Boolean).length >= 4, null, 15000).catch(() => undefined);
    await page.evaluate(({ x, z }) => {
      const t = window.__WORLDS_TEST__;
      // Look at the fire from just behind the first log.
      t.view(Math.atan2(-(x - 50), -(z - -12)) + Math.PI + 0.45, 0.3, -2);
    }, s0);
    for (let k = 0; k < people.length; k++) if (people[k][2]) clients[k].send({ t: 'chat', text: people[k][2] });
    await sleep(1200);
    total += await shoot(browser, page, 'campfire', { x: 80, y: 20, width: 800, height: 600 });
    await ctx.close();
    for (const c of clients) c.ws.close();
  }

  // 5. The library: the two bookcases.
  if (want('library')) {
    const { ctx, page } = await enter(browser, '15:00');
    await page.evaluate(() => window.__WORLDS_TEST__.enterLibrary());
    await until(page, () => window.__WORLDS_DEBUG__.la.inLibrary === true, null, 20000);
    await sleep(2500);
    const lib = await page.evaluate(() => window.__WORLDS_TEST__.library());
    const f = Object.values(lib.fronts);
    const mx = f.reduce((s, p) => s + p.x, 0) / f.length;
    const mz = f.reduce((s, p) => s + p.z, 0) / f.length;
    await teleport(page, { x: mx, z: mz + 2.5 });
    await page.evaluate(() => window.__WORLDS_TEST__.view(0, 0.14, -1));
    await sleep(1500);
    // The bookcase signs carry emoji (no emoji font headless): crop below them.
    total += await shoot(browser, page, 'library', { x: 120, y: 85, width: 720, height: 540 });
    await ctx.close();
  }

  console.log(`total ${(total / 1024).toFixed(1)} KB`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  for (const c of bots) c.ws.close();
  await browser?.close();
  await stopAll();
  dropDb(DB);
}
