import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import { FOOTPRINT_KEEP_DAYS, kstDateOf, SHOT_MAX_BYTES, SHOT_MAX_DIM, SHOTS_PER_DAY, cleanText } from '../../shared/protocol.js';
import type { DB } from './db.js';
import { HttpError } from './http.js';

const DAY_MS = 86_400_000;

export type ShotMime = 'image/webp' | 'image/jpeg';

/** Width and height from the file's own header (JPEG SOFn or WebP VP8/VP8L/VP8X), or null if it isn't one. */
export function imageInfo(buf: Buffer): { mime: ShotMime; width: number; height: number } | null {
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    if (buf.readUInt32LE(4) + 8 > buf.length + 1) return null;
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') {
      if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
      return { mime: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      if (buf[20] !== 0x2f) return null;
      const b = buf.subarray(21, 25);
      return { mime: 'image/webp', width: 1 + (b[0] | ((b[1] & 0x3f) << 8)), height: 1 + ((b[1] >> 6) | (b[2] << 2) | ((b[3] & 0x0f) << 10)) };
    }
    if (chunk === 'VP8X') return { mime: 'image/webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    return null;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) return null;
      const marker = buf[off + 1];
      if (marker === 0xff) {
        off++;
        continue;
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        off += 2;
        continue;
      }
      const len = buf.readUInt16BE(off + 2);
      if (len < 2) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { mime: 'image/jpeg', height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      if (marker === 0xda || marker === 0xd9) return null;
      off += 2 + len;
    }
    return null;
  }
  return null;
}

