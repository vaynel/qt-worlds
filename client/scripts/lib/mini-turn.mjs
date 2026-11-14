// Minimal TURN server (RFC 5766 subset, UDP, IPv4) for local browser end-to-end tests only.
// Long-term credentials with a single fixed user; no nonce expiry; no rate limiting.
// Never expose this outside 127.0.0.1.
import dgram from 'node:dgram';
import { createHash, createHmac, randomBytes } from 'node:crypto';

const MAGIC = 0x2112a442;
const CLASS = { request: 0x0000, indication: 0x0010, success: 0x0100, error: 0x0110 };
const M = { binding: 0x001, allocate: 0x003, refresh: 0x004, send: 0x006, data: 0x007, createPermission: 0x008, channelBind: 0x009 };
const A = {
  MAPPED: 0x0001,
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  CHANNEL_NUMBER: 0x000c,
  LIFETIME: 0x000d,
  XOR_PEER_ADDRESS: 0x0012,
  DATA: 0x0013,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_TRANSPORT: 0x0019,
  XOR_MAPPED_ADDRESS: 0x0020,
  SOFTWARE: 0x8022,
  FINGERPRINT: 0x8028,
};
const DEFAULT_LIFETIME = 600;
const MAX_LIFETIME = 3600;

// ---------- CRC32 (for FINGERPRINT) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- STUN parse / encode ----------
function isStun(buf) {
  return buf.length >= 20 && (buf[0] & 0xc0) === 0 && buf.readUInt32BE(4) === MAGIC && buf.readUInt16BE(2) + 20 <= buf.length;
}

function parseStun(buf) {
  const type = buf.readUInt16BE(0);
  const len = buf.readUInt16BE(2);
  if (len % 4 !== 0) throw new Error('bad stun length');
  const msg = {
    type,
    method: (type & 0x000f) | ((type & 0x00e0) >> 1) | ((type & 0x3e00) >> 2),
    cls: type & 0x0110,
    tid: buf.subarray(8, 20),
    attrs: [], // { type, value, offset }
    raw: buf.subarray(0, 20 + len),
  };
  let off = 20;
  const end = 20 + len;
  while (off + 4 <= end) {
    const at = buf.readUInt16BE(off);
    const al = buf.readUInt16BE(off + 2);
    if (off + 4 + al > end) throw new Error('attr overflow');
    msg.attrs.push({ type: at, value: buf.subarray(off + 4, off + 4 + al), offset: off });
    off += 4 + al + ((4 - (al % 4)) % 4);
  }
  return msg;
}
const getAttr = (msg, t) => msg.attrs.find((a) => a.type === t);

function encodeXorAddr(ip, port) {
  const b = Buffer.alloc(8);
  b[1] = 0x01;
  b.writeUInt16BE(port ^ (MAGIC >>> 16), 2);
  const parts = ip.split('.').map(Number);
  const v = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  b.writeUInt32BE((v ^ MAGIC) >>> 0, 4);
  return b;
}
function decodeXorAddr(v) {
  if (v.length < 8 || v[1] !== 0x01) return null; // IPv4 only
  const port = v.readUInt16BE(2) ^ (MAGIC >>> 16);
  const a = (v.readUInt32BE(4) ^ MAGIC) >>> 0;
  return { ip: `${a >>> 24}.${(a >>> 16) & 0xff}.${(a >>> 8) & 0xff}.${a & 0xff}`, port };
}

function errorValue(code, reason) {
  const r = Buffer.from(reason, 'utf8');
  const b = Buffer.alloc(4 + r.length);
  b[2] = Math.floor(code / 100);
  b[3] = code % 100;
  r.copy(b, 4);
  return b;
}
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

