import { randomInt } from 'node:crypto';
import {
  cleanMultiline,
  cleanText,
  GROUP_CHAT_DAYS,
  GROUP_CHAT_MAX,
  type GroupMessage,
  DATE_RE,
  LANTERN_SLOTS,
  REACTION_TYPES,
  ANONYMOUS_NAME,
  seoulDate,
  type LanternDetail,
  type LanternInfo,
  type ReactionType,
  type WordPassage,
} from '../../shared/protocol.js';
import type { DailyWord } from './dailyWord.js';
import type { DB } from './db.js';
import { HttpError } from './http.js';

const DAY_MS = 86_400_000;
/** Lanterns stay on the hill this long. */
export const LANTERN_DAYS = 7;
export const LANTERN_CAP = 120;
const TEXT_MAX = 2000;
const PLACES = ['골방', '기도의 뜰'] as const;

function text(v: unknown, field: string): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, 'bad_field', `${field} 형식이 올바르지 않아요.`);
  const t = v.replace(/\r\n/g, '\n').trim();
  if ([...t].length > TEXT_MAX) throw new HttpError(400, 'too_long', `${TEXT_MAX}자까지 적을 수 있어요.`);
  return t;
}

function validDate(v: unknown, testMode: boolean): string {
  if (typeof v !== 'string' || !DATE_RE.test(v)) throw new HttpError(400, 'bad_date', '날짜가 올바르지 않아요.');
  const t = Date.parse(`${v}T00:00:00+09:00`);
  if (!Number.isFinite(t) || new Date(t + 9 * 3600_000).toISOString().slice(0, 10) !== v) {
    throw new HttpError(400, 'bad_date', '날짜가 올바르지 않아요.');
  }
  // No future pages (a day of slack for clock skew); tests may use any date.
  if (!testMode && t > Date.parse(`${seoulDate()}T00:00:00+09:00`) + DAY_MS) throw new HttpError(400, 'bad_date', '아직 오지 않은 날이에요.');
  if (t < Date.parse('2020-01-01T00:00:00+09:00')) throw new HttpError(400, 'bad_date', '날짜가 올바르지 않아요.');
  return v;
}

export interface MeditationRow {
  id: number;
  user_id: number;
  date: string;
  place: string;
  meditation: string;
  feeling: string;
  application: string;
  created_at: number;
  updated_at: number;
}

const meditationOut = (m: MeditationRow & { lantern_id?: number | null }) => ({
  id: m.id,
  date: m.date,
  place: m.place,
  meditation: m.meditation,
  feeling: m.feeling,
  application: m.application,
  createdAt: new Date(m.created_at).toISOString(),
  updatedAt: new Date(m.updated_at).toISOString(),
  lanternId: m.lantern_id ?? null,
});

// =============================================================================
// 나의 말씀 책
// =============================================================================

export class WordBookService {
  constructor(
    private readonly db: DB,
    private readonly daily: DailyWord | null,
    private readonly testMode: boolean,
  ) {}

  private wordFor(date: string): WordPassage {
    if (!this.daily) throw new HttpError(503, 'no_word', '말씀 데이터를 불러오지 못했어요.');
    return this.daily.forDate(date);
  }

  /** The verse always comes from the server's own data, never from the client. */
  ensurePage(userId: number, dateRaw: unknown): string {
    const date = validDate(dateRaw, this.testMode);
    this.db
      .prepare('INSERT OR IGNORE INTO wordbook_pages (user_id, date, word_json, created_at) VALUES (?, ?, ?, ?)')
      .run(userId, date, JSON.stringify(this.wordFor(date)), Date.now());
    return date;
  }

