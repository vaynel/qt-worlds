// Headless capture of the world at desktop and mobile viewports.
// Usage: start `npm run preview` (port 5180) first, then `npm run screenshots`.
// Saves PNGs to ../docs/screenshots and prints renderer diagnostics + pixel stats.
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../../docs/screenshots');
const base = process.env.WORLDS_URL ?? 'http://127.0.0.1:5180/';
mkdirSync(outDir, { recursive: true });

// Use Playwright's own browser if present, else any cached Chromium build
// (avoids a fresh download on machines that already have one).
function findChromium() {
  if (process.env.WORLDS_CHROME) return process.env.WORLDS_CHROME;
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    /* fall through */
  }
  const cache = resolve(homedir(), '.cache/ms-playwright');
  if (!existsSync(cache)) return undefined;
  const builds = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
  for (const b of builds) {
    const exe = resolve(cache, b, 'chrome-linux64/chrome');
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

async function waitReady(page) {
  await page.waitForFunction(() => window.__WORLDS_DEBUG__?.ready === true, null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
}

/** Rough "is this a real image" check: sample canvas pixels, count distinct colours. */
async function pixelStats(page) {
  return page.evaluate(() => {
    const src = document.querySelector('#world-canvas');
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = 90;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const colours = new Set();
    let lum = 0;
    for (let i = 0; i < d.length; i += 4) {
      colours.add(((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3));
      lum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    }
    return { distinctColours: colours.size, meanLuminance: +(lum / (d.length / 4)).toFixed(1) };
  });
}

async function capture(name, contextOptions, query, action) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.addInitScript(() => {
    // Let the pixel sampler read the WebGL canvas.
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      if (type === 'webgl2' || type === 'webgl') attrs = { ...(attrs || {}), preserveDrawingBuffer: true };
      return orig.call(this, type, attrs);
    };
  });
  await page.goto(base + query);
  await waitReady(page);
  const before = await page.evaluate(() => window.__WORLDS_DEBUG__);
  if (action) await action(page);
  const debug = await page.evaluate(() => window.__WORLDS_DEBUG__);
  const stats = await pixelStats(page);
  const file = resolve(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(JSON.stringify({ name, file, stats, before: before.player, debug, errors }));
  await context.close();
}

const desktop = { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 };
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const holdKey = (key, ms) => async (page) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
  await page.waitForTimeout(600);
};

await capture('desktop-day', desktop, '?time=10:30');
await capture('desktop-sunset', desktop, '?time=17:20');
await capture('desktop-night', desktop, '?time=21:30');
await capture('desktop-live-seoul-time', desktop, '');
// Walk north with W, then drag the camera to look around.
await capture('desktop-walk-and-look', desktop, '?time=15:00', async (page) => {
  await holdKey('KeyW', 2500)(page);
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await page.mouse.move(420, 330, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(800);
});
await capture('mobile-day', mobile, '?time=11:00');
await capture('mobile-night', mobile, '?time=22:00');
// Drive the virtual joystick: press inside the stick zone and push up.
await capture('mobile-joystick-walk', mobile, '?time=16:00', async (page) => {
  const box = await page.locator('#stick-base').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  await touch('touchStart', cx, cy);
  for (let i = 1; i <= 6; i++) await touch('touchMove', cx + i * 2, cy - i * 9);
  await page.waitForTimeout(2500);
  await touch('touchEnd', 0, 0);
  await page.waitForTimeout(600);
});

// Landmark close-ups (start next to each one).
for (const at of ['prayerGarden', 'campfire', 'lanternHill', 'closet']) {
  await capture(`landmark-${at}-day`, desktop, `?time=14:00&at=${at}`);
}
await capture('landmark-campfire-night', desktop, '?time=20:30&at=campfire');

// Determinism: same seed -> same terrain checksum; different seed -> different.
async function checksum(query) {
  const page = await browser.newPage();
  await page.goto(base + query);
  await page.waitForFunction(() => window.__WORLDS_DEBUG__?.ready === true, null, { timeout: 60_000 });
  const value = await page.evaluate(() => window.__WORLDS_DEBUG__.terrainChecksum);
  await page.close();
  return value;
}
const a = await checksum('?seed=alpha');
const b = await checksum('?seed=alpha');
const c = await checksum('?seed=beta');
const d = await checksum('');
console.log(JSON.stringify({ determinism: { alpha1: a, alpha2: b, beta: c, default: d, sameSeedMatches: a === b, differentSeedDiffers: a !== c } }));

await browser.close();