/** Encode a STUN message. attrs: [[type, Buffer]]; key: long-term key Buffer to add MESSAGE-INTEGRITY. */
function encodeStun(type, tid, attrs, { key, fingerprint = true } = {}) {
  const chunks = [];
  for (const [t, v] of attrs) {
    const h = Buffer.alloc(4);
    h.writeUInt16BE(t, 0);
    h.writeUInt16BE(v.length, 2);
    chunks.push(h, v, Buffer.alloc((4 - (v.length % 4)) % 4));
  }
  let body = Buffer.concat(chunks);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type, 0);
  header.writeUInt32BE(MAGIC, 4);
  tid.copy(header, 8);
  if (key) {
    header.writeUInt16BE(body.length + 24, 2);
    const mac = createHmac('sha1', key).update(Buffer.concat([header, body])).digest();
    const h = Buffer.alloc(4);
    h.writeUInt16BE(A.MESSAGE_INTEGRITY, 0);
    h.writeUInt16BE(20, 2);
    body = Buffer.concat([body, h, mac]);
  }
  if (fingerprint) {
    header.writeUInt16BE(body.length + 8, 2);
    const crc = (crc32(Buffer.concat([header, body])) ^ 0x5354554e) >>> 0;
    const h = Buffer.alloc(8);
    h.writeUInt16BE(A.FINGERPRINT, 0);
    h.writeUInt16BE(4, 2);
    h.writeUInt32BE(crc, 4);
    body = Buffer.concat([body, h]);
  }
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

function checkIntegrity(msg, key) {
  const mi = getAttr(msg, A.MESSAGE_INTEGRITY);
  if (!mi || mi.value.length !== 20) return false;
  const pre = Buffer.from(msg.raw.subarray(0, mi.offset));
  pre.writeUInt16BE(mi.offset - 20 + 24, 2);
  const mac = createHmac('sha1', key).update(pre).digest();
  return mac.equals(mi.value);
}

