import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type PlayerInfo,
  type PlayerSnap,
  type ServerMessage,
  type StatePayload,
  type WordPassage,
  type AccountInfo,
  type LanternInfo,
} from '../../../shared/protocol';

export type NetStatus = 'connecting' | 'online' | 'reconnecting' | 'closed';

export interface Welcome {
  id: string;
  name: string;
  seed: string;
  players: PlayerInfo[];
  mats: (string | null)[];
  /** Today's word (absent on servers older than M3). */
  word: WordPassage | null;
  account: AccountInfo | null;
  guest: boolean;
}

export interface NetHandlers {
  welcome(w: Welcome): void;
  join(p: PlayerInfo): void;
  leave(id: string): void;
  snapshot(players: PlayerSnap[]): void;
  chat(id: string, name: string, text: string): void;
  mats(mats: (string | null)[]): void;
  error(code: ErrorCode, message: string): void;
  status(status: NetStatus): void;
  word(word: WordPassage): void;
  rename(id: string, name: string): void;
  lanterns(list: LanternInfo[]): void;
  lantern(l: LanternInfo): void;
  lanternGone(id: number): void;
  correct(x: number, y: number, z: number): void;
}

/** Codes after which reconnecting would just fail again. */
const FATAL_CLOSE = new Set([4001, 4002, 4003, 4004]);
const CONNECT_TIMEOUT_MS = 6000;

/**
 * Where the multiplayer server lives. Default: same origin at /ws (Vite proxies
 * it in dev; a reverse proxy does it in production). VITE_WS_URL overrides it
 * at build time, ?ws= at runtime.
 */
