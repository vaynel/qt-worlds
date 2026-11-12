import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  CAMPFIRE,
  BENCH_SEAT_COUNT,
  DESK_SEAT_COUNT,
  LIBRARY_DOOR,
  LIBRARY_ENTER_REACH,
  LOG_SEAT_COUNT,
  type Space,
  MAT_COUNT,
  seatSpot,
  type SeatKind,
  PROTOCOL_VERSION,
  VOICE_KICK_BLOCK_MS,
  VOICE_MAX,
  type VoicePeerInfo,
  SIT_REACH,
  SNAPSHOT_HZ,
  parseClientMessage,
  seoulDate,
  validateChat,
  validateNickname,
  type ErrorCode,
  type Look,
  type PlayerInfo,
  type PlayerSnap,
  type PropId,
  type PropWear,
  type ServerMessage,
  type StatePayload,
} from '../../shared/protocol.js';
import type { RoomEvents } from './api.js';
import type { SessionUser, Users } from './auth.js';
import type { DailyWord } from './dailyWord.js';
import type { GroupService, LanternService } from './services.js';
import type { LookService } from './looks.js';
import type { ShopEvents, ShopService } from './shop.js';
import { TokenBucket } from './rateLimit.js';
import type { FootprintService } from './footprints.js';
import type { LibraryService } from './library.js';

const HELLO_TIMEOUT_MS = 10_000;
/** Bad or rate-limited frames tolerated per minute before disconnecting. */
const STRIKE_LIMIT = 60;
const SPAWN: StatePayload = { x: 0, y: 2.5, z: 8, yaw: Math.PI, speed: 0 };

interface Client {
  id: string;
  ws: WebSocket;
  joined: boolean;
  name: string;
  baseName: string;
  state: StatePayload;
  seat: number;
  /** What `seat` indexes (meaningful only while seat >= 0). */
  seatKind: SeatKind;
  buckets: { state: TokenBucket; chat: TokenBucket; seat: TokenBucket; voice: TokenBucket; signal: TokenBucket; voiceState: TokenBucket };
  /** Voice prayer room this connection is in (group id), or null. */
  voiceGroup: number | null;
  voiceMuted: boolean;
  voiceSpeaking: boolean;
  strikes: number;
  strikeWindowStart: number;
  helloTimer: NodeJS.Timeout | null;
  /** Date override for tests (only when the server allows it). */
  testDate: string | null;
  /** Signed-in account (null = guest). */
  userId: number | null;
  accountName: string | null;
  groupIds: Set<number>;
  /** Test clients may teleport (only when the server runs in test mode). */
  testClient: boolean;
  /** Last accepted position time (ms) for the speed check; 0 = none yet. */
  lastStateAt: number;
  /** Appearance as others see it, and as this account itself sees it (hidden drawing flagged). */
  lookPublic: Look | null;
  lookOwn: Look | null;
  /** Borrowed props (M9) everyone sees. */
  props: PropWear[];
}

const spaceOf = (c: Client): Space => c.state.inside ?? 'world';

/** Fastest legit movement (run speed 7.5 m/s) with headroom for lag. */
const MAX_SPEED = 11;
const MOVE_SLACK = 2;
/** A state this far from your seat means you got up and walked off. */
const SEAT_LEAVE_DISTANCE = 1.2;

export interface RoomOptions {
  seed: string;
  maxPlayers: number;
  log?: (msg: string) => void;
  /** Source of 오늘의 말씀; null disables the feature. */
  dailyWord?: DailyWord | null;
  /** Honour hello.testDate (automated tests only, never in production). */
  allowTestDates?: boolean;
  /** Test mode: hello.test clients may teleport. Never in production. */
  testMode?: boolean;
  users?: Users | null;
  groups?: GroupService | null;
  lanterns?: LanternService | null;
  looks?: LookService | null;
  shop?: ShopService | null;
  library?: LibraryService | null;
  footprints?: FootprintService | null;
  /** How often presence minutes (발자취) are sampled. */
  footprintTickMs?: number;
}

const round = (v: number) => Math.round(v * 100) / 100;

/**
 * One shared world. The server owns the player list, display names, mat
 * occupancy and who may hear whom; clients own their own movement (validated
 * for shape and range only, see known issues).
 */
