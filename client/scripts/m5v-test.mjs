// M5 voice test: group voice prayer rooms over a WebRTC mesh.
// Fake media devices (Chromium flags) + a local mock of Cloudflare's TURN API.
// Ports: 5182 preview, 5183 server, 5189 mock Cloudflare.
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/m5v-test.mjs
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import {
  check,
  currentStep,
  debug,
  desktop,
  dropDb,
  freshDb,
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

const CLIENT_PORT = 5182;
const SERVER_PORT = 5183;
const CF_PORT = 5189;
const BASE = `http://127.0.0.1:${CLIENT_PORT}/`;
const WS = `ws://127.0.0.1:${CLIENT_PORT}/ws`;
const KEY_ID = 'test-key-id-123';
const KEY_TOKEN = 'secret-turn-token-xyz';
const Q = '?test=1&shadows=0&time=14:00&noguide=1';
const DB = freshDb('m5v');

// ---------------------------------------------------------------- mock Cloudflare TURN API
const cf = { calls: 0, auth: [], bodies: [] };
const cfServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    cf.calls++;
    cf.auth.push(req.headers.authorization);
    cf.bodies.push(body);
    if (req.method !== 'POST' || !req.url.startsWith(`/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers`)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        iceServers: [
          { urls: ['stun:stun.cloudflare.com:3478'] },
          { urls: ['turn:turn.invalid:3478?transport=udp'], username: 'mock-user', credential: 'mock-cred' },
          { urls: 'javascript:alert(1)', username: 'x' },
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
    const res = await fetch(path.startsWith('http') ? path : BASE + path.replace(/^\//, ''), {
      method,
      redirect: 'manual',
      headers: { ...(this.jar.size ? { cookie: this.cookie() } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
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
  async login(hint, nickname) {
    let url = `${BASE}api/auth/google/start?hint=${hint}&remember=1`;
    for (let i = 0; i < 6; i++) {
      const res = await this.raw('GET', url);
      const loc = res.headers.get('location');
      if (!loc || !loc.includes('/api/')) break;
      url = new URL(loc, url).toString();
    }
    await this.json('POST', '/api/me/nickname', { nickname, agree: true });
    return this;
  }
}

const box = (page, sel) => page.locator(sel).first().boundingBox();
const overlaps = (a, b) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const v = async (page) => (await debug(page)).m4.voice;
const stats = (page) => page.evaluate(() => window.__WORLDS_TEST__.voiceStats());
const inboundBytes = async (page) => (await stats(page)).reduce((n, s) => n + s.bytesReceived, 0);
const pageFetch = (page, path) => page.evaluate(async (p) => {
  const r = await fetch(p);
  return { status: r.status, text: await r.text() };
}, path);

let browser;
const raws = [];
try {
  await new Promise((r) => cfServer.listen(CF_PORT, '127.0.0.1', r));
  startServer(SERVER_PORT, DB, {
    WORLDS_AUTH_MOCK: '1',
    AUTH_RATE_LIMIT: '300',
    MAX_CONN_PER_IP: '60',
    TURN_KEY_ID: KEY_ID,
    TURN_KEY_API_TOKEN: KEY_TOKEN,
    TURN_API_BASE: `http://127.0.0.1:${CF_PORT}`,
  });
  await waitHttp(`http://127.0.0.1:${SERVER_PORT}/health`);
  startPreview(CLIENT_PORT, SERVER_PORT);
  await waitHttp(BASE);
  // Headless Linux can't resolve mDNS-obfuscated host candidates between two
  // contexts, so expose plain local IPs for this local-only test.
  browser = await launch([
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
  ]);

  // ---------------------------------------------------------------- people + group
  step('setup');
  const ctxA = await browser.newContext(desktop);
  const ctxB = await browser.newContext(desktop);
  const ctxC = await browser.newContext(desktop);
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  const C = await ctxC.newPage();
  const errors = [];
  for (const [n, p] of [['A', A], ['B', B], ['C', C]]) p.on('pageerror', (e) => errors.push(`${n}: ${e}`));
  await loginJoin(A, BASE, 'anna', '안나', Q);
  await loginJoin(B, BASE, 'bora', '보라', Q);
  await loginJoin(C, BASE, 'chul', '철수', Q);
  const group = await A.evaluate(async () => (await (await fetch('/api/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '새벽 기도' }) })).json()));
  await B.evaluate(async (code) => fetch('/api/groups/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }), group.code);
  const gid = group.id;

  // ---------------------------------------------------------------- /api/voice/ice
  step('ice');
  const iceA = await pageFetch(A, `/api/voice/ice?group=${gid}`);
  const iceA2 = await pageFetch(A, `/api/voice/ice?group=${gid}`);
  const iceC = await pageFetch(C, `/api/voice/ice?group=${gid}`);
  const iceGuest = await new Agent().json('GET', `/api/voice/ice?group=${gid}`);
  const servers = JSON.parse(iceA.text).iceServers;
  check('ICE: members get Cloudflare-minted servers (only stun/turn urls kept)', iceA.status === 200 && servers.length === 2 && servers[1].username === 'mock-user', iceA.text);
  check('ICE: the TURN key id and API token never reach the client', !iceA.text.includes(KEY_TOKEN) && !iceA.text.includes(KEY_ID));
  check('ICE: server called Cloudflare with Bearer token and ttl 1800, then cached', cf.calls === 1 && cf.auth[0] === `Bearer ${KEY_TOKEN}` && JSON.parse(cf.bodies[0]).ttl === 1800 && iceA2.status === 200);
  check('ICE: non-members 403, guests 401', iceC.status === 403 && iceGuest.status === 401);

  // ---------------------------------------------------------------- join + connect + audio
  step('join');
  const cRaw = await rawClient(WS, { nickname: 'x', test: true }, { cookie: (await ctxC.cookies()).map((c) => `${c.name}=${c.value}`).join('; ') });
  raws.push(cRaw);
  await A.click('#btn-groups');
  await A.waitForSelector(`.voice-join[data-group="${gid}"]`);
  check('모임 panel shows "🎙️ 음성 기도방 들어가기" with the count', (await A.textContent(`.voice-join[data-group="${gid}"]`)).includes('음성 기도방 들어가기 · 0명'));
  await A.screenshot({ path: resolve(shotDir, 'm5v-groups-desktop.png') });
  await A.click(`.voice-join[data-group="${gid}"]`);
  await until(A, () => window.__WORLDS_DEBUG__.m4.voice?.state === 'in');
  await B.evaluate((g) => window.__WORLDS_TEST__.voiceJoin(g), gid);
  await until(A, () => window.__WORLDS_DEBUG__.m4.voice.peers.some((p) => p.connection === 'connected'), null, 30000).catch(async (e) => {
    console.log('DEBUG A', JSON.stringify(await v(A)), JSON.stringify(await stats(A)));
    console.log('DEBUG B', JSON.stringify(await v(B)), await B.textContent('#toast'));
    throw e;
  });
  await until(B, () => window.__WORLDS_DEBUG__.m4.voice.peers.some((p) => p.connection === 'connected'), null, 30000);
  const va = await v(A);
  check('two members connect peer-to-peer (joined muted)', va.peers.length === 1 && va.muted && va.peers[0].muted, JSON.stringify(va.peers));
  check('voice join ducks the ambience', (await debug(A)).m3.audio.ducked === true && (await debug(A)).m3.audio.targets.ambience < 0.06);

  const before = await inboundBytes(A);
  await B.evaluate(() => window.__WORLDS_TEST__.voiceMute(false));
  await sleep(2500);
  const after = await inboundBytes(A);
  check('B unmutes (fake mic) → A receives audio (inbound-rtp bytes increasing)', after > before + 2000, `${before} → ${after}`);
  await A.evaluate(() => window.__WORLDS_TEST__.voiceMute(false));
  const b1 = await inboundBytes(B);
  await sleep(2500);
  const b2 = await inboundBytes(B);
  check('A unmutes → B receives audio too', b2 > b1 + 2000, `${b1} → ${b2}`);
  await until(A, () => window.__WORLDS_DEBUG__.m4.voice.peers[0]?.muted === false);
  check('mute state propagates (B unmuted seen by A)', true);
  await B.evaluate(() => window.__WORLDS_TEST__.voiceMute(true));
  await until(A, () => window.__WORLDS_DEBUG__.m4.voice.peers[0]?.muted === true);
  check('mute state propagates (B muted seen by A)', true);
  await B.evaluate(() => window.__WORLDS_TEST__.voiceMute(false));

  // speaking indicator (fake device beeps)
  step('speaking');
  const bId = (await v(B)).selfId;
  await teleport(B, { x: 3, z: 4 });
  await teleport(A, { x: 0, z: 8 });
  let spoke = false;
  try {
    await until(A, (id) => window.__WORLDS_DEBUG__.m4.voice.peers.some((p) => p.id === id && p.speaking) && window.__WORLDS_DEBUG__.net.remotes.some((r) => r.id === id && r.speakingTag), bId, 20000);
    spoke = true;
  } catch {
    /* reported */
  }
  check('speaking indicator: A sees B speaking (list + 🔊 ring on B\'s name tag)', spoke);
  if (spoke) await A.screenshot({ path: resolve(shotDir, 'm5v-speaking-desktop.png') });

  // non-member gets nothing
  step('non-member');
  await C.evaluate((g) => window.__WORLDS_TEST__.voiceJoin(g), gid);
  await sleep(1200);
  cRaw.send({ t: 'voiceJoin', groupId: gid });
  cRaw.send({ t: 'voiceSignal', to: bId, data: { type: 'offer', sdp: 'v=0' } });
  await sleep(800);
  const cVoice = cRaw.inbox.filter((m) => m.t.startsWith('voice'));
  check(
    'non-member cannot join and receives no voice signaling',
    (await v(C)).state === 'idle' && cVoice.length === 1 && cVoice[0].t === 'voiceError' && cVoice[0].code === 'voice_not_member',
    JSON.stringify(cVoice),
  );
  check('C\'s fake offer never reaches B', !(await B.evaluate(() => JSON.stringify(window.__WORLDS_DEBUG__.m4.voice))).includes('v=0'));
  // C's browser is no longer needed (keep its cookie for API checks); frees CPU.
  const cCookieHeader = (await ctxC.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  await ctxC.close();

  // ---------------------------------------------------------------- 8-person cap
  step('cap');
  const extra = [];
  for (let i = 0; i < 7; i++) {
    const ag = await new Agent().login(`cap${i}`, `캡${i}`);
    await ag.json('POST', '/api/groups/join', { code: group.code });
    const ws = await rawClient(WS, { nickname: 'x', test: true }, { cookie: ag.cookie() });
    raws.push(ws);
    ws.send({ t: 'voiceJoin', groupId: gid });
    extra.push(ws);
  }
  await sleep(1200);
  const joined = extra.filter((w) => of(w, 'voiceRoom').length === 1).length;
  const full = extra.filter((w) => of(w, 'voiceError').some((e) => e.code === 'voice_full')).length;
  check('room caps at 8 people (6 more joined, the 9th refused)', joined === 6 && full === 1, `joined=${joined} full=${full}`);
  const countText = await (async () => {
    await A.click('#btn-groups');
    await A.waitForSelector(`.voice-join[data-group="${gid}"]`);
    const t = await A.textContent(`.voice-join[data-group="${gid}"]`);
    await A.keyboard.press('Escape');
    return t;
  })();
  check('participant count shown in 모임', countText.includes('음성 기도방에 있어요'));
  for (const w of extra) w.ws.close();
  await until(A, () => window.__WORLDS_DEBUG__.m4.voice.peers.length === 1, null, 15000);

  // ---------------------------------------------------------------- reconnect rejoin
  step('reconnect');
  await B.evaluate(() => window.__WORLDS_TEST__.dropSocket());
  await until(B, () => window.__WORLDS_DEBUG__.net.status === 'online' && window.__WORLDS_DEBUG__.m4.voice.state === 'in', null, 30000);
  await until(A, () => window.__WORLDS_DEBUG__.m4.voice.peers.some((p) => p.connection === 'connected'), null, 30000);
  check('after a WebSocket drop, B rejoins the room automatically and reconnects', true);

  // ---------------------------------------------------------------- group chat (모임 채팅)
  step('chat');
  const post = (page, text) => page.evaluate(async ({ g, text }) => {
    const r = await fetch(`/api/groups/${g}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { g: gid, text });
  const listFor = (page) => page.evaluate(async (g) => (await (await fetch(`/api/groups/${g}/messages`)).json()), gid);
  // A opens the group panel's 💬 대화 tab
  await A.click('#btn-groups');
  await A.click(`.group-open[data-group="${gid}"]`);
  await A.waitForSelector('#gchat-list');
  const xss = '<img src=x onerror="window.__xss=1"><b>굵게</b>\n둘째 줄';
  const bMsg = await post(B, '안녕하세요, 함께 기도해요');
  const bXss = await post(B, xss);
  await A.waitForSelector('#gchat-list .gmsg-text:has-text("함께 기도해요")', { timeout: 15000 });
  await A.waitForSelector('#gchat-list .gmsg-text:has-text("굵게")', { timeout: 15000 });
  const injected = await A.evaluate(() => ({ els: document.querySelectorAll('#gchat-list img, #gchat-list b').length, xss: window.__xss ?? 0 }));
  check('members see messages live', bMsg.status === 201);
  check('XSS payload is shown as plain text (line breaks kept)', injected.els === 0 && injected.xss === 0 && (await A.textContent('#gchat-list')).includes('<img src=x'), JSON.stringify(injected));
  // A types in the UI
  await A.fill('#gchat-input', '오늘 저녁에 같이 묵상해요');
  await A.press('#gchat-input', 'Enter');
  await A.waitForSelector('#gchat-list .gmsg.mine .gmsg-text:has-text("저녁에")');
  await A.screenshot({ path: resolve(shotDir, 'm5v-chat-desktop.png') });

  // unread badge synced across two devices of the same user (B and B2)
  step('chat unread');
  const ctxB2 = await browser.newContext({ viewport: { width: 640, height: 400 } });
  const B2 = await ctxB2.newPage();
  await loginJoin(B2, BASE, 'bora', '보라', Q);
  await post(A, '배지 확인용 메시지');
  await B.waitForSelector('#btn-groups .badge', { timeout: 15000 });
  await B2.waitForSelector('#btn-groups .badge', { timeout: 15000 });
  const badgeB2 = await B2.textContent('#btn-groups .badge');
  await B.click('#btn-groups');
  await B.click(`.group-open[data-group="${gid}"]`);
  await B.waitForSelector('#gchat-list .gmsg-text:has-text("배지 확인용")');
  await B2.waitForSelector('#btn-groups .badge', { state: 'detached', timeout: 15000 });
  check('unread badge 🔴 appears on both devices and clears on both after reading on one', Number(badgeB2) >= 1);
  await B.keyboard.press('Escape');
  await ctxB2.close();

  // delete own + creator hides
  step('chat moderation');
  const del = await B.evaluate(async ({ g, id }) => (await fetch(`/api/groups/${g}/messages/${id}`, { method: 'DELETE' })).status, { g: gid, id: bMsg.body.id });
  const notMine = await B.evaluate(async ({ g, id }) => (await fetch(`/api/groups/${g}/messages/${id}`, { method: 'DELETE' })).status, { g: gid, id: bXss.body.id - 1 });
  await A.waitForSelector(`#gchat-list .gmsg[data-id="${bMsg.body.id}"] .gmsg-text:has-text("삭제된 메시지예요")`, { timeout: 15000 });
  check('a member deletes their own message ("삭제된 메시지예요" for everyone)', del === 200);
  await A.click(`.gmsg-hide[data-id="${bXss.body.id}"]`);
  await A.waitForSelector(`#gchat-list .gmsg[data-id="${bXss.body.id}"] .gmsg-text:has-text("모임장이 가린")`);
  const seenByB = (await listFor(B)).messages.find((m) => m.id === bXss.body.id);
  const bHide = await B.evaluate(async ({ g, id }) => (await fetch(`/api/groups/${g}/messages/${id}/hide`, { method: 'POST' })).status, { g: gid, id: bXss.body.id });
  check('the group creator hides any message (text removed for everyone); others cannot', seenByB.hidden && seenByB.text === '' && bHide === 403 && notMine === 404);

  // non-member: 404 and no push
  step('chat non-member');
  const cCookie = { cookie: cCookieHeader };
  const cGet = await fetch(`${BASE}api/groups/${gid}/messages`, { headers: cCookie });
  const cPost = await fetch(`${BASE}api/groups/${gid}/messages`, { method: 'POST', headers: { ...cCookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: '끼어들기' }) });
  check('non-member gets 404 (read and send) and no WebSocket push', cGet.status === 404 && cPost.status === 404 && !cRaw.inbox.some((m) => m.t.startsWith('group')));

  // rate limit: burst 5, then 1 / 2 s
  step('chat rate');
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await post(B, `연속 ${i}`)).status);
  check('rate limit (burst 5, then 1 every 2 s)', codes.filter((c) => c === 429).length >= 2 && codes.slice(0, 3).every((c) => c === 201), codes.join(','));

  // history after reload
  step('chat history');
  await loginJoin(A, BASE, 'anna', '안나', Q);
  await A.click('#btn-groups');
  await A.click(`.group-open[data-group="${gid}"]`);
  await A.waitForSelector('#gchat-list .gmsg-text:has-text("저녁에")');
  check('history is there after a reload (server-side, 7 days)', true);
  await A.keyboard.press('Escape');
  // The reload took A out of the voice room: go back in (the kick test needs it).
  await A.evaluate((g) => window.__WORLDS_TEST__.voiceJoin(g), gid);
  await until(A, () => window.__WORLDS_DEBUG__.m4.voice?.state === 'in' && window.__WORLDS_DEBUG__.m4.voice.peers.length >= 1, null, 30000);

  // 7-day purge with a simulated clock
  const purge = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/test/chat-purge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ days: 8 }) }).then((r) => r.json());
  const afterPurge = await listFor(B);
  check('messages older than 7 days are purged (clock +8 days)', purge.removed > 5 && afterPurge.messages.length === 0, JSON.stringify(purge));
  await post(A, '모바일 대화 확인');

  // ---------------------------------------------------------------- mobile layout
  step('mobile');
  const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const M = await ctxM.newPage();
  await loginJoin(M, BASE, 'mina', '미나', '?test=1&shadows=0&time=14:00&noguide=1');
  await M.evaluate(async (code) => fetch('/api/groups/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }), group.code);
  await M.evaluate((g) => window.__WORLDS_TEST__.voiceJoin(g), gid);
  await until(M, () => window.__WORLDS_DEBUG__.m4.voice?.state === 'in');
  await sleep(1500);
  const layout = async () => {
    const chip = await box(M, '#voice-chip');
    const others = {
      joystick: await box(M, '#stick-zone'),
      emote: (await M.isVisible('#emote-btn')) ? await box(M, '#emote-btn') : null,
      place: await box(M, '.place-card'),
      tools: await box(M, '#tools'),
      chat: (await M.isVisible('#chat')) ? await box(M, '#chat') : null,
    };
    const hits = Object.entries(others).filter(([, b]) => overlaps(chip, b)).map(([k]) => k);
    return { chip, hits };
  };
  const l1 = await layout();
  check('390x844: voice chip overlaps nothing (joystick, 😊, HUD)', l1.hits.length === 0, JSON.stringify(l1));
  await M.screenshot({ path: resolve(shotDir, 'm5v-mobile-chip.png') });
  await teleport(M, { x: 51, z: -6 });
  await until(M, () => window.__WORLDS_DEBUG__.net.chatVisible);
  await sleep(700);
  const l2 = await layout();
  check('390x844 with campfire chat open: still no overlap', l2.hits.length === 0, JSON.stringify(l2));
  await M.screenshot({ path: resolve(shotDir, 'm5v-mobile-chat.png') });
  const hit = await M.evaluate(() => {
    const r = document.getElementById('voice-open').getBoundingClientRect();
    const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return `${e?.tagName}#${e?.id}.${e?.className}`;
  });
  console.log('DEBUG hit', hit);
  await M.tap('#voice-open');
  await until(M, () => window.__WORLDS_DEBUG__.m3.modal === '음성 기도방');
  await sleep(500);
  const vsheet = await box(M, '.sheet.voice-sheet');
  check('voice sheet on mobile fits the screen', vsheet && vsheet.y >= -0.5 && vsheet.y + vsheet.height <= 844.5, JSON.stringify(vsheet));
  await M.screenshot({ path: resolve(shotDir, 'm5v-mobile-sheet.png') });
  await M.tap('.voice-sheet .book-top .ghost');
  await until(M, () => window.__WORLDS_DEBUG__.m3.modal === null);
  await M.tap('#voice-chat');
  await until(M, () => window.__WORLDS_DEBUG__.m3.modal === '모임');
  await M.waitForSelector('#gchat-input');
  await sleep(600);
  check('mobile: 💬 from the voice chip opens 모임 대화', await M.isVisible('.sheet.group-panel'));
  await M.screenshot({ path: resolve(shotDir, 'm5v-chat-mobile.png') });
  await M.tap('#gchat-input');
  await M.setViewportSize({ width: 390, height: 500 }); // on-screen keyboard
  await sleep(800);
  const inp = await box(M, '#gchat-input');
  check(
    'mobile with the keyboard up (viewport 390x500): input visible above it',
    inp && inp.y + inp.height <= 500 && inp.y >= 0,
    JSON.stringify(inp),
  );
  await M.screenshot({ path: resolve(shotDir, 'm5v-chat-mobile-keyboard.png') });
  await M.setViewportSize({ width: 390, height: 844 });
  await M.keyboard.press('Escape');
  await M.evaluate(() => window.__WORLDS_TEST__.voiceLeave());
  await until(M, () => window.__WORLDS_DEBUG__.m4.voice.state === 'idle');
  await ctxM.close();

  // ---------------------------------------------------------------- kick + block
  step('kick');
  await A.click('#voice-open');
  await until(A, () => window.__WORLDS_DEBUG__.m3.modal === '음성 기도방');
  await A.waitForSelector('.voice-kick');
  await A.screenshot({ path: resolve(shotDir, 'm5v-voice-sheet-desktop.png') });
  const bNow = (await v(B)).selfId;
  await A.click(`.voice-kick[data-peer="${bNow}"]`);
  await until(B, () => window.__WORLDS_DEBUG__.m4.voice.state === 'idle', null, 15000);
  check('owner kicks B; B leaves (mic muted)', (await v(B)).micEnabled === false && (await v(B)).state === 'idle');
  await B.evaluate((g) => window.__WORLDS_TEST__.voiceJoin(g), gid);
  await B.waitForSelector('#toast:has-text("분 뒤")', { timeout: 15000 });
  check('kicked user cannot rejoin for 10 minutes', (await v(B)).state === 'idle', await B.textContent('#toast'));
  await A.keyboard.press('Escape');

  // ---------------------------------------------------------------- leave cleanup
  step('leave');
  await A.click('#voice-open');
  await A.click('#voice-leave');
  await until(A, () => window.__WORLDS_DEBUG__.m4.voice.state === 'idle');
  const left = await v(A);
  check(
    'leave cleans up: peers closed, audio removed, mic muted (kept for reuse), ducking restored',
    left.peers.length === 0 && left.audioElements === 0 && left.micEnabled === false && (await debug(A)).m3.audio.ducked === false,
    JSON.stringify(left),
  );
  await A.evaluate(() => window.__WORLDS_TEST__.voiceReleaseMic());
  check('releasing the mic stops its tracks (page unload / 10 min out of voice)', (await v(A)).micTracks.length === 0);

  const unexpected = errors.filter((e) => !/Permissions policy/.test(e));
  check('no page errors', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
} catch (err) {
  check('test run completed', false, `[step: ${currentStep()}] ${String(err).split('\n')[0]}`);
} finally {
  for (const r of raws) r.ws.close();
  await browser?.close();
  await stopAll();
  cfServer.close();
  dropDb(DB);
}
process.exit(summary());
