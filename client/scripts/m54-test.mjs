// M5.4 test: sitting on the 중앙 광장 benches (server-authoritative seats like
// the campfire logs), plus quick checks that logs, mats and today's letter at
// the plaza basin still work.
// Ports: 5192 preview, 5193 server (override with TEST_CLIENT_PORT / TEST_SERVER_PORT).
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/m54-test.mjs
import { resolve } from 'node:path';
import { check, debug, dropDb, freshDb, join, launch, of, rawClient, shotDir, sleep, startPreview, startServer, step, stopAll, summary, teleport, until, waitHttp } from './lib/harness.mjs';

const CLIENT_PORT = Number(process.env.TEST_CLIENT_PORT ?? 5192);
const SERVER_PORT = Number(process.env.TEST_SERVER_PORT ?? 5193);
const BASE = `http://127.0.0.1:${CLIENT_PORT}/`;
const WS = `ws://127.0.0.1:${CLIENT_PORT}/ws`;
const Q = '?test=1&shadows=0&time=10:30&noguide=1';
const DB = freshDb('m54');
const waitOk = (p, fn, arg, ms = 15000) => until(p, fn, arg, ms).then(() => true, () => false);
const remote = (p, id) => p.evaluate((rid) => window.__WORLDS_DEBUG__.net.remotes.find((r) => r.id === rid), id);