export class Room implements RoomEvents, ShopEvents {
  private readonly clients = new Map<string, Client>();
  private readonly mats: (string | null)[] = Array(MAT_COUNT).fill(null);
  /** Campfire log seats (LOG_SEATS order). */
  private readonly logs: (string | null)[] = Array(LOG_SEAT_COUNT).fill(null);
  /** 중앙 광장 bench seats (BENCH_SEATS order). */
  private readonly benches: (string | null)[] = Array(BENCH_SEAT_COUNT).fill(null);
  /** 이야기 도서관 reading desk seats (DESK_SEATS order). */
  private readonly desks: (string | null)[] = Array(DESK_SEAT_COUNT).fill(null);
  private readonly timer: NodeJS.Timeout;
  private readonly footprintTimer: NodeJS.Timeout;
  private readonly log: (msg: string) => void;
  private currentDate = seoulDate();

  constructor(private readonly options: RoomOptions) {
    this.log = options.log ?? (() => undefined);
    this.timer = setInterval(() => {
      this.broadcastSnapshot();
      this.checkDayChange();
    }, 1000 / SNAPSHOT_HZ);
    this.footprintTimer = setInterval(() => this.sampleFootprints(), options.footprintTickMs ?? 20_000);
  }

  /**
   * 발자취 presence: once per sample, every signed-in player's minute counts as
   * time here, and as prayer (on a mat), campfire (with how many others were
   * there; never what was said), voice room or library time. Stored per minute,
   * so several tabs or a reconnect never count twice.
   */
  private sampleFootprints() {
    const fp = this.options.footprints;
    if (!fp) return;
    let fire = 0;
    for (const c of this.clients.values()) if (c.joined && this.nearCampfire(c)) fire++;
    for (const c of this.clients.values()) {
      if (!c.joined || c.userId === null) continue;
      fp.minute(c.userId, 'play');
      if (c.seat >= 0 && c.seatKind === 'mat') fp.minute(c.userId, 'pray');
      if (this.nearCampfire(c)) fp.minute(c.userId, 'fire', fire - 1);
      if (c.voiceGroup !== null) fp.minute(c.userId, 'voice');
      if (spaceOf(c) === 'library') fp.minute(c.userId, 'library');
    }
  }

  get playerCount(): number {
    let n = 0;
    for (const c of this.clients.values()) if (c.joined) n++;
    return n;
  }

