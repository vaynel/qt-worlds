// M5.3 test: campfire chat 접기/펼치기 (pill + unread badge, persistence, no
// overlaps on phone/tablet/desktop) and sitting on the campfire log benches
// (server-authoritative seats, synced pose, refusals, stand on move/disconnect).
// Ports: 5186 preview, 5187 server.
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/m53-test.mjs
// Dev filters: M53_ONLY=chat|logs, M53_DEVICES=phone,desktop
import { resolve } from 'node:path';
import {
  check,
  debug,
  dropDb,
  freshDb,
  join,
  launch,
  loginJoin,
  of,
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
import { layoutBoxes, overlaps } from './lib/tablet.mjs';

const CLIENT_PORT = 5186;
const SERVER_PORT = 5187;
const BASE = `http://127.0.0.1:${CLIENT_PORT}/`;
const WS = `ws://127.0.0.1:${CLIENT_PORT}/ws`;
const Q = '?test=1&shadows=0&time=14:00&noguide=1';
const QN = '?test=1&shadows=0&time=21:30&noguide=1';
const DB = freshDb('m53');
const FIRE = { x: 50, z: -12 };
const near = { x: 51, z: -6 };
const only = process.env.M53_ONLY ?? '';
const pick = (list) => (process.env.M53_DEVICES ? list.filter(([n]) => process.env.M53_DEVICES.split(',').includes(n)) : list);

const DEVICES = [
  ['phone', 390, 844, true],
  ['phone-s', 360, 740, true],
  ['ipad-air', 820, 1180, true],
  ['ipad-air-land', 1180, 820, true],
  ['desktop', 1280, 720, false],
];
const AVOID = ['voice', 'joystick', 'tools', 'place', 'clock', 'action', 'emote', 'camera'];

async function boxes(p) {
  const b = await layoutBoxes(p);
  const extra = await p.evaluate(() => {
    const box = (s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    };
    return { pill: box('#chat-pill'), badge: box('#chat-unread'), fold: box('#chat-fold'), size: box('#chat-collapse'), head: box('.chat-head') };
  });
  return { ...b, ...extra };
}
const hitsOf = (b, target, keys = AVOID) => keys.filter((k) => overlaps(b[target], b[k]));
/** like until(), but a timeout is a failed check instead of an abort */
const waitOk = (p, fn, arg, ms = 15000) => until(p, fn, arg, ms).then(() => true, () => false);
const isFolded = (p) => p.evaluate(() => document.getElementById('chat').classList.contains('folded'));
const inView = (r, b) => r && r.x >= 0 && r.y >= 0 && r.x + r.width <= b.viewport.width + 0.5 && r.y + r.height <= b.viewport.height + 0.5;

let browser;
const raws = [];
try {
  startServer(SERVER_PORT, DB, { WORLDS_AUTH_MOCK: '1', AUTH_RATE_LIMIT: '300', MAX_CONN_PER_IP: '60' });
  await waitHttp(`http://127.0.0.1:${SERVER_PORT}/health`);
  startPreview(CLIENT_PORT, SERVER_PORT);
  await waitHttp(BASE);
  browser = await launch(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']);

  // Someone at the fire who keeps talking.
  const friend = await rawClient(WS, { nickname: '모닥불친구', test: true });
  raws.push(friend);
  friend.send({ t: 'state', x: near.x + 2, y: 3, z: near.z, yaw: 0, speed: 0 });
  let said = 0;
  const say = async (text) => {
    // Chat bucket: 3 burst, 1 per 2 s.
    if (++said > 2) await sleep(2100);
    friend.send({ t: 'chat', text });
  };

  // ================================================================ chat fold
  let groupCode = null;
  for (const [name, w, h, touch] of only === 'logs' ? [] : pick(DEVICES)) {
    step(`fold ${name}`);
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, screen: { width: w, height: h }, deviceScaleFactor: 1, isMobile: touch, hasTouch: touch });
    const p = await ctx.newPage();
    const tap = (sel) => (touch ? p.tap(sel) : p.click(sel));
    await loginJoin(p, BASE, `fold-${name}`, `접기${name}`.slice(0, 12), Q);
    // A voice room so the voice chip is on screen too.
    if (!groupCode) {
      groupCode = await p.evaluate(async () => (await (await fetch('/api/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '모닥불' }) })).json()).code);
    } else {
      await p.evaluate(async (code) => fetch('/api/groups/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }), groupCode);
    }
    const gid = await p.evaluate(async () => (await (await fetch('/api/groups')).json()).groups[0].id);
    await p.evaluate((g) => window.__WORLDS_TEST__.voiceJoin(g), gid);
    await until(p, () => window.__WORLDS_DEBUG__.m4.voice?.state === 'in', null, 20000);

    await teleport(p, near);
    await until(p, () => window.__WORLDS_DEBUG__.net.chatVisible);
    await sleep(600);
    let b = await boxes(p);
    check(`${name}: header has [작게] [접기] (no separate 닫기)`, !!b.size && !!b.fold && (await p.$('#chat-close')) === null);
    check(`${name}: 작게 and 접기 are ≥40px tap targets`, b.size.height >= 40 && b.size.width >= 40 && b.fold.height >= 40 && b.fold.width >= 40, `${Math.round(b.size.width)}x${Math.round(b.size.height)}, ${Math.round(b.fold.width)}x${Math.round(b.fold.height)}`);
    check(`${name}: open panel overlaps nothing`, hitsOf(b, 'chat').length === 0, hitsOf(b, 'chat').join(',') || 'ok');

    // 작게 first, so we can see unfolding restores it.
    await tap('#chat-collapse');
    await sleep(200);
    await p.focus('#chat-input');
    await tap('#chat-fold');
    await sleep(400);
    await waitOk(p, () => window.__WORLDS_DEBUG__.net.chatFolded);
    b = await boxes(p);
    check(`${name}: 접기 folds the panel to the pill`, (await isFolded(p)) && !b.input && !b.log && !!b.pill, `pill ${JSON.stringify(b.pill && { w: Math.round(b.pill.width), h: Math.round(b.pill.height) })}`);
    check(`${name}: pill is a ≥40px tap target, fully on screen`, b.pill.height >= 40 && b.pill.width >= 40 && inView(b.pill, b));
    check(`${name}: folding drops focus (no keyboard)`, await p.evaluate(() => document.activeElement?.id !== 'chat-input' && !document.body.classList.contains('chatting')));
    check(`${name}: folded state saved`, (await p.evaluate(() => localStorage.getItem('worlds.chat.folded'))) === '1');

    // Messages while folded: badge counts them, bubbles still show.
    const fid = await p.evaluate(() => window.__WORLDS_DEBUG__.net.remotes.find((r) => r.name === '모닥불친구')?.id);
    await say(`접힌 동안 하나 ${name}`);
    await say(`접힌 동안 둘 ${name}`);
    await until(p, () => window.__WORLDS_DEBUG__.net.chatUnread >= 2, null, 15000);
    b = await boxes(p);
    const badge = await p.textContent('#chat-unread');
    check(`${name}: unread badge counts messages received while folded`, badge === '2' && !!b.badge, `badge "${badge}"`);
    check(`${name}: speech bubble still shows over the speaker while folded`, await p.evaluate((id) => window.__WORLDS_DEBUG__.net.remotes.find((r) => r.id === id)?.bubble === true, fid));

    {
      const bb = await boxes(p);
      const hits = hitsOf(bb, 'pill');
      check(`${name}: pill clear of voice/joystick/HUD/buttons, on screen`, hits.length === 0 && inView(bb.pill, bb), hits.join(',') || 'ok');
      await p.screenshot({ path: resolve(shotDir, `m53-chat-folded-${name}.png`) });
    }

    // Unfold: back at 작게, badge cleared.
    await tap('#chat-pill');
    await sleep(400);
    await waitOk(p, () => !window.__WORLDS_DEBUG__.net.chatFolded && window.__WORLDS_DEBUG__.net.chatUnread === 0);
    b = await boxes(p);
    const d = (await debug(p)).net;
    const cls = await p.evaluate(() => document.getElementById('chat').className);
    check(`${name}: pill unfolds to the previous size (작게)`, !d.chatFolded && !!b.input && !b.pill && /\bcollapsed\b/.test(cls), JSON.stringify({ folded: d.chatFolded, input: !!b.input, pill: !!b.pill, cls }));
    check(`${name}: unread badge cleared on unfold`, d.chatUnread === 0 && (await p.evaluate(() => document.getElementById('chat-unread').hidden)), `unread ${d.chatUnread}`);
    check(`${name}: latest message visible after unfolding`, (await p.evaluate(() => document.querySelector('#chat-log li:last-child')?.textContent ?? '')).includes('접힌 동안 둘'));
    check(`${name}: unfolded (작게) overlaps nothing`, hitsOf(b, 'chat').length === 0, hitsOf(b, 'chat').join(',') || 'ok');
    await tap('#chat-collapse'); // 크게
    await sleep(300);
    b = await boxes(p);
    check(`${name}: unfolded (크게) overlaps nothing`, hitsOf(b, 'chat').length === 0, hitsOf(b, 'chat').join(',') || 'ok');
    await p.screenshot({ path: resolve(shotDir, `m53-chat-unfolded-${name}.png`) });

    // Fold, then reload: still folded when back at the fire.
    await tap('#chat-fold');
    await sleep(200);
    if (name === 'phone' || name === 'desktop' || name === 'ipad-air') {
      await p.evaluate(() => window.__WORLDS_TEST__.voiceLeave());
      await join(p, BASE, `접기${name}`.slice(0, 12), Q);
      await teleport(p, near);
      await until(p, () => window.__WORLDS_DEBUG__.net.chatVisible);
      await sleep(400);
      b = await boxes(p);
      check(`${name}: folded state survives a reload`, (await isFolded(p)) && !!b.pill && !b.input);
    }
    // Leave the campfire: pill hidden too; come back: pill again.
    await teleport(p, { x: FIRE.x + 20, z: FIRE.z + 6 });
    await until(p, () => !window.__WORLDS_DEBUG__.net.chatVisible);
    b = await boxes(p);
    check(`${name}: away from the fire neither panel nor pill shows`, !b.pill && !b.chat);
    await teleport(p, near);
    await until(p, () => window.__WORLDS_DEBUG__.net.chatVisible);
    await tap('#chat-pill');
    await sleep(400);
    check(`${name}: back at the fire the pill unfolds the panel`, !(await isFolded(p)) && !!(await boxes(p)).input);
    await p.evaluate(() => window.__WORLDS_TEST__.voiceLeave());
    await ctx.close();
  }

  // ================================================================ log seats
  if (only !== 'chat') {
    step('logs');
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const A = await ctxA.newPage();
    const B = await ctxB.newPage();
    await join(A, BASE, '통나무A', QN);
    await join(B, BASE, '통나무B', QN);
    const idA = (await debug(A)).net.id;
    const idB = (await debug(B)).net.id;
    const { campfire, seats } = await A.evaluate(() => window.__WORLDS_TEST__.logSeats());

    const perLog = new Map();
    for (const s of seats) perLog.set(s.log, (perLog.get(s.log) ?? 0) + 1);
    check('8–12 log seats, 2–3 per log', seats.length >= 8 && seats.length <= 12 && [...perLog.values()].every((n) => n >= 2 && n <= 3), `${seats.length} seats on ${perLog.size} logs`);
    const dists = seats.map((s) => Math.hypot(s.x - campfire.x, s.z - campfire.z));
    check('every seat is well inside the chat radius', dists.every((r) => r < campfire.chatRadius - 1), `max ${Math.max(...dists).toFixed(2)} m of ${campfire.chatRadius}`);
    const facing = seats.every((s) => {
      const want = Math.atan2(campfire.x - s.x, campfire.z - s.z);
      return Math.abs(Math.atan2(Math.sin(s.yaw - want), Math.cos(s.yaw - want))) < 0.01;
    });
    check('every seat faces the fire', facing);
    // Stand 1 m in front of a seat (between log and fire).
    const front = (i, m = 1.0) => ({ x: seats[i].x + Math.sin(seats[i].yaw) * m, z: seats[i].z + Math.cos(seats[i].yaw) * m });

    // A sits on seat 0 with E.
    await teleport(A, front(0));
    await until(A, () => document.getElementById('action-btn').textContent.includes('통나무에 앉기'));
    check('near a free log seat the prompt says 통나무에 앉기 (E)', (await A.textContent('#action-btn')).includes('(E)'));
    await A.keyboard.press('KeyE');
    await until(A, () => window.__WORLDS_DEBUG__.net.seat === 0 && window.__WORLDS_DEBUG__.net.seatKind === 'log');
    let dA = (await debug(A)).net;
    check('A sits on log seat 0 in the relaxed sitting pose', dA.pose === 'sit' && dA.logs[0] === idA, `pose ${dA.pose}`);
    check('A snapped onto the seat', Math.hypot((await debug(A)).player.x - seats[0].x, (await debug(A)).player.z - seats[0].z) < 0.05);
    check('stand prompt shows while seated', (await A.textContent('#action-btn')).includes('일어나기'));
    await until(B, (id) => window.__WORLDS_DEBUG__.net.logs[0] === id, idA);
    await teleport(B, front(1, 1.1));
    await until(B, (id) => window.__WORLDS_DEBUG__.net.remotes.find((r) => r.id === id)?.pose === 'sit', idA);
    const rA = (await debug(B)).net.remotes.find((r) => r.id === idA);
    check('B sees A seated on the log (sit pose, at the seat)', rA.seatKind === 'log' && rA.seat === 0 && Math.hypot(rA.x - seats[0].x, rA.z - seats[0].z) < 0.1, JSON.stringify({ k: rA.seatKind, p: rA.pose }));

    // B (touch) sits on seat 1 with the action button.
    await until(B, () => !document.getElementById('action-btn').hidden && document.getElementById('action-btn').textContent === '통나무에 앉기');
    check('touch: action button says 통나무에 앉기', true);
    await B.tap('#action-btn');
    await until(B, () => window.__WORLDS_DEBUG__.net.seat === 1 && window.__WORLDS_DEBUG__.net.seatKind === 'log');
    await until(A, (id) => window.__WORLDS_DEBUG__.net.remotes.find((r) => r.id === id)?.pose === 'sit', idB);
    check('A sees B seated on seat 1', true);

    // Chat while seated.
    check('chat is open for both while seated', (await debug(A)).net.chatVisible && (await debug(B)).net.chatVisible);
    await A.fill('#chat-input', '불 따뜻하네요');
    await A.press('#chat-input', 'Enter');
    await until(B, () => window.__WORLDS_DEBUG__.net.chatLog.some((l) => l.includes('불 따뜻하네요')), null, 15000);
    check('seated A chats, seated B hears it', true);
    await A.evaluate(() => document.activeElement?.blur());
    await B.fill('#chat-input', '아멘, 같이 앉으니 좋아요');
    await B.press('#chat-input', 'Enter');
    await until(A, () => window.__WORLDS_DEBUG__.net.chatLog.some((l) => l.includes('같이 앉으니')), null, 15000);
    await B.evaluate(() => document.activeElement?.blur());

    // Night screenshot from beyond the fire, looking at the two on their log.
    await A.evaluate((yaw) => window.__WORLDS_TEST__.view(yaw, 0.22, -2), seats[0].yaw + 0.25);
    await sleep(1500);
    await A.screenshot({ path: resolve(shotDir, 'm53-logs-night-desktop.png') });
    // Phone: fold the chat so the scene shows (the pill stays).
    await B.tap('#chat-fold');
    await B.evaluate((yaw) => window.__WORLDS_TEST__.view(yaw - 0.35, 0.25), seats[1].yaw);
    await sleep(1200);
    await B.screenshot({ path: resolve(shotDir, 'm53-logs-night-phone.png') });

    // Refusals.
    const thief = await rawClient(WS, { nickname: '자리도둑', test: true });
    raws.push(thief);
    thief.send({ t: 'state', ...front(0), y: 3, yaw: 0, speed: 0 });
    await sleep(300);
    thief.send({ t: 'sit', kind: 'log', seat: 0 });
    await sleep(600);
    check('occupied log seat is refused (seat_taken)', of(thief, 'error').some((e) => e.code === 'seat_taken') && (await debug(A)).net.logs[0] === idA);
    const far = await rawClient(WS, { nickname: '멀리서', test: true });
    raws.push(far);
    far.send({ t: 'state', x: FIRE.x + 15, y: 3, z: FIRE.z, yaw: 0, speed: 0 });
    await sleep(300);
    far.send({ t: 'sit', kind: 'log', seat: 4 });
    await sleep(600);
    check("can't sit from far away (not_near)", of(far, 'error').some((e) => e.code === 'not_near') && (await debug(A)).net.logs[4] === null);
    far.send({ t: 'sit', kind: 'log', seat: 99 });
    await sleep(400);
    check('bad seat index rejected', of(far, 'error').some((e) => e.code === 'bad_message'));

    // A raw sitter on seat 4: B sees it; disconnect frees it.
    const sitter = await rawClient(WS, { nickname: '앉았다감', test: true });
    raws.push(sitter);
    sitter.send({ t: 'state', ...front(4), y: 3, yaw: 0, speed: 0 });
    await sleep(300);
    sitter.send({ t: 'sit', kind: 'log', seat: 4 });
    const sitterId = of(sitter, 'welcome')[0].id;
    await until(B, (id) => window.__WORLDS_DEBUG__.net.logs[4] === id, sitterId);
    const snapSeat = of(thief, 'snap').at(-1)?.players.find((pl) => pl.id === sitterId);
    await sleep(300);
    const snap2 = of(thief, 'snap').at(-1)?.players.find((pl) => pl.id === sitterId);
    check('snapshots carry seatKind log for log sitters', (snap2 ?? snapSeat)?.seatKind === 'log' && (snap2 ?? snapSeat)?.seat === 4);
    sitter.ws.close();
    await until(B, () => window.__WORLDS_DEBUG__.net.logs[4] === null);
    check('disconnect frees the log seat', true);

    // A raw client that walks off without 'stand' is stood up by the server.
    const walker = await rawClient(WS, { nickname: '걷는사람', test: true });
    raws.push(walker);
    walker.send({ t: 'state', ...front(6), y: 3, yaw: 0, speed: 0 });
    await sleep(300);
    walker.send({ t: 'sit', kind: 'log', seat: 6 });
    const walkerId = of(walker, 'welcome')[0].id;
    await until(B, (id) => window.__WORLDS_DEBUG__.net.logs[6] === id, walkerId);
    walker.send({ t: 'state', x: front(6, 3).x, y: 3, z: front(6, 3).z, yaw: 0, speed: 3 });
    await until(B, () => window.__WORLDS_DEBUG__.net.logs[6] === null);
    check('moving away (state far from the seat) frees it server-side', true);

    // A moves: stands up and frees seat 0.
    await A.keyboard.down('KeyW');
    await sleep(700);
    await A.keyboard.up('KeyW');
    await until(A, () => window.__WORLDS_DEBUG__.net.seat === -1);
    await until(B, () => window.__WORLDS_DEBUG__.net.logs[0] === null);
    await until(B, (id) => window.__WORLDS_DEBUG__.net.remotes.find((r) => r.id === id)?.pose === 'stand', idA);
    dA = (await debug(A)).net;
    check('moving stands A up; seat 0 freed for everyone', dA.pose === 'stand' && dA.logs[0] === null);
    // Now the thief can take it.
    thief.inbox.length = 0;
    thief.send({ t: 'sit', kind: 'log', seat: 0 });
    await until(B, () => typeof window.__WORLDS_DEBUG__.net.logs[0] === 'string');
    check('freed seat can be taken by someone else', !of(thief, 'error').length);
    thief.send({ t: 'stand' });

    // B stands with the button.
    await B.tap('#action-btn');
    await until(A, () => window.__WORLDS_DEBUG__.net.logs[1] === null);
    check('touch: 일어나기 button stands up and frees the seat', await waitOk(B, () => window.__WORLDS_DEBUG__.net.seat === -1));

    // Mats still work (기도의 뜰).
    step('mats');
    const mat0 = { x: -52 + 5.2 + 1.0, z: -16 };
    await teleport(A, mat0);
    await until(A, () => document.getElementById('action-btn').textContent.includes('자리에 앉기'));
    await A.keyboard.press('KeyE');
    await until(A, () => window.__WORLDS_DEBUG__.net.seat === 0 && window.__WORLDS_DEBUG__.net.seatKind === 'mat');
    await until(B, (id) => window.__WORLDS_DEBUG__.net.remotes.find((r) => r.id === id)?.seatKind === 'mat', idA);
    const rM = (await debug(B)).net.remotes.find((r) => r.id === idA);
    dA = (await debug(A)).net;
    check('mat sit still works: praying pose, mats[0] synced', dA.pose === 'pray' && dA.mats[0] === idA && rM.pose === 'pray' && (await debug(B)).net.logs.every((x) => x === null));
    const legacy = await rawClient(WS, { nickname: '옛날방식', test: true });
    raws.push(legacy);
    legacy.send({ t: 'state', x: mat0.x, y: 3, z: mat0.z, yaw: 0, speed: 0 });
    await sleep(300);
    legacy.send({ t: 'sit', mat: 0 });
    await sleep(500);
    check('legacy { sit, mat } still refused with mat_taken on an occupied mat', of(legacy, 'error').some((e) => e.code === 'mat_taken'));
    await A.keyboard.press('KeyE');
    await until(B, () => window.__WORLDS_DEBUG__.net.mats[0] === null);
    // __WORLDS_DEBUG__ refreshes every 5 frames; swiftshader frames can be slow.
    await waitOk(A, () => window.__WORLDS_DEBUG__.net.seat === -1 && window.__WORLDS_DEBUG__.net.pose === 'stand');
    const dS = (await debug(A)).net;
    check('standing from the mat frees it', dS.seat === -1 && dS.pose === 'stand', JSON.stringify({ seat: dS.seat, kind: dS.seatKind, pose: dS.pose, mats: dS.mats }));
    await ctxA.close();
    await ctxB.close();
  }
} catch (err) {
  check(`unexpected error`, false, String(err?.stack ?? err).slice(0, 600));
} finally {
  for (const r of raws) r.ws.close();
  await browser?.close();
  await stopAll();
  dropDb(DB);
}
process.exit(summary());