let browser;
const raws = [];
try {
  startServer(SERVER_PORT, DB, { MAX_CONN_PER_IP: '60' });
  await waitHttp(`http://127.0.0.1:${SERVER_PORT}/health`);
  startPreview(CLIENT_PORT, SERVER_PORT);
  await waitHttp(BASE);
  browser = await launch();

  step('benches');
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  await join(A, BASE, '벤치A', Q);
  await join(B, BASE, '벤치B', Q);
  const idA = (await debug(A)).net.id;
  const idB = (await debug(B)).net.id;

  // Today's letter still lands in the plaza basin (benches don't get in the way).
  check("today's letter still lands and waits at the plaza", await waitOk(A, () => window.__WORLDS_DEBUG__.m3.letter === 'waiting', null, 90000));
  check('the letter is on screen to tap', !!(await A.evaluate(() => window.__WORLDS_TEST__.letterScreen())));

  const { benches, seats } = await A.evaluate(() => window.__WORLDS_TEST__.benchSeats());
  const per = new Map();
  for (const s of seats) per.set(s.bench, (per.get(s.bench) ?? 0) + 1);
  check('4 benches, 2–3 seats each', benches.length === 4 && [...per.values()].every((n) => n >= 2 && n <= 3), `${seats.length} seats`);
  check('every seat faces the plaza centre (same as its bench)', seats.every((s) => Math.abs(s.yaw - Math.atan2(-s.x, -s.z)) < 0.12 && s.yaw === benches[s.bench].yaw));
  const front = (i, m = 1.0) => ({ x: seats[i].x + Math.sin(seats[i].yaw) * m, z: seats[i].z + Math.cos(seats[i].yaw) * m });

  // A sits on seat 2 (bench 1) with E.
  await teleport(A, front(2));
  check('near a free bench the prompt says 벤치에 앉기 (E)', await waitOk(A, () => document.getElementById('action-btn').textContent === '벤치에 앉기 (E)'));
  await A.keyboard.press('KeyE');
  await until(A, () => window.__WORLDS_DEBUG__.net.seat === 2 && window.__WORLDS_DEBUG__.net.seatKind === 'bench');
  let dA = await debug(A);
  check('A sits on bench seat 2 in the sitting pose, snapped onto it', dA.net.pose === 'sit' && dA.net.benches[2] === idA && Math.hypot(dA.player.x - seats[2].x, dA.player.z - seats[2].z) < 0.05);

  // B (touch) sits next to A with the action button.
  await teleport(B, front(3, 1.1));
  check('touch: action button says 벤치에 앉기', await waitOk(B, () => !document.getElementById('action-btn').hidden && document.getElementById('action-btn').textContent === '벤치에 앉기'));
  await waitOk(B, (id) => window.__WORLDS_DEBUG__.net.remotes.find((r) => r.id === id)?.pose === 'sit', idA);
  const rA = await remote(B, idA);
  check('B sees A seated on the bench', rA.seatKind === 'bench' && rA.seat === 2 && rA.pose === 'sit' && Math.hypot(rA.x - seats[2].x, rA.z - seats[2].z) < 0.1, JSON.stringify({ k: rA.seatKind, p: rA.pose }));
  await B.tap('#action-btn');
  await until(B, () => window.__WORLDS_DEBUG__.net.seat === 3 && window.__WORLDS_DEBUG__.net.seatKind === 'bench');
  check('A sees B seated on seat 3', await waitOk(A, (id) => window.__WORLDS_DEBUG__.net.remotes.find((r) => r.id === id)?.seatKind === 'bench', idB));

  // Screenshots: two people on one bench by day, from the default camera
  // (behind the local player) and from in front.
  await sleep(1500);
  await A.screenshot({ path: resolve(shotDir, 'm54-plaza-bench-desktop-behind.png') });
  await A.evaluate((yaw) => window.__WORLDS_TEST__.view(yaw - 0.3, 0.25, -3), seats[2].yaw);
  await sleep(1500);
  await A.screenshot({ path: resolve(shotDir, 'm54-plaza-bench-desktop.png') });
  await B.evaluate((yaw) => window.__WORLDS_TEST__.view(yaw + 0.35, 0.28), seats[3].yaw);
  await sleep(1500);
  await B.screenshot({ path: resolve(shotDir, 'm54-plaza-bench-phone.png') });

  // Refusals.
  const thief = await rawClient(WS, { nickname: '자리도둑', test: true });
  raws.push(thief);
  thief.send({ t: 'state', ...front(2), y: 3, yaw: 0, speed: 0 });
  await sleep(300);
  thief.send({ t: 'sit', kind: 'bench', seat: 2 });
  await sleep(600);
  check('occupied bench seat is refused (seat_taken)', of(thief, 'error').some((e) => e.code === 'seat_taken'));
  thief.send({ t: 'sit', kind: 'bench', seat: 6 });
  await sleep(600);
  check("can't sit on a bench from far away (not_near)", of(thief, 'error').some((e) => e.code === 'not_near'));
  thief.send({ t: 'sit', kind: 'bench', seat: 8 });
  await sleep(400);
  check('bad bench index rejected', of(thief, 'error').some((e) => e.code === 'bad_message'));

  // Disconnect and walking off free the seat.
  const sitter = await rawClient(WS, { nickname: '앉았다감', test: true });
  raws.push(sitter);
  sitter.send({ t: 'state', ...front(4), y: 3, yaw: 0, speed: 0 });
  await sleep(300);
  sitter.send({ t: 'sit', kind: 'bench', seat: 4 });
  const sitterId = of(sitter, 'welcome')[0].id;
  await until(B, (id) => window.__WORLDS_DEBUG__.net.benches[4] === id, sitterId);
  await sleep(400);
  check('snapshots carry seatKind bench', of(thief, 'snap').at(-1)?.players.find((pl) => pl.id === sitterId)?.seatKind === 'bench');
  check('welcome carries bench occupancy', Array.isArray(of(sitter, 'welcome')[0].benches) && of(sitter, 'welcome')[0].benches.length === seats.length);
  sitter.ws.close();
  check('disconnect frees the bench seat', await waitOk(B, () => window.__WORLDS_DEBUG__.net.benches[4] === null));
  const walker = await rawClient(WS, { nickname: '걷는사람', test: true });
  raws.push(walker);
  walker.send({ t: 'state', ...front(6), y: 3, yaw: 0, speed: 0 });
  await sleep(300);
  walker.send({ t: 'sit', kind: 'bench', seat: 6 });
  const walkerId = of(walker, 'welcome')[0].id;
  await until(B, (id) => window.__WORLDS_DEBUG__.net.benches[6] === id, walkerId);
  walker.send({ t: 'state', ...front(6, 3), y: 3, yaw: 0, speed: 3 });
  check('walking away (state far from the seat) frees it server-side', await waitOk(B, () => window.__WORLDS_DEBUG__.net.benches[6] === null));

  // A moves: stands up forward, off the bench, and frees seat 2.
  await A.keyboard.down('KeyW');
  await sleep(700);
  await A.keyboard.up('KeyW');
  const freed = await waitOk(B, () => window.__WORLDS_DEBUG__.net.benches[2] === null);
  await waitOk(A, () => window.__WORLDS_DEBUG__.net.seat === -1 && window.__WORLDS_DEBUG__.net.pose === 'stand');
  dA = await debug(A);
  const fwd = (dA.player.x - seats[2].x) * Math.sin(seats[2].yaw) + (dA.player.z - seats[2].z) * Math.cos(seats[2].yaw);
  check('moving stands A up (in front of the bench) and frees the seat', freed && dA.net.pose === 'stand' && fwd > 0.6, `forward ${fwd.toFixed(2)} m`);
  check('B sees A standing again', await waitOk(B, (id) => window.__WORLDS_DEBUG__.net.remotes.find((r) => r.id === id)?.pose === 'stand', idA));
  await B.tap('#action-btn');
  check('touch: 일어나기 frees the bench seat', await waitOk(A, () => window.__WORLDS_DEBUG__.net.benches[3] === null));

  // Quick: logs and mats still work.
  step('logs + mats');
  const { seats: logs } = await A.evaluate(() => window.__WORLDS_TEST__.logSeats());
  await teleport(A, { x: logs[0].x + Math.sin(logs[0].yaw), z: logs[0].z + Math.cos(logs[0].yaw) });
  await waitOk(A, () => document.getElementById('action-btn').textContent === '통나무에 앉기 (E)');
  await A.keyboard.press('KeyE');
  check('log seat still works', await waitOk(B, (id) => window.__WORLDS_DEBUG__.net.logs[0] === id, idA));
  await A.keyboard.press('KeyE');
  await waitOk(B, () => window.__WORLDS_DEBUG__.net.logs[0] === null);
  await teleport(A, { x: -52 + 5.2 + 1.0, z: -16 });
  await waitOk(A, () => document.getElementById('action-btn').textContent === '자리에 앉기 (E)');
  await A.keyboard.press('KeyE');
  check('mat still works (praying pose)', (await waitOk(B, (id) => window.__WORLDS_DEBUG__.net.mats[0] === id, idA)) && (await waitOk(A, () => window.__WORLDS_DEBUG__.net.pose === 'pray')));
  await A.keyboard.press('KeyE');
  check('standing from the mat frees it', await waitOk(B, () => window.__WORLDS_DEBUG__.net.mats[0] === null));
  await ctxA.close();
  await ctxB.close();
} catch (err) {
  check('unexpected error', false, String(err?.stack ?? err).slice(0, 600));
} finally {
  for (const r of raws) r.ws.close();
  await browser?.close();
  await stopAll();
  dropDb(DB);
}
process.exit(summary());
