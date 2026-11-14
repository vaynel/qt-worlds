// M4 end-to-end test: Google-style OIDC login (mock provider), personal QT on the
// server, import, groups, lanterns (visibility, live pushes, reactions, removal),
// guest limits, hardening (speed check, Origin, per-IP limit, rate limit), and the
// single-port production mode. Uses ports 5182 (preview), 5183 (mock server),
// 5184 (production-mode server). Never touches the dev DB.
//   cd client && npm run build && (cd ../server && npm run build) && node scripts/m4-test.mjs
import { resolve } from 'node:path';
import {
  check,
  currentStep,
  debug,
  desktop,
  dropDb,
  freshDb,
  join,
  launch,
  loginJoin,
  mobile,
  openBook,
  of,
  rawClient,
  shotDir,
  sleep,
  start,
  startPreview,
  startServer,
  step,
  stopAll,
  summary,
  teleport,
  until,
  waitHttp,
  serverDir,
} from './lib/harness.mjs';

const CLIENT_PORT = 5182;
const SERVER_PORT = 5183;
const PROD_PORT = 5184;
const BASE = `http://127.0.0.1:${CLIENT_PORT}/`;
const DIRECT = `http://127.0.0.1:${SERVER_PORT}`;
const WS = `ws://127.0.0.1:${CLIENT_PORT}/ws`;
const DAY = '2026-11-08';
const Q = (extra = '') => `?test=1&shadows=0&time=14:00&date=${DAY}&noguide=1${extra}`;
const DB = freshDb('m4');
const DB_PROD = freshDb('m4-prod');