  attach(ws: WebSocket, user: SessionUser | null = null): void {
    const client: Client = {
      id: randomBytes(6).toString('base64url'),
      ws,
      joined: false,
      name: '',
      baseName: '',
      state: { ...SPAWN },
      seat: -1,
      seatKind: 'mat',
      buckets: {
        state: new TokenBucket(30, 25),
        chat: new TokenBucket(3, 0.5),
        seat: new TokenBucket(4, 2),
        voice: new TokenBucket(4, 0.5),
        // ICE trickling comes in bursts; SDP is a handful per renegotiation.
        signal: new TokenBucket(200, 40),
        voiceState: new TokenBucket(20, 8),
      },
      voiceGroup: null,
      voiceMuted: true,
      voiceSpeaking: false,
      strikes: 0,
      strikeWindowStart: Date.now(),
      helloTimer: null,
      testDate: null,
      userId: user?.id ?? null,
      accountName: user?.nickname ?? null,
      groupIds: user && this.options.groups ? this.options.groups.groupIds(user.id) : new Set(),
      testClient: false,
      lastStateAt: 0,
      lookPublic: null,
      lookOwn: null,
      props: [],
    };
    client.helloTimer = setTimeout(() => ws.close(4000, 'hello timeout'), HELLO_TIMEOUT_MS);
    this.clients.set(client.id, client);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return this.strike(client, 'bad_message');
      this.handle(client, data.toString());
    });
    ws.on('close', () => this.detach(client));
    ws.on('error', () => ws.terminate());
  }

  private send(client: Client, msg: ServerMessage): void {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage, except?: Client): void {
    const data = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      if (c.joined && c !== except && c.ws.readyState === c.ws.OPEN) c.ws.send(data);
    }
  }

  private error(client: Client, code: ErrorCode, message: string): void {
    this.send(client, { t: 'error', code, message });
  }

  private strike(client: Client, code: ErrorCode, silent = false): void {
    const now = Date.now();
    if (now - client.strikeWindowStart > 60_000) {
      client.strikeWindowStart = now;
      client.strikes = 0;
    }
    client.strikes++;
    // Explain the first few problems; after that stay quiet until the limit.
    if (client.strikes <= 20 && !silent) {
      this.error(client, code, code === 'rate_limited' ? '조금 천천히 보내 주세요.' : '잘못된 요청이에요.');
    }
    if (client.strikes > STRIKE_LIMIT) client.ws.close(1008, 'too many bad messages');
  }

  private handle(client: Client, raw: string): void {
    const msg = parseClientMessage(raw);
    if (!msg) return this.strike(client, 'bad_message');

    if (!client.joined) {
      if (msg.t !== 'hello') return this.strike(client, 'bad_message');
      if (msg.testDate && this.options.allowTestDates) client.testDate = msg.testDate;
      if (msg.test && this.options.testMode) client.testClient = true;
      return this.join(client, msg.v, msg.nickname);
    }

    switch (msg.t) {
      case 'hello':
        return this.strike(client, 'bad_message');
      case 'state': {
        if (!client.buckets.state.take()) return this.strike(client, 'rate_limited');
        if (client.seat >= 0) {
          // Seated players stay put; walking away (a client that skipped
          // 'stand') stands them up and frees the seat.
          const spot = seatSpot(client.seatKind, client.seat)!;
          if (Math.hypot(msg.x - spot.x, msg.z - spot.z) <= SEAT_LEAVE_DISTANCE && (msg.inside ?? 'world') === spaceOf(client)) return;
          this.freeSeat(client);
        }
        const now = Date.now();
        const from = spaceOf(client);
        const to: Space = msg.inside ?? 'world';
        if (from !== to) {
          // Stepping into the library: only from its door (the 골방 keeps the old trust model).
          if (to === 'library' && from === 'world' && !client.testClient && Math.hypot(client.state.x - LIBRARY_DOOR.x, client.state.z - LIBRARY_DOOR.z) > LIBRARY_ENTER_REACH) {
            const s0 = client.state;
            this.send(client, { t: 'correct', x: s0.x, y: s0.y, z: s0.z });
            return this.strike(client, 'not_near', true);
          }
          // A new space has its own coordinates: no speed check across the switch.
          client.lastStateAt = 0;
          if (to === 'library' && client.userId !== null) this.options.footprints?.event(client.userId, 'library', `${seoulDate()}:${Math.floor(now / 600_000)}`);
          if (to === 'library') this.sendLibrary(client);
        }
        if (client.lastStateAt && !client.testClient) {
          // Speed check: reject teleports and tell the client where it really is.
          const dt = Math.min(5, Math.max(0.05, (now - client.lastStateAt) / 1000));
          const dist = Math.hypot(msg.x - client.state.x, msg.z - client.state.z);
          if (dist > MAX_SPEED * dt + MOVE_SLACK) {
            const s0 = client.state;
            this.send(client, { t: 'correct', x: s0.x, y: s0.y, z: s0.z });
            return this.strike(client, 'rate_limited', true);
          }
        }
        client.lastStateAt = now;
        client.state = { x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw, speed: msg.speed, ...(msg.inside ? { inside: msg.inside } : {}) };
        return;
      }
      case 'chat': {
        if (!client.buckets.chat.take()) return this.strike(client, 'rate_limited');
        const text = validateChat(msg.text);
        if (!text) return this.strike(client, 'bad_message');
        if (!this.nearCampfire(client)) return this.error(client, 'not_near', '모닥불 가까이에서만 이야기할 수 있어요.');
        const out: ServerMessage = { t: 'chat', id: client.id, name: client.name, text };
        const data = JSON.stringify(out);
        let heard = 0;
        for (const c of this.clients.values()) {
          if (c.joined && this.nearCampfire(c) && c.ws.readyState === c.ws.OPEN) {
            c.ws.send(data);
            heard++;
          }
        }
        this.log(`chat ${client.name}: ${text.length} chars, heard by ${heard}`);
        return;
      }
      case 'sit': {
        if (!client.buckets.seat.take()) return this.strike(client, 'rate_limited');
        const spot = seatSpot(msg.kind, msg.seat)!;
        const list = this.seats(msg.kind);
        const owner = list[msg.seat];
        if (owner && owner !== client.id) {
          return msg.kind === 'mat'
            ? this.error(client, 'mat_taken', '이미 다른 분이 앉아 있어요.')
            : this.error(client, 'seat_taken', '이미 다른 분이 앉아 있어요.');
        }
        // Desks are inside the library; every other seat is out in the world.
        const space = spaceOf(client);
        if (space !== (msg.kind === 'desk' ? 'library' : 'world') || Math.hypot(client.state.x - spot.x, client.state.z - spot.z) > SIT_REACH) {
          return this.error(client, 'not_near', '자리에 조금 더 가까이 가 주세요.');
        }
        if (client.seat >= 0 && (client.seatKind !== msg.kind || client.seat !== msg.seat)) this.freeSeat(client);
        list[msg.seat] = client.id;
        client.seat = msg.seat;
        client.seatKind = msg.kind;
        client.state = { ...client.state, x: spot.x, z: spot.z, yaw: spot.yaw, speed: 0 };
        this.broadcastSeats(msg.kind);
        if (client.userId !== null && msg.kind !== 'mat') {
          const now = Date.now();
          this.options.footprints?.event(client.userId, 'sit', `${msg.kind}:${seoulDate()}:${Math.floor(now / 60_000)}`, { kind: msg.kind }, now);
        }
        return;
      }
      case 'stand': {
        if (!client.buckets.seat.take()) return this.strike(client, 'rate_limited');
        this.freeSeat(client);
        return;
      }
      case 'voiceJoin':
        if (!client.buckets.voice.take()) return this.strike(client, 'rate_limited');
        return this.voiceJoin(client, msg.groupId);
      case 'voiceLeave':
        if (!client.buckets.voice.take()) return this.strike(client, 'rate_limited');
        return this.voiceLeave(client, 'left');
      case 'voiceSignal': {
        if (!client.buckets.signal.take()) return this.strike(client, 'rate_limited', true);
        // Relay only between two connections in the same room.
        const peer = this.clients.get(msg.to);
        if (client.voiceGroup === null || !peer || peer === client || peer.voiceGroup !== client.voiceGroup) return;
        this.send(peer, { t: 'voiceSignal', from: client.id, data: msg.data });
        return;
      }
      case 'voiceMute':
      case 'voiceSpeaking': {
        if (!client.buckets.voiceState.take()) return this.strike(client, 'rate_limited', true);
        if (client.voiceGroup === null) return;
        if (msg.t === 'voiceMute') {
          client.voiceMuted = msg.muted;
          if (msg.muted) client.voiceSpeaking = false;
        } else {
          client.voiceSpeaking = msg.speaking && !client.voiceMuted;
        }
        this.voiceBroadcast(client.voiceGroup, { t: 'voicePeer', peer: this.voiceInfo(client), joined: false }, client);
        return;
      }
      case 'voiceKick':
        if (!client.buckets.voice.take()) return this.strike(client, 'rate_limited');
        return this.voiceKick(client, msg.target);
    }
  }

  // ---------------------------------------------------------------- voice rooms

  /** groupId -> connection ids in that room (memory only; nothing is recorded). */
  private readonly voiceRooms = new Map<number, Set<string>>();
  /** "groupId:userId" -> blocked until (ms) after a kick. */
  private readonly voiceBlocks = new Map<string, number>();

  voiceCount(groupId: number): number {
    return this.voiceRooms.get(groupId)?.size ?? 0;
  }

  private voiceInfo(c: Client): VoicePeerInfo {
    const owner = c.voiceGroup !== null && c.userId !== null && this.options.groups?.info(c.voiceGroup)?.ownerId === c.userId;
    return { id: c.id, name: c.name, muted: c.voiceMuted, speaking: c.voiceSpeaking, owner };
  }

  private voiceBroadcast(groupId: number, msg: ServerMessage, except?: Client) {
    for (const id of this.voiceRooms.get(groupId) ?? []) {
      const c = this.clients.get(id);
      if (c && c !== except) this.send(c, msg);
    }
  }

  private voiceError(client: Client, code: ErrorCode, message: string) {
    this.send(client, { t: 'voiceError', code, message });
  }

  private voiceJoin(client: Client, groupId: number) {
    const groups = this.options.groups;
    if (client.userId === null || !groups) return this.voiceError(client, 'voice_login', '로그인하고 모임에 함께하면 음성 기도방을 쓸 수 있어요.');
    const info = groups.info(groupId);
    if (!info || !groups.isMember(client.userId, groupId)) {
      return this.voiceError(client, 'voice_not_member', '모임 사람만 들어갈 수 있어요.');
    }
    const blockedUntil = this.voiceBlocks.get(`${groupId}:${client.userId}`) ?? 0;
    if (blockedUntil > Date.now()) {
      const min = Math.ceil((blockedUntil - Date.now()) / 60_000);
      return this.voiceError(client, 'voice_blocked', `방장이 내보내서 ${min}분 뒤에 다시 들어올 수 있어요.`);
    }
    if (client.voiceGroup === groupId) return;
    if (client.voiceGroup !== null) this.voiceLeave(client, 'left');
    const room = this.voiceRooms.get(groupId) ?? new Set<string>();
    if (room.size >= VOICE_MAX) return this.voiceError(client, 'voice_full', `음성 기도방은 ${VOICE_MAX}명까지 함께할 수 있어요.`);
    client.voiceGroup = groupId;
    client.voiceMuted = true; // everyone joins muted
    client.voiceSpeaking = false;
    const peers = [...room].map((id) => this.clients.get(id)).filter((c): c is Client => !!c).map((c) => this.voiceInfo(c));
    room.add(client.id);
    this.voiceRooms.set(groupId, room);
    this.send(client, { t: 'voiceRoom', groupId, groupName: info.name, selfId: client.id, owner: info.ownerId === client.userId, peers });
    this.voiceBroadcast(groupId, { t: 'voicePeer', peer: this.voiceInfo(client), joined: true }, client);
    this.log(`voice join g${groupId} ${client.name} (${room.size})`);
  }

  private voiceLeave(client: Client, reason: 'left' | 'kicked' | 'removed') {
    const groupId = client.voiceGroup;
    if (groupId === null) return;
    const room = this.voiceRooms.get(groupId);
    room?.delete(client.id);
    if (room && room.size === 0) this.voiceRooms.delete(groupId);
    client.voiceGroup = null;
    client.voiceSpeaking = false;
    client.voiceMuted = true;
    if (client.joined) this.send(client, { t: 'voiceLeft', reason });
    this.voiceBroadcast(groupId, { t: 'voicePeerLeft', id: client.id });
  }

  private voiceKick(client: Client, targetId: string) {
    const groupId = client.voiceGroup;
    const target = this.clients.get(targetId);
    if (groupId === null || !target || target.voiceGroup !== groupId || target === client) return;
    if (this.options.groups?.info(groupId)?.ownerId !== client.userId) {
      return this.voiceError(client, 'voice_not_member', '모임을 만든 분만 내보낼 수 있어요.');
    }
    if (target.userId !== null) this.voiceBlocks.set(`${groupId}:${target.userId}`, Date.now() + VOICE_KICK_BLOCK_MS);
    this.voiceLeave(target, 'kicked');
    // Every connection of that account leaves the room.
    for (const c of this.clients.values()) {
      if (c.userId === target.userId && c.voiceGroup === groupId) this.voiceLeave(c, 'kicked');
    }
  }

  private join(client: Client, version: number, nickname: string): void {
    if (version !== PROTOCOL_VERSION) {
      this.error(client, 'version', '새 버전이 있어요. 페이지를 새로고침해 주세요.');
      client.ws.close(4001, 'version');
      return;
    }
    let base: string | null;
    if (client.userId !== null) {
      // Signed-in: the account nickname is used (hello.nickname is ignored).
      base = client.accountName;
      if (!base) {
        this.error(client, 'bad_nickname', '먼저 닉네임을 정해 주세요.');
        client.ws.close(4002, 'needs nickname');
        return;
      }
    } else {
      base = validateNickname(nickname);
      if (!base) {
        this.error(client, 'bad_nickname', '닉네임은 1~12자로 정해 주세요.');
        client.ws.close(4002, 'bad nickname');
        return;
      }
      if (this.options.users?.isRegistered(base)) {
        this.error(client, 'name_taken', '이미 가입한 분이 쓰는 닉네임이에요. 다른 이름을 써 주세요.');
        client.ws.close(4004, 'name taken');
        return;
      }
    }
    if (this.playerCount >= this.options.maxPlayers) {
      this.error(client, 'full', '지금은 자리가 가득 찼어요. 잠시 후 다시 들어와 주세요.');
      client.ws.close(4003, 'full');
      return;
    }
    if (client.helloTimer) clearTimeout(client.helloTimer);
    client.helloTimer = null;

    const taken = new Set<string>();
    for (const c of this.clients.values()) if (c.joined) taken.add(c.name);
    let name = base;
    // Only guests get "(2)" suffixes; an account's nickname is already unique.
    if (client.userId === null) for (let n = 2; taken.has(name); n++) name = `${base} (${n})`;

    client.joined = true;
    client.name = name;
    client.baseName = base;
    this.loadLook(client);
    client.props = this.loadProps(client);

    const players: PlayerInfo[] = [];
    for (const c of this.clients.values()) if (c.joined && c !== client) players.push(this.info(c, client));
    this.send(client, {
      t: 'welcome',
      id: client.id,
      name,
      seed: this.options.seed,
      players,
      mats: [...this.mats],
      logs: [...this.logs],
      benches: [...this.benches],
      desks: [...this.desks],
      snapshotHz: SNAPSHOT_HZ,
      word: this.wordFor(client),
      account: client.userId !== null && client.accountName ? { id: client.userId, nickname: client.accountName } : null,
      guest: client.userId === null,
      look: client.lookOwn,
    });
    this.sendLanterns(client);
    this.sendShop(client);
    for (const c of this.clients.values()) {
      if (c.joined && c !== client) this.send(c, { t: 'join', player: this.info(client, c) });
    }
    this.log(`join ${name} (${client.id}), players=${this.playerCount}`);
  }

  // ---------------------------------------------------------------- looks (M8)

  private loadLook(c: Client) {
    const looks = this.options.looks;
    c.lookPublic = c.userId !== null && looks ? looks.lookFor(c.userId, false) : null;
    c.lookOwn = c.userId !== null && looks ? looks.lookFor(c.userId, true) : null;
  }

  /** What `viewer` sees of `c`: the same account sees its own hidden drawing, others don't. */
  private lookSeenBy(c: Client, viewer: Client): Look | null {
    return c.userId !== null && c.userId === viewer.userId ? c.lookOwn : c.lookPublic;
  }

  private info(c: Client, viewer: Client): PlayerInfo {
    const look = this.lookSeenBy(c, viewer);
    return { id: c.id, name: c.name, guest: c.userId === null, ...(look ? { look } : {}), ...(c.props.length ? { props: c.props } : {}) };
  }

  // ---------------------------------------------------------------- 나눔 소품 가게 (M9)

  private loadProps(c: Client): PropWear[] {
    return c.userId !== null && this.options.shop ? this.options.shop.activeProps(c.userId) : [];
  }

  /** Shop status to everyone, and this account's own rentals, right after joining (also after a reconnect). */
  private sendShop(c: Client) {
    const shop = this.options.shop;
    if (!shop) return;
    this.send(c, { t: 'shop', shop: shop.status() });
    if (c.userId !== null) this.send(c, { t: 'myShop', mine: shop.mine(c.userId) });
  }

  /** Rented, returned or expired: everyone sees the props change live. */
  propsChanged(userId: number) {
    for (const c of this.clients.values()) {
      if (c.userId !== userId) continue;
      const next = this.loadProps(c);
      if (JSON.stringify(next) === JSON.stringify(c.props)) continue;
      c.props = next;
      if (c.joined) this.broadcast({ t: 'props', id: c.id, props: next });
    }
  }

  private shopTimer: NodeJS.Timeout | null = null;

  /** Window opened/closed or stock changed: one coalesced broadcast. */
  shopChanged() {
    if (this.shopTimer || !this.options.shop) return;
    this.shopTimer = setTimeout(() => {
      this.shopTimer = null;
      const shop = this.options.shop;
      if (shop && this.playerCount > 0) this.broadcast({ t: 'shop', shop: shop.status() });
    }, 150);
  }

  myShopChanged(userId: number, ended?: PropId[]) {
    const shop = this.options.shop;
    if (!shop) return;
    let mine: ReturnType<ShopService['mine']> | null = null;
    for (const c of this.clients.values()) {
      if (!c.joined || c.userId !== userId) continue;
      mine ??= shop.mine(userId);
      this.send(c, { t: 'myShop', mine, ...(ended?.length ? { ended } : {}) });
    }
  }

  propReminder(userId: number, item: PropId, endsAt: number) {
    const now = this.options.shop?.now() ?? Date.now();
    for (const c of this.clients.values()) {
      if (c.joined && c.userId === userId) this.send(c, { t: 'propReminder', item, endsAt, now });
    }
  }

  /** Appearance saved, drawing worn/edited, hidden or restored: everyone sees it live. */
  lookChanged(userId: number) {
    for (const c of this.clients.values()) {
      if (c.userId !== userId) continue;
      this.loadLook(c);
      if (!c.joined) continue;
      for (const v of this.clients.values()) {
        if (v.joined) this.send(v, { t: 'look', id: c.id, look: this.lookSeenBy(c, v) });
      }
    }
  }

  // ---------------------------------------------------------------- lanterns

  private sendLanterns(client: Client) {
    const svc = this.options.lanterns;
    if (!svc) return;
    this.send(client, { t: 'lanterns', lanterns: svc.listFor(client.userId, client.groupIds) });
  }

  /** New or updated lantern: only clients allowed to see it receive it. */
  lanternChanged(id: number) {
    const svc = this.options.lanterns;
    if (!svc) return;
    for (const c of this.clients.values()) {
      if (!c.joined) continue;
      const info = svc.infoFor(id, c.userId, c.groupIds);
      if (info) this.send(c, { t: 'lantern', lantern: info });
    }
  }

  lanternRemoved(id: number) {
    const svc = this.options.lanterns;
    if (!svc) return;
    for (const c of this.clients.values()) {
      if (c.joined && svc.couldSee(id, c.userId, c.groupIds)) this.send(c, { t: 'lanternGone', id });
    }
  }

  // ---------------------------------------------------------------- group chat

  /** Deliver to connected members of that group only (membership is checked live). */
  groupChat(message: import('../../shared/protocol.js').GroupMessage, update: boolean) {
    for (const c of this.clients.values()) {
      if (!c.joined || c.userId === null || !c.groupIds.has(message.groupId)) continue;
      this.send(c, update ? { t: 'groupChatUpdate', message } : { t: 'groupChat', message });
    }
  }

  /** ✉️ 받은 편지: unread count (and an optional fixed-text toast) to that account's own connections. */
  letters(userId: number, unread: number, toast?: string, storyId?: number) {
    for (const c of this.clients.values()) {
      if (c.joined && c.userId === userId && c.accountName) this.send(c, { t: 'letters', unread, ...(toast ? { toast } : {}), ...(storyId ? { storyId } : {}) });
    }
  }

  /** Read on one device: tell the user's other connections (badge sync). */
  groupRead(userId: number, groupId: number, lastReadId: number) {
    for (const c of this.clients.values()) {
      if (c.joined && c.userId === userId) this.send(c, { t: 'groupRead', groupId, lastReadId });
    }
  }

  /**
   * 회원 탈퇴: the rows are already gone, so visibility can't be checked any
   * more. Every client hears "gone" for those ids (ids alone reveal nothing),
   * and that account's connections leave voice and are closed.
   */
  accountDeleted(userId: number, lanternIds: number[]) {
    for (const c of this.clients.values()) {
      if (!c.joined || c.userId === userId) continue;
      for (const id of lanternIds) this.send(c, { t: 'lanternGone', id });
    }
    for (const key of this.voiceBlocks.keys()) if (key.endsWith(`:${userId}`)) this.voiceBlocks.delete(key);
    for (const c of this.clients.values()) {
      if (c.userId !== userId) continue;
      this.voiceLeave(c, 'removed');
      c.userId = null;
      c.accountName = null;
      c.groupIds = new Set();
      c.ws.close(4005, 'account deleted');
    }
  }

  /** Live rename: every connection of that account gets the new name, and everyone sees it. */
  nicknameChanged(userId: number, nickname: string) {
    for (const c of this.clients.values()) {
      if (c.userId !== userId) continue;
      c.accountName = nickname;
      if (!c.joined) continue;
      c.name = nickname;
      this.broadcast({ t: 'rename', id: c.id, name: nickname });
    }
  }

  /** Group membership changed: refresh what that user's connections may see. */
  membershipChanged(userId: number) {
    const groups = this.options.groups;
    for (const c of this.clients.values()) {
      if (c.userId !== userId) continue;
      if (groups) c.groupIds = groups.groupIds(userId);
      if (c.joined) this.sendLanterns(c);
      if (c.joined && spaceOf(c) === 'library') this.sendLibrary(c);
      if (c.voiceGroup !== null && !c.groupIds.has(c.voiceGroup)) this.voiceLeave(c, 'removed');
    }
  }

  private wordFor(client: Client) {
    const dw = this.options.dailyWord;
    return dw ? dw.forDate(client.testDate ?? this.currentDate) : null;
  }

  /** At 00:00 KST everyone gets the new day's word. */
  private checkDayChange(): void {
    const today = seoulDate();
    if (today === this.currentDate) return;
    this.currentDate = today;
    this.log(`new day ${today}`);
    for (const c of this.clients.values()) {
      if (!c.joined || c.testDate) continue;
      const word = this.wordFor(c);
      if (word) this.send(c, { t: 'word', word });
    }
  }

  private nearCampfire(c: Client): boolean {
    if (c.state.inside) return false;
    return Math.hypot(c.state.x - CAMPFIRE.x, c.state.z - CAMPFIRE.z) <= CAMPFIRE.chatRadius;
  }

  private seats(kind: SeatKind): (string | null)[] {
    return kind === 'log' ? this.logs : kind === 'bench' ? this.benches : kind === 'desk' ? this.desks : this.mats;
  }

  private broadcastSeats(kind: SeatKind): void {
    if (kind === 'log') this.broadcast({ t: 'logs', logs: [...this.logs] });
    else if (kind === 'desk') this.broadcast({ t: 'desks', desks: [...this.desks] });
    else if (kind === 'bench') this.broadcast({ t: 'benches', benches: [...this.benches] });
    else this.broadcast({ t: 'mats', mats: [...this.mats] });
  }

  /** Stand up (stand message, disconnect): the seat is free again for everyone. */
  private freeSeat(client: Client): void {
    if (client.seat < 0) return;
    const list = this.seats(client.seatKind);
    if (list[client.seat] === client.id) list[client.seat] = null;
    client.seat = -1;
    this.broadcastSeats(client.seatKind);
  }

  private detach(client: Client): void {
    if (client.helloTimer) clearTimeout(client.helloTimer);
    if (!this.clients.delete(client.id)) return;
    if (!client.joined) return;
    this.voiceLeave(client, 'left');
    client.joined = false;
    this.broadcast({ t: 'leave', id: client.id });
    this.freeSeat(client);
    this.log(`leave ${client.name} (${client.id}), players=${this.playerCount}`);
  }

  /**
   * One snapshot per space: people in the open world see the world, people in
   * the library see each other, and nobody sees into a 골방. Players outside
   * the viewer's space are sent only as hidden (`inside`) with no position.
   */
  private broadcastSnapshot(): void {
    if (this.playerCount === 0) return;
    const cache = new Map<Space, string>();
    const frame = (space: Space): string => {
      let data = cache.get(space);
      if (data) return data;
      const players: PlayerSnap[] = [];
      for (const c of this.clients.values()) {
        if (!c.joined) continue;
        const s = c.state;
        if (space === 'room' || spaceOf(c) !== space) {
          players.push({ id: c.id, x: 0, y: 0, z: 0, yaw: 0, speed: 0, seat: -1, inside: true });
          continue;
        }
        players.push({
          id: c.id,
          x: round(s.x),
          y: round(s.y),
          z: round(s.z),
          yaw: round(s.yaw),
          speed: round(s.speed),
          seat: c.seat,
          ...(c.seat >= 0 && c.seatKind !== 'mat' ? { seatKind: c.seatKind } : {}),
        });
      }
      data = JSON.stringify({ t: 'snap', players } satisfies ServerMessage);
      cache.set(space, data);
      return data;
    };
    for (const c of this.clients.values()) {
      if (c.joined && c.ws.readyState === c.ws.OPEN) c.ws.send(frame(spaceOf(c)));
    }
  }

  // ---------------------------------------------------------------- 이야기 도서관

  private sendLibrary(c: Client) {
    const lib = this.options.library;
    if (lib) this.send(c, { t: 'library', shelves: lib.shelfCounts(c.userId !== null && c.accountName ? c.userId : null) });
  }

  private libraryTimer: NodeJS.Timeout | null = null;

  /** Books changed: everyone inside gets the shelf counts they may see (coalesced). */
  libraryChanged() {
    if (this.libraryTimer) return;
    this.libraryTimer = setTimeout(() => {
      this.libraryTimer = null;
      for (const c of this.clients.values()) if (c.joined && spaceOf(c) === 'library') this.sendLibrary(c);
    }, 120);
  }

  close(): void {
    clearInterval(this.timer);
    clearInterval(this.footprintTimer);
    if (this.shopTimer) clearTimeout(this.shopTimer);
    if (this.libraryTimer) clearTimeout(this.libraryTimer);
    for (const c of this.clients.values()) c.ws.close(1001, 'server shutdown');
  }
}
