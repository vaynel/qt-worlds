// EV test: 표현 (emotes) and 🔥 모닥불 공개 음성 (public campfire voice).
//
// Emotes: the 😊 grid opens; firing shows the bubble (and a gesture) to a second
// player in the same space, never to someone in the library or a 골방; keys 1–8;
// the rate limit (burst 3, then 1 per 1.5 s); no 😊 in the 골방; seated → bubble only.
// Campfire voice (fake media + a mock of Cloudflare's TURN API + a local mini TURN
// relay): two signed-in users at the campfire join (muted, mic asked only on 🎤),
// hear each other (inbound-rtp bytes), the ICE config is relay-only and the
// selected candidates are relay; a guest is refused; outside the radius refused and
// walking out leaves; one voice room at a time (group ↔ campfire, with a prompt);
// capacity 8; 3 reports → muted 24 h (fake clock), repeat → 7 days, admin lift;
// non-admin 404. Layout: no overlaps at phone portrait 360/390/412, phone landscape,
// tablet and desktop with every worship state, chat open/folded, the voice chip.
//
// Ports: 5194 server (serves the built client), 5197 mock Cloudflare API, UDP 5198 TURN.
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/ev-test.mjs
// EV_ONLY=api,emote,voice,layout runs some phases only.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
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
  loginJoin,
  join,
  of,
  rawClient,
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
import { startMiniTurn } from './lib/mini-turn.mjs';

const PORT = 5194;
const CF_PORT = 5197;
const TURN_PORT = 5198;
const BASE = `http://127.0.0.1:${PORT}/`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const KEY_ID = 'ev-key-id';
const KEY_TOKEN = 'ev-secret-turn-token';
const ADMIN_HINT = 'ev-admin';
const Q = '?test=1&shadows=0&time=14:00&noguide=1&noworship=1';
const QN = '?test=1&shadows=0&time=21:40&noguide=1&noworship=1';
const DB = freshDb('ev');
const P = await import(pathToFileURL(resolve(serverDir, 'dist/shared/protocol.js')).href);
const ONLY = process.env.EV_ONLY ? process.env.EV_ONLY.split(',') : null;
const run = (phase) => !ONLY || ONLY.includes(phase);

const FIRE = { x: 51, z: -6 }; // 6 m from the campfire (inside the 12 m radius)
const FAR = { x: 50, z: 8 }; // 20 m away
const y = 2;

// ---------------------------------------------------------------- mock Cloudflare TURN API
const cf = { calls: 0 };
const cfServer = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    cf.calls++;
    if (req.method !== 'POST' || !req.url.startsWith(`/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers`) || req.headers.authorization !== `Bearer ${KEY_TOKEN}`) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        iceServers: [
          { urls: ['stun:127.0.0.1:3478'] },
          { urls: [`turn:127.0.0.1:${TURN_PORT}?transport=udp`], username: 'mock-user', credential: 'mock-cred' },
        ],
      }),
    );
  });
});

