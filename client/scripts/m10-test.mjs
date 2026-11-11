// M10 test: the simplified HUD. [말씀] [모임] [찬양] [⚙] fit every screen;
// 말씀 opens 📖 나의 말씀 책 on [오늘] (verse, ✓ status, 묵상하기, 등불로 나누기),
// [지난 말씀] / [담아 둔 묵상] still work, the daily letter still arrives once,
// and ⚙ is a two-level menu (꾸미기, 소리, 알림, 계정, 앱 설치, 사용 안내, 약관, 관리).
// Serves the built client (client/dist) from its own server on TEST_SERVER_PORT (default 5191).
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/m10-test.mjs
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  check,
  clientDir,
  currentStep,
  debug,
  desktop,
  dropDb,
  freshDb,
  join,
  launch,
  loginJoin,
  serverDir,
  shotDir,
  sleep,
  startServer,
  step,
  stopAll,
  summary,
  until,
  waitHttp,
} from './lib/harness.mjs';
import { overlaps } from './lib/tablet.mjs';

const PORT = Number(process.env.TEST_SERVER_PORT ?? 5191);
const BASE = `http://127.0.0.1:${PORT}/`;
const DAY = '2026-11-08';
const Q = (extra = '') => `?test=1&shadows=0&time=13:00&date=${DAY}&noworship=1&noguide=1${extra}`;
const DB = freshDb('m10');
const ADMIN_HINT = 'm10-admin';
const webpush = createRequire(resolve(serverDir, 'package.json'))('web-push');
const VAPID = webpush.generateVAPIDKeys(); // throwaway, test only
const shot = (page, name) => page.screenshot({ path: resolve(shotDir, `m10-${name}.png`) });

const DEVICES = [
  ['phone-360', 360, 740, true],
  ['phone-390', 390, 844, true],
  ['tablet', 820, 1180, true],
  ['desktop', 1280, 720, false],
];

// Screenshots only: headless Linux here has no emoji font, so 👕🔊🔔 would be boxes.
// If a (monochrome) Noto Emoji font is around, serve it to the page for emoji code points.
const EMOJI_FONT = [process.env.M10_EMOJI_FONT, resolve(homedir(), '.local/opt/blender/blender-4.5.15-linux-x64/4.5/datafiles/fonts/NotoEmoji-VariableFont_wght.woff2')].find((f) => f && existsSync(f));
async function newContext(options) {
  const ctx = await browser.newContext(options);
  if (!EMOJI_FONT) return ctx;
  const font = readFileSync(EMOJI_FONT);
  await ctx.route('**/__m10-emoji.woff2', (r) => r.fulfill({ status: 200, contentType: 'font/woff2', body: font }));
  await ctx.addInitScript(() => {
    addEventListener('DOMContentLoaded', () => {
      const stack = getComputedStyle(document.body).fontFamily;
      const st = document.createElement('style');
      st.textContent = `@font-face{font-family:'M10Emoji';src:url(/__m10-emoji.woff2) format('woff2');unicode-range:U+1F000-1FAFF,U+2600-27BF,U+FE0F}
        body,button,input,textarea,select{font-family:'M10Emoji',${stack}}`;
      document.head.append(st);
    });
  });
  return ctx;
}
const ctxFor = (w, h, touch) => ({ viewport: { width: w, height: h }, screen: { width: w, height: h }, deviceScaleFactor: touch ? 2 : 1, isMobile: touch, hasTouch: touch });

const modal = (p) => p.evaluate(() => window.__WORLDS_DEBUG__.m3.modal);
const m10 = (p) => p.evaluate(() => window.__WORLDS_DEBUG__.m10);
const waitModal = (p, name, ms = 15000) => until(p, (n) => window.__WORLDS_DEBUG__.m3.modal === n, name, ms);
const settingsPage = (p, name) => until(p, (n) => window.__WORLDS_DEBUG__.m10.settingsPage === n, name, 10000);

