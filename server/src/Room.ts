import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  CAMPFIRE,
  MATS,
  MAT_COUNT,
  PROTOCOL_VERSION,
  SIT_REACH,
  SNAPSHOT_HZ,
  parseClientMessage,
  seoulDate,
  validateChat,
  validateNickname,
  type ErrorCode,
  type PlayerInfo,
  type PlayerSnap,
  type ServerMessage,
  type StatePayload,
} from '../../shared/protocol.js';
import type { RoomEvents } from './api.js';
import type { SessionUser, Users } from './auth.js';
import type { DailyWord } from './dailyWord.js';
import type { GroupService, LanternService } from './services.js';
import { TokenBucket } from './rateLimit.js';

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
  buckets: { state: TokenBucket; chat: TokenBucket; seat: TokenBucket };
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
}

/** Fastest legit movement (run speed 7.5 m/s) with headroom for lag. */
const MAX_SPEED = 11;
const MOVE_SLACK = 2;

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
}

const round = (v: number) => Math.round(v * 100) / 100;

/**
 * One shared world. The server owns the player list, display names, mat
 * occupancy and who may hear whom; clients own their own movement (validated
 * for shape and range only, see known issues).
 */
export class Room implements RoomEvents {
  private readonly clients = new Map<string, Client>();
  private readonly mats: (string | null)[] = Array(MAT_COUNT).fill(null);
  private readonly timer: NodeJS.Timeout;
  private readonly log: (msg: string) => void;
  private currentDate = seoulDate();

  constructor(private readonly options: RoomOptions) {
    this.log = options.log ?? (() => undefined);
    this.timer = setInterval(() => {
      this.broadcastSnapshot();
      this.checkDayChange();
    }, 1000 / SNAPSHOT_HZ);
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
      buckets: {
        state: new TokenBucket(30, 25),
        chat: new TokenBucket(3, 0.5),
        seat: new TokenBucket(4, 2),
      },
      strikes: 0,
      strikeWindowStart: Date.now(),
      helloTimer: null,
      testDate: null,
      userId: user?.id ?? null,
      accountName: user?.nickname ?? null,
      groupIds: user && this.options.groups ? this.options.groups.groupIds(user.id) : new Set(),
      testClient: false,
      lastStateAt: 0,
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
        if (client.seat >= 0) return; // seated players stay on their mat
        const now = Date.now();
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
        client.state = { x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw, speed: msg.speed, inside: msg.inside === true };
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
        const mat = MATS[msg.mat];
        const owner = this.mats[msg.mat];
        if (owner && owner !== client.id) return this.error(client, 'mat_taken', '이미 다른 분이 앉아 있어요.');
        if (Math.hypot(client.state.x - mat.x, client.state.z - mat.z) > SIT_REACH) {
          return this.error(client, 'not_near', '자리에 조금 더 가까이 가 주세요.');
        }
        if (client.seat >= 0) this.mats[client.seat] = null;
        this.mats[msg.mat] = client.id;
        client.seat = msg.mat;
        client.state = { ...client.state, x: mat.x, z: mat.z, yaw: mat.yaw, speed: 0 };
        this.broadcast({ t: 'mats', mats: [...this.mats] });
        return;
      }
      case 'stand': {
        if (!client.buckets.seat.take()) return this.strike(client, 'rate_limited');
        this.freeSeat(client);
        return;
      }
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

    const players: PlayerInfo[] = [];
    for (const c of this.clients.values()) if (c.joined && c !== client) players.push({ id: c.id, name: c.name, guest: c.userId === null });
    this.send(client, {
      t: 'welcome',
      id: client.id,
      name,
      seed: this.options.seed,
      players,
      mats: [...this.mats],
      snapshotHz: SNAPSHOT_HZ,
      word: this.wordFor(client),
      account: client.userId !== null && client.accountName ? { id: client.userId, nickname: client.accountName } : null,
      guest: client.userId === null,
    });
    this.sendLanterns(client);
    this.broadcast({ t: 'join', player: { id: client.id, name, guest: client.userId === null } }, client);
    this.log(`join ${name} (${client.id}), players=${this.playerCount}`);
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

  private freeSeat(client: Client): void {
    if (client.seat < 0) return;
    if (this.mats[client.seat] === client.id) this.mats[client.seat] = null;
    client.seat = -1;
    this.broadcast({ t: 'mats', mats: [...this.mats] });
  }

  private detach(client: Client): void {
    if (client.helloTimer) clearTimeout(client.helloTimer);
    if (!this.clients.delete(client.id)) return;
    if (!client.joined) return;
    client.joined = false;
    this.broadcast({ t: 'leave', id: client.id });
    if (client.seat >= 0) {
      this.mats[client.seat] = null;
      client.seat = -1;
      this.broadcast({ t: 'mats', mats: [...this.mats] });
    }
    this.log(`leave ${client.name} (${client.id}), players=${this.playerCount}`);
  }

  private broadcastSnapshot(): void {
    if (this.playerCount === 0) return;
    const players: PlayerSnap[] = [];
    for (const c of this.clients.values()) {
      if (!c.joined) continue;
      const s = c.state;
      players.push({
        id: c.id,
        x: round(s.x),
        y: round(s.y),
        z: round(s.z),
        yaw: round(s.yaw),
        speed: round(s.speed),
        seat: c.seat,
        ...(s.inside ? { inside: true } : {}),
      });
    }
    this.broadcast({ t: 'snap', players });
  }

  close(): void {
    clearInterval(this.timer);
    for (const c of this.clients.values()) c.ws.close(1001, 'server shutdown');
  }
}