/** Raw request body up to `max` bytes (413 beyond). */
export async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > max) throw new HttpError(413, 'too_large', '사진이 너무 커요.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, 'too_large', '사진이 너무 커요.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

interface ShotRow {
  id: number;
  user_id: number;
  file: string;
  kst_date: string;
  place: string;
  mime: ShotMime;
  width: number;
  height: number;
  bytes: number;
  created_at: number;
}

export interface ShotInfo {
  id: number;
  date: string;
  place: string;
  width: number;
  height: number;
  bytes: number;
  createdAt: string;
  url: string;
  /** In a published diary (kept with it instead of the 30-day 파기). */
  inDiary: boolean;
}

/**
 * 📸 In-world screenshots: validated images (magic bytes, header dimensions,
 * size) stored as files with random names under `<data dir>/screenshots`, one
 * row each. Only the owner may fetch a photo until it is part of a published
 * diary; then the diary's visibility decides (see LibraryService.canSeeShot).
 */
export class ShotService {
  now: () => number = () => Date.now();
  readonly dir: string;

  constructor(
    private readonly db: DB,
    dir: string,
  ) {
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true });
  }

  private path(file: string): string {
    if (!/^[0-9a-f]{32}\.(webp|jpg)$/.test(file)) throw new Error('bad shot file name');
    return resolve(this.dir, file);
  }

  private info(r: ShotRow & { in_diary?: number }): ShotInfo {
    return {
      id: r.id,
      date: r.kst_date,
      place: r.place,
      width: r.width,
      height: r.height,
      bytes: r.bytes,
      createdAt: new Date(r.created_at).toISOString(),
      url: `/api/shots/${r.id}`,
      inDiary: !!r.in_diary,
    };
  }

  usedToday(userId: number, date = kstDateOf(this.now())): number {
    return (this.db.prepare('SELECT count FROM shot_days WHERE user_id = ? AND kst_date = ?').get(userId, date) as { count: number } | undefined)?.count ?? 0;
  }

  upload(userId: number, buf: Buffer, contentType: string, rawPlace: unknown): ShotInfo {
    if (buf.length < 64) throw new HttpError(400, 'bad_image', '사진 파일이 올바르지 않아요.');
    if (buf.length > SHOT_MAX_BYTES) throw new HttpError(413, 'too_large', '사진이 너무 커요.');
    const img = imageInfo(buf);
    if (!img) throw new HttpError(400, 'bad_image', 'WebP나 JPEG 사진만 올릴 수 있어요.');
    if (contentType !== img.mime) throw new HttpError(400, 'bad_image', '사진 형식이 맞지 않아요.');
    if (img.width < 16 || img.height < 16 || img.width > SHOT_MAX_DIM || img.height > SHOT_MAX_DIM) {
      throw new HttpError(400, 'bad_size', `사진은 ${SHOT_MAX_DIM}px 이하여야 해요.`);
    }
    const now = this.now();
    const date = kstDateOf(now);
    if (this.usedToday(userId, date) >= SHOTS_PER_DAY) throw new HttpError(429, 'too_many', `사진은 하루에 ${SHOTS_PER_DAY}장까지 찍을 수 있어요.`);
    const place = typeof rawPlace === 'string' ? cleanText(rawPlace).slice(0, 20) : '';
    const file = `${randomBytes(16).toString('hex')}.${img.mime === 'image/webp' ? 'webp' : 'jpg'}`;
    writeFileSync(this.path(file), buf, { mode: 0o600 });
    try {
      const id = this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO shot_days (user_id, kst_date, count) VALUES (?, ?, 1)
             ON CONFLICT (user_id, kst_date) DO UPDATE SET count = count + 1`,
          )
          .run(userId, date);
        const info = this.db
          .prepare('INSERT INTO screenshots (user_id, file, kst_date, place, mime, width, height, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(userId, file, date, place, img.mime, img.width, img.height, buf.length, now);
        return Number(info.lastInsertRowid);
      })();
      return this.get(userId, id)!;
    } catch (err) {
      rmSync(this.path(file), { force: true });
      throw err;
    }
  }

  get(userId: number, id: number): ShotInfo | null {
    const r = this.db
      .prepare('SELECT s.*, EXISTS (SELECT 1 FROM diary_photos p WHERE p.shot_id = s.id) AS in_diary FROM screenshots s WHERE s.id = ? AND s.user_id = ?')
      .get(id, userId) as (ShotRow & { in_diary: number }) | undefined;
    return r ? this.info(r) : null;
  }

  /** My photos (newest first), optionally one KST day. */
  list(userId: number, date?: string): ShotInfo[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, EXISTS (SELECT 1 FROM diary_photos p WHERE p.shot_id = s.id) AS in_diary FROM screenshots s
         WHERE s.user_id = ? ${date ? 'AND s.kst_date = ?' : ''} ORDER BY s.created_at DESC LIMIT 200`,
      )
      .all(...(date ? [userId, date] : [userId])) as (ShotRow & { in_diary: number })[];
    return rows.map((r) => this.info(r));
  }

  /** Owner check plus file bytes (the caller decides who may see it). */
  row(id: number): ShotRow | null {
    return (this.db.prepare('SELECT * FROM screenshots WHERE id = ?').get(id) as ShotRow | undefined) ?? null;
  }

  read(r: ShotRow): Buffer | null {
    const p = this.path(r.file);
    return existsSync(p) ? readFileSync(p) : null;
  }

  delete(userId: number, id: number) {
    const r = this.db.prepare('SELECT * FROM screenshots WHERE id = ? AND user_id = ?').get(id, userId) as ShotRow | undefined;
    if (!r) throw new HttpError(404, 'not_found', '사진을 찾을 수 없어요.');
    this.db.prepare('DELETE FROM screenshots WHERE id = ?').run(id);
    rmSync(this.path(r.file), { force: true });
  }

  /** Files of one account (회원 탈퇴 removes them after the rows are gone). */
  files(userId: number): string[] {
    return (this.db.prepare('SELECT file FROM screenshots WHERE user_id = ?').all(userId) as { file: string }[]).map((r) => r.file);
  }

  removeFiles(files: string[]) {
    for (const f of files) rmSync(this.path(f), { force: true });
  }

  /** Hourly 파기: photos older than FOOTPRINT_KEEP_DAYS that no published diary uses. */
  sweep(now = this.now()): number {
    const rows = this.db
      .prepare('SELECT id, file FROM screenshots s WHERE s.created_at < ? AND NOT EXISTS (SELECT 1 FROM diary_photos p WHERE p.shot_id = s.id)')
      .all(now - FOOTPRINT_KEEP_DAYS * DAY_MS) as { id: number; file: string }[];
    const del = this.db.prepare('DELETE FROM screenshots WHERE id = ?');
    this.db.transaction(() => rows.forEach((r) => del.run(r.id)))();
    this.removeFiles(rows.map((r) => r.file));
    // Old per-day counters (photos, stories) are only needed for today.
    this.db.prepare('DELETE FROM shot_days WHERE kst_date < ?').run(kstDateOf(now - 2 * DAY_MS));
    this.db.prepare('DELETE FROM story_days WHERE kst_date < ?').run(kstDateOf(now - 2 * DAY_MS));
    return rows.length;
  }

  /** 내 데이터 내려받기: metadata and the image itself (base64 data URL). */
  export(userId: number) {
    const rows = this.db.prepare('SELECT * FROM screenshots WHERE user_id = ? ORDER BY created_at').all(userId) as ShotRow[];
    return rows.map((r) => {
      const data = this.read(r);
      return {
        id: r.id,
        date: r.kst_date,
        place: r.place,
        type: r.mime,
        width: r.width,
        height: r.height,
        bytes: r.bytes,
        createdAt: new Date(r.created_at).toISOString(),
        image: data ? `data:${r.mime};base64,${data.toString('base64')}` : null,
      };
    });
  }
}
