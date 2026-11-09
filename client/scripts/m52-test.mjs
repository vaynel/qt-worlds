// M5.2 test: tablet layout for the campfire chat (portrait + landscape, keyboard simulated).
// For every tablet size: compact chat (≤50% width portrait, ≤40% landscape), no
// overlaps (chat vs worship player/handle vs voice chip vs joystick vs HUD),
// input visible above the simulated keyboard, send + receive, collapse, blur.
// Ports: 5182 preview, 5183 server.
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/m52-test.mjs
import { resolve } from 'node:path';
import {
  check,
  currentStep,
  debug,
  dropDb,
  freshDb,
  launch,
  loginJoin,
  rawClient,
  shotDir,
  sleep,
  startPreview,
  startServer,
  step,
  stopAll,
  summary,
  teleport,
  until,
  waitHttp,
} from './lib/harness.mjs';
import { TABLETS, layoutBoxes, overlaps } from './lib/tablet.mjs';

const CLIENT_PORT = 5182;
const SERVER_PORT = 5183;
const BASE = `http://127.0.0.1:${CLIENT_PORT}/`;
const WS = `ws://127.0.0.1:${CLIENT_PORT}/ws`;
const Q = '?test=1&shadows=0&time=14:00&noguide=1';
const DB = freshDb('m52');
const near = { x: 51, z: -6 };

function collisions(b, keys) {
  return keys.filter((k) => overlaps(b.chat, b[k]));
}