/** Minimal cookie-keeping HTTP client (a "device"). */
class Agent {
  constructor() {
    this.jar = new Map();
  }
  cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async raw(method, path, body) {
    const res = await fetch(BASE + path.replace(/^\//, ''), {
      method,
      redirect: 'manual',
      headers: { origin: BASE.slice(0, -1), ...(this.jar.size ? { cookie: this.cookie() } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const v = pair.slice(i + 1);
      if (v) this.jar.set(pair.slice(0, i), v);
      else this.jar.delete(pair.slice(0, i));
    }
    return res;
  }
  async json(method, path, body) {
    const res = await this.raw(method, path, body);
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* none */
    }
    return { status: res.status, data, text: JSON.stringify(data) };
  }
  async login(hint, nickname, agree = true) {
    let url = `api/auth/google/start?hint=${hint}&remember=1`;
    for (let i = 0; i < 6; i++) {
      const res = await this.raw('GET', url);
      const loc = res.headers.get('location');
      if (!loc || !loc.includes('/api/')) break;
      url = new URL(loc, BASE).pathname.slice(1) + new URL(loc, BASE).search;
    }
    const r = await this.json('POST', '/api/me/nickname', { nickname, agree });
    if (r.status !== 200 && agree) throw new Error(`login ${hint}: ${r.text}`);
    return this;
  }
  ws(nickname = 'x') {
    return rawClient(WS, { nickname, test: true }, this.jar.size ? { cookie: this.cookie() } : {});
  }
}

const move = (c, p, inside) => c.send({ t: 'state', x: p.x, y, z: p.z, yaw: 0, speed: 0, ...(inside ? { inside } : {}) });
const waitFor = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(50);
  }
  return fn();
};
const box = async (page, sel) => page.locator(sel).first().boundingBox().catch(() => null);
const overlaps = (a, b) => !!a && !!b && a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
const fmt = (r) => (r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` : 'none');
const v = async (page) => (await debug(page)).m4.voice;
const inboundBytes = async (page) => (await page.evaluate(() => window.__WORLDS_TEST__.voiceStats())).reduce((n, s) => n + s.bytesReceived, 0);

const YT_STUB = `
window.YT = { Player: function (el, opts) {
  var st = -1;
  var fire = function (s) { st = s; if (opts.events && opts.events.onStateChange) opts.events.onStateChange({ data: s }); };
  this.playVideo = function () { fire(1); };
  this.pauseVideo = function () { fire(2); };
  this.loadVideoById = function () { fire(1); };
  this.cueVideoById = function () { fire(5); };
  this.getPlayerState = function () { return st; };
  this.seekTo = function () {};
  this.setVolume = function () {};
  this.mute = function () {};
  this.unMute = function () {};
  this.destroy = function () {};
  this.getVideoData = function () { return { video_id: opts.videoId }; };
  setTimeout(function () { if (opts.events && opts.events.onReady) opts.events.onReady(); }, 50);
} };
setTimeout(function () { if (window.onYouTubeIframeAPIReady) window.onYouTubeIframeAPIReady(); }, 0);
`;

let browser;
let turn;
const raws = [];
const keep = (c) => (raws.push(c), c);
try {
  await new Promise((r) => cfServer.listen(CF_PORT, '127.0.0.1', r));
  turn = await startMiniTurn({ port: TURN_PORT });
  startServer(PORT, DB, {
    WORLDS_AUTH_MOCK: '1',
    SERVE_CLIENT: '1',
    WORLDS_CLIENT_DIST: resolve(clientDir, 'dist'),
    AUTH_RATE_LIMIT: '600',
    MAX_CONN_PER_IP: '80',
    IP_RATE_LIMIT: '5000',
    TURN_KEY_ID: KEY_ID,
    TURN_KEY_API_TOKEN: KEY_TOKEN,
    TURN_API_BASE: `http://127.0.0.1:${CF_PORT}`,
    WORLDS_ADMIN_EMAILS: `mock-${ADMIN_HINT}@example.test`,
  });
  await waitHttp(`${BASE}health`);

  // ================================================================ protocol / API (raw clients)
  if (run('api')) {
    step('api: emotes');
    const g1 = keep(await rawClient(WS, { nickname: '손님일', test: true }));
    const g2 = keep(await rawClient(WS, { nickname: '손님이', test: true }));
    const g3 = keep(await rawClient(WS, { nickname: '손님삼', test: true }));
    const g4 = keep(await rawClient(WS, { nickname: '손님사', test: true }));
    const id1 = of(g1, 'welcome')[0].id;
    move(g1, FIRE);
    move(g2, { x: 40, z: 0 });
    move(g3, { x: 0, z: 0 }, 'library');
    move(g4, { x: 0, z: 0 }, 'room');
    await sleep(300);
    g1.send({ t: 'emote', e: 0 });
    await waitFor(() => of(g2, 'emote').length);
    await sleep(300);
    check('emote: a guest may send one; it is echoed to the sender and reaches others in the world', of(g1, 'emote').length === 1 && of(g2, 'emote')[0]?.id === id1 && of(g2, 'emote')[0]?.e === 0, JSON.stringify(of(g2, 'emote')));
    check('emote: never reaches the library or a 골방', of(g3, 'emote').length === 0 && of(g4, 'emote').length === 0);
    g3.send({ t: 'emote', e: 6 });
    g4.send({ t: 'emote', e: 7 });
    await sleep(500);
    check('emote: one sent in the library stays in the library; one sent in a 골방 goes nowhere', of(g3, 'emote').length === 1 && of(g2, 'emote').length === 1 && of(g4, 'emote').length === 0 && of(g1, 'emote').length === 1);
    g1.send({ t: 'emote', e: 8 });
    g1.send({ t: 'emote', e: -1 });
    g1.send({ t: 'emote', e: '1' });
    await sleep(300);
    check('emote: ids outside 0..7 are refused (bad_message), nothing relayed', of(g1, 'error').filter((e) => e.code === 'bad_message').length === 3 && of(g2, 'emote').length === 1);
    // rate limit: burst 3 then 1 per 1.5 s (g1 already used one token ~1 s ago)
    await sleep(3200);
    const before = of(g2, 'emote').length;
    for (let i = 0; i < 6; i++) g1.send({ t: 'emote', e: i });
    await sleep(500);
    const burst = of(g2, 'emote').length - before;
    const limited = of(g1, 'error').filter((e) => e.code === 'rate_limited').length;
    await sleep(1600);
    g1.send({ t: 'emote', e: 3 });
    await sleep(400);
    check('emote: rate limit (6 at once → 3 relayed + rate_limited; 1.5 s later another one goes)', burst === 3 && limited === 3 && of(g2, 'emote').length - before === 4, `burst=${burst} limited=${limited} total=${of(g2, 'emote').length - before}`);
    for (const c of [g1, g2, g3, g4]) c.ws.close();

    step('api: campfire ice');
    const guestAgent = new Agent();
    const ann = await new Agent().login('ev-ann', '앤');
    const bob = await new Agent().login('ev-bob', '밥');
    const noConsent = await new Agent().login('ev-nocons', '미동의');
    {
      // An account from before the current TERMS_VERSION (agreed to an older version).
      const Database = createRequire(resolve(serverDir, 'package.json'))('better-sqlite3');
      const db = new Database(DB);
      db.prepare("UPDATE users SET terms_version = '2026-11-12' WHERE nickname = ?").run('미동의');
      db.close();
    }
    const annWs = keep(await ann.ws());
    const bobWs = keep(await bob.ws());
    move(annWs, FAR);
    move(bobWs, FIRE);
    await sleep(300);
    const iceGuest = await guestAgent.json('GET', '/api/voice/ice?campfire=1');
    const iceFar = await ann.json('GET', '/api/voice/ice?campfire=1');
    const iceNear = await bob.json('GET', '/api/voice/ice?campfire=1');
    check('campfire ICE: guests 401', iceGuest.status === 401, iceGuest.text);
    check('campfire ICE: a signed-in user outside the campfire radius 403 (voice_not_near)', iceFar.status === 403 && iceFar.data?.error === 'voice_not_near', iceFar.text);
    const servers = iceNear.data?.iceServers ?? [];
    check(
      'campfire ICE: near the fire → TURN relay servers only (no stun), relayOnly flag, no secrets',
      iceNear.status === 200 && iceNear.data.relayOnly === true && servers.length === 1 && servers.every((s) => s.urls.every((u) => /^turns?:/.test(u)) && s.username && s.credential) && !iceNear.text.includes(KEY_TOKEN) && !iceNear.text.includes(KEY_ID),
      iceNear.text,
    );
    const ncWs = keep(await noConsent.ws());
    move(ncWs, FIRE);
    await sleep(200);
    const iceNc = await noConsent.json('GET', '/api/voice/ice?campfire=1');
    check('campfire ICE: an account that has not agreed to the current terms 403', iceNc.status === 403 && iceNc.data?.error === 'needs_consent', iceNc.text);
    ncWs.send({ t: 'voiceJoin', groupId: 0 });
    await sleep(300);
    check('campfire voice: no consent → refused over the socket too (voice_consent)', of(ncWs, 'voiceError').some((e) => e.code === 'voice_consent'), JSON.stringify(of(ncWs, 'voiceError')));
    // group ICE unchanged: non-member still 403
    const iceGroup = await bob.json('GET', '/api/voice/ice?group=99');
    check('group voice ICE keeps its old rule (non-members 403)', iceGroup.status === 403);

    step('api: campfire join rules');
    const gWs = keep(await rawClient(WS, { nickname: '손님오', test: true }));
    move(gWs, FIRE);
    await sleep(200);
    gWs.send({ t: 'voiceJoin', groupId: 0 });
    annWs.send({ t: 'voiceJoin', groupId: 0 });
    await sleep(400);
    check('campfire voice: guests refused ("로그인하면 함께 이야기할 수 있어요")', of(gWs, 'voiceError').some((e) => e.code === 'voice_login' && e.message.includes('로그인하면 함께 이야기할 수 있어요')), JSON.stringify(of(gWs, 'voiceError')));
    check('campfire voice: outside the radius refused (voice_not_near)', of(annWs, 'voiceError').some((e) => e.code === 'voice_not_near'));
    bobWs.send({ t: 'voiceJoin', groupId: 0 });
    const room = await waitFor(() => of(bobWs, 'voiceRoom')[0]);
    check('campfire voice: near the fire → joined muted (campfire room, no owner)', room?.campfire === true && room.groupId === 0 && room.owner === false && room.silencedUntil === null, JSON.stringify(room));
    // walking out leaves
    move(bobWs, { x: 51, z: 1 }); // 13 m: inside the 1.5 m slack, still in
    await sleep(300);
    const stillIn = of(bobWs, 'voiceLeft').length === 0;
    move(bobWs, { x: 51, z: 3 }); // 15 m: out
    const left = await waitFor(() => of(bobWs, 'voiceLeft')[0]);
    check('campfire voice: walking out of the circle leaves (reason away; a little slack at the edge)', stillIn && left?.reason === 'away', JSON.stringify(left));
    move(bobWs, FIRE);
    await sleep(200);
    // the library also leaves
    bobWs.send({ t: 'voiceJoin', groupId: 0 });
    await waitFor(() => of(bobWs, 'voiceRoom').length === 2);
    move(bobWs, { x: 0, z: 0 }, 'library');
    await waitFor(() => of(bobWs, 'voiceLeft').length === 2);
    check('campfire voice: stepping into the library leaves too', of(bobWs, 'voiceLeft')[1]?.reason === 'away');
    move(bobWs, { x: 0, z: 0 });
    await sleep(100);
    move(bobWs, FIRE);

    step('api: exclusivity');
    const grp = await bob.json('POST', '/api/groups', { name: '저녁 기도' });
    // voiceJoin is rate limited (burst 4, then one per 2 s): pace the joins.
    await sleep(6500);
    bobWs.send({ t: 'voiceJoin', groupId: grp.data.id });
    await waitFor(() => of(bobWs, 'voiceRoom').some((r) => r.groupId === grp.data.id));
    const leftBefore = of(bobWs, 'voiceLeft').length;
    await sleep(2100);
    bobWs.send({ t: 'voiceJoin', groupId: 0 });
    await waitFor(() => of(bobWs, 'voiceRoom').filter((r) => r.campfire).length === 3);
    check('one voice room at a time: joining the campfire leaves the group room (server)', of(bobWs, 'voiceLeft').length === leftBefore + 1 && of(bobWs, 'voiceRoom').at(-1).campfire === true);
    await sleep(2100);
    bobWs.send({ t: 'voiceJoin', groupId: grp.data.id });
    await waitFor(() => of(bobWs, 'voiceRoom').at(-1)?.groupId === grp.data.id);
    check('…and joining a group room leaves the campfire', of(bobWs, 'voiceLeft').length === leftBefore + 2 && of(bobWs, 'voiceRoom').at(-1).groupId === grp.data.id);
    bobWs.ws.close();
    await sleep(300);

    step('api: capacity');
    const crowd = [];
    for (let i = 0; i < 9; i++) {
      const ag = await new Agent().login(`ev-cap${i}`, `자리${i}`);
      const ws = keep(await ag.ws());
      move(ws, FIRE);
      crowd.push({ ag, ws });
    }
    await sleep(300);
    for (const c of crowd) {
      c.ws.send({ t: 'voiceJoin', groupId: 0 });
      await sleep(60);
    }
    await sleep(800);
    const inRoom = crowd.filter((c) => of(c.ws, 'voiceRoom').length === 1).length;
    const full = crowd.filter((c) => of(c.ws, 'voiceError').some((e) => e.code === 'voice_full' && e.message.includes('자리가 꽉 찼어요'))).length;
    check('campfire voice: 8 speakers at most, the 9th hears "자리가 꽉 찼어요"', inRoom === 8 && full === 1, `in=${inRoom} full=${full}`);
    const ninth = crowd.find((c) => of(c.ws, 'voiceRoom').length === 0);
    const inside = crowd.filter((c) => c !== ninth);

    step('api: reports');
    const target = inside[0];
    const targetId = of(target.ws, 'welcome')[0].id;
    // signaling relays only inside the campfire room
    ninth.ws.send({ t: 'voiceSignal', to: targetId, data: { type: 'offer', sdp: 'v=0 from outside' } });
    inside[1].ws.send({ t: 'voiceSignal', to: targetId, data: { type: 'offer', sdp: 'v=0 inside' } });
    await sleep(300);
    const sigs = of(target.ws, 'voiceSignal');
    check('campfire signaling: relayed between room members only', sigs.length === 1 && sigs[0].data.sdp === 'v=0 inside', JSON.stringify(sigs.map((s) => s.data.sdp)));
    target.ws.send({ t: 'voiceMute', muted: false });
    await sleep(200);
    const guestReport = await guestAgent.json('POST', '/api/voice/campfire/report', { target: targetId, reason: 'abuse' });
    const farReport = await ann.json('POST', '/api/voice/campfire/report', { target: targetId, reason: 'abuse' });
    const badReason = await inside[1].ag.json('POST', '/api/voice/campfire/report', { target: targetId, reason: 'nope' });
    const selfReport = await target.ag.json('POST', '/api/voice/campfire/report', { target: targetId, reason: 'abuse' });
    check('report: guests 401, someone away from the fire 404, a bad reason 400, yourself 404', guestReport.status === 401 && farReport.status === 404 && badReason.status === 400 && selfReport.status === 404, [guestReport.status, farReport.status, badReason.status, selfReport.status].join(','));
    const r1 = await inside[1].ag.json('POST', '/api/voice/campfire/report', { target: targetId, reason: 'abuse' });
    const r1b = await inside[1].ag.json('POST', '/api/voice/campfire/report', { target: targetId, reason: 'harass' });
    const r2 = await inside[2].ag.json('POST', '/api/voice/campfire/report', { target: targetId, reason: 'sexual' });
    await sleep(300);
    check('report: 2 distinct reporters (one twice) → nobody muted yet; replies never say', r1.status === 200 && r1b.status === 200 && r2.status === 200 && of(target.ws, 'voiceSilenced').length === 0 && r2.text === '{"ok":true}');
    const r3 = await ninth.ag.json('POST', '/api/voice/campfire/report', { target: targetId, reason: 'abuse' });
    check('report: a listener-only person at the fire (not in the room) may report too', r3.status === 200, r3.text);
    const sil = await waitFor(() => of(target.ws, 'voiceSilenced')[0]);
    const now = Date.now();
    check('3 distinct reporters within 10 minutes → muted from campfire voice for 24 h (told politely)', sil && Math.abs(sil.until - (now + 24 * 3600_000)) < 60_000, JSON.stringify(sil));
    const peerView = of(inside[3].ws, 'voicePeer').filter((m) => m.peer.id === targetId).at(-1);
    check('others see them muted and silenced (listeners do not play them)', peerView?.peer.muted === true && peerView.peer.silenced === true, JSON.stringify(peerView));
    target.ws.send({ t: 'voiceMute', muted: false });
    await sleep(300);
    check('a muted speaker cannot unmute (server refuses, repeats the notice), but stays in the room to listen', of(target.ws, 'voiceSilenced').length === 2 && of(target.ws, 'voiceLeft').length === 0);
    // admin
    step('api: admin');
    const admin = await new Agent().login(ADMIN_HINT, '관리자');
    const notAdmin = await inside[1].ag.json('GET', '/api/admin/campfire-voice');
    const guestAdmin = await guestAgent.json('GET', '/api/admin/campfire-voice');
    const notAdminPost = await inside[1].ag.json('POST', '/api/admin/campfire-voice/1', { action: 'lift' });
    check('admin list: 404 for non-admins and guests (GET and POST)', notAdmin.status === 404 && guestAdmin.status === 404 && notAdminPost.status === 404);
    const list = await admin.json('GET', '/api/admin/campfire-voice');
    const row = list.data?.people?.find((p) => p.nickname === '자리0');
    check('admin list: the muted user with 3 reports by reason (the same reporter twice counts once) and the active 24 h mute', row && row.reports === 3 && row.reasons.abuse === 2 && row.reasons.sexual === 1 && row.active?.level === 1, JSON.stringify(row));
    // fake clock: 25 h later the mute is over
    await admin.json('POST', '/api/test/voice/clock', { offsetMs: 25 * 3600_000 });
    target.ws.send({ t: 'voiceMute', muted: false });
    await sleep(300);
    const unmuted = of(inside[3].ws, 'voicePeer').filter((m) => m.peer.id === targetId).at(-1);
    check('fake clock +25 h: the mute has ended, they can speak again', unmuted?.peer.muted === false && !unmuted.peer.silenced && of(target.ws, 'voiceSilenced').length === 2, JSON.stringify(unmuted));
    // repeat offender: 3 new reports → a week
    for (const c of [inside[4], inside[5], inside[6]]) await c.ag.json('POST', '/api/voice/campfire/report', { target: targetId, reason: 'harass' });
    const sil2 = await waitFor(() => of(target.ws, 'voiceSilenced')[2]);
    const fake = Date.now() + 25 * 3600_000;
    check('repeat offender: the next 3 reports mute for 7 days', sil2 && Math.abs(sil2.until - (fake + 7 * 24 * 3600_000)) < 120_000, JSON.stringify(sil2));
    const row2 = (await admin.json('GET', '/api/admin/campfire-voice')).data.people.find((p) => p.nickname === '자리0');
    check('admin list: level 2, one earlier mute', row2?.active?.level === 2 && row2.past === 1, JSON.stringify(row2));
    const ext = await admin.json('POST', `/api/admin/campfire-voice/${row2.userId}`, { action: 'extend', days: 3 });
    check('admin: extend adds days', ext.status === 200 && Math.abs(ext.data.until - (sil2.until + 3 * 86_400_000)) < 1000, ext.text);
    const lift = await admin.json('POST', `/api/admin/campfire-voice/${row2.userId}`, { action: 'lift' });
    const liftMsg = await waitFor(() => of(target.ws, 'voiceSilenced').find((m, i) => i >= 3 && m.until === null));
    check('admin: lift ends the mute at once and tells the user', lift.status === 200 && !!liftMsg);
    await admin.json('POST', '/api/test/voice/clock', { offsetMs: 0 });
    // export holds my reports (never who reported me)
    const exp = await inside[1].ag.json('GET', '/api/me/export');
    const expT = await target.ag.json('GET', '/api/me/export');
    check('export: reports I made and mutes I received (no reporter identities)', exp.data?.campfireVoice?.reportsMade?.length === 1 && expT.data?.campfireVoice?.campfireVoiceMutes?.length === 2 && !expT.text.includes('자리1'), JSON.stringify(expT.data?.campfireVoice));
    for (const c of raws) c.ws.close();
    raws.length = 0;
    await sleep(500);
  }

  browser = await launch([
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ]);

  // ================================================================ emotes in the browser
  if (run('emote')) {
    step('emote: setup');
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const deskCtx = await browser.newContext(desktop);
    const libCtx = await browser.newContext(desktop);
    const roomCtx = await browser.newContext(desktop);
    const A = await phoneCtx.newPage();
    const B = await deskCtx.newPage();
    const L = await libCtx.newPage();
    const R = await roomCtx.newPage();
    const errors = [];
    for (const [n, p] of [['A', A], ['B', B], ['L', L], ['R', R]]) p.on('pageerror', (e) => errors.push(`${n}: ${e}`));
    await join(A, BASE, '폰손님', Q);
    await join(B, BASE, '데스크', Q);
    await join(L, BASE, '도서관', Q);
    await join(R, BASE, '골방이', Q);
    await teleport(A, FIRE);
    await teleport(B, { x: 53, z: -5 });
    await L.evaluate(() => window.__WORLDS_TEST__.enterLibrary());
    await until(L, () => window.__WORLDS_DEBUG__.la.inLibrary);
    const door = await R.evaluate(() => window.__WORLDS_TEST__.closetDoor());
    await teleport(R, door);
    await until(R, () => document.getElementById('action-btn').textContent.includes('골방'));
    await R.click('#action-btn');
    await until(R, () => window.__WORLDS_DEBUG__.m3.closet === true);
    await sleep(800);
    const aId = (await debug(A)).net.id;
    const bId = (await debug(B)).net.id;
    await until(B, (id) => window.__WORLDS_DEBUG__.net.remotes.some((r) => r.id === id && r.visible), aId, 20000);
    await B.evaluate(() => window.__WORLDS_TEST__.view(Math.PI * 0.85, 0.3, 0.6));

    step('emote: wheel');
    check('😊 button shown in the world (phone and desktop)', (await A.isVisible('#emote-btn')) && (await B.isVisible('#emote-btn')));
    check('no 😊 button inside the 골방', !(await R.isVisible('#emote-btn')));
    check('😊 button shown inside the library', await L.isVisible('#emote-btn'));
    await A.tap('#emote-btn');
    await until(A, () => window.__WORLDS_DEBUG__.m4.emoteOpen === true);
    const items = await A.$$eval('#emote-grid .emote-item', (els) => els.map((e) => e.textContent));
    check('the grid opens with the 8 emotes and labels', items.length === 8 && items[0].includes('기도해요') && items[6].includes('안녕하세요') && items[7].includes('사랑해요'), items.join('|'));
    const gridBox = await box(A, '#emote-grid');
    check('the grid is fully on screen', gridBox && gridBox.x >= 0 && gridBox.y >= 0 && gridBox.x + gridBox.width <= 390 && gridBox.y + gridBox.height <= 844, fmt(gridBox));
    await A.screenshot({ path: resolve(shotDir, 'ev-emote-wheel-phone.png') });
    await A.tap('#emote-grid .emote-item[data-e="0"]');
    // B's view (bubble + gesture), captured while it shows; meanwhile A's own screenshot.
    const seenByB = B.waitForFunction(
      (id) => {
        const r = window.__WORLDS_DEBUG__.net.remotes.find((x) => x.id === id);
        return r && r.emote === 0 ? { emote: r.emote, gesture: r.gesture } : null;
      },
      aId,
      { timeout: 10000, polling: 100 },
    );
    await until(A, () => window.__WORLDS_DEBUG__.net.emote === 0, null, 8000).catch(() => undefined);
    await sleep(350); // past the pop-in
    await A.screenshot({ path: resolve(shotDir, 'ev-emote-bubble-phone.png') });
    const rb = await (await seenByB).jsonValue();
    check('firing 🙏 shows the bubble over A to B, with the praying-hands gesture', rb.emote === 0 && rb.gesture === 'pray', JSON.stringify({ e: rb.emote, g: rb.gesture }));
    await until(A, (id) => window.__WORLDS_DEBUG__.net.emoteLog.some((e) => e.id === id && e.e === 0), aId, 8000).catch(() => undefined);
    check('the grid closes after firing; A sees its own bubble (server echo)', !(await debug(A)).m4.emoteOpen && (await debug(A)).net.emoteLog.some((e) => e.id === aId && e.e === 0));
    await B.screenshot({ path: resolve(shotDir, 'ev-emote-bubble-desktop.png') });
    await sleep(400);
    check('…but not to the player in the library, nor the one in a 골방', (await debug(L)).net.emoteLog.length === 0 && (await debug(R)).net.emoteLog.length === 0);
    await until(B, (id) => !window.__WORLDS_DEBUG__.net.remotes.find((r) => r.id === id)?.emote, aId, 6000);
    check('the bubble goes away after about 3 s', true);

    step('emote: keys');
    await B.keyboard.press('7');
    await until(A, (id) => window.__WORLDS_DEBUG__.net.remotes.some((r) => r.id === id && r.emote === 6 && r.gesture === 'wave'), bId, 8000);
    check('desktop key 7 fires 👋 directly (A sees the bubble and the wave)', true);
    await sleep(1600);
    await B.keyboard.press('3');
    await until(A, (id) => window.__WORLDS_DEBUG__.net.remotes.some((r) => r.id === id && r.emote === 2 && r.gesture === 'raise'), bId, 8000);
    check('key 3 fires 🙌 (arms raised)', true);
    await A.screenshot({ path: resolve(shotDir, 'ev-emote-raise-phone.png') });
    // typing in the chat never fires emotes
    await B.click('#chat-input');
    await B.keyboard.type('123');
    await sleep(500);
    const typed = (await debug(B)).net.emoteLog.filter((e) => e.id === bId).length;
    check('digits typed into the chat are text, not emotes', typed === 2, String(typed));
    await B.fill('#chat-input', '');
    await B.evaluate(() => document.activeElement.blur());

    step('emote: rate limit');
    await sleep(4600);
    const n0 = (await debug(A)).net.emoteLog.filter((e) => e.id === bId).length;
    for (const k of ['1', '2', '4', '5', '6']) await B.keyboard.press(k);
    await until(B, () => document.getElementById('toast').textContent.includes('천천히'), null, 5000).catch(() => undefined);
    const toast = await B.textContent('#toast');
    await until(A, ({ id, n }) => window.__WORLDS_DEBUG__.net.emoteLog.filter((e) => e.id === id).length >= n + 3, { id: bId, n: n0 }, 8000).catch(() => undefined);
    await sleep(1000);
    const n1 = (await debug(A)).net.emoteLog.filter((e) => e.id === bId).length;
    check('rate limit in the UI: 5 quick keys → 3 shown to others, a gentle toast', n1 - n0 === 3 && toast.includes('천천히'), `${n1 - n0} · ${toast}`);

    step('emote: library and seated');
    await L.keyboard.press('8');
    await until(L, () => window.__WORLDS_DEBUG__.net.emoteLog.some((e) => e.id === window.__WORLDS_DEBUG__.net.id && e.e === 7), null, 10000);
    await sleep(400);
    check('in the library: you see your own ❤️; the world does not', !(await debug(B)).net.emoteLog.some((e) => e.e === 7));
    // seated on a log: bubble only, pose kept
    const seats = await B.evaluate(() => window.__WORLDS_TEST__.logSeats());
    const seat = seats.seats[2];
    await teleport(B, { x: seat.x + 0.4, z: seat.z + 0.4 });
    await sleep(500);
    await B.keyboard.press('e');
    await until(B, () => window.__WORLDS_DEBUG__.net.seatKind === 'log', null, 8000);
    await sleep(2000);
    await sleep(1600); // a fresh emote token
    const seenSeated = A.waitForFunction(
      (id) => {
        const r = window.__WORLDS_DEBUG__.net.remotes.find((x) => x.id === id);
        return r && r.emote === 0 ? { emote: r.emote, pose: r.pose } : null;
      },
      bId,
      { timeout: 12000, polling: 100 },
    );
    await B.keyboard.press('1');
    const seated = await (await seenSeated).jsonValue();
    check('seated on a log: the bubble shows, the sitting pose stays', seated.emote === 0 && seated.pose === 'sit' && (await debug(B)).net.pose === 'sit', `${seated.pose}`);
    check('no page errors (emotes)', errors.length === 0, errors.slice(0, 3).join(' | '));
    await phoneCtx.close();
    await deskCtx.close();
    await libCtx.close();
    await roomCtx.close();
  }

  // ================================================================ campfire voice in the browser
  if (run('voice')) {
    step('voice: setup');
    const ctxA = await browser.newContext(desktop);
    const ctxB = await browser.newContext(desktop);
    const ctxG = await browser.newContext(desktop);
    const A = await ctxA.newPage();
    const B = await ctxB.newPage();
    const G = await ctxG.newPage();
    const errors = [];
    for (const [n, p] of [['A', A], ['B', B], ['G', G]]) p.on('pageerror', (e) => errors.push(`${n}: ${e}`));
    await loginJoin(A, BASE, 'ev-va', '모닥', QN);
    await loginJoin(B, BASE, 'ev-vb', '불빛', QN);
    await join(G, BASE, '손님불', QN);
    await teleport(A, FIRE);
    await teleport(B, { x: 46, z: -6 });
    await teleport(G, { x: 54, z: -7 });
    await until(A, () => window.__WORLDS_DEBUG__.net.chatVisible);
    await until(B, () => window.__WORLDS_DEBUG__.net.chatVisible);
    await until(G, () => window.__WORLDS_DEBUG__.net.chatVisible);

    step('voice: guest');
    check('the campfire chat header shows "🎙️ 모닥불 음성 참여"', (await A.textContent('#campfire-voice-btn')).includes('모닥불 음성 참여'));
    await G.click('#campfire-voice-btn');
    await G.waitForSelector('.overlay.shown .login-prompt');
    check('a guest tapping it gets "로그인하면 함께 이야기할 수 있어요"', (await G.textContent('.overlay.shown')).includes('로그인하면 함께 이야기할 수 있어요'));
    await G.keyboard.press('Escape');

    step('voice: join');
    await A.click('#campfire-voice-btn');
    await until(A, () => window.__WORLDS_DEBUG__.m4.voice?.state === 'in', null, 15000);
    await B.click('#campfire-voice-btn');
    await until(B, () => window.__WORLDS_DEBUG__.m4.voice?.state === 'in', null, 15000);
    const va0 = await v(A);
    check('A joined the campfire voice muted, no mic requested yet', va0.campfire && va0.muted && va0.signaling.micRequests === 0 && va0.micTracks.length === 0, JSON.stringify({ c: va0.campfire, m: va0.muted, r: va0.signaling.micRequests }));
    check('the header button now says "음성 참여 중"; the voice chip shows 🔥 모닥불', (await A.textContent('#campfire-voice-btn')).includes('참여 중') && (await A.textContent('#voice-chip')).includes('모닥불'));
    await until(A, () => window.__WORLDS_DEBUG__.m4.voice.peers.some((p) => p.connection === 'connected'), null, 40000).catch(async (e) => {
      console.log('DEBUG A', JSON.stringify(await v(A)), JSON.stringify(await A.evaluate(() => window.__WORLDS_TEST__.voiceStats())), JSON.stringify(turn.stats));
      throw e;
    });
    await until(B, () => window.__WORLDS_DEBUG__.m4.voice.peers.some((p) => p.connection === 'connected'), null, 40000);
    const cfgA = await A.evaluate(() => window.__WORLDS_TEST__.voicePcConfig());
    const cfgB = await B.evaluate(() => window.__WORLDS_TEST__.voicePcConfig());
    check('relay-only ICE: every campfire peer connection has iceTransportPolicy "relay" (pc.getConfiguration())', cfgA.length === 1 && cfgB.length === 1 && [...cfgA, ...cfgB].every((c) => c.iceTransportPolicy === 'relay'), JSON.stringify([cfgA, cfgB]));
    const stA = await A.evaluate(() => window.__WORLDS_TEST__.voiceStats());
    check('only relay candidates are gathered and the selected pair is relay (no IP of the other side)', stA[0].localCandidates.length > 0 && stA[0].localCandidates.every((t) => t === 'relay') && stA[0].selectedLocal === 'relay' && turn.stats.relayedPackets > 0, JSON.stringify({ ...stA[0], turn: turn.stats }));
    check('joining ducks the worship player to 20%', (await debug(A)).m3.worship.duck === 0.2);
    const before = await inboundBytes(A);
    await B.evaluate(() => window.__WORLDS_TEST__.voiceMute(false));
    await until(B, () => window.__WORLDS_DEBUG__.m4.voice.muted === false, null, 10000).catch(() => undefined);
    await sleep(2500);
    const after = await inboundBytes(A);
    check('B taps 🎤 → the mic is asked for then (once) and A hears B (inbound-rtp bytes rising)', after > before + 2000 && (await v(B)).signaling.micRequests === 1, `${before} → ${after}, mic requests ${(await v(B)).signaling.micRequests}`);
    await A.click('#voice-mic');
    await until(A, () => window.__WORLDS_DEBUG__.m4.voice.muted === false, null, 10000);
    const b1 = await inboundBytes(B);
    await sleep(2500);
    const b2 = await inboundBytes(B);
    check('A taps 🎤 on the chip → B hears A', b2 > b1 + 2000 && (await v(A)).signaling.micRequests === 1, `${b1} → ${b2}`);
    const bId = (await v(B)).selfId;
    await A.evaluate(() => window.__WORLDS_TEST__.view(Math.PI * 1.15, 0.28, 0.55));
    let spoke = false;
    try {
      await until(A, (id) => window.__WORLDS_DEBUG__.m4.voice.peers.some((p) => p.id === id && p.speaking) && window.__WORLDS_DEBUG__.net.remotes.some((r) => r.id === id && r.speakingTag), bId, 20000);
      spoke = true;
    } catch {
      /* reported */
    }
    check('speaking ring: A sees B speaking (list + the ring on B\'s name tag)', spoke);
    // The fake mic beeps on and off: catch a moment with the ring showing.
    for (let i = 0; i < 12; i++) {
      await until(A, (id) => window.__WORLDS_DEBUG__.net.remotes.some((r) => r.id === id && r.speakingTag), bId, 8000).catch(() => undefined);
      await A.screenshot({ path: resolve(shotDir, 'ev-campfire-voice-night.png') });
      if ((await debug(A)).net.remotes.some((r) => r.id === bId && r.speakingTag)) break;
    }

    step('voice: panel + report sheet');
    await A.click('#voice-open');
    await A.waitForSelector('.overlay.shown .voice-sheet');
    const sheetText = await A.textContent('.voice-sheet');
    check('participant sheet: campfire note (not recorded, Cloudflare relay), volume, mute-for-me, 🚩', sheetText.includes('녹음하거나 저장하지 않아요') && sheetText.includes('Cloudflare') && (await A.$$('.voice-sheet .voice-vol')).length === 1 && (await A.$$('.voice-sheet .voice-localmute')).length === 1 && (await A.$$('.voice-sheet .voice-report')).length === 1 && (await A.$$('.voice-sheet .voice-kick')).length === 0);
    await sleep(700); // the sheet slides in
    await A.screenshot({ path: resolve(shotDir, 'ev-campfire-voice-sheet.png') });
    await A.click('.voice-sheet .voice-localmute');
    await until(A, () => window.__WORLDS_DEBUG__.m4.voice.peers[0]?.audioMuted === true);
    check('mute-for-me: B\'s audio element is muted on A only', !(await v(B)).peers[0].audioMuted);
    await A.click('.voice-sheet .voice-localmute');
    await A.click('.voice-sheet .voice-report');
    await until(A, () => window.__WORLDS_DEBUG__.m4.voiceReportOpen === true);
    const reasons = await A.$$eval('.voice-report-sheet .report-reasons button', (els) => els.map((e) => e.textContent));
    check('🚩 음성 신고 sheet: 욕설·혐오 / 음란 / 괴롭힘 / 기타', reasons.join(',') === '욕설·혐오,음란,괴롭힘,기타', reasons.join(','));
    await A.click('#voice-report-reason-harass');
    await sleep(500);
    await A.screenshot({ path: resolve(shotDir, 'ev-voice-report-sheet.png') });
    await A.click('#voice-report-send');
    await A.waitForSelector('.voice-report-sheet .groups-status:has-text("신고를 받았어요")');
    check('report sent from the sheet (signed in, at the fire)', true);
    await A.keyboard.press('Escape');

    step('voice: exclusivity');
    const grp = await A.evaluate(async () => (await (await fetch('/api/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '새벽 모임' }) })).json()));
    await A.click('#btn-groups');
    await A.waitForSelector(`.voice-join[data-group="${grp.id}"]`);
    await A.click(`.voice-join[data-group="${grp.id}"]`);
    await A.waitForSelector('.overlay.shown #voice-switch-ok');
    check('joining a group room while at the campfire voice asks first', (await A.textContent('.overlay.shown')).includes('모닥불 음성에서 나와'));
    await A.click('#voice-switch-ok');
    await until(A, (g) => window.__WORLDS_DEBUG__.m4.voice.state === 'in' && window.__WORLDS_DEBUG__.m4.voice.groupId === g && !window.__WORLDS_DEBUG__.m4.voice.campfire, grp.id, 15000).catch(async (e) => {
      console.log('DEBUG A', JSON.stringify({ ...(await v(A)), peers: undefined }), await A.textContent('#toast'));
      throw e;
    });
    check('…and on OK A is in the group room, not the campfire', true);
    await until(B, () => window.__WORLDS_DEBUG__.m4.voice.peers.length === 0, null, 10000);
    await A.click('#campfire-voice-btn');
    await A.waitForSelector('.overlay.shown #voice-switch-ok');
    check('the campfire button from a group room asks too ("모임 음성 기도방에서 나와")', (await A.textContent('.overlay.shown')).includes('모임 음성 기도방에서 나와'));
    await A.click('#voice-switch-cancel');
    await sleep(300);
    check('그대로 있기 keeps the group room', (await v(A)).groupId === grp.id);
    await A.click('#campfire-voice-btn');
    await A.click('#voice-switch-ok');
    await until(A, () => window.__WORLDS_DEBUG__.m4.voice.campfire && window.__WORLDS_DEBUG__.m4.voice.state === 'in', null, 15000);
    check('OK moves A back to the campfire voice', true);

    step('voice: walk out');
    await teleport(A, FAR);
    await until(A, () => window.__WORLDS_DEBUG__.m4.voice.state === 'idle', null, 10000);
    const t = await A.textContent('#toast');
    check('walking out of the circle leaves the campfire voice, with a toast', t.includes('모닥불에서 멀어져서'), t);
    const farIce = await A.evaluate(async () => (await fetch('/api/voice/ice?campfire=1')).status);
    check('…and TURN credentials are refused away from the fire', farIce === 403);
    await teleport(A, FIRE);
    await until(A, () => window.__WORLDS_DEBUG__.net.chatVisible);

    step('voice: muted by reports (UI)');
    // three accounts at the fire report B → B is told, can't unmute, A doesn't play B
    await A.click('#campfire-voice-btn');
    await until(A, () => window.__WORLDS_DEBUG__.m4.voice.state === 'in', null, 15000);
    await until(A, () => window.__WORLDS_DEBUG__.m4.voice.peers.length === 1, null, 15000);
    const bConn = (await v(B)).selfId;
    for (let i = 0; i < 2; i++) {
      const ag = await new Agent().login(`ev-rep${i}`, `신고${i}`);
      const ws = keep(await ag.ws());
      move(ws, FIRE);
      await sleep(200);
      await ag.json('POST', '/api/voice/campfire/report', { target: bConn, reason: 'abuse' });
    }
    await until(B, () => !!window.__WORLDS_DEBUG__.m4.voice.silencedUntil, null, 10000);
    const bt = await B.textContent('#toast');
    check('B is told politely (24시간, 듣기는 계속)', bt.includes('24시간') && bt.includes('듣기는 계속할 수 있어요'), bt);
    check('B is muted and the 🎤 is disabled', (await v(B)).muted && (await B.isDisabled('#voice-mic')));
    await until(A, () => window.__WORLDS_DEBUG__.m4.voice.peers[0]?.silenced === true && window.__WORLDS_DEBUG__.m4.voice.peers[0]?.audioMuted === true, null, 10000);
    check('A shows B as silenced and does not play B', true);
    await B.evaluate(() => window.__WORLDS_TEST__.voiceMute(false));
    await sleep(500);
    check('B cannot unmute while muted by reports', (await v(B)).muted === true);

    step('voice: admin UI');
    const ctxAd = await browser.newContext(desktop);
    const AD = await ctxAd.newPage();
    AD.on('pageerror', (e) => errors.push(`AD: ${e}`));
    await loginJoin(AD, BASE, ADMIN_HINT, '관리자', Q);
    await until(AD, () => window.__WORLDS_DEBUG__.m8.admin === true, null, 10000);
    await AD.click('#btn-settings');
    await AD.click('#settings-nav-admin');
    await AD.click('#settings-admin-voice');
    await AD.waitForSelector('#admin-voice-list .admin-voice-item');
    const item = AD.locator('#admin-voice-list .admin-voice-item', { hasText: '불빛' });
    check('⚙ → 🛠️ 관리 → 모닥불 음성 신고 lists B with the active mute', (await item.count()) === 1 && (await item.textContent()).includes('말하기 제한 중'));
    await AD.waitForSelector('.overlay.shown .admin-sheet');
    await AD.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
    await sleep(1500);
    await AD.screenshot({ path: resolve(shotDir, 'ev-admin-voice-list.png') });
    await item.locator('.admin-voice-lift').click();
    await until(B, () => window.__WORLDS_DEBUG__.m4.voice.silencedUntil === null, null, 10000);
    await AD.waitForSelector('#admin-voice-list .admin-voice-item:has-text("제한 없음")');
    check('제한 해제 lifts it: B may speak again (told so)', (await B.textContent('#toast')).includes('다시 말할 수 있어요') && !(await B.isDisabled('#voice-mic')));
    await B.evaluate(() => window.__WORLDS_TEST__.voiceMute(false));
    await until(A, () => window.__WORLDS_DEBUG__.m4.voice.peers[0]?.muted === false && window.__WORLDS_DEBUG__.m4.voice.peers[0]?.audioMuted === false, null, 10000);
    check('…and A plays B again', true);
    const nonAdmin = await A.evaluate(async () => (await fetch('/api/admin/campfire-voice')).status);
    check('non-admin GET /api/admin/campfire-voice → 404', nonAdmin === 404);
    check('no page errors (voice)', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctxAd.close();
    await ctxA.close();
    await ctxB.close();
    await ctxG.close();
  }

  // ================================================================ layout
  if (run('layout')) {
    step('layout');
    const DEVICES = [
      ['p360', 360, 780, true],
      ['p390', 390, 844, true],
      ['p412', 412, 915, true],
      ['l740', 740, 360, true],
      ['l915', 915, 412, true],
      ['tab820', 820, 1180, true],
      ['desk', 1280, 720, false],
    ];
    const probe = (page) =>
      page.evaluate(() => {
        const vis = (el) => {
          if (!el) return null;
          for (let e = el; e; e = e.parentElement) {
            const s = getComputedStyle(e);
            if (e.hidden || s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return null;
          }
          const r = el.getBoundingClientRect();
          return r.width > 1 && r.height > 1 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
        };
        const q = (s) => vis(document.querySelector(s));
        const chatEl = document.getElementById('chat');
        return {
          vw: innerWidth,
          vh: innerHeight,
          emote: q('#emote-btn'),
          grid: q('#emote-grid'),
          camera: q('#camera-btn'),
          action: q('#action-btn'),
          chat: chatEl && !chatEl.classList.contains('folded') ? vis(chatEl) : null,
          pill: q('#chat-pill'),
          voice: q('#voice-chip'),
          dock: q('.prop-dock'),
          joystick: q('#stick-base'),
          tools: q('#tools'),
          place: q('.place-card'),
          clock: q('.clock-card'),
          card: q('#worship'),
          frame: q('#worship .worship-frame'),
          tab: q('#worship-tab'),
          handle: q('#worship-handle'),
          letter: q('#letter-btn'),
          cvBtn: q('#campfire-voice-btn'),
          headBtns: [...document.querySelectorAll('#chat .chat-head > *')].map((e) => vis(e)).filter(Boolean),
        };
      });
    const FLOAT = ['emote', 'camera', 'action', 'chat', 'pill', 'voice', 'dock', 'joystick', 'tools', 'place', 'clock', 'card', 'tab', 'handle', 'letter'];
    const inside = (r, vw, vh) => !!r && r.x >= -0.5 && r.y >= -0.5 && r.x + r.width <= vw + 0.5 && r.y + r.height <= vh + 0.5;
    for (const [dev, w, h, touch] of DEVICES) {
      const ctx = await browser.newContext(touch ? { viewport: { width: w, height: h }, screen: { width: w, height: h }, deviceScaleFactor: 1, isMobile: true, hasTouch: true } : desktop);
      await ctx.route('https://www.youtube.com/iframe_api', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: YT_STUB }));
      const p = await ctx.newPage();
      p.on('pageerror', (e) => check(`${dev}: no page error`, false, String(e).split('\n')[0]));
      await loginJoin(p, BASE, `ev-lay-${dev}`, `배치${dev}`.slice(0, 12), '?test=1&shadows=0&time=14:00&noguide=1');
      if (await p.isVisible('#worship-facade-play')) await p.tap('#worship-facade-play');
      await until(p, () => window.__WORLDS_DEBUG__.m3.worship.state === 'playing', null, 30000).catch(() => undefined);
      await teleport(p, FIRE);
      await until(p, () => window.__WORLDS_DEBUG__.net.chatVisible, null, 15000).catch(() => undefined);
      if (await p.isVisible('#campfire-voice-btn')) await p.click('#campfire-voice-btn');
      await until(p, () => window.__WORLDS_DEBUG__.m4.voice?.state === 'in', null, 15000).catch(() => undefined);
      await sleep(800);
      const states = touch ? ['mini', 'open', 'folded'] : ['open', 'folded'];
      for (const st of states) {
        for (const chatState of ['open', 'folded']) {
          await p.evaluate((f) => window.__WORLDS_TEST__.worshipFold(f), st);
          await p.evaluate((c) => {
            const chat = document.getElementById('chat');
            if ((c === 'folded') !== chat.classList.contains('folded')) document.getElementById(c === 'folded' ? 'chat-fold' : 'chat-pill').click();
          }, chatState);
          await sleep(900);
          const r = await probe(p);
          // The new UI against everything else (other pairs belong to b1/m53/p13).
          const hits = [];
          for (const k of FLOAT) if (k !== 'emote' && overlaps(r.emote, r[k])) hits.push(`emote×${k}`);
          if (overlaps(r.voice, r.frame)) hits.push('voice chip×video');
          const label = `${dev} worship ${st} · chat ${chatState}`;
          check(`${label}: 😊 shown, on screen, overlapping nothing (camera, action, chat, voice chip, joystick, HUD, player); the voice chip never over the video`, !!r.emote && inside(r.emote, r.vw, r.vh) && hits.length === 0, hits.join(' ') || `emote ${fmt(r.emote)} camera ${fmt(r.camera)} action ${fmt(r.action)} card ${fmt(r.card)}`);
          if (chatState === 'open' && r.chat) {
            const headHits = [];
            for (let i = 0; i < r.headBtns.length; i++) for (let j = i + 1; j < r.headBtns.length; j++) if (overlaps(r.headBtns[i], r.headBtns[j])) headHits.push(`${i}×${j}`);
            check(`${label}: 🎙️ campfire voice button fits in the chat header`, !!r.cvBtn && headHits.length === 0 && r.cvBtn.x >= r.chat.x - 0.5 && r.cvBtn.x + r.cvBtn.width <= r.chat.x + r.chat.width + 0.5, headHits.join(' ') || `cv ${fmt(r.cvBtn)} chat ${fmt(r.chat)}`);
          }
          if (dev === 'p390' || dev === 'l915' || dev === 'desk' || dev === 'tab820') await p.screenshot({ path: resolve(shotDir, `ev-layout-${dev}-${st}-chat-${chatState}.png`) });
        }
        // the grid open: on screen, clear of the video and the HUD tools
        await p.evaluate(() => document.getElementById('emote-btn').click());
        // (slow software rendering: let the pop-in animation finish)
        await until(p, () => {
          const gr = document.getElementById('emote-grid');
          return !gr.hidden && getComputedStyle(gr).opacity === '1';
        }, null, 5000).catch(() => undefined);
        const g = await probe(p);
        const bad = [];
        if (!g.grid || !inside(g.grid, g.vw, g.vh)) bad.push(`grid ${fmt(g.grid)}`);
        if (overlaps(g.grid, g.frame)) bad.push(`grid over the video ${fmt(g.grid)} / ${fmt(g.frame)}`);
        if (overlaps(g.grid, g.tools)) bad.push('grid over the HUD');
        check(`${dev} worship ${st}: the emote grid opens on screen, clear of the player and the HUD`, bad.length === 0, bad.join('; ') || fmt(g.grid));
        if (dev === 'l740' || dev === 'p360') await p.screenshot({ path: resolve(shotDir, `ev-layout-${dev}-${st}-grid.png`) });
        await p.evaluate(() => document.getElementById('emote-btn').click());
      }
      await ctx.close();
    }
  }
} catch (err) {
  check(`ev test completed (step: ${currentStep()})`, false, String(err?.stack ?? err).split('\n').slice(0, 4).join(' | '));
} finally {
  for (const c of raws) c.ws.close();
  await browser?.close();
  await stopAll();
  await turn?.close();
  cfServer.close();
  dropDb(DB);
}
process.exit(summary());
