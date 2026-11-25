// Onboarding test: the picture guide and the contextual first-time tips.
//   Picture guide: shows on the first login and not again on device B (server flag); once per
//   device for guests; every image loads (naturalWidth > 0) with alt text; swipe, arrows, dots
//   and ← →; 시작하기 works from any card; fits without overlaps at phone portrait (360/390/412),
//   phone landscape, tablet and desktop; total image weight ≤ 200 KB; the SW precaches the pictures.
//   Coach tips: each appears once at its trigger (letter, 말씀, seat/door, campfire chat, 😊, lantern
//   hill, library, after the first meditation), never two at once, never under a sheet, never over
//   the HUD; dismissed by tap, by doing the thing, or after ~8 s; ⚙ → 사용 안내 → 도움말 다시 보기
//   resets them.
// One production-like server (SERVE_CLIENT, mock login, throwaway DB) on TEST_SERVER_PORT (default 5197).
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/ob-test.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  check,
  clientDir,
  currentStep,
  debug,
  desktop,
  dropDb,
  freshDb,
  launch,
  mobile,
  serverDir,
  shotDir,
  sleep,
  startServer,
  step,
  stopAll,
  summary,
  teleport,
  until,
  waitHttp,
} from './lib/harness.mjs';

const PORT = Number(process.env.TEST_SERVER_PORT ?? 5197);
const BASE = `http://127.0.0.1:${PORT}/`;
const Q = '?test=1&shadows=0&time=14:00';
const DB = freshDb('ob');
const DIST = resolve(clientDir, 'dist');
const P = await import(pathToFileURL(resolve(serverDir, 'dist/shared/protocol.js')).href);

const shot = (page, name) => page.screenshot({ path: resolve(shotDir, `ob-${name}.png`) });
const modal = async (page) => (await debug(page)).m3.modal;
const tips = async (page) => (await debug(page)).m4.tips;
const online = (page) => until(page, () => window.__WORLDS_DEBUG__?.ready && window.__WORLDS_DEBUG__.net?.status === 'online', null, 120000);
const isTouch = (page) => !!page.context()._options?.hasTouch;
const tap = (page, sel) => (isTouch(page) ? page.tap(sel) : page.click(sel));
const tipOn = (page, id, ms = 20000) => until(page, (t) => window.__WORLDS_DEBUG__.m4.tips.current === t && window.__WORLDS_DEBUG__.m4.tips.visible, id, ms);

/** The visible tip: inside the screen, over no HUD control, no sheet open, and only one bubble. */
const tipCheck = (page) =>
  page.evaluate(() => {
    const tip = document.getElementById('coach-tip');
    const bubbles = document.querySelectorAll('.coach-tip.on').length;
    if (!tip || !tip.classList.contains('on')) return { ok: false, why: 'not visible', bubbles };
    const r = tip.getBoundingClientRect();
    const inView = r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
    const sels = ['#tools', '#action-btn', '#meditate-btn', '#letter-btn', '#chat-form', '#chat-pill', '#emote-btn', '#camera-btn', '#stick-base', '#closet-ui', '#library-exit', '.clock-card', '.place-card', '#prompt', '.chat-head-btn'];
    const hits = [];
    for (const sel of sels) {
      for (const n of document.querySelectorAll(sel)) {
        if (n.hidden || n.checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) === false) continue;
        const b = n.getBoundingClientRect();
        if (b.width < 1 || b.height < 1) continue;
        if (r.left < b.right && b.left < r.right && r.top < b.bottom && b.top < r.bottom) hits.push(sel);
      }
    }
    const sheet = !!document.querySelector('.overlay');
    return { ok: inView && hits.length === 0 && !sheet && bubbles === 1, inView, hits, sheet, bubbles, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, text: tip.textContent, side: tip.dataset.side };
  });