// ---------- server ----------
export async function startMiniTurn({ port, host = '127.0.0.1', username = 'mock-user', password = 'mock-cred', realm = 'qt.test' } = {}) {
  const key = createHash('md5').update(`${username}:${realm}:${password}`).digest();
  const nonce = randomBytes(12).toString('hex');
  const stats = { allocations: 0, permissions: 0, channels: 0, relayedPackets: 0, authFailures: 0 };
  const allocs = new Map(); // "ip:port" of client -> allocation
  const sock = dgram.createSocket('udp4');
  const software = Buffer.from('mini-turn');

  const send = (buf, addr) => {
    try {
      sock.send(buf, addr.port, addr.ip);
    } catch {
      /* closed */
    }
  };
  const respond = (msg, cls, attrs, addr, authed) =>
    send(encodeStun(msg.method | cls, msg.tid, attrs, { key: authed ? key : undefined }), addr);
  const error = (msg, addr, code, reason, extra = [], authed = false) =>
    respond(msg, CLASS.error, [[A.ERROR_CODE, errorValue(code, reason)], ...extra, [A.SOFTWARE, software]], addr, authed);
  const unauthorized = (msg, addr) =>
    error(msg, addr, 401, 'Unauthorized', [
      [A.REALM, Buffer.from(realm)],
      [A.NONCE, Buffer.from(nonce)],
    ]);

  function freeAlloc(k) {
    const a = allocs.get(k);
    if (!a) return;
    allocs.delete(k);
    clearTimeout(a.timer);
    try {
      a.relay.close();
    } catch {
      /* already closed */
    }
  }
  function armTimer(k, a, lifetime) {
    clearTimeout(a.timer);
    a.timer = setTimeout(() => freeAlloc(k), lifetime * 1000);
    a.timer.unref?.();
  }

  /** Returns true if the request is authenticated; otherwise has already replied. */
  function authenticate(msg, addr) {
    const mi = getAttr(msg, A.MESSAGE_INTEGRITY);
    const user = getAttr(msg, A.USERNAME);
    if (!mi || !user || !getAttr(msg, A.NONCE) || !getAttr(msg, A.REALM)) {
      unauthorized(msg, addr);
      return false;
    }
    if (user.value.toString('utf8') !== username || !checkIntegrity(msg, key)) {
      stats.authFailures++;
      unauthorized(msg, addr);
      return false;
    }
    return true;
  }

  function addPermission(a, ip) {
    if (!a.perms.has(ip)) stats.permissions++;
    a.perms.set(ip, Date.now() + 300000);
  }
  const permitted = (a, ip) => (a.perms.get(ip) ?? 0) > Date.now();

  async function handleAllocate(msg, addr, k) {
    const existing = allocs.get(k);
    if (existing) {
      if (existing.tid.equals(msg.tid)) return send(existing.response, addr);
      return error(msg, addr, 437, 'Allocation Mismatch', [], true);
    }
    const rt = getAttr(msg, A.REQUESTED_TRANSPORT);
    if (!rt) return error(msg, addr, 400, 'Bad Request', [], true);
    if (rt.value[0] !== 17) return error(msg, addr, 442, 'Unsupported Transport Protocol', [], true);
    const relay = dgram.createSocket('udp4');
    const a = { tid: Buffer.from(msg.tid), relay, perms: new Map(), chanByNum: new Map(), chanByPeer: new Map(), client: addr, timer: null, response: null };
    allocs.set(k, a); // reserve before awaiting bind so retransmits hit the resend path
    try {
      await new Promise((res, rej) => {
        relay.once('error', rej);
        relay.bind(0, host, () => {
          relay.off('error', rej);
          res();
        });
      });
    } catch {
      allocs.delete(k);
      return error(msg, addr, 508, 'Insufficient Capacity', [], true);
    }
    relay.on('error', () => {});
    relay.on('message', (data, rinfo) => {
      try {
        if (rinfo.family !== 'IPv4' || !permitted(a, rinfo.address)) return;
        const peerKey = `${rinfo.address}:${rinfo.port}`;
        const ch = a.chanByPeer.get(peerKey);
        let out;
        if (ch !== undefined) {
          out = Buffer.alloc(4 + data.length);
          out.writeUInt16BE(ch, 0);
          out.writeUInt16BE(data.length, 2);
          data.copy(out, 4);
        } else {
          out = encodeStun(
            M.data | CLASS.indication,
            randomBytes(12),
            [
              [A.XOR_PEER_ADDRESS, encodeXorAddr(rinfo.address, rinfo.port)],
              [A.DATA, data],
            ],
            { fingerprint: false },
          );
        }
        stats.relayedPackets++;
        send(out, a.client);
      } catch {
        /* ignore */
      }
    });
    let lifetime = DEFAULT_LIFETIME;
    const lt = getAttr(msg, A.LIFETIME);
    if (lt && lt.value.length >= 4) lifetime = Math.min(MAX_LIFETIME, Math.max(DEFAULT_LIFETIME, lt.value.readUInt32BE(0)));
    armTimer(k, a, lifetime);
    stats.allocations++;
    const rport = relay.address().port;
    a.response = encodeStun(
      msg.method | CLASS.success,
      msg.tid,
      [
        [A.XOR_RELAYED_ADDRESS, encodeXorAddr(host, rport)],
        [A.XOR_MAPPED_ADDRESS, encodeXorAddr(addr.ip, addr.port)],
        [A.LIFETIME, u32(lifetime)],
        [A.SOFTWARE, software],
      ],
      { key },
    );
    send(a.response, addr);
  }

  function handleStun(msg, addr) {
    const k = `${addr.ip}:${addr.port}`;
    if (msg.cls === CLASS.request) {
      if (msg.method === M.binding) {
        return respond(msg, CLASS.success, [[A.XOR_MAPPED_ADDRESS, encodeXorAddr(addr.ip, addr.port)], [A.SOFTWARE, software]], addr, false);
      }
      if (![M.allocate, M.refresh, M.createPermission, M.channelBind].includes(msg.method)) {
        return error(msg, addr, 400, 'Bad Request');
      }
      if (!authenticate(msg, addr)) return;
      if (msg.method === M.allocate) return handleAllocate(msg, addr, k);
      const a = allocs.get(k);
      if (!a) return error(msg, addr, 437, 'Allocation Mismatch', [], true);
      if (msg.method === M.refresh) {
        let lifetime = DEFAULT_LIFETIME;
        const lt = getAttr(msg, A.LIFETIME);
        if (lt && lt.value.length >= 4) lifetime = lt.value.readUInt32BE(0);
        if (lifetime === 0) {
          freeAlloc(k);
        } else {
          lifetime = Math.min(MAX_LIFETIME, Math.max(DEFAULT_LIFETIME, lifetime));
          armTimer(k, a, lifetime);
        }
        return respond(msg, CLASS.success, [[A.LIFETIME, u32(lifetime)], [A.SOFTWARE, software]], addr, true);
      }
      if (msg.method === M.createPermission) {
        const peers = msg.attrs.filter((x) => x.type === A.XOR_PEER_ADDRESS).map((x) => decodeXorAddr(x.value));
        if (!peers.length || peers.some((p) => !p)) return error(msg, addr, 400, 'Bad Request', [], true);
        for (const p of peers) addPermission(a, p.ip);
        return respond(msg, CLASS.success, [[A.SOFTWARE, software]], addr, true);
      }
      if (msg.method === M.channelBind) {
        const cn = getAttr(msg, A.CHANNEL_NUMBER);
        const pa = getAttr(msg, A.XOR_PEER_ADDRESS);
        const peer = pa && decodeXorAddr(pa.value);
        const num = cn && cn.value.length >= 2 ? cn.value.readUInt16BE(0) : -1;
        if (!peer || num < 0x4000 || num > 0x7fff) return error(msg, addr, 400, 'Bad Request', [], true);
        const peerKey = `${peer.ip}:${peer.port}`;
        const boundPeer = a.chanByNum.get(num);
        const boundNum = a.chanByPeer.get(peerKey);
        if ((boundPeer && boundPeer.key !== peerKey) || (boundNum !== undefined && boundNum !== num)) {
          return error(msg, addr, 400, 'Bad Request', [], true);
        }
        if (!boundPeer) stats.channels++;
        a.chanByNum.set(num, { key: peerKey, ip: peer.ip, port: peer.port });
        a.chanByPeer.set(peerKey, num);
        addPermission(a, peer.ip);
        return respond(msg, CLASS.success, [[A.SOFTWARE, software]], addr, true);
      }
    } else if (msg.cls === CLASS.indication && msg.method === M.send) {
      const a = allocs.get(k);
      if (!a) return;
      const pa = getAttr(msg, A.XOR_PEER_ADDRESS);
      const data = getAttr(msg, A.DATA);
      const peer = pa && decodeXorAddr(pa.value);
      if (!peer || !data || !permitted(a, peer.ip)) return;
      a.relay.send(data.value, peer.port, peer.ip);
      stats.relayedPackets++;
    }
    // other classes (responses etc.) are ignored
  }

  function handleChannelData(buf, addr) {
    const a = allocs.get(`${addr.ip}:${addr.port}`);
    if (!a) return;
    const num = buf.readUInt16BE(0);
    const len = buf.readUInt16BE(2);
    if (num < 0x4000 || num > 0x7fff || 4 + len > buf.length) return;
    const peer = a.chanByNum.get(num);
    if (!peer || !permitted(a, peer.ip)) return;
    a.relay.send(buf.subarray(4, 4 + len), peer.port, peer.ip);
    stats.relayedPackets++;
  }

  sock.on('error', () => {});
  sock.on('message', (buf, rinfo) => {
    try {
      if (rinfo.family !== 'IPv4' || buf.length < 4) return;
      const addr = { ip: rinfo.address, port: rinfo.port };
      if ((buf[0] & 0xc0) === 0x40) return handleChannelData(buf, addr);
      if (!isStun(buf)) return;
      const r = handleStun(parseStun(buf), addr);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {
      /* never crash on malformed input */
    }
  });

  await new Promise((res, rej) => {
    sock.once('error', rej);
    sock.bind(port, host, () => {
      sock.off('error', rej);
      res();
    });
  });

  return {
    port: sock.address().port,
    stats,
    close: async () => {
      for (const k of [...allocs.keys()]) freeAlloc(k);
      await new Promise((r) => {
        try {
          sock.close(() => r());
        } catch {
          r();
        }
      });
    },
  };
}