export function resolveServerUrl(): string {
  const param = new URLSearchParams(location.search).get('ws');
  if (param && /^wss?:\/\//.test(param)) return param;
  const env = import.meta.env.VITE_WS_URL as string | undefined;
  if (env) return env;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/** Thrown by connect() when the server refuses us (nickname, full, version). */
export class JoinRefused extends Error {
  constructor(
    readonly code: ErrorCode | 'unreachable',
    message: string,
  ) {
    super(message);
  }
}

/**
 * WebSocket session with automatic reconnect (exponential backoff + jitter).
 * Messages from the server are only trusted for shape here; rendering code
 * must still treat names and chat text as plain text.
 */
export class NetClient {
  private ws: WebSocket | null = null;
  private handlers: Partial<NetHandlers> = {};
  private attempt = 0;
  private retryTimer = 0;
  private closedByUser = false;
  private everWelcomed = false;
  status: NetStatus = 'connecting';
  id = '';
  name = '';

  constructor(
    private readonly url: string,
    private readonly nickname: string,
    /** Test-only date override (the server ignores it unless explicitly allowed). */
    private readonly testDate: string | null = null,
    /** ?test=1: marks the session as a test client (honoured only by test servers). */
    private readonly testClient = false,
  ) {}

  on(handlers: Partial<NetHandlers>): void {
    this.handlers = { ...this.handlers, ...handlers };
    // Replay messages that arrived before anyone listened (e.g. between the
    // welcome and the world being built).
    const queued = this.backlog;
    this.backlog = [];
    for (const m of queued) this.dispatch(m);
  }

  private backlog: ServerMessage[] = [];

  /** Hand a message to its handler, or keep it until one is registered. */
  private dispatch(msg: ServerMessage) {
    const key = msg.t === 'snap' ? 'snapshot' : msg.t === 'lanternGone' ? 'lanternGone' : msg.t;
    const handler = (this.handlers as Record<string, unknown>)[key];
    if (!handler) {
      if (msg.t !== 'snap' && msg.t !== 'welcome' && this.backlog.length < 500) this.backlog.push(msg);
      return;
    }
    switch (msg.t) {
      case 'join':
        this.handlers.join?.(msg.player);
        break;
      case 'leave':
        this.handlers.leave?.(msg.id);
        break;
      case 'rename':
        this.handlers.rename?.(msg.id, msg.name);
        break;
      case 'snap':
        this.handlers.snapshot?.(msg.players);
        break;
      case 'chat':
        this.handlers.chat?.(msg.id, msg.name, msg.text);
        break;
      case 'mats':
        this.handlers.mats?.(msg.mats);
        break;
      case 'lanterns':
        this.handlers.lanterns?.(msg.lanterns);
        break;
      case 'lantern':
        this.handlers.lantern?.(msg.lantern);
        break;
      case 'lanternGone':
        this.handlers.lanternGone?.(msg.id);
        break;
      case 'correct':
        this.handlers.correct?.(msg.x, msg.y, msg.z);
        break;
      case 'word':
        this.handlers.word?.(msg.word);
        break;
      default:
        break;
    }
  }

  /** First connection. Resolves on welcome; rejects if refused or unreachable. */
  connect(): Promise<Welcome> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        this.closedByUser = true;
        this.ws?.close();
        reject(new JoinRefused('unreachable', '서버에 연결할 수 없어요.'));
      }, CONNECT_TIMEOUT_MS);

      this.open({
        onWelcome: (w) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          resolve(w);
        },
        onFail: (err) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          this.closedByUser = true;
          reject(err);
        },
      });
    });
  }

  private open(first?: { onWelcome: (w: Welcome) => void; onFail: (e: JoinRefused) => void }): void {
    this.setStatus(this.everWelcomed ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      first?.onFail(new JoinRefused('unreachable', '서버 주소가 올바르지 않아요.'));
      return;
    }
    this.ws = ws;
    let refusal: JoinRefused | null = null;

    ws.onopen = () => {
      this.raw({
        t: 'hello',
        v: PROTOCOL_VERSION,
        nickname: this.nickname,
        ...(this.testDate ? { testDate: this.testDate } : {}),
        ...(this.testClient ? { test: true } : {}),
      });
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      switch (msg.t) {
        case 'welcome': {
          this.attempt = 0;
          this.everWelcomed = true;
          this.id = msg.id;
          this.name = msg.name;
          const w: Welcome = {
            id: msg.id,
            name: msg.name,
            seed: msg.seed,
            players: msg.players ?? [],
            mats: msg.mats ?? [],
            word: msg.word ?? null,
            account: msg.account ?? null,
            guest: msg.guest ?? !msg.account,
          };
          this.setStatus('online');
          if (first) first.onWelcome(w);
          this.handlers.welcome?.(w);
          break;
        }
        case 'join':
        case 'leave':
          this.dispatch(msg);
          break;
        case 'rename':
          if (typeof msg.id === 'string' && typeof msg.name === 'string') this.dispatch(msg);
          break;
        case 'snap':
          if (Array.isArray(msg.players)) this.dispatch(msg);
          break;
        case 'chat':
          this.dispatch(msg);
          break;
        case 'mats':
          if (Array.isArray(msg.mats)) this.dispatch(msg);
          break;
        case 'lanterns':
          if (Array.isArray(msg.lanterns)) this.dispatch(msg);
          break;
        case 'lantern':
          if (msg.lantern && typeof msg.lantern.id === 'number') this.dispatch(msg);
          break;
        case 'lanternGone':
          if (typeof msg.id === 'number') this.dispatch(msg);
          break;
        case 'correct':
          if ([msg.x, msg.y, msg.z].every((v) => typeof v === 'number' && Number.isFinite(v))) this.dispatch(msg);
          break;
        case 'word':
          if (msg.word && typeof msg.word.text === 'string') this.dispatch(msg);
          break;
        case 'error':
          if (msg.code === 'bad_nickname' || msg.code === 'full' || msg.code === 'version' || msg.code === 'name_taken') {
            refusal = new JoinRefused(msg.code, msg.message);
          }
          this.handlers.error?.(msg.code, msg.message);
          break;
      }
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (first && !this.everWelcomed) {
        first.onFail(refusal ?? new JoinRefused('unreachable', '서버에 연결할 수 없어요.'));
        return;
      }
      if (this.closedByUser || FATAL_CLOSE.has(event.code)) {
        this.setStatus('closed');
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.setStatus('reconnecting');
    const delay = Math.min(10_000, 1000 * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
    this.attempt = Math.min(this.attempt + 1, 6);
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.open(), delay);
  }

  /** Reconnect right away (e.g. when a phone comes back to the tab). */
  nudge(): void {
    if (this.status === 'reconnecting' && !this.ws) {
      window.clearTimeout(this.retryTimer);
      this.open();
    }
  }

  private setStatus(status: NetStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.handlers.status?.(status);
  }

  private raw(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  get online(): boolean {
    return this.status === 'online';
  }

  sendState(s: StatePayload): void {
    this.raw({ t: 'state', x: s.x, y: s.y, z: s.z, yaw: s.yaw, speed: s.speed, ...(s.inside ? { inside: true } : {}) });
  }

  sendChat(text: string): void {
    this.raw({ t: 'chat', text });
  }

  sit(mat: number): void {
    this.raw({ t: 'sit', mat });
  }

  stand(): void {
    this.raw({ t: 'stand' });
  }

  close(): void {
    this.closedByUser = true;
    window.clearTimeout(this.retryTimer);
    this.ws?.close(1000);
    this.ws = null;
  }
}