/** Geometry of the HUD row: each tool, its text overflow, and the cards beside it. */
const hudBoxes = (p) =>
  p.evaluate(() => {
    const r = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    };
    const tools = [...document.querySelectorAll('#tools > *')].map((el) => ({
      id: el.id,
      text: el.childNodes[0]?.textContent?.trim() ?? '',
      box: r(el),
      clipped: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
    }));
    return { tools, place: r(document.querySelector('.place-card')), clock: r(document.querySelector('.clock-card')), vw: innerWidth, vh: innerHeight, docW: document.documentElement.scrollWidth };
  });

let browser;
try {
  startServer(PORT, DB, {
    WORLDS_AUTH_MOCK: '1',
    WORLDS_ALLOW_TEST_DATES: '1',
    SERVE_CLIENT: '1',
    WORLDS_CLIENT_DIST: resolve(clientDir, 'dist'),
    MAX_CONN_PER_IP: '60',
    AUTH_RATE_LIMIT: '400',
    NEW_ACCOUNTS_PER_HOUR: '500',
    WORLDS_PUSH_MOCK: '1',
    VAPID_PUBLIC_KEY: VAPID.publicKey,
    VAPID_PRIVATE_KEY: VAPID.privateKey,
    VAPID_SUBJECT: 'mailto:test@example.invalid',
    WORLDS_ADMIN_EMAILS: `MOCK-${ADMIN_HINT}@example.test`,
  });
  await waitHttp(`${BASE}health`);
  browser = await launch();

  // ================================================================ HUD on every screen
  for (const [name, w, h, touch] of DEVICES) {
    step(`hud ${name}`);
    const ctx = await newContext(ctxFor(w, h, touch));
    const p = await ctx.newPage();
    await loginJoin(p, BASE, `m10-hud-${name}`, `화면${w}`, Q());
    // Worst case for width: an unread badge on 모임 and the "new word" dot on 말씀.
    await p.evaluate(() => {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = '12';
      document.getElementById('btn-groups').append(b);
      document.getElementById('btn-word').classList.add('has-new');
    });
    await sleep(500);
    const hb = await hudBoxes(p);
    const ids = hb.tools.map((t) => t.id).join(',');
    const labels = hb.tools.map((t) => t.text).join(' ');
    check(`${name}: HUD has exactly 말씀 · 모임 · 찬양 · ⚙`, ids === 'btn-word,btn-groups,btn-worship,btn-settings' && labels === '말씀 모임 찬양 ⚙', `${ids} | ${labels}`);
    const inside = hb.tools.every((t) => t.box.x >= 0 && t.box.y >= 0 && t.box.x + t.box.width <= hb.vw + 0.5 && t.box.y + t.box.height <= hb.vh);
    check(`${name}: every button is fully on screen (no page scroll)`, inside && hb.docW <= hb.vw, JSON.stringify(hb.tools.map((t) => [t.id, Math.round(t.box.x), Math.round(t.box.x + t.box.width)])));
    check(`${name}: ≥40px tap targets`, hb.tools.every((t) => t.box.width >= 40 && t.box.height >= 40), hb.tools.map((t) => `${Math.round(t.box.width)}x${Math.round(t.box.height)}`).join(' '));
    const pairs = [];
    hb.tools.forEach((a, i) => hb.tools.slice(i + 1).forEach((b) => overlaps(a.box, b.box) && pairs.push(`${a.id}/${b.id}`)));
    const cards = hb.tools.filter((t) => overlaps(t.box, hb.place) || overlaps(t.box, hb.clock)).map((t) => t.id);
    check(`${name}: buttons overlap nothing (each other, place card, clock)`, pairs.length === 0 && cards.length === 0 && !overlaps(hb.place, hb.clock), [...pairs, ...cards].join(',') || 'ok');
    const badge = await p.evaluate(() => {
      const b = document.querySelector('#btn-groups .badge').getBoundingClientRect();
      return { x: b.x, right: b.right, y: b.y };
    });
    check(`${name}: 모임 unread badge stays on screen`, badge.x >= 0 && badge.right <= hb.vw && badge.y >= 0, JSON.stringify(badge));
    await p.evaluate(() => {
      document.querySelector('#btn-groups .badge')?.remove();
      document.getElementById('btn-word').classList.remove('has-new');
    });
    await sleep(300);
    const plain = await hudBoxes(p);
    check(`${name}: no clipped labels`, plain.tools.every((t) => !t.clipped), plain.tools.filter((t) => t.clipped).map((t) => t.id).join(','));
    await shot(p, `hud-${name}`);
    await ctx.close();
  }

  // ================================================================ 말씀 (phone)
  step('letter');
  const mctx = await newContext(ctxFor(390, 844, true));
  const M = await mctx.newPage();
  const errors = [];
  M.on('pageerror', (e) => errors.push(String(e)));
  await loginJoin(M, BASE, 'm10-mia', '미아', Q());
  await until(M, () => window.__WORLDS_DEBUG__.m3.word);
  const word = (await debug(M)).m3.word;
  check('the 말씀 button is highlighted until the letter is opened', await M.evaluate(() => document.getElementById('btn-word').classList.contains('has-new')));
  await until(M, () => window.__WORLDS_DEBUG__.m3.letter === 'waiting', null, 90000);
  check('the daily letter flies in and waits (편지 열기)', await M.isVisible('#letter-btn'));
  await M.tap('#letter-btn');
  await waitModal(M, '오늘의 말씀');
  await sleep(2600); // envelope + unfold
  const letterText = await M.textContent('.word-page');
  check('opening the letter shows today’s word (envelope page)', letterText.includes(word.text.slice(0, 10)) && letterText.includes(word.ref) && (await M.locator('.sheet.word-stage.from-letter').count()) === 1);
  await M.tap('#word-to-book');
  await waitModal(M, '나의 말씀 책');
  check('"말씀 책에서 보기" opens 📖 나의 말씀 책 on [오늘]', (await m10(M)).bookTab === 'today');
  await M.tap('#book-close');
  await waitModal(M, null);

  step('letter once');
  await join(M, BASE, '', Q());
  await until(M, () => window.__WORLDS_DEBUG__.m3.word);
  await sleep(4000);
  check('the letter appears only once a day', (await debug(M)).m3.letter === 'opened' && !(await M.isVisible('#letter-btn')) && !(await M.evaluate(() => document.getElementById('btn-word').classList.contains('has-new'))));

  step('today tab');
  await M.tap('#btn-word');
  await waitModal(M, '나의 말씀 책');
  await M.waitForSelector('#today-status');
  const today = await M.textContent('#book-today');
  check('말씀 opens [오늘] with today’s verse, context, reference and 개역한글판', (await m10(M)).bookTab === 'today' && today.includes(word.text.slice(0, 10)) && today.includes(word.ref) && today.includes('개역한글판') && (await M.locator('#book-today .word-body .ctx').count()) > 0);
  const tabs = await M.$$eval('.book-tabs .tab', (els) => els.map((e) => e.textContent));
  check('tabs: 오늘 · 지난 말씀 · 담아 둔 묵상', tabs.length === 3 && tabs[0] === '오늘' && tabs[1] === '지난 말씀' && tabs[2].startsWith('담아 둔 묵상'), tabs.join(' | '));
  check('before meditating: a gentle prompt, 등불로 나누기 disabled', (await M.textContent('#today-status')).includes('아직') && (await M.isDisabled('#today-share')));
  await sleep(500);
  await shot(M, 'word-today-phone');

  step('today meditate');
  await M.tap('#today-meditate');
  await waitModal(M, '묵상하기');
  check('묵상하기 from [오늘] opens the meditation sheet (outside: 골방 by default)', (await M.textContent('.med-place')).includes('골방'));
  await M.tap('.med-foot .primary');
  await M.fill('#med-meditation', '말씀 책 오늘 탭에서 쓴 묵상이에요');
  await M.tap('.med-foot .primary');
  await M.fill('#med-feeling', '평안해요');
  await M.tap('.med-foot .primary');
  await M.fill('#med-application', '오늘 한 사람에게 먼저 인사하기');
  await M.tap('.med-save');
  await waitModal(M, '나의 말씀 책');
  await until(M, () => document.querySelector('#today-status')?.classList.contains('done'), null, 10000);
  const status = await M.textContent('#today-status');
  check('after saving, [오늘] shows "✓ 오늘 골방에서 묵상했어요" with a preview', (await m10(M)).bookTab === 'today' && status.includes('✓ 오늘 골방에서 묵상했어요') && status.includes('말씀 책 오늘 탭에서'), status);
  await sleep(400);
  await shot(M, 'word-today-done-phone');

  step('today share');
  check('등불로 나누기 is enabled once today’s meditation exists', !(await M.isDisabled('#today-share')));
  await M.tap('#today-share');
  await M.waitForSelector('#share-submit');
  await M.tap('#share-submit');
  await until(M, () => document.querySelector('#today-share')?.textContent.includes('밝혔어요'), null, 10000);
  const lit = await M.evaluate(async () => (await (await fetch('/api/wordbook')).json()).pages.flatMap((p) => p.meditations).filter((m) => m.lanternId).length);
  check('🏮 등불로 나누기 from [오늘] lights a lantern', lit === 1 && (await M.isDisabled('#today-share')));

  step('past and saved tabs');
  await M.tap('#book-tab-mine');
  await M.waitForSelector('.book-note');
  const tabOk = await until(M, () => window.__WORLDS_DEBUG__.m10.bookTab === 'mine', null, 5000).then(() => true, () => false);
  const past = await M.textContent('.book');
  const pastParts = { tabOk, place: past.includes('골방에서'), text: past.includes('오늘 한 사람에게'), edit: await M.isVisible('.note-edit'), unshare: await M.isVisible('.note-unshare') };
  check('[지난 말씀]: the day’s page with my meditation, edit/delete and 등불 내리기', Object.values(pastParts).every(Boolean), JSON.stringify(pastParts));
  // Someone else's lantern, kept with 기록하기 (API), shows under 담아 둔 묵상.
  const octx = await newContext(desktop);
  const O = await octx.newPage();
  await loginJoin(O, BASE, 'm10-other', '다른이', Q());
  const lid = await O.evaluate(async (day) => {
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const m = await post('/api/wordbook/meditations', { date: day, place: '기도의 뜰', meditation: '다른 분이 나눈 묵상', feeling: '', application: '' });
    const id = m.meditation?.id ?? m.id;
    const l = await post('/api/lanterns', { meditationId: Number(id), visibility: 'public' });
    return l.id ?? l.lantern?.id;
  }, DAY);
  await octx.close();
  await M.evaluate((id) => fetch(`/api/lanterns/${id}/reactions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'record' }) }), lid);
  await M.tap('#book-close');
  await M.tap('#btn-word');
  await waitModal(M, '나의 말씀 책');
  await M.tap('#book-tab-saved');
  await M.waitForSelector('.book-page.saved', { timeout: 10000 }).catch(() => undefined);
  await until(M, () => window.__WORLDS_DEBUG__.m10.bookTab === 'saved', null, 5000).catch(() => undefined);
  check('[담아 둔 묵상] lists the kept lantern', (await m10(M)).bookTab === 'saved' && (await M.textContent('.book')).includes('다른 분이 나눈 묵상'), `lantern ${lid}`);
  await M.keyboard.press('Escape');
  await waitModal(M, null);

  // ================================================================ ⚙ menu (phone)
  step('settings menu');
  await M.tap('#btn-settings');
  await waitModal(M, '설정');
  await settingsPage(M, 'menu');
  const items = await M.$$eval('.settings-menu .settings-item', (els) => els.map((e) => e.id.replace('settings-nav-', '')));
  check('⚙ opens the level-1 list (꾸미기, 소리, 알림, 계정, 사용 안내 …)', ['look', 'sound', 'notify', 'account', 'guide'].every((i) => items.includes(i)) && !items.includes('admin'), items.join(','));
  check('the list links 개인정보처리방침 · 이용약관', (await M.getAttribute('#settings-privacy', 'href')) === '/privacy' && (await M.getAttribute('#settings-terms', 'href')) === '/terms');
  const tall = await M.$$eval('.settings-menu .settings-item', (els) => els.every((e) => e.getBoundingClientRect().height >= 44));
  check('menu rows are comfortable tap targets', tall);
  await sleep(400);
  await shot(M, 'settings-menu-phone');

  const pages = [
    ['sound', '#vol-master'],
    ['notify', '#notify-settings'],
    ['account', '#settings-nickname'],
  ];
  for (const [id, sel] of pages) {
    await M.tap(`#settings-nav-${id}`);
    await settingsPage(M, id);
    const ok = (await M.isVisible(sel)) && (await M.isVisible('#settings-back')) && (await M.locator('.settings-menu').count()) === 0;
    check(`⚙ → ${id}: its page opens inside the same sheet with ← 뒤로`, ok && (await modal(M)) === '설정');
    if (id === 'sound') {
      await sleep(300);
      await shot(M, 'settings-sound-phone');
    }
    if (id === 'account') {
      check('계정 has 내 데이터 내려받기, 로그아웃, 회원 탈퇴', (await M.isVisible('#settings-export')) && (await M.isVisible('#settings-logout')) && (await M.isVisible('#settings-delete')));
      await sleep(300);
      await shot(M, 'settings-account-phone');
    }
    await M.tap('#settings-back');
    await settingsPage(M, 'menu');
  }
  const menuBack = await M.evaluate(() => ({ menus: document.querySelectorAll('.settings-menu').length, back: !!document.getElementById('settings-back'), cls: document.querySelector('.sheet.settings')?.className }));
  check('← 뒤로 returns to the list', menuBack.menus === 1 && !menuBack.back, JSON.stringify(menuBack));
  // Esc on a level-2 page closes everything; the next open starts at the list again.
  await M.tap('#settings-nav-sound');
  await settingsPage(M, 'sound');
  await M.keyboard.press('Escape');
  await waitModal(M, null);
  await M.tap('#btn-settings');
  await settingsPage(M, 'menu');
  check('Esc closes the whole sheet; reopening starts at the list', true);
  // Backdrop closes too.
  await M.tap('#settings-nav-account');
  await settingsPage(M, 'account');
  await M.touchscreen.tap(195, 4);
  await until(M, () => window.__WORLDS_DEBUG__.m3.modal === null, null, 5000).catch(() => undefined);
  check('tapping the backdrop closes the sheet', (await modal(M)) === null);
  // Deep link (e.g. reminders → 알림).
  await M.evaluate(() => window.__WORLDS_TEST__.openSettings('notify'));
  await settingsPage(M, 'notify');
  check('deep link opens a page directly (알림)', await M.isVisible('#notify-settings'));
  await M.tap('#settings-back');
  await settingsPage(M, 'menu');

  step('settings guide');
  await M.tap('#settings-nav-guide');
  await waitModal(M, '사용 안내');
  for (let i = 0; i < 5; i++) await M.tap('#guide-next');
  const lastPage = await M.textContent('.guide-body');
  check('사용 안내 reopens from ⚙; its last page names 말씀 and ⚙ → 꾸미기', lastPage.includes('말씀') && lastPage.includes('⚙ → 👕 꾸미기') && !lastPage.includes('말씀 책\n'), lastPage.slice(0, 120));
  await M.tap('.guide-skip');
  await waitModal(M, null);

  step('settings look');
  await M.tap('#btn-settings');
  await M.tap('#settings-nav-look');
  await until(M, () => window.__WORLDS_TEST__.customize().open, null, 15000);
  check('⚙ → 👕 꾸미기 opens 꾸미기 with "← 설정"', await M.isVisible('#look-back'));
  await M.tap('.swatch[data-key="r"][data-index="4"]');
  await M.tap('#look-save');
  await M.waitForSelector('.look-status:has-text("저장했어요")', { timeout: 15000 });
  const saved = await M.evaluate(async () => (await (await fetch('/api/me/look')).json()).appearance);
  check('꾸미기 reached from ⚙ saves', saved?.r === 4, JSON.stringify(saved));
  await M.tap('#look-back');
  await settingsPage(M, 'menu');
  check('"← 설정" goes back to the ⚙ list', (await modal(M)) === '설정');
  await M.keyboard.press('Escape');
  check('no page errors (phone)', errors.length === 0, errors.slice(0, 2).join(' | '));
  await mctx.close();

  // ================================================================ admin (desktop)
  step('admin');
  const actx = await newContext(desktop);
  const AD = await actx.newPage();
  await loginJoin(AD, BASE, ADMIN_HINT, '관리자', Q());
  await until(AD, () => window.__WORLDS_DEBUG__.m8.admin === true, null, 10000);
  await AD.click('#btn-settings');
  await settingsPage(AD, 'menu');
  check('admins see 🛠️ 관리 in the list', await AD.isVisible('#settings-nav-admin'));
  await AD.click('#settings-nav-admin');
  await settingsPage(AD, 'admin');
  check('관리 → 옷 그림 관리 · 소품 가게 관리', (await AD.isVisible('#settings-admin')) && (await AD.isVisible('#settings-admin-shop')));
  await sleep(300);
  await shot(AD, 'settings-admin-desktop');
  await AD.click('#settings-admin-shop');
  await until(AD, () => window.__WORLDS_DEBUG__.m3.modal !== '설정' && window.__WORLDS_DEBUG__.m3.modal !== null, null, 10000);
  check('소품 가게 관리 opens from ⚙ → 관리', true, await modal(AD));
  await AD.keyboard.press('Escape');
  await actx.close();

  // ================================================================ guest (desktop)
  step('guest');
  const gctx = await newContext(desktop);
  const G = await gctx.newPage();
  await join(G, BASE, '손님', Q());
  await until(G, () => window.__WORLDS_DEBUG__.m3.word);
  await G.click('#btn-word');
  await waitModal(G, '나의 말씀 책');
  await G.waitForSelector('#today-login');
  const gToday = await G.textContent('#book-today');
  check('guests: [오늘] shows the verse and a login prompt for saving', gToday.includes(word.ref) && gToday.includes('로그인하면') && (await G.isDisabled('#today-share')));
  await G.click('#book-tab-mine');
  check('guests: [지난 말씀] asks to log in', (await G.textContent('.book-empty')).includes('로그인하면'));
  await G.click('#book-tab-today');
  await G.click('#today-login');
  await waitModal(G, '로그인 안내');
  check('guests: 로그인하러 가기 opens the login prompt', await G.isVisible('.login-prompt .google-btn'));
  await G.keyboard.press('Escape');
  await G.click('#btn-settings');
  await G.click('#settings-nav-account');
  await settingsPage(G, 'account');
  check('guests: ⚙ → 계정 offers Google 로그인 (no export/탈퇴)', (await G.isVisible('#settings-login')) && !(await G.isVisible('#settings-export')));
  await G.click('#settings-back');
  await G.click('#settings-nav-look');
  await waitModal(G, '로그인 안내');
  check('guests: ⚙ → 꾸미기 explains logging in', true);
  await G.keyboard.press('Escape');
  await gctx.close();
} catch (err) {
  check('test run completed', false, `[step: ${currentStep()}] ${String(err).split('\n')[0]}`);
} finally {
  await browser?.close();
  await stopAll();
  dropDb(DB);
}
process.exit(summary());