/** Guide layout on the current card: everything on screen, nothing overlapping. */
const guideLayout = (page) =>
  page.evaluate(() => {
    const rect = (n) => {
      const b = n.getBoundingClientRect();
      return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height };
    };
    const page = window.__WORLDS_DEBUG__.m4.guide.page;
    const card = document.querySelectorAll('.guide-card')[page];
    const parts = {
      sheet: rect(document.querySelector('.sheet.guide')),
      skip: rect(document.querySelector('.guide-skip')),
      pic: rect(card.querySelector('.guide-pic')),
      title: rect(card.querySelector('.guide-title')),
      sub: rect(card.querySelector('.guide-sub')),
      nav: rect(document.querySelector('.guide-nav')),
      start: rect(document.querySelector('#guide-start')),
    };
    const vw = innerWidth;
    const vh = innerHeight;
    const off = Object.entries(parts).filter(([, p]) => p.l < -0.5 || p.t < -0.5 || p.r > vw + 0.5 || p.b > vh + 0.5).map(([k]) => k);
    const keys = ['skip', 'pic', 'title', 'sub', 'nav', 'start'];
    const over = [];
    for (let i = 0; i < keys.length; i++)
      for (let j = i + 1; j < keys.length; j++) {
        const a = parts[keys[i]];
        const b = parts[keys[j]];
        if (a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5) over.push(`${keys[i]}×${keys[j]}`);
      }
    // The caption must not be cut by the card viewport.
    const vp = rect(document.querySelector('.guide-viewport'));
    const clipped = parts.sub.b > vp.b + 0.5 || parts.title.t < vp.t - 0.5;
    const ok = off.length === 0 && over.length === 0 && !clipped && parts.pic.w >= 180 && parts.start.h >= 40;
    return { ok, off, over, clipped, pic: `${Math.round(parts.pic.w)}×${Math.round(parts.pic.h)}`, start: Math.round(parts.start.h), vw, vh };
  });

async function guestEnter(page, nickname, query = Q) {
  await page.goto(BASE + query);
  await page.waitForSelector('#entry-signed-out:not([hidden]), #entry-signed-in:not([hidden])');
  if (await page.isVisible('#entry-continue')) await page.click('#entry-continue');
  else {
    await page.fill('#nickname', nickname);
    await page.click('#entry-submit');
  }
  await online(page);
}
async function loginEnter(page, hint, nickname, query = Q) {
  await page.goto(`${BASE}api/auth/google/start?remember=1&hint=${encodeURIComponent(hint)}`);
  await page.goto(BASE + query);
  await page.waitForSelector('#entry-signed-in:not([hidden]), #entry-nick:not([hidden])');
  if (await page.isVisible('#entry-nick')) {
    await page.fill('#account-nickname', nickname);
    await page.check('#nick-agree');
    await page.click('#nick-submit');
  } else await page.click('#entry-continue');
  await online(page);
}
/** A touch swipe on the guide's picture area (CDP touch events → pointer events). */
async function swipe(page, dx) {
  const box = await page.locator('.guide-viewport').boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const y = box.y + box.height * 0.4;
  const x0 = box.x + box.width / 2 - dx / 2;
  const t = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  await t('touchStart', x0);
  for (let i = 1; i <= 8; i++) await t('touchMove', x0 + (dx * i) / 8);
  await t('touchEnd', 0);
  await cdp.detach();
}