let browser;
const raws = [];
try {
  startServer(SERVER_PORT, DB, { WORLDS_AUTH_MOCK: '1', AUTH_RATE_LIMIT: '300', MAX_CONN_PER_IP: '60' });
  await waitHttp(`http://127.0.0.1:${SERVER_PORT}/health`);
  startPreview(CLIENT_PORT, SERVER_PORT);
  await waitHttp(BASE);
  browser = await launch(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']);

  // Someone else at the fire (raw client) to prove receiving.
  const friend = await rawClient(WS, { nickname: '모닥불친구', test: true });
  raws.push(friend);
  friend.send({ t: 'state', x: near.x + 2, y: 3, z: near.z, yaw: 0, speed: 0 });

  let groupCode = null;
  // Dev filter: M52_ONLY=chat|closet, M52_DEVICES=ipad-mini,phone
  const only = process.env.M52_ONLY ?? '';
  const pick = (list) => (process.env.M52_DEVICES ? list.filter(([n]) => process.env.M52_DEVICES.split(',').includes(n)) : list);
  for (const [name, w, h] of only === 'closet' ? [] : pick(TABLETS)) {
    step(name);
    const land = w > h;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, screen: { width: w, height: h }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const p = await ctx.newPage();
    await loginJoin(p, BASE, `tab-${name}`, name.slice(0, 12), Q);
    // Join a group voice room so the voice chip is on screen too.
    if (!groupCode) {
      groupCode = (await p.evaluate(async () => (await (await fetch('/api/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '태블릿' }) })).json()).code));
    } else {
      await p.evaluate(async (code) => fetch('/api/groups/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }), groupCode);
    }
    const gid = (await p.evaluate(async () => (await (await fetch('/api/groups')).json()).groups[0].id));
    await p.evaluate((g) => window.__WORLDS_TEST__.voiceJoin(g), gid);
    await until(p, () => window.__WORLDS_DEBUG__.m4.voice?.state === 'in', null, 20000);
    const tabletClass = await p.evaluate(() => document.body.classList.contains('tablet') && document.body.classList.contains('touch'));
    check(`${name}: detected as a tablet (touch + tablet layout)`, tabletClass);
    check(`${name}: worship player starts 작게 and the joystick is on`, (await debug(p)).m3.worship.fold === 'mini' && (await p.isVisible('#stick-base')));

    await teleport(p, near);
    await until(p, () => window.__WORLDS_DEBUG__.net.chatVisible);
    // send + receive
    await p.fill('#chat-input', `${name} 인사드려요`);
    await p.press('#chat-input', 'Enter');
    friend.send({ t: 'chat', text: `반가워요 ${name}` });
    await until(p, (t) => window.__WORLDS_DEBUG__.net.chatLog.some((l) => l.includes(t)), `반가워요 ${name}`, 15000);
    await until(p, (t) => window.__WORLDS_DEBUG__.net.chatLog.some((l) => l.includes(t)), `${name} 인사드려요`, 15000);
    check(`${name}: messages sent and received`, true);
    await p.evaluate(() => document.activeElement?.blur());
    await sleep(900);

    // Unfocused layout
    const b = await layoutBoxes(p);
    const maxW = (land ? 0.4 : 0.5) * w + 2;
    check(`${name}: chat panel compact (≤${land ? 40 : 50}% width)`, b.chat && b.chat.width <= maxW, `${Math.round(b.chat?.width)}px of ${w}`);
    const hits = collisions(b, ['worship', 'handle', 'voice', 'joystick', 'stickZone', 'tools', 'place', 'clock', 'action']);
    check(`${name}: nothing overlaps the chat (player, handle, voice chip, joystick, HUD)`, hits.length === 0, hits.join(',') || 'ok');
    const others = [['worship', 'voice'], ['worship', 'joystick'], ['voice', 'joystick'], ['handle', 'voice']].filter(([a, c]) => overlaps(b[a], b[c]));
    check(`${name}: player / voice chip / joystick clear of each other`, others.length === 0, JSON.stringify(others));
    await p.screenshot({ path: resolve(shotDir, `m52-after-${name}.png`) });

    // Collapse: input + latest lines only
    await p.tap('#chat-collapse');
    await sleep(300);
    const collapsed = await layoutBoxes(p);
    check(`${name}: 작게 collapses the log to the latest lines`, collapsed.log.height <= 60 && collapsed.input !== null, `${Math.round(collapsed.log.height)}px`);
    await p.tap('#chat-collapse');

    // Keyboard: focus and shrink the viewport (≈40% portrait, ≈50% landscape)
    await p.tap('#chat-input');
    const kbH = Math.round(h * (land ? 0.5 : 0.6));
    await p.setViewportSize({ width: w, height: kbH });
    await sleep(900);
    const k = await layoutBoxes(p);
    check(
      `${name}: with the keyboard, the input sits visibly above it`,
      k.input && k.input.y >= 0 && k.input.y + k.input.height <= kbH + 0.5,
      `input ${Math.round(k.input?.y)}..${Math.round((k.input?.y ?? 0) + (k.input?.height ?? 0))} / ${kbH}`,
    );
    const kHits = collisions(k, ['worship', 'handle', 'voice', 'tools', 'place', 'clock']);
    check(`${name}: with the keyboard, the chat overlaps nothing and the log shrinks`, kHits.length === 0 && k.chat.height < kbH * 0.75, kHits.join(',') || `${Math.round(k.chat.height)}px`);
    await p.screenshot({ path: resolve(shotDir, `m52-after-${name}-keyboard.png`) });

    // Tap the world: keyboard away, view restored, joystick back
    await p.setViewportSize({ width: w, height: h });
    await p.mouse.click(Math.round(w * 0.6), Math.round(h * 0.6));
    await sleep(500);
    const restored = await p.evaluate(() => document.activeElement?.id !== 'chat-input' && !document.body.classList.contains('chatting'));
    check(`${name}: tapping the world blurs the input; joystick usable again`, restored && (await p.isVisible('#stick-base')));
    await p.evaluate(() => window.__WORLDS_TEST__.voiceLeave());
    await ctx.close();
  }

  // ---------------------------------------------------------------- phone + desktop chat (no regressions)
  for (const [name, w, h, touch] of only === 'closet' ? [] : pick([['phone', 390, 844, true], ['phone-s', 360, 740, true], ['desktop', 1280, 720, false]])) {
    step(`chat ${name}`);
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, screen: { width: w, height: h }, deviceScaleFactor: 1, isMobile: touch, hasTouch: touch });
    const p = await ctx.newPage();
    await loginJoin(p, BASE, `chat-${name}`, name, Q);
    const cls = await p.evaluate(() => document.body.className);
    check(`${name}: not treated as a tablet`, !/\btablet\b/.test(cls) && /\btouch\b/.test(cls) === touch, cls);
    await teleport(p, near);
    await until(p, () => window.__WORLDS_DEBUG__.net.chatVisible);
    await p.fill('#chat-input', `${name} 안녕`);
    await p.press('#chat-input', 'Enter');
    friend.send({ t: 'chat', text: `어서와요 ${name}` });
    await until(p, (t) => window.__WORLDS_DEBUG__.net.chatLog.some((l) => l.includes(t)), `어서와요 ${name}`, 15000);
    check(`${name}: messages sent and received`, true);
    await p.evaluate(() => document.activeElement?.blur());
    await sleep(700);
    const b = await layoutBoxes(p);
    const hits = collisions(b, ['worship', 'handle', 'voice', 'joystick', 'tools', 'place', 'clock']);
    check(`${name}: chat overlaps nothing`, hits.length === 0, hits.join(',') || 'ok');
    // 작게/크게 now exists on every device (it used to be tablet-only).
    check(`${name}: 작게 button is available`, await p.isVisible('#chat-collapse'));
    await p.click('#chat-collapse');
    await sleep(300);
    const small = await layoutBoxes(p);
    check(`${name}: 작게 shrinks the log to one line and keeps the input`, small.log.height <= 40 && small.input !== null && small.chat.height <= b.chat.height + 8, `log ${Math.round(small.log.height)} chat ${Math.round(b.chat.height)}→${Math.round(small.chat.height)}`);
    if (touch) check(`${name}: campfire blurb hidden while chat is open`, !(await p.isVisible('#prompt')));
    await p.screenshot({ path: resolve(shotDir, `m53-chat-small-${name}.png`) });
    check(`${name}: 작게 is remembered (saved for the next visit)`, (await p.evaluate(() => localStorage.getItem('worlds.chat.collapsed'))) === '1');
    await p.click('#chat-collapse');
    await sleep(300);
    if (touch) {
      await p.tap('#chat-input');
      const kbH = Math.round(h * 0.6);
      await p.setViewportSize({ width: w, height: kbH });
      await sleep(900);
      const k = await layoutBoxes(p);
      check(`${name}: with the keyboard the input stays visible`, k.input && k.input.y >= 0 && k.input.y + k.input.height <= kbH + 0.5, `input ${Math.round(k.input?.y)}+${Math.round(k.input?.height)} chat ${Math.round(k.chat?.y)}+${Math.round(k.chat?.height)} log ${Math.round(k.log?.height)} / ${kbH}`);
    }
    await p.screenshot({ path: resolve(shotDir, `m52-after-${name}${touch ? '-keyboard' : ''}.png`) });
    await ctx.close();
  }

  // ---------------------------------------------------------------- 골방 player sizes
  const ROOM_DEVICES = [...TABLETS, ['phone', 390, 844], ['desktop', 1280, 720]];
  for (const [name, w, h] of only === 'chat' ? [] : pick(ROOM_DEVICES)) {
    step(`closet ${name}`);
    const touch = name !== 'desktop';
    const ctx = await browser.newContext({
      viewport: { width: w, height: h },
      screen: { width: w, height: h },
      deviceScaleFactor: 1,
      isMobile: touch,
      hasTouch: touch,
    });
    const p = await ctx.newPage();
    const tap = (sel) => (touch ? p.tap(sel) : p.click(sel));
    const enterRoom = async () => {
      await p.goto(BASE + Q);
      await p.fill('#nickname', `골방${name}`.slice(0, 12));
      await p.click('#entry-submit');
      await until(p, () => window.__WORLDS_DEBUG__?.net?.status === 'online', null, 60000);
      const door = await p.evaluate(() => window.__WORLDS_TEST__.closetDoor());
      await teleport(p, door);
      await until(p, () => document.getElementById('action-btn').textContent.includes('골방'));
      await p.keyboard.press('KeyE');
      await until(p, () => window.__WORLDS_DEBUG__.m3.closet === true && window.__WORLDS_DEBUG__.m3.worship.mode === 'room', null, 20000);
      await sleep(900);
    };
    await enterRoom();
    const def = (await debug(p)).m3.worship;
    check(`골방 ${name}: default size 보통, player on the wall (펼침)`, def.roomSize === 'm' && def.effective === 'open');
    const area = {};
    for (const size of ['s', 'm', 'l']) {
      await tap(`#worship-room-${size}`);
      await sleep(500);
      const r = await p.evaluate(() => {
        const box = (sel) => {
          const e = document.querySelector(sel);
          if (!e) return null;
          const s = getComputedStyle(e);
          if (s.display === 'none' || e.hidden) return null;
          const b = e.getBoundingClientRect();
          return { x: b.x, y: b.y, width: b.width, height: b.height };
        };
        return {
          card: box('#worship'),
          frame: box('.worship-frame'),
          meditate: box('#closet-meditate'),
          exit: box('#closet-exit'),
          head: box('.closet-head'),
          tools: box('#tools'),
          place: box('.place-card'),
          clock: box('.clock-card'),
        };
      });
      area[size] = r.frame.width * r.frame.height;
      const limit = { s: 380, m: Math.max(380, 0.36 * w), l: Math.max(380, 0.61 * w) }[size];
      const hits = ['meditate', 'exit', 'head', 'tools', 'place', 'clock'].filter((k) => overlaps(r.card, r[k]));
      check(
        `골방 ${name} ${size}: video >= 200x200, width within bounds, overlaps nothing`,
        r.frame.width >= 200 && r.frame.height >= 199.5 && r.card.width <= limit + 1 && r.card.y + r.card.height <= h && hits.length === 0,
        `${Math.round(r.card.width)}x${Math.round(r.card.height)} frame ${Math.round(r.frame.width)}x${Math.round(r.frame.height)} limit ${Math.round(limit)} ${hits.join(',')}`,
      );
      if (size === 'm' || (size === 'l' && ['ipad-air', 'desktop', 'ipad-pro-land', 'phone'].includes(name)) || (size === 's' && name === 'phone')) {
        await p.screenshot({ path: resolve(shotDir, `m52-closet-${name}-${size}.png`) });
      }
    }
    check(`골방 ${name}: the steps grow (작게 ≤ 보통 ≤ 크게, 작게 < 크게)`, area.s <= area.m + 1 && area.m <= area.l + 1 && area.s < area.l, JSON.stringify(area));
    // persists per device type
    await tap('#worship-room-l');
    await enterRoom();
    const again = (await debug(p)).m3.worship;
    check(`골방 ${name}: size choice remembered after reload`, again.roomSize === 'l' && (await p.evaluate(() => document.getElementById('worship').classList.contains('room-l'))));
    await tap('#worship-room-m');

    // 작게 and 접기 in the room
    await tap('#worship-mini');
    await until(p, () => window.__WORLDS_DEBUG__.m3.worship.effective === 'mini');
    await sleep(500);
    const mf = await p.locator('.worship-frame').boundingBox();
    const mh = await p.locator('#worship-handle').boundingBox();
    check(`골방 ${name}: 작게 shows the minimum video with the handle beside it`, mf.width >= 200 && mf.height >= 199.5 && !overlaps(mf, mh));
    if (name === 'ipad-mini') await p.screenshot({ path: resolve(shotDir, `m52-closet-${name}-mini.png`) });
    await tap('#worship-handle');
    await until(p, () => window.__WORLDS_DEBUG__.m3.worship.effective === 'open');
    await tap('#worship-fold');
    await until(p, () => window.__WORLDS_DEBUG__.m3.worship.effective === 'folded');
    // The PAUSED event can lag the tap on a slow machine: once paused it must stay
    // paused, and the player must never report PLAYING while folded.
    const seen = [];
    for (let i = 0; i < 8; i++) {
      seen.push((await debug(p)).m3.worship.state);
      await sleep(400);
    }
    const firstPaused = seen.findIndex((st) => st !== 'playing' && st !== 'buffering');
    const fw = (await debug(p)).m3.worship;
    check(
      `골방 ${name}: 접기 pauses (never playing) and shows the tab`,
      firstPaused >= 0 && firstPaused <= 3 && !seen.slice(firstPaused).includes('playing') && !fw.playedWhileFolded && fw.tabVisible,
      JSON.stringify({ seen, pwf: fw.playedWhileFolded, tab: fw.tabVisible }),
    );
    if (name === 'ipad-mini') await p.screenshot({ path: resolve(shotDir, `m52-closet-${name}-folded.png`) });
    await tap('#worship-tab');
    await until(p, () => window.__WORLDS_DEBUG__.m3.worship.effective === 'open');
    check(`골방 ${name}: single iframe`, (await debug(p)).m3.worship.iframes === 1);
    await ctx.close();
  }
} catch (err) {
  check('test run completed', false, `[step: ${currentStep()}] ${String(err).split('\n')[0]}`);
} finally {
  for (const r of raws) r.ws.close();
  await browser?.close();
  await stopAll();
  dropDb(DB);
}
process.exit(summary());