/** A cookie-keeping HTTP client (one "device"). */
class Agent {
  constructor(base = BASE.slice(0, -1), headers = {}) {
    this.base = base;
    this.jar = new Map();
    this.headers = headers;
    this.setCookies = [];
  }
  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  absorb(res) {
    for (const c of res.headers.getSetCookie()) {
      this.setCookies.push(c);
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (/Max-Age=0/i.test(c) || v === '') this.jar.delete(k);
      else this.jar.set(k, v);
    }
  }
  async raw(method, path, body, extra = {}) {
    const url = path.startsWith('http') ? path : this.base + path;
    const res = await fetch(url, {
      method,
      redirect: 'manual',
      headers: {
        ...this.headers,
        ...(this.jar.size ? { cookie: this.cookieHeader() } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...extra,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    this.absorb(res);
    return res;
  }
  async json(method, path, body, extra) {
    const res = await this.raw(method, path, body, extra);
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* none */
    }
    return { status: res.status, data };
  }
  /** Follow redirects by hand (cookies kept) and return the final location. */
  async follow(path, max = 8) {
    let url = path;
    for (let i = 0; i < max; i++) {
      const res = await this.raw('GET', url);
      const loc = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !loc) return url;
      url = new URL(loc, url.startsWith('http') ? url : this.base + url).toString();
      // Behind a (pretend) TLS proxy the server builds https URLs; we talk plain http.
      if (this.rewriteHttps) url = url.replace(/^https:/, 'http:');
      if (!url.includes('/api/')) return url;
    }
    return url;
  }
  login(hint, remember = true) {
    return this.follow(`/api/auth/google/start?hint=${encodeURIComponent(hint)}${remember ? '&remember=1' : ''}`);
  }
}

async function account(hint, nickname) {
  const a = new Agent();
  const landed = await a.login(hint);
  if (nickname) {
    const r = await a.json('POST', '/api/me/nickname', { nickname, agree: true }); // M7: sign-up needs consent
    if (r.status !== 200) throw new Error(`nickname ${nickname}: ${JSON.stringify(r.data)}`);
  }
  a.landed = landed;
  return a;
}

let browser;
try {
  step('start');
  startServer(SERVER_PORT, DB, { WORLDS_AUTH_MOCK: '1', MAX_CONN_PER_IP: '20', AUTH_RATE_LIMIT: '80' });
  await waitHttp(`${DIRECT}/health`);
  startPreview(CLIENT_PORT, SERVER_PORT);
  await waitHttp(BASE);

  // ---------------------------------------------------------------- OAuth
  step('oauth');
  const cfg = await new Agent().json('GET', '/api/auth/config');
  check('auth config reports the (mock) provider', cfg.data.ready && cfg.data.provider === 'mock');

  // State mismatch / missing browser binding
  const s1 = new Agent();
  const authUrl = (await s1.raw('GET', '/api/auth/google/start?hint=x')).headers.get('location');
  const state = new URL(authUrl, BASE).searchParams.get('state');
  const wrong = (await s1.raw('GET', `/api/auth/google/callback?code=abc&state=nope`)).headers.get('location');
  check('callback with a wrong state is rejected', wrong.includes('login_error=bad_state'), wrong);
  const other = new Agent();
  const unbound = (await other.raw('GET', `/api/auth/google/callback?code=abc&state=${state}`)).headers.get('location');
  check('callback without the state cookie (other browser) is rejected', unbound.includes('login_error=bad_state'), unbound);

  for (const [hint, code] of [
    ['bad-sig:mallory', 'bad_id_token'],
    ['expired:mallory', 'bad_id_token'],
    ['wrong-aud:mallory', 'bad_id_token'],
    ['bad-nonce:mallory', 'bad_nonce'],
  ]) {
    const a = new Agent();
    const landed = await a.login(hint);
    const me = await a.json('GET', '/api/me');
    check(`ID token "${hint.split(':')[0]}" is rejected`, landed.includes(`login_error=${code}`) && me.data.user === null, landed);
  }

  // First login asks for a nickname; duplicates refused (NFC + case-insensitive)
  const alice = new Agent();
  const landedA = await alice.login('alice');
  const meA = await alice.json('GET', '/api/me');
  check('first login lands on the nickname step', landedA.includes('login=nickname') && meA.data.needsNickname === true);
  const cookieFlags = alice.setCookies.find((c) => c.startsWith('worlds_session='));
  check('session cookie is HttpOnly + SameSite=Lax (not Secure on plain http)', /HttpOnly/.test(cookieFlags) && /SameSite=Lax/.test(cookieFlags) && !/Secure/.test(cookieFlags), cookieFlags);
  const guestWrite = await alice.json('POST', '/api/wordbook/meditations', { date: DAY, place: '골방', meditation: 'x' });
  check('no saving before a nickname is chosen', guestWrite.status === 403);
  check('alice picks 은혜', (await alice.json('POST', '/api/me/nickname', { nickname: '은혜', agree: true })).status === 200);
  const bob = await account('bob');
  const dupe = await bob.json('POST', '/api/me/nickname', { nickname: '은혜', agree: true });
  const nfd = await bob.json('POST', '/api/me/nickname', { nickname: '은혜'.normalize('NFD'), agree: true });
  check('duplicate nickname refused (also NFD form)', dupe.status === 409 && nfd.status === 409, dupe.data?.message);
  await bob.json('POST', '/api/me/nickname', { nickname: 'Grace', agree: true });
  const carolDupe = await (await account('carol0')).json('POST', '/api/me/nickname', { nickname: ' grace ', agree: true });
  check('nickname comparison is case-insensitive and trimmed', carolDupe.status === 409);
  const second = await account('alice');
  check('same Google sub logs into the same account', (await second.json('GET', '/api/me')).data.user.nickname === '은혜' && second.landed.includes('login=ok'));

  // Logout
  const tmp = await account('tmp-user', '잠깐');
  const oldCookie = tmp.cookieHeader();
  await tmp.json('POST', '/api/auth/logout', {});
  const after = await tmp.json('GET', '/api/me');
  const replay = await new Agent().json('GET', '/api/me', undefined, { cookie: oldCookie });
  check('logout ends the session (old cookie no longer works)', after.data.user === null && replay.data.user === null);

  // Secure cookies behind an HTTPS proxy (X-Forwarded-Proto from 127.0.0.1)
  const tls = new Agent(DIRECT, { 'x-forwarded-proto': 'https', 'x-forwarded-host': '127.0.0.1:5183' });
  tls.rewriteHttps = true;
  await tls.login('tls-user');
  const tlsCookie = tls.setCookies.find((c) => c.startsWith('worlds_session='));
  check('cookies are Secure when X-Forwarded-Proto is https (trusted proxy)', /Secure/.test(tlsCookie ?? ''), tlsCookie);

  // ---------------------------------------------------------------- word book privacy
  step('privacy');
  const mA = await alice.json('POST', '/api/wordbook/meditations', { date: DAY, place: '골방', meditation: '앨리스만의 묵상', feeling: '감사', application: '' });
  check('alice saves a meditation', mA.status === 201);
  const peek = await bob.json('GET', `/api/wordbook/meditations/${mA.data.id}`);
  const edit = await bob.json('PATCH', `/api/wordbook/meditations/${mA.data.id}`, { meditation: 'hacked' });
  const del = await bob.json('DELETE', `/api/wordbook/meditations/${mA.data.id}`);
  const bobBook = await bob.json('GET', '/api/wordbook');
  check('another user cannot read, edit or delete it', peek.status === 404 && edit.status === 404 && del.status === 404 && !JSON.stringify(bobBook.data).includes('앨리스만의'));
  const upd = await alice.json('PATCH', `/api/wordbook/meditations/${mA.data.id}`, { meditation: '앨리스만의 묵상 (고침)', feeling: '감사', application: '기도하기' });
  check('owner can edit', upd.status === 200 && upd.data.meditation.includes('고침'));
  const tmpMed = await alice.json('POST', '/api/wordbook/meditations', { date: DAY, place: '골방', meditation: '지울 묵상' });
  check('owner can delete', (await alice.json('DELETE', `/api/wordbook/meditations/${tmpMed.data.id}`)).status === 200);
  const forged = await alice.json('PUT', `/api/wordbook/pages/${DAY}`, { word: { text: '가짜 말씀' } });
  const pageWord = (await alice.json('GET', '/api/wordbook')).data.pages.find((p) => p.date === DAY).word;
  check('verse text always comes from the server', forged.status === 200 && pageWord.text !== '가짜 말씀' && pageWord.translation === '개역한글판');

  // ---------------------------------------------------------------- guests
  step('guests');
  const guest = new Agent();
  const g1 = await guest.json('POST', '/api/wordbook/meditations', { date: DAY, place: '골방', meditation: 'x' });
  const g2 = await guest.json('POST', '/api/groups', { name: 'x' });
  check('guests cannot save or create groups (401)', g1.status === 401 && g2.status === 401, g1.data?.message);
  let nameTaken = false;
  const gws = await rawClient(WS, { nickname: '은혜' });
  await sleep(300);
  nameTaken = of(gws, 'error').some((e) => e.code === 'name_taken');
  check('a guest cannot use a registered nickname', nameTaken && gws.closed !== null);

  // ---------------------------------------------------------------- groups
  step('groups');
  const grp = await alice.json('POST', '/api/groups', { name: '수요 큐티반' });
  check('group created with an unambiguous 6-char code', grp.status === 201 && /^[A-HJ-NP-Z2-9]{6}$/.test(grp.data.code) && !/[01OI]/.test(grp.data.code), grp.data.code);
  const joined = await bob.json('POST', '/api/groups/join', { code: grp.data.code.toLowerCase() });
  check('bob joins by code (case-insensitive)', joined.status === 200 && joined.data.members === 2);
  const bad = await bob.json('POST', '/api/groups/join', { code: 'ZZZZZZ' });
  check('unknown code refused', bad.status === 404);
  const dave = await account('dave', '다윗');
  const listB = await bob.json('GET', '/api/groups');
  check('my groups list', listB.data.groups.length === 1 && listB.data.groups[0].name === '수요 큐티반');
  const g3 = await dave.json('POST', '/api/groups', { name: '임시' });
  await dave.json('POST', `/api/groups/${g3.data.id}/leave`, {});
  check('leave works', (await dave.json('GET', '/api/groups')).data.groups.length === 0);

  // ---------------------------------------------------------------- lanterns + WS visibility
  step('lanterns');
  const wsBob = await rawClient(WS, { nickname: 'x', test: true }, { cookie: bob.cookieHeader() });
  const wsDave = await rawClient(WS, { nickname: 'x', test: true }, { cookie: dave.cookieHeader() });
  const wsGuest = await rawClient(WS, { nickname: '손님', test: true });
  check('signed-in sockets use the account nickname', of(wsBob, 'welcome')[0]?.name === 'Grace' && of(wsBob, 'welcome')[0]?.account?.nickname === 'Grace');

  const pubMed = await alice.json('POST', '/api/wordbook/meditations', { date: DAY, place: '기도의 뜰', meditation: '모두와 나누는 묵상', feeling: '평안', application: '먼저 인사하기' });
  const privMed = await alice.json('POST', '/api/wordbook/meditations', { date: DAY, place: '골방', meditation: '모임만 보는 비밀 묵상', feeling: '', application: '' });
  const pub = await alice.json('POST', '/api/lanterns', { meditationId: pubMed.data.id, visibility: 'public' });
  const priv = await alice.json('POST', '/api/lanterns', { meditationId: privMed.data.id, visibility: 'group', groupId: grp.data.id });
  const notMember = await dave.json('POST', '/api/lanterns', { meditationId: pubMed.data.id, visibility: 'public' });
  check('lanterns lit (public + group); only the owner can light their meditation', pub.status === 201 && priv.status === 201 && notMember.status === 404);
  check('stable, distinct slots', pub.data.slot !== priv.data.slot, `${pub.data.slot}, ${priv.data.slot}`);
  await sleep(1200);

  const ids = (r) => r.data.lanterns.map((l) => l.id);
  const lb = await bob.json('GET', '/api/lanterns');
  const ld = await dave.json('GET', '/api/lanterns');
  const lg = await guest.json('GET', '/api/lanterns');
  check('public lantern visible to everyone', [lb, ld, lg].every((r) => ids(r).includes(pub.data.id)));
  check('private lantern visible to the group member only (API list)', ids(lb).includes(priv.data.id) && !ids(ld).includes(priv.data.id) && !ids(lg).includes(priv.data.id));
  const dDetail = await dave.json('GET', `/api/lanterns/${priv.data.id}`);
  const gDetail = await guest.json('GET', `/api/lanterns/${priv.data.id}`);
  const bDetail = await bob.json('GET', `/api/lanterns/${priv.data.id}`);
  check('private lantern detail: 404 for non-members and guests, readable for members', dDetail.status === 404 && gDetail.status === 404 && bDetail.status === 200 && bDetail.data.meditation.includes('비밀'));
  const pushed = (c, id) => c.inbox.some((m) => (m.t === 'lantern' && m.lantern.id === id) || (m.t === 'lanterns' && m.lanterns.some((l) => l.id === id)));
  check('live push: bob (member) got both lanterns over WS', pushed(wsBob, pub.data.id) && pushed(wsBob, priv.data.id));
  const leak = (c) => JSON.stringify(c.inbox).includes('비밀') || pushed(c, priv.data.id);
  check('no private lantern over WS to non-members or guests', pushed(wsDave, pub.data.id) && pushed(wsGuest, pub.data.id) && !leak(wsDave) && !leak(wsGuest));
  const dupL = await alice.json('POST', '/api/lanterns', { meditationId: pubMed.data.id, visibility: 'public' });
  check('one lantern per meditation', dupL.status === 409);

  // ---------------------------------------------------------------- reactions
  step('reactions');
  const r1 = await bob.json('POST', `/api/lanterns/${pub.data.id}/reactions`, { type: 'amen' });
  const r2 = await bob.json('POST', `/api/lanterns/${pub.data.id}/reactions`, { type: 'amen' });
  check('아멘 toggles on and off (one per user)', r1.data.counts.amen === 1 && r1.data.myReactions.includes('amen') && r2.data.counts.amen === 0);
  await bob.json('POST', `/api/lanterns/${pub.data.id}/reactions`, { type: 'pray' });
  await dave.json('POST', `/api/lanterns/${pub.data.id}/reactions`, { type: 'pray' });
  const forAlice = await alice.json('GET', `/api/lanterns/${pub.data.id}`);
  check('the author sees how many prayed', forAlice.data.counts.pray === 2 && forAlice.data.mine === true);
  const daveOnPriv = await dave.json('POST', `/api/lanterns/${priv.data.id}/reactions`, { type: 'amen' });
  const guestReact = await guest.json('POST', `/api/lanterns/${pub.data.id}/reactions`, { type: 'amen' });
  check('no reacting to lanterns you cannot see; guests cannot react', daveOnPriv.status === 404 && guestReact.status === 401);
  await bob.json('POST', `/api/lanterns/${pub.data.id}/reactions`, { type: 'record' });
  const bobSaved = (await bob.json('GET', '/api/wordbook')).data.saved;
  check('기록하기 puts a snapshot into the word book (담아 둔 묵상)', bobSaved.length === 1 && bobSaved[0].meditation === '모두와 나누는 묵상' && bobSaved[0].nickname === '은혜');
  await sleep(600);
  check('reaction counts pushed live', wsDave.inbox.some((m) => m.t === 'lantern' && m.lantern.id === pub.data.id && m.lantern.counts.pray === 2));

  // ---------------------------------------------------------------- browsers: device A/B, import, UI
  step('browsers');
  browser = await launch();
  const ctxA = await browser.newContext(desktop);
  const ctxB = await browser.newContext(desktop);
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  const pageErrors = [];
  for (const [n, p] of [['A', A], ['B', B]]) {
    p.on('pageerror', (e) => pageErrors.push(`${n}: ${e}`));
    p.on('console', (m) => m.type() === 'error' && pageErrors.push(`${n} console: ${m.text()}`));
  }

  // Entry screen, then the real button → mock provider page → callback → nickname step.
  await A.goto(BASE + Q());
  await A.waitForSelector('#entry-signed-out:not([hidden])');
  await A.screenshot({ path: resolve(shotDir, 'm4-entry-desktop.png') });
  await A.click('#btn-google');
  await A.waitForURL(/mock\/authorize/);
  await A.fill('input[name=login_hint]', 'erin');
  await A.click('form button');
  await A.waitForURL(/test=1/);
  await A.waitForSelector('#entry-nick:not([hidden])');
  check('login returns to the same page (query kept, login flag cleaned up)', !A.url().includes('login=') && A.url().includes('noguide=1'), A.url());
  await A.fill('#account-nickname', 'grace');
  await A.check('#nick-agree'); // M7: 만 14세 이상 + 약관 동의 checkbox
  await A.click('#nick-submit');
  await A.waitForSelector('#entry-status:has-text("이미")');
  check('UI: duplicate nickname refused on the 닉네임 정하기 step', true, await A.textContent('#entry-status'));
  await A.fill('#account-nickname', '에린');
  await A.screenshot({ path: resolve(shotDir, 'm4-nickname-desktop.png') });
  await A.click('#nick-submit');
  await until(A, () => window.__WORLDS_DEBUG__?.net?.status === 'online', null, 60000);
  check('UI: Google button → provider → callback → nickname → world', (await debug(A)).m4.account?.nickname === '에린');

  // Device A: meditate in the 골방 and save.
  const door = await A.evaluate(() => window.__WORLDS_TEST__.closetDoor());
  await teleport(A, door);
  await until(A, () => document.getElementById('action-btn').textContent.includes('골방'));
  await A.keyboard.press('KeyE');
  await until(A, () => window.__WORLDS_DEBUG__.m3.closet === true);
  await A.click('#closet-meditate');
  await until(A, () => window.__WORLDS_DEBUG__.m3.modal === '묵상하기');
  await A.click('.med-foot .primary');
  await A.fill('#med-meditation', '기기 A에서 쓴 묵상');
  await A.click('.med-foot .primary');
  await A.click('.med-foot .primary');
  await A.fill('#med-application', '기기 B에서도 보이기');
  await A.click('.med-save');
  await until(A, () => window.__WORLDS_DEBUG__.m3.lastSaved === '골방');

  // Device B: same Google sub signs in elsewhere and opens the book.
  await loginJoin(B, BASE, 'erin', '에린', Q());
  await openBook(B, 'mine');
  await B.waitForSelector('.book-page');
  const bookB = await B.textContent('.book');
  check('device B (same sub) sees device A\'s QT', bookB.includes('기기 A에서 쓴 묵상') && bookB.includes('기기 B에서도 보이기'));

  // Share it as a lantern from the book (UI), public.
  await B.click('.note-share');
  await B.click('#share-submit');
  await B.waitForSelector('.note-unshare');
  await B.screenshot({ path: resolve(shotDir, 'm4-wordbook-desktop.png') });
  check('UI: 등불로 나누기 from the word book', true);
  await B.keyboard.press('Escape');

  // Edit and delete in the UI.
  await openBook(B, 'mine');
  await B.waitForSelector('.note-edit');
  await B.click('.note-edit');
  await B.fill('#edit-feeling', '고친 느낌');
  await B.click('#edit-save');
  await B.waitForSelector('.book-field-text:has-text("고친 느낌")');
  check('UI: edit my meditation', true);
  await B.keyboard.press('Escape');

  step('hill: wait list');
  // Lantern hill: walk up to a lantern, read it, react.
  await until(B, () => window.__WORLDS_DEBUG__.m4.lanterns.length >= 2).catch(async (e) => {
    console.log('DEBUG', JSON.stringify((await debug(B)).m4));
    throw e;
  });
  const visible = (await debug(B)).m4.lanterns;
  step('hill: teleport');
  const target = visible.find((l) => l.nickname === '은혜' && l.group === null);
  await teleport(B, { x: target.x + 1.2, z: target.z + 1.2 });
  await until(B, () => document.getElementById('action-btn').textContent.includes('등불')).catch(async (e) => {
    console.log('DEBUG', JSON.stringify({ target, m4: (await debug(B)).m4, player: (await debug(B)).player, action: await B.textContent('#action-btn') }));
    throw e;
  });
  await sleep(1500);
  await B.screenshot({ path: resolve(shotDir, 'm4-lantern-hill-desktop.png') });
  step('hill: open card');
  await B.keyboard.press('KeyE');
  await until(B, () => window.__WORLDS_DEBUG__.m3.modal === '등불');
  step('hill: react');
  await B.click('#react-pray');
  await B.waitForSelector('#react-pray[aria-pressed="true"]');
  await B.click('#react-record');
  await B.waitForSelector('#react-record[aria-pressed="true"]');
  const cardText = await B.textContent('.lantern-card');
  check('UI: lantern card shows nickname, ref, text and counts', cardText.includes('은혜의 등불') && cardText.includes('모두와 나누는 묵상') && /기도하기 3/.test(cardText), cardText.slice(0, 80));
  await B.screenshot({ path: resolve(shotDir, 'm4-lantern-card-desktop.png') });
  await B.keyboard.press('Escape');
  await openBook(B, 'saved');
  await B.waitForSelector('.book-page.saved');
  check('UI: 기록하기 shows up under 담아 둔 묵상', (await B.textContent('.book')).includes('모두와 나누는 묵상'));
  await B.keyboard.press('Escape');

  step('groups ui');
  // Groups UI.
  await B.click('#btn-groups');
  await until(B, () => window.__WORLDS_DEBUG__.m3.modal === '모임');
  await B.fill('#group-code', grp.data.code);
  await B.click('.groups-form:last-of-type button');
  await B.waitForSelector('.group-item');
  await B.screenshot({ path: resolve(shotDir, 'm4-groups-desktop.png') });
  await until(B, (id) => window.__WORLDS_DEBUG__.m4.lanterns.some((l) => l.id === id), priv.data.id, 15000);
  check('UI: joining a group reveals its private lanterns live', true);
  await B.keyboard.press('Escape');

  step('take down');
  // Take down (owner): alice removes the public lantern; B sees it vanish.
  const gone = await alice.json('DELETE', `/api/lanterns/${pub.data.id}`);
  const notOwner = await bob.json('DELETE', `/api/lanterns/${priv.data.id}`);
  await until(B, (id) => !window.__WORLDS_DEBUG__.m4.lanterns.some((l) => l.id === id), pub.data.id, 15000);
  check('owner takes a lantern down; it disappears live; others cannot', gone.status === 200 && notOwner.status === 404 && wsDave.inbox.some((m) => m.t === 'lanternGone' && m.id === pub.data.id));

  // Local (M3) book import on first login on this device.
  step('import');
  const ctxC = await browser.newContext(mobile);
  const C = await ctxC.newPage();
  await C.goto(BASE + Q());
  await C.evaluate((day) => {
    const word = { date: day, book: '시편', chapter: 23, verse: 1, ref: '시편 23:1', text: '여호와는 나의 목자시니', before: [], after: [], translation: '개역한글판' };
    const page = { date: day, word, meditations: [{ id: 'local-1', place: '골방', createdAt: new Date().toISOString(), meditation: '이 기기에만 있던 묵상', feeling: '', application: '' }] };
    localStorage.setItem('worlds.wordbook.v1', JSON.stringify({ version: 1, pages: { [day]: page } }));
  }, DAY);
  await C.screenshot({ path: resolve(shotDir, 'm4-entry-mobile.png') });
  await loginJoin(C, BASE, 'faith', '믿음', Q());
  await until(C, () => window.__WORLDS_DEBUG__.m3.modal === '말씀 책 옮기기');
  await C.screenshot({ path: resolve(shotDir, 'm4-import-mobile.png') });
  await C.tap('#import-confirm');
  await until(C, () => window.__WORLDS_DEBUG__.m3.modal === null);
  await openBook(C, 'mine');
  await C.waitForSelector('.book-page');
  check('local word book imported into the account', (await C.textContent('.book')).includes('이 기기에만 있던 묵상'));
  await C.screenshot({ path: resolve(shotDir, 'm4-wordbook-mobile.png') });
  await C.tap('.book-top button');
  await join(C, BASE, '', Q());
  await sleep(2500);
  check('import is offered only once', (await debug(C)).m3.modal === null);

  // Guest in the browser: saving prompts sign-in.
  step('guest ui');
  const ctxG = await browser.newContext(desktop);
  const G = await ctxG.newPage();
  await join(G, BASE, '나그네', Q());
  const door2 = await G.evaluate(() => window.__WORLDS_TEST__.closetDoor());
  await teleport(G, door2);
  await until(G, () => document.getElementById('action-btn').textContent.includes('골방'));
  await G.keyboard.press('KeyE');
  await until(G, () => window.__WORLDS_DEBUG__.m3.closet === true);
  await G.click('#closet-meditate');
  await until(G, () => window.__WORLDS_DEBUG__.m3.modal === '묵상하기');
  await G.click('.med-foot .primary');
  await G.fill('#med-meditation', '손님의 묵상');
  await G.click('.med-foot .primary');
  await G.click('.med-foot .primary');
  await G.click('.med-save');
  await until(G, () => window.__WORLDS_DEBUG__.m3.modal === '로그인 안내');
  await G.screenshot({ path: resolve(shotDir, 'm4-guest-prompt-desktop.png') });
  check('guest save → gentle sign-in prompt', true);
  await ctxG.close();

  // ---------------------------------------------------------------- hardening
  step('hardening');
  const runner = await rawClient(WS, { nickname: '달리기' });
  runner.send({ t: 'state', x: 0, y: 2.5, z: 8, yaw: 0, speed: 0 });
  await sleep(200);
  runner.send({ t: 'state', x: 60, y: 3, z: 8, yaw: 0, speed: 4 });
  await sleep(500);
  const corr = of(runner, 'correct')[0];
  const snapPos = [...of(runner, 'snap')].reverse().find((s) => s.players.some((p) => p.id === of(runner, 'welcome')[0].id));
  const me = snapPos?.players.find((p) => p.id === of(runner, 'welcome')[0].id);
  check('speed check: a 60 m jump is refused and corrected', corr && Math.abs(corr.x) < 1 && me && Math.abs(me.x) < 1, JSON.stringify({ corr, me: me && { x: me.x } }));
  runner.send({ t: 'state', x: 1.5, y: 2.5, z: 8, yaw: 0, speed: 4 });
  await sleep(400);
  check('normal walking still accepted', of(runner, 'correct').length === 1);

  let originBlocked = false;
  try {
    await rawClient(WS, { nickname: 'evil' }, { origin: 'http://evil.example' });
  } catch (e) {
    originBlocked = e.status === 403;
  }
  const evilPost = await new Agent().json('POST', '/api/auth/logout', {}, { origin: 'http://evil.example' });
  check('foreign Origin refused on WebSocket upgrade and API writes', originBlocked && evilPost.status === 403);

  const sockets = [];
  let limited = false;
  for (let i = 0; i < 25 && !limited; i++) {
    try {
      sockets.push(await rawClient(WS, null));
    } catch (e) {
      limited = e.status === 429;
    }
  }
  check('per-IP connection limit (via the forwarded IP)', limited, `opened ${sockets.length} more before 429`);
  for (const s of sockets) s.ws.close();

  // Login rate limit (30/min/IP): hammer the start endpoint.
  let hit429 = false;
  for (let i = 0; i < 100 && !hit429; i++) {
    hit429 = (await new Agent().raw('GET', '/api/auth/google/start?hint=spam')).status === 429;
  }
  check('login attempts are rate-limited per IP (limit set to 80/min for this run)', hit429);

  const unexpected = pageErrors.filter((e) => !/WebSocket connection to .* failed|Permissions policy violation|status of 40[1349]/.test(e));
  check('no unexpected page errors', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
  for (const c of [wsBob, wsDave, wsGuest, runner]) c.ws.close();

  // ---------------------------------------------------------------- production single port
  step('production');
  start('prod', 'node', ['dist/server/src/index.js'], serverDir, {
    PORT: String(PROD_PORT),
    WORLDS_DB: DB_PROD,
    NODE_ENV: 'production',
    SERVE_CLIENT: '1',
    QUIET: '1',
  });
  const P = `http://127.0.0.1:${PROD_PORT}`;
  await waitHttp(`${P}/health`);
  const html = await fetch(`${P}/`, { headers: { 'accept-encoding': 'gzip' } });
  const htmlText = await html.text();
  const asset = /src="(\/assets\/[^"]+\.js)"/.exec(htmlText)?.[1];
  const js = await fetch(P + asset, { headers: { 'accept-encoding': 'gzip' } });
  const spa = await fetch(`${P}/some/deep/link`);
  const missing = await fetch(`${P}/assets/nope.js`);
  check(
    'production: one port serves the page (no-cache), hashed assets (immutable, gzip) and SPA fallback',
    html.status === 200 && htmlText.includes('말씀 나눔') && /no-cache/.test(html.headers.get('cache-control')) &&
      js.status === 200 && /immutable/.test(js.headers.get('cache-control')) && js.headers.get('content-encoding') === 'gzip' &&
      spa.status === 200 && (await spa.text()).includes('<div id="entry">') && missing.status === 404,
  );
  const csp = html.headers.get('content-security-policy') ?? '';
  check(
    'production: HTML security headers (CSP self-only, no YouTube, frame-ancestors none, referrer policy, nosniff)',
    csp.includes("frame-ancestors 'none'") && !/youtube|ytimg/i.test(csp) &&
      html.headers.get('referrer-policy') === 'strict-origin-when-cross-origin' && html.headers.get('x-content-type-options') === 'nosniff',
    csp.slice(0, 120),
  );
  const healthLocal = await fetch(`${P}/health`).then((r) => r.json());
  const healthProxied = await fetch(`${P}/health`, { headers: { 'x-forwarded-for': '203.0.113.5' } }).then((r) => r.json());
  check('/health: details only for direct local calls; proxied callers get {ok:true}', 'players' in healthLocal && JSON.stringify(healthProxied) === '{"ok":true}');
  const prodMe = await fetch(`${P}/api/me`).then((r) => r.json());
  const prodCfg = await fetch(`${P}/api/auth/config`).then((r) => r.json());
  const prodWs = await rawClient(`ws://127.0.0.1:${PROD_PORT}/ws`, { nickname: '배포', test: true });
  await sleep(300);
  check('production: /api/me and /ws on the same port; no mock login', prodMe.user === null && prodCfg.ready === false && of(prodWs, 'welcome').length === 1);
  prodWs.ws.close();
  const prodBrowser = await browser.newContext(desktop);
  const PB = await prodBrowser.newPage();
  await PB.goto(`${P}/?test=1&shadows=0`); // test=1: only for __WORLDS_DEBUG__ (the server ignores it in production)
  await PB.waitForSelector('#btn-google');
  check('production: the page loads; Google button shows "준비 중" without credentials', (await PB.textContent('#btn-google')).includes('준비 중'));
  await PB.fill('#nickname', '배포손님');
  await PB.click('#entry-submit');
  await until(PB, () => window.__WORLDS_DEBUG__?.net?.status === 'online', null, 60000);
  check('production: a guest enters the world through the single port', true);
  await prodBrowser.close();

  const refused = start('prod-mock', 'node', ['dist/server/src/index.js'], serverDir, {
    PORT: '5187',
    WORLDS_DB: DB_PROD,
    NODE_ENV: 'production',
    WORLDS_AUTH_MOCK: '1',
  });
  const code = await new Promise((r) => refused.once('exit', (c) => r(c)));
  check('NODE_ENV=production refuses WORLDS_AUTH_MOCK', code === 1);
} catch (err) {
  check('test run completed', false, `[step: ${currentStep()}] ${String(err).split('\n')[0]}`);
} finally {
  await browser?.close();
  await stopAll();
  dropDb(DB);
  dropDb(DB_PROD);
}
process.exit(summary());