let browser;
try {
  step('server');
  startServer(PORT, DB, { WORLDS_AUTH_MOCK: '1', SERVE_CLIENT: '1', WORLDS_CLIENT_DIST: DIST, MAX_CONN_PER_IP: '60', AUTH_RATE_LIMIT: '300' });
  await waitHttp(`${BASE}health`);
  browser = await launch();
  const errors = [];

  // ------------------------------------------------------------------ images + precache
  step('images');
  const dir = resolve(clientDir, 'public/guide');
  const files = readdirSync(dir).filter((f) => f.endsWith('.webp'));
  const sizes = files.map((f) => statSync(resolve(dir, f)).size);
  const total = sizes.reduce((a, b) => a + b, 0);
  check('picture guide: 4–5 WebP images, each ≤ 40 KB, total ≤ 200 KB', files.length >= 4 && files.length <= 5 && sizes.every((s) => s <= 40 * 1024) && total <= 200 * 1024, files.map((f, i) => `${f} ${(sizes[i] / 1024).toFixed(1)} KB`).join(', ') + ` · total ${(total / 1024).toFixed(1)} KB`);
  const sw = readFileSync(resolve(DIST, 'sw.js'), 'utf8');
  check('the service worker precaches every guide picture', files.every((f) => sw.includes(`"/guide/${f}"`)));
  const head = await fetch(`${BASE}guide/${files[0]}`);
  check('guide pictures are served same-origin as image/webp', head.status === 200 && head.headers.get('content-type') === 'image/webp', `${head.status} ${head.headers.get('content-type')}`);

  // ------------------------------------------------------------------ account: desktop A, then device B
  step('guide account');
  const ctxA = await browser.newContext(desktop);
  const A = await ctxA.newPage();
  A.on('pageerror', (e) => errors.push(`A: ${e}`));
  await loginEnter(A, 'ob-hana', '하나');
  await until(A, () => window.__WORLDS_DEBUG__.m3.modal === '사용 안내');
  check('the picture guide opens right after the first login', true);
  await until(A, () => [...document.querySelectorAll('.guide-img')].every((i) => i.complete), null, 15000);
  const imgs = await A.evaluate(() => [...document.querySelectorAll('.guide-img')].map((i) => ({ src: i.getAttribute('src'), w: i.naturalWidth, alt: i.alt })));
  check('4–5 cards; every picture loads (naturalWidth > 0) and has alt text', imgs.length >= 4 && imgs.length <= 5 && imgs.every((i) => i.w > 0 && i.alt.length > 10), JSON.stringify(imgs.map((i) => `${i.src}:${i.w}`)));
  const titles = await A.$$eval('.guide-title', (n) => n.map((x) => x.textContent));
  check('one short line per card (≤ 20 characters)', titles.every((t) => [...t].length <= 20), titles.join(' / '));
  check('desktop: the first card shows the animated WASD hint (no controls page)', (await A.$$('.guide-card:first-child .guide-keys')).length === 1 && !(await A.textContent('.sheet.guide')).includes('조작법'));
  await sleep(500);
  await shot(A, 'guide-desktop');
  let L = await guideLayout(A);
  check('desktop 1280×720: the guide fits, nothing overlaps', L.ok, JSON.stringify(L));
  await A.click('#guide-next');
  await until(A, () => window.__WORLDS_DEBUG__.m4.guide.page === 1);
  await A.click('#guide-next');
  await until(A, () => window.__WORLDS_DEBUG__.m4.guide.page === 2);
  await A.click('#guide-prev');
  await until(A, () => window.__WORLDS_DEBUG__.m4.guide.page === 1);
  check('arrows: › and ‹ move between cards', true);
  await A.click('.guide-dot:nth-child(4)');
  await until(A, () => window.__WORLDS_DEBUG__.m4.guide.page === 3);
  check('dots: tapping the 4th dot shows card 4', true);
  await A.keyboard.press('ArrowLeft');
  await until(A, () => window.__WORLDS_DEBUG__.m4.guide.page === 2);
  check('keyboard ← → move between cards', true);
  await sleep(450);
  await shot(A, 'guide-desktop-card3');
  check('시작하기 is on every card (one button under the cards)', await A.isVisible('#guide-start'));
  await A.click('#guide-start');
  await until(A, () => window.__WORLDS_DEBUG__.m3.modal === null);
  check('시작하기 from card 3 closes the guide', true);
  // Desktop: the first tip is the letter.
  await tipOn(A, 'letter', 30000);
  let T = await tipCheck(A);
  check('desktop: "편지를 눌러 보세요" points at the flying letter, over no HUD control', T.ok && T.text.includes('편지를 눌러'), JSON.stringify(T));
  await shot(A, 'tip-letter-desktop');

  const ctxB = await browser.newContext(desktop);
  const B = await ctxB.newPage();
  await loginEnter(B, 'ob-hana', '하나');
  await sleep(4000);
  check('same account on device B: no guide again (server flag)', (await modal(B)) === null);
  await ctxB.close();

  // ------------------------------------------------------------------ guest phone
  step('guide guest');
  const ctxP = await browser.newContext(mobile);
  const Ph = await ctxP.newPage();
  Ph.on('pageerror', (e) => errors.push(`P: ${e}`));
  await guestEnter(Ph, '손님');
  await until(Ph, () => window.__WORLDS_DEBUG__.m3.modal === '사용 안내');
  await until(Ph, () => [...document.querySelectorAll('.guide-img')].every((i) => i.complete && i.naturalWidth > 0), null, 15000);
  check('guest phone: the guide shows; the first card has the joystick hint', (await Ph.$$('.guide-card:first-child .guide-stick')).length === 1);
  await sleep(500);
  await shot(Ph, 'guide-phone');
  check('guest phone: no tip shows while the guide is open', (await tips(Ph)).visible === false);
  await swipe(Ph, -200);
  await until(Ph, () => window.__WORLDS_DEBUG__.m4.guide.page === 1, null, 5000).catch(() => undefined);
  const afterLeft = (await debug(Ph)).m4.guide.page;
  await swipe(Ph, -200);
  await until(Ph, () => window.__WORLDS_DEBUG__.m4.guide.page === 2, null, 5000).catch(() => undefined);
  await swipe(Ph, 200);
  await until(Ph, () => window.__WORLDS_DEBUG__.m4.guide.page === 1, null, 5000).catch(() => undefined);
  check('swipe left → next card, swipe right → previous card', afterLeft === 1 && (await debug(Ph)).m4.guide.page === 1);
  await sleep(450);
  await shot(Ph, 'guide-phone-card2');
  L = await guideLayout(Ph);
  check('phone 390×844: the guide fits, nothing overlaps', L.ok, JSON.stringify(L));
  await Ph.tap('#guide-start');
  await until(Ph, () => window.__WORLDS_DEBUG__.m3.modal === null);
  check('시작하기 from card 2 closes the guide (phone)', true);

  // ------------------------------------------------------------------ tips (guest phone)
  step('tip letter');
  await tipOn(Ph, 'letter', 30000);
  T = await tipCheck(Ph);
  check('first entry: "편지를 눌러 보세요" over the letter (one bubble, no HUD covered)', T.ok, JSON.stringify(T));
  await shot(Ph, 'tip-letter-phone');
  await until(Ph, () => window.__WORLDS_DEBUG__.m3.letter === 'waiting', null, 20000);
  await Ph.tap('#letter-btn');
  await until(Ph, () => window.__WORLDS_DEBUG__.m3.modal === '오늘의 말씀');
  let S = await tips(Ph);
  check('opening the letter ends its tip for good', S.seen.includes('letter') && !S.visible, JSON.stringify(S));
  await sleep(1200);
  S = await tips(Ph);
  check('never under a sheet: no tip while 오늘의 말씀 is open', !S.visible && (await Ph.$$('.coach-tip.on')).length === 0, JSON.stringify(S));

  step('tip word');
  await Ph.keyboard.press('Escape');
  await until(Ph, () => window.__WORLDS_DEBUG__.m3.modal === null);
  await tipOn(Ph, 'word', 10000);
  T = await tipCheck(Ph);
  const wordBtn = await Ph.locator('#btn-word').boundingBox();
  const nearWord = T.rect && Math.abs(T.rect.y - (wordBtn.y + wordBtn.height)) < 30;
  check('after the letter: "말씀 → 오늘에서 묵상하기" points at the 말씀 button', T.ok && T.text.includes('말씀') && nearWord, JSON.stringify({ T, wordBtn }));
  await shot(Ph, 'tip-word-phone');
  await Ph.tap('#coach-tip', { force: true });
  await until(Ph, () => !window.__WORLDS_DEBUG__.m4.tips.visible && window.__WORLDS_DEBUG__.m4.tips.seen.includes('word'), null, 5000);
  check('tapping a tip dismisses it for good', true);

  step('tip seat + chat');
  const seats = P.LOG_SEATS;
  const s0 = seats[0];
  await teleport(Ph, { x: s0.x + 0.3, z: s0.z + 0.3 });
  await until(Ph, () => ['seat', 'chat'].includes(window.__WORLDS_DEBUG__.m4.tips.current) && window.__WORLDS_DEBUG__.m4.tips.visible, null, 15000);
  await sleep(600);
  S = await tips(Ph);
  const bubbles = await Ph.$$eval('.coach-tip.on', (n) => n.length);
  check('campfire: seat and chat tips both asked for, but one at a time (the other waits)', bubbles === 1 && S.current && ((S.current === 'seat' && S.queued.includes('chat')) || (S.current === 'chat' && S.queued.includes('seat'))), JSON.stringify(S));
  T = await tipCheck(Ph);
  check(`campfire: the "${S.current}" tip covers no HUD control`, T.ok, JSON.stringify(T));
  await shot(Ph, `tip-${S.current}-phone`);
  await Ph.evaluate(() => window.__WORLDS_TEST__.openSettings('menu'));
  await until(Ph, () => window.__WORLDS_DEBUG__.m3.modal === '설정');
  await sleep(800);
  check('never under a sheet: the tip hides while ⚙ is open', !(await tips(Ph)).visible);
  await Ph.keyboard.press('Escape');
  await until(Ph, () => window.__WORLDS_DEBUG__.m3.modal === null);
  await until(Ph, () => window.__WORLDS_DEBUG__.m4.tips.visible, null, 5000);
  check('…and comes back when the sheet closes', true);
  const first = S.current;
  const second = first === 'seat' ? 'chat' : 'seat';
  await Ph.tap('#coach-tip', { force: true });
  await tipOn(Ph, second, 10000);
  T = await tipCheck(Ph);
  check(`the queued "${second}" tip follows after the first`, T.ok, JSON.stringify(T));
  await shot(Ph, `tip-${second}-phone`);
  // Do the thing: sitting ends the seat tip, typing ends the chat tip.
  if (second === 'seat') {
    await Ph.tap('#action-btn');
    await until(Ph, () => window.__WORLDS_DEBUG__.m4.tips.seen.includes('seat'), null, 8000);
    check('sitting down ends the seat tip', true);
  } else {
    await Ph.evaluate(() => {
      const chat = document.getElementById('chat-pill');
      if (chat && !chat.hidden) chat.click();
    });
    await Ph.focus('#chat-input').catch(() => undefined);
    await until(Ph, () => window.__WORLDS_DEBUG__.m4.tips.seen.includes('chat'), null, 8000);
    check('typing in the chat ends the chat tip', true);
    await Ph.evaluate(() => document.activeElement?.blur());
  }

  step('tip emote');
  await tipOn(Ph, 'emote', 15000);
  T = await tipCheck(Ph);
  check('"마음을 표현해 보세요" points at 😊 (covers nothing)', T.ok && T.text.includes('표현'), JSON.stringify(T));
  await Ph.tap('#emote-btn');
  await until(Ph, () => window.__WORLDS_DEBUG__.m4.tips.seen.includes('emote'), null, 5000);
  check('opening 😊 ends the emote tip', true);
  await Ph.keyboard.press('Escape');
  if ((await debug(Ph)).net.seat >= 0) await Ph.tap('#action-btn');

  step('tip lantern');
  {
    // One public lantern from an account.
    const ctxL = await browser.newContext(desktop);
    const La = await ctxL.newPage();
    await loginEnter(La, 'ob-lamp', '등불지기', `${Q}&noguide=1`);
    const day = P.seoulDate();
    await La.evaluate(async (d) => {
      const m = await (await fetch('/api/wordbook/meditations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date: d, place: '골방', meditation: '등불 하나 밝혀요', feeling: '감사', application: '' }) })).json();
      await fetch('/api/lanterns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ meditationId: m.id, visibility: 'public' }) });
    }, day);
    await ctxL.close();
  }
  await until(Ph, () => window.__WORLDS_DEBUG__.m4.lanterns.length > 0, null, 15000);
  const lan = (await debug(Ph)).m4.lanterns[0];
  await teleport(Ph, { x: lan.x, z: lan.z + 6 });
  await Ph.evaluate(() => window.__WORLDS_TEST__.view(0, 0.3));
  await tipOn(Ph, 'lantern', 15000);
  T = await tipCheck(Ph);
  check('lantern hill: "등불을 눌러 읽어 보세요" over a lantern', T.ok && T.text.includes('등불'), JSON.stringify(T));
  await shot(Ph, 'tip-lantern-phone');
  const t0 = Date.now();
  await until(Ph, () => !window.__WORLDS_DEBUG__.m4.tips.visible && window.__WORLDS_DEBUG__.m4.tips.seen.includes('lantern'), null, 15000);
  const hid = (Date.now() - t0) / 1000;
  check('a tip hides by itself after about 8 s', hid > 4 && hid < 12, `${hid.toFixed(1)} s`);

  step('tip library');
  await Ph.evaluate(() => window.__WORLDS_TEST__.enterLibrary());
  await until(Ph, () => window.__WORLDS_DEBUG__.la.inLibrary === true, null, 20000);
  await tipOn(Ph, 'library', 15000);
  T = await tipCheck(Ph);
  check('library: "책장을 눌러 이야기를 읽어요" points at the bookcases', T.ok, JSON.stringify(T));
  await shot(Ph, 'tip-library-phone');
  await Ph.tap('#coach-tip', { force: true });
  await Ph.evaluate(() => window.__WORLDS_TEST__.leaveLibrary());
  await until(Ph, () => window.__WORLDS_DEBUG__.la.inLibrary === false, null, 20000);

  S = await tips(Ph);
  check('each tip appeared exactly once, in context', new Set(S.history).size === S.history.length && ['letter', 'word', 'seat', 'chat', 'emote', 'lantern', 'library'].every((id) => S.history.includes(id)), S.history.join(' → '));

  // Saving needs an account (guests are asked to sign in), so the share tip is checked on desktop A.
  step('tip share');
  await A.click('#btn-word');
  await until(A, () => window.__WORLDS_DEBUG__.m3.modal === '나의 말씀 책');
  await A.waitForSelector('#today-meditate');
  await A.click('#today-meditate');
  await until(A, () => window.__WORLDS_DEBUG__.m3.modal === '묵상하기');
  await A.click('.med-foot .primary');
  await A.fill('#med-meditation', '처음 묵상');
  await A.click('.med-foot .primary');
  await A.fill('#med-feeling', '감사해요');
  await A.click('.med-foot .primary');
  await A.fill('#med-application', '인사하기');
  await A.click('.med-save');
  await until(A, () => window.__WORLDS_DEBUG__.m3.modal === '나의 말씀 책', null, 10000);
  await sleep(800);
  S = await tips(A);
  check('after the first meditation: the share tip waits while the book is open', !S.visible && S.queued.includes('share'), JSON.stringify(S));
  await A.keyboard.press('Escape');
  await until(A, () => window.__WORLDS_DEBUG__.m3.modal === null);
  // Another tip asked for earlier (😊 after a while) may come first: tap it away.
  for (let i = 0; i < 40; i++) {
    S = await tips(A);
    if (S.current === 'share' && S.visible) break;
    if (S.visible && S.current !== 'share') await A.click('#coach-tip', { force: true });
    await sleep(250);
  }
  T = await tipCheck(A);
  check('then "🏮 등불로 나누면 다른 사람이 함께 기도해요" points at 말씀', T.ok && T.text.includes('등불로 나누면'), JSON.stringify(T));
  await A.click('#coach-tip', { force: true });

  step('once per device');
  await guestEnter(Ph, '손님');
  await sleep(4000);
  check('guest: the guide only once per device', (await modal(Ph)) === null);
  await teleport(Ph, { x: s0.x + 0.3, z: s0.z + 0.3 });
  await sleep(4000);
  S = await tips(Ph);
  check('after a reload: no tip shows again on this device', S.history.length === 0 && !S.visible, JSON.stringify(S));

  step('도움말 다시 보기');
  await Ph.evaluate(() => window.__WORLDS_TEST__.openSettings('menu'));
  await Ph.tap('#settings-nav-guide');
  await until(Ph, () => window.__WORLDS_DEBUG__.m3.modal === '사용 안내');
  await Ph.waitForSelector('#guide-tips-reset');
  await Ph.tap('#guide-tips-reset');
  await until(Ph, () => window.__WORLDS_DEBUG__.m3.modal === null);
  S = await tips(Ph);
  const stored = await Ph.evaluate(() => localStorage.getItem('worlds.tips.seen'));
  check('⚙ → 사용 안내 → 도움말 다시 보기 resets every tip', S.seen.length === 0 && stored === '[]', `${JSON.stringify(S.seen)} ${stored}`);
  await teleport(Ph, { x: s0.x + 8, z: s0.z + 20 });
  await sleep(600);
  await teleport(Ph, { x: s0.x + 0.3, z: s0.z + 0.3 });
  await until(Ph, () => ['seat', 'chat'].includes(window.__WORLDS_DEBUG__.m4.tips.current) && window.__WORLDS_DEBUG__.m4.tips.visible, null, 15000);
  check('…and the campfire tips show again', true);

  // ------------------------------------------------------------------ sizes
  step('sizes');
  const sizesList = [
    ['phone-360', 360, 740],
    ['phone-412', 412, 915],
    ['phone-land', 844, 390],
  ];
  for (const [name, w, h] of sizesList) {
    await Ph.setViewportSize({ width: w, height: h });
    await sleep(900);
    // Let the bubble follow the new layout (it is placed once per rendered frame).
    await until(Ph, () => {
      const r = document.getElementById('coach-tip').getBoundingClientRect();
      return !document.querySelector('.coach-tip.on') || (r.bottom <= innerHeight && r.right <= innerWidth);
    }, null, 8000).catch(() => undefined);
    // A tip at this size (if one is up): still clear of the HUD.
    const cur = await tips(Ph);
    if (cur.visible) {
      T = await tipCheck(Ph);
      check(`${name} ${w}×${h}: the "${cur.current}" tip covers no HUD control`, T.ok, JSON.stringify(T));
      if (name === 'phone-land') await shot(Ph, `tip-${cur.current}-landscape`);
    }
    await Ph.evaluate(() => window.__WORLDS_TEST__.openSettings('menu'));
    await Ph.tap('#settings-nav-guide');
    await until(Ph, () => window.__WORLDS_DEBUG__.m3.modal === '사용 안내');
    await sleep(500);
    L = await guideLayout(Ph);
    check(`${name} ${w}×${h}: the guide fits, nothing overlaps`, L.ok, JSON.stringify(L));
    await shot(Ph, `guide-${name}`);
    await Ph.tap('.guide-skip');
    await until(Ph, () => window.__WORLDS_DEBUG__.m3.modal === null);
  }

  // Tablets are tablets from the start (the app decides from the screen size): fresh guests.
  for (const [name, w, h] of [
    ['tablet', 1024, 768],
    ['tablet-portrait', 768, 1024],
  ]) {
    const ctxT = await browser.newContext({ viewport: { width: w, height: h }, screen: { width: w, height: h }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const Tb = await ctxT.newPage();
    Tb.on('pageerror', (e) => errors.push(`${name}: ${e}`));
    await guestEnter(Tb, '태블릿');
    await until(Tb, () => window.__WORLDS_DEBUG__.m3.modal === '사용 안내');
    await until(Tb, () => [...document.querySelectorAll('.guide-img')].every((i) => i.complete && i.naturalWidth > 0), null, 15000);
    await sleep(500);
    L = await guideLayout(Tb);
    check(`${name} ${w}×${h}: the guide fits, nothing overlaps`, L.ok, JSON.stringify(L));
    await shot(Tb, `guide-${name}`);
    await Tb.tap('#guide-start');
    await tipOn(Tb, 'letter', 30000);
    T = await tipCheck(Tb);
    check(`${name}: the letter tip covers no HUD control`, T.ok, JSON.stringify(T));
    await ctxT.close();
  }

  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  await ctxP.close();
  await ctxA.close();
} catch (err) {
  check(`no exception (step: ${currentStep()})`, false, String(err?.stack ?? err).slice(0, 600));
} finally {
  await browser?.close();
  await stopAll();
  dropDb(DB);
}
process.exit(summary());