  list(userId: number) {
    const pages = this.db
      .prepare('SELECT date, word_json FROM wordbook_pages WHERE user_id = ? ORDER BY date DESC')
      .all(userId) as { date: string; word_json: string }[];
    const meds = this.db
      .prepare(
        `SELECT m.*, (SELECT l.id FROM lanterns l WHERE l.meditation_id = m.id AND l.removed_at IS NULL ORDER BY l.id DESC LIMIT 1) AS lantern_id
         FROM meditations m WHERE m.user_id = ? ORDER BY m.created_at`,
      )
      .all(userId) as (MeditationRow & { lantern_id: number | null })[];
    const byDate = new Map<string, ReturnType<typeof meditationOut>[]>();
    for (const m of meds) {
      if (!byDate.has(m.date)) byDate.set(m.date, []);
      byDate.get(m.date)!.push(meditationOut(m));
    }
    const saved = this.db
      .prepare('SELECT lantern_id, snapshot_json, created_at FROM saved_lanterns WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as { lantern_id: number; snapshot_json: string; created_at: number }[];
    return {
      pages: pages.map((p) => ({ date: p.date, word: JSON.parse(p.word_json) as WordPassage, meditations: byDate.get(p.date) ?? [] })),
      saved: saved.map((s) => ({ lanternId: s.lantern_id, savedAt: new Date(s.created_at).toISOString(), ...JSON.parse(s.snapshot_json) })),
    };
  }

  private fields(body: Record<string, unknown>) {
    const f = { meditation: text(body.meditation, '묵상'), feeling: text(body.feeling, '느낀 점'), application: text(body.application, '적용') };
    if (!f.meditation && !f.feeling && !f.application) throw new HttpError(400, 'empty', '한 줄이라도 적어 주세요.');
    return f;
  }

  addMeditation(userId: number, body: Record<string, unknown>) {
    const date = this.ensurePage(userId, body.date);
    const place = body.place;
    if (typeof place !== 'string' || !(PLACES as readonly string[]).includes(place)) throw new HttpError(400, 'bad_place', '장소가 올바르지 않아요.');
    const f = this.fields(body);
    const count = (this.db.prepare('SELECT COUNT(*) c FROM meditations WHERE user_id = ? AND date = ?').get(userId, date) as { c: number }).c;
    if (count >= 50) throw new HttpError(429, 'too_many', '하루에 너무 많이 적었어요.');
    const now = Date.now();
    const info = this.db
      .prepare('INSERT INTO meditations (user_id, date, place, meditation, feeling, application, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(userId, date, place, f.meditation, f.feeling, f.application, now, now);
    return this.get(userId, Number(info.lastInsertRowid));
  }

  /** Owner-only read: other users get "not found", never the content. */
  get(userId: number, id: number) {
    const m = this.db.prepare('SELECT * FROM meditations WHERE id = ? AND user_id = ?').get(id, userId) as MeditationRow | undefined;
    if (!m) throw new HttpError(404, 'not_found', '묵상을 찾을 수 없어요.');
    return meditationOut(m);
  }

  update(userId: number, id: number, body: Record<string, unknown>) {
    this.get(userId, id);
    const f = this.fields(body);
    this.db
      .prepare('UPDATE meditations SET meditation = ?, feeling = ?, application = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(f.meditation, f.feeling, f.application, Date.now(), id, userId);
    return this.get(userId, id);
  }

  /** Deleting a meditation also takes down any lantern made from it. Returns removed lantern ids. */
  delete(userId: number, id: number): number[] {
    this.get(userId, id);
    const lanterns = this.db
      .prepare('SELECT id FROM lanterns WHERE meditation_id = ? AND user_id = ? AND removed_at IS NULL')
      .all(id, userId) as { id: number }[];
    this.db.transaction(() => {
      this.db.prepare('UPDATE lanterns SET removed_at = ? WHERE meditation_id = ? AND user_id = ? AND removed_at IS NULL').run(Date.now(), id, userId);
      this.db.prepare('DELETE FROM meditations WHERE id = ? AND user_id = ?').run(id, userId);
    })();
    return lanterns.map((l) => l.id);
  }

  /** One-time import of the M3 localStorage book. Idempotent via client ids. */
  import(userId: number, body: Record<string, unknown>) {
    const pages = body.pages;
    if (!Array.isArray(pages) || pages.length > 400) throw new HttpError(400, 'bad_import', '가져올 내용이 올바르지 않아요.');
    let pagesAdded = 0;
    let meditationsAdded = 0;
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO meditations (user_id, date, place, meditation, feeling, application, client_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      for (const p of pages) {
        if (typeof p !== 'object' || p === null) continue;
        const page = p as Record<string, unknown>;
        let date: string;
        try {
          date = validDate(page.date, this.testMode);
        } catch {
          continue;
        }
        const before = this.db.prepare('SELECT 1 FROM wordbook_pages WHERE user_id = ? AND date = ?').get(userId, date);
        this.ensurePage(userId, date);
        if (!before) pagesAdded++;
        const meds = Array.isArray(page.meditations) ? page.meditations.slice(0, 50) : [];
        for (const raw of meds) {
          if (typeof raw !== 'object' || raw === null) continue;
          const m = raw as Record<string, unknown>;
          const place = typeof m.place === 'string' && (PLACES as readonly string[]).includes(m.place) ? m.place : '골방';
          let f: { meditation: string; feeling: string; application: string };
          try {
            f = this.fields(m);
          } catch {
            continue;
          }
          const clientId = typeof m.id === 'string' && m.id.length <= 64 ? `local:${m.id}` : null;
          const created = typeof m.createdAt === 'string' && Number.isFinite(Date.parse(m.createdAt)) ? Date.parse(m.createdAt) : Date.now();
          const r = insert.run(userId, date, place, f.meditation, f.feeling, f.application, clientId, created, created);
          meditationsAdded += r.changes;
        }
      }
    })();
    return { pagesAdded, meditationsAdded };
  }
}

// =============================================================================
// 모임 (groups)
// =============================================================================

/** No 0/O, 1/I/L: easy to read aloud and type. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export class GroupService {
  constructor(private readonly db: DB) {}

  private newCode(): string {
    for (let attempt = 0; attempt < 20; attempt++) {
      let code = '';
      for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.db.prepare('SELECT 1 FROM groups WHERE code = ?').get(code)) return code;
    }
    throw new HttpError(500, 'code', '잠시 후 다시 시도해 주세요.');
  }

  list(userId: number) {
    return (
      this.db
        .prepare(
          `SELECT g.id, g.name, g.code, g.owner_id, (SELECT COUNT(*) FROM group_members m2 WHERE m2.group_id = g.id) AS members
           FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY m.joined_at`,
        )
        .all(userId) as { id: number; name: string; code: string; owner_id: number; members: number }[]
    ).map((g) => ({ id: g.id, name: g.name, code: g.code, members: g.members, owner: g.owner_id === userId }));
  }

  groupIds(userId: number): Set<number> {
    return new Set((this.db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(userId) as { group_id: number }[]).map((r) => r.group_id));
  }

  info(groupId: number): { id: number; name: string; ownerId: number } | null {
    const g = this.db.prepare('SELECT id, name, owner_id FROM groups WHERE id = ?').get(groupId) as { id: number; name: string; owner_id: number } | undefined;
    return g ? { id: g.id, name: g.name, ownerId: g.owner_id } : null;
  }

  isMember(userId: number, groupId: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM group_members WHERE user_id = ? AND group_id = ?').get(userId, groupId);
  }

  create(userId: number, nameRaw: unknown) {
    const name = typeof nameRaw === 'string' ? cleanText(nameRaw) : '';
    if ([...name].length < 1 || [...name].length > 20) throw new HttpError(400, 'bad_name', '모임 이름은 1~20자로 정해 주세요.');
    if (this.list(userId).length >= 20) throw new HttpError(429, 'too_many', '모임은 20개까지 함께할 수 있어요.');
    const now = Date.now();
    const id = this.db.transaction(() => {
      const info = this.db.prepare('INSERT INTO groups (name, code, owner_id, created_at) VALUES (?, ?, ?, ?)').run(name, this.newCode(), userId, now);
      const gid = Number(info.lastInsertRowid);
      this.db.prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)').run(gid, userId, now);
      return gid;
    })();
    return this.list(userId).find((g) => g.id === id)!;
  }

  join(userId: number, codeRaw: unknown) {
    const code = typeof codeRaw === 'string' ? codeRaw.toUpperCase().replace(/[\s-]/g, '') : '';
    if (!/^[A-Z0-9]{6}$/.test(code)) throw new HttpError(400, 'bad_code', '모임 코드는 6자리예요.');
    const g = this.db.prepare('SELECT id FROM groups WHERE code = ?').get(code) as { id: number } | undefined;
    if (!g) throw new HttpError(404, 'no_group', '그런 모임 코드를 찾지 못했어요.');
    if (this.list(userId).length >= 20) throw new HttpError(429, 'too_many', '모임은 20개까지 함께할 수 있어요.');
    this.db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)').run(g.id, userId, Date.now());
    return this.list(userId).find((x) => x.id === g.id)!;
  }

  leave(userId: number, groupId: number) {
    const r = this.db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(groupId, userId);
    if (!r.changes) throw new HttpError(404, 'no_group', '함께하는 모임이 아니에요.');
  }
}

// =============================================================================
// 등불 (lanterns) and reactions
// =============================================================================

interface LanternRow {
  id: number;
  user_id: number;
  meditation_id: number | null;
  group_id: number | null;
  slot: number;
  date: string;
  ref: string;
  verse: string;
  translation: string;
  meditation: string;
  feeling: string;
  application: string;
  created_at: number;
  removed_at: number | null;
  anonymous: number;
  nickname: string;
  group_name: string | null;
}

const SELECT_LANTERN = `SELECT l.*, u.nickname AS nickname, g.name AS group_name
  FROM lanterns l JOIN users u ON u.id = l.user_id LEFT JOIN groups g ON g.id = l.group_id`;

export class LanternService {
  constructor(
    private readonly db: DB,
    private readonly groups: GroupService,
  ) {}

  private since(): number {
    return Date.now() - LANTERN_DAYS * DAY_MS;
  }

  private row(id: number): LanternRow | undefined {
    return this.db.prepare(`${SELECT_LANTERN} WHERE l.id = ?`).get(id) as LanternRow | undefined;
  }

  /** Server-side visibility rule: public, or private to a group the viewer belongs to. */
  private visibleTo(l: Pick<LanternRow, 'group_id'>, viewerId: number | null, viewerGroups?: Set<number>): boolean {
    if (l.group_id === null) return true;
    if (viewerId === null) return false;
    return (viewerGroups ?? this.groups.groupIds(viewerId)).has(l.group_id);
  }

  private active(l: LanternRow): boolean {
    return l.removed_at === null && l.created_at >= this.since();
  }

  private counts(id: number): Record<ReactionType, number> {
    const c: Record<ReactionType, number> = { amen: 0, pray: 0, record: 0 };
    for (const r of this.db.prepare('SELECT type, COUNT(*) n FROM reactions WHERE lantern_id = ? GROUP BY type').all(id) as { type: ReactionType; n: number }[]) {
      c[r.type] = r.n;
    }
    return c;
  }

  private info(l: LanternRow, viewerId: number | null): LanternInfo {
    const mine = viewerId !== null && l.user_id === viewerId;
    // Anonymous: only the author ever sees their own name; user_id never leaves the server.
    const anonymous = l.anonymous === 1;
    return {
      id: l.id,
      slot: l.slot,
      nickname: anonymous && !mine ? ANONYMOUS_NAME : l.nickname,
      anonymous,
      date: l.date,
      ref: l.ref,
      group: l.group_id === null ? null : (l.group_name ?? '모임'),
      counts: this.counts(l.id),
      mine,
    };
  }

  /** Recent lanterns this viewer may see (guests: public only). */
  listFor(viewerId: number | null, viewerGroups?: Set<number>): LanternInfo[] {
    const rows = this.db
      .prepare(`${SELECT_LANTERN} WHERE l.removed_at IS NULL AND l.created_at >= ? ORDER BY l.created_at DESC LIMIT 400`)
      .all(this.since()) as LanternRow[];
    const groups = viewerGroups ?? (viewerId !== null ? this.groups.groupIds(viewerId) : new Set<number>());
    return rows.filter((l) => this.visibleTo(l, viewerId, groups)).slice(0, LANTERN_CAP).map((l) => this.info(l, viewerId));
  }

  /** Info for one viewer, or null if they may not see it (used for live pushes). */
  infoFor(id: number, viewerId: number | null, viewerGroups?: Set<number>): LanternInfo | null {
    const l = this.row(id);
    if (!l || !this.active(l) || !this.visibleTo(l, viewerId, viewerGroups)) return null;
    return this.info(l, viewerId);
  }

  /** Who could see a lantern regardless of removal (to tell them it's gone). */
  couldSee(id: number, viewerId: number | null, viewerGroups?: Set<number>): boolean {
    const l = this.row(id);
    return !!l && this.visibleTo(l, viewerId, viewerGroups);
  }

  detail(id: number, viewerId: number | null): LanternDetail {
    const l = this.row(id);
    // Same response for "missing" and "not allowed": no existence leak.
    if (!l || !this.active(l) || !this.visibleTo(l, viewerId)) throw new HttpError(404, 'not_found', '등불을 찾을 수 없어요.');
    const mine =
      viewerId === null
        ? []
        : ((this.db.prepare('SELECT type FROM reactions WHERE lantern_id = ? AND user_id = ?').all(id, viewerId) as { type: ReactionType }[]).map((r) => r.type));
    return {
      ...this.info(l, viewerId),
      verse: l.verse,
      translation: l.translation,
      meditation: l.meditation,
      feeling: l.feeling,
      application: l.application,
      createdAt: new Date(l.created_at).toISOString(),
      myReactions: mine,
    };
  }

  create(userId: number, body: Record<string, unknown>): number {
    const meditationId = Number(body.meditationId);
    if (!Number.isInteger(meditationId)) throw new HttpError(400, 'bad_field', '묵상을 골라 주세요.');
    const m = this.db.prepare('SELECT * FROM meditations WHERE id = ? AND user_id = ?').get(meditationId, userId) as MeditationRow | undefined;
    if (!m) throw new HttpError(404, 'not_found', '묵상을 찾을 수 없어요.');
    let groupId: number | null = null;
    if (body.visibility === 'group') {
      groupId = Number(body.groupId);
      if (!Number.isInteger(groupId) || !this.groups.isMember(userId, groupId)) throw new HttpError(403, 'not_member', '함께하는 모임에만 나눌 수 있어요.');
    } else if (body.visibility !== 'public') {
      throw new HttpError(400, 'bad_field', '공개 범위를 골라 주세요.');
    }
    // 익명 is offered for public lanterns only.
    const anonymous = groupId === null && body.anonymous === true ? 1 : 0;
    const existing = this.db.prepare('SELECT id FROM lanterns WHERE meditation_id = ? AND removed_at IS NULL AND created_at >= ?').get(meditationId, this.since());
    if (existing) throw new HttpError(409, 'exists', '이미 등불로 나눈 묵상이에요.');
    const today = (this.db.prepare('SELECT COUNT(*) n FROM lanterns WHERE user_id = ? AND created_at >= ?').get(userId, Date.now() - DAY_MS) as { n: number }).n;
    if (today >= 10) throw new HttpError(429, 'too_many', '하루에 등불은 10개까지 밝힐 수 있어요.');
    const page = this.db.prepare('SELECT word_json FROM wordbook_pages WHERE user_id = ? AND date = ?').get(userId, m.date) as { word_json: string } | undefined;
    if (!page) throw new HttpError(400, 'no_page', '말씀을 찾을 수 없어요.');
    const word = JSON.parse(page.word_json) as WordPassage;

    return this.db.transaction(() => {
      // Stable, non-overlapping spot: lowest slot not held by an active lantern.
      const used = new Set(
        (this.db.prepare('SELECT slot FROM lanterns WHERE removed_at IS NULL AND created_at >= ?').all(this.since()) as { slot: number }[]).map((r) => r.slot),
      );
      let slot = -1;
      for (let i = 0; i < LANTERN_SLOTS.length; i++) {
        if (!used.has(i)) {
          slot = i;
          break;
        }
      }
      if (slot < 0) throw new HttpError(409, 'hill_full', '등불 언덕이 가득 찼어요. 내일 다시 밝혀 주세요.');
      const info = this.db
        .prepare(
          `INSERT INTO lanterns (user_id, meditation_id, group_id, slot, date, ref, verse, translation, meditation, feeling, application, created_at, anonymous)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(userId, m.id, groupId, slot, m.date, word.ref, word.text, word.translation || '개역한글판', m.meditation, m.feeling, m.application, Date.now(), anonymous);
      return Number(info.lastInsertRowid);
    })();
  }

  remove(userId: number, id: number) {
    const r = this.db.prepare('UPDATE lanterns SET removed_at = ? WHERE id = ? AND user_id = ? AND removed_at IS NULL').run(Date.now(), id, userId);
    if (!r.changes) throw new HttpError(404, 'not_found', '내 등불만 내릴 수 있어요.');
  }

  /** Toggle one reaction. 기록하기 also keeps a snapshot in the viewer's word book. */
  toggle(userId: number, id: number, typeRaw: unknown) {
    if (typeof typeRaw !== 'string' || !(REACTION_TYPES as readonly string[]).includes(typeRaw)) throw new HttpError(400, 'bad_type', '반응 종류가 올바르지 않아요.');
    const type = typeRaw as ReactionType;
    const d = this.detail(id, userId); // enforces visibility
    const has = d.myReactions.includes(type);
    this.db.transaction(() => {
      if (has) {
        this.db.prepare('DELETE FROM reactions WHERE lantern_id = ? AND user_id = ? AND type = ?').run(id, userId, type);
        if (type === 'record') this.db.prepare('DELETE FROM saved_lanterns WHERE user_id = ? AND lantern_id = ?').run(userId, id);
      } else {
        this.db.prepare('INSERT INTO reactions (lantern_id, user_id, type, created_at) VALUES (?, ?, ?, ?)').run(id, userId, type, Date.now());
        if (type === 'record') {
          // d.nickname is already ANONYMOUS_NAME for anonymous lanterns (viewer != author).
          const snapshot = {
            nickname: d.anonymous ? ANONYMOUS_NAME : d.nickname,
            anonymous: d.anonymous,
            date: d.date,
            ref: d.ref,
            verse: d.verse,
            translation: d.translation,
            meditation: d.meditation,
            feeling: d.feeling,
            application: d.application,
          };
          this.db
            .prepare('INSERT OR REPLACE INTO saved_lanterns (user_id, lantern_id, snapshot_json, created_at) VALUES (?, ?, ?, ?)')
            .run(userId, id, JSON.stringify(snapshot), Date.now());
        }
      }
    })();
    return this.detail(id, userId);
  }

  /** Remove a saved snapshot from my book (also clears my 기록하기 mark). */
  unsave(userId: number, id: number) {
    this.db.prepare('DELETE FROM saved_lanterns WHERE user_id = ? AND lantern_id = ?').run(userId, id);
    this.db.prepare("DELETE FROM reactions WHERE lantern_id = ? AND user_id = ? AND type = 'record'").run(id, userId);
  }
}

// =============================================================================
// 모임 채팅 (group text chat): members only, kept 7 days
// =============================================================================

interface MessageRow {
  id: number;
  group_id: number;
  user_id: number | null;
  kind: 'msg' | 'system';
  text: string;
  created_at: number;
  deleted_at: number | null;
  hidden_at: number | null;
  nickname: string | null;
}

const SELECT_MESSAGE = `SELECT m.*, u.nickname AS nickname FROM group_messages m LEFT JOIN users u ON u.id = m.user_id`;

export class GroupChatService {
  constructor(
    private readonly db: DB,
    private readonly groups: GroupService,
  ) {}

  /** Non-members get the same 404 as a missing group. */
  private member(userId: number, groupId: number) {
    if (!Number.isInteger(groupId) || !this.groups.isMember(userId, groupId)) throw new HttpError(404, 'not_found', '모임을 찾을 수 없어요.');
  }

  out(m: MessageRow): GroupMessage {
    const gone = m.deleted_at !== null || m.hidden_at !== null;
    return {
      id: m.id,
      groupId: m.group_id,
      userId: m.user_id,
      nickname: m.kind === 'system' ? '' : (m.nickname ?? '알 수 없음'),
      kind: m.kind,
      text: gone ? '' : m.text,
      createdAt: new Date(m.created_at).toISOString(),
      deleted: m.deleted_at !== null,
      hidden: m.hidden_at !== null,
    };
  }

  get(id: number): GroupMessage | null {
    const m = this.db.prepare(`${SELECT_MESSAGE} WHERE m.id = ?`).get(id) as MessageRow | undefined;
    return m ? this.out(m) : null;
  }

  list(userId: number, groupId: number, before: number | null, limit = 50) {
    this.member(userId, groupId);
    const since = Date.now() - GROUP_CHAT_DAYS * DAY_MS;
    const rows = this.db
      .prepare(`${SELECT_MESSAGE} WHERE m.group_id = ? AND m.created_at >= ? ${before ? 'AND m.id < ?' : ''} ORDER BY m.id DESC LIMIT ?`)
      .all(...(before ? [groupId, since, before, limit + 1] : [groupId, since, limit + 1])) as MessageRow[];
    const hasMore = rows.length > limit;
    return { messages: rows.slice(0, limit).reverse().map((m) => this.out(m)), hasMore };
  }

  post(userId: number, groupId: number, raw: unknown): GroupMessage {
    this.member(userId, groupId);
    const text = typeof raw === 'string' ? cleanMultiline(raw) : '';
    if (!text) throw new HttpError(400, 'empty', '내용을 적어 주세요.');
    if ([...text].length > GROUP_CHAT_MAX) throw new HttpError(400, 'too_long', `${GROUP_CHAT_MAX}자까지 보낼 수 있어요.`);
    const info = this.db
      .prepare("INSERT INTO group_messages (group_id, user_id, kind, text, created_at) VALUES (?, ?, 'msg', ?, ?)")
      .run(groupId, userId, text, Date.now());
    const id = Number(info.lastInsertRowid);
    // Sending counts as reading everything up to it.
    this.markRead(userId, groupId, id);
    return this.get(id)!;
  }

  system(groupId: number, text: string): GroupMessage {
    const info = this.db
      .prepare("INSERT INTO group_messages (group_id, user_id, kind, text, created_at) VALUES (?, NULL, 'system', ?, ?)")
      .run(groupId, text, Date.now());
    return this.get(Number(info.lastInsertRowid))!;
  }

  /** Delete my own message. */
  remove(userId: number, groupId: number, id: number): GroupMessage {
    this.member(userId, groupId);
    const r = this.db
      .prepare("UPDATE group_messages SET deleted_at = ? WHERE id = ? AND group_id = ? AND user_id = ? AND kind = 'msg' AND deleted_at IS NULL")
      .run(Date.now(), id, groupId, userId);
    if (!r.changes) throw new HttpError(404, 'not_found', '내가 보낸 메시지만 지울 수 있어요.');
    return this.get(id)!;
  }

  /** The group creator hides any message in their group. */
  hide(userId: number, groupId: number, id: number): GroupMessage {
    this.member(userId, groupId);
    if (this.groups.info(groupId)?.ownerId !== userId) throw new HttpError(403, 'not_owner', '모임을 만든 분만 가릴 수 있어요.');
    const r = this.db.prepare('UPDATE group_messages SET hidden_at = ? WHERE id = ? AND group_id = ? AND hidden_at IS NULL').run(Date.now(), id, groupId);
    if (!r.changes) throw new HttpError(404, 'not_found', '메시지를 찾을 수 없어요.');
    return this.get(id)!;
  }

  markRead(userId: number, groupId: number, lastId: number): number {
    this.member(userId, groupId);
    const max = (this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM group_messages WHERE group_id = ?').get(groupId) as { m: number }).m;
    const id = Math.max(0, Math.min(Number.isInteger(lastId) ? lastId : max, max));
    this.db
      .prepare(
        `INSERT INTO group_reads (group_id, user_id, last_read_id) VALUES (?, ?, ?)
         ON CONFLICT (group_id, user_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`,
      )
      .run(groupId, userId, id);
    return (this.db.prepare('SELECT last_read_id FROM group_reads WHERE group_id = ? AND user_id = ?').get(groupId, userId) as { last_read_id: number }).last_read_id;
  }

  /** Unread messages from others (not deleted/hidden), per group. */
  unread(userId: number, groupId: number): number {
    const since = Date.now() - GROUP_CHAT_DAYS * DAY_MS;
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM group_messages m
           WHERE m.group_id = ? AND m.created_at >= ? AND m.kind = 'msg' AND (m.user_id IS NULL OR m.user_id != ?)
             AND m.deleted_at IS NULL AND m.hidden_at IS NULL
             AND m.id > COALESCE((SELECT last_read_id FROM group_reads r WHERE r.group_id = m.group_id AND r.user_id = ?), 0)`,
        )
        .get(groupId, since, userId, userId) as { n: number }
    ).n;
  }

  /** Drop messages older than 7 days (hourly). `now` is injectable for tests. */
  purge(now = Date.now()): number {
    return this.db.prepare('DELETE FROM group_messages WHERE created_at < ?').run(now - GROUP_CHAT_DAYS * DAY_MS).changes;
  }
}
