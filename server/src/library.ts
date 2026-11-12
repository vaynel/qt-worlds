import {
  ANONYMOUS_NAME,
  cleanMultiline,
  cleanText,
  DIARY_LINE_MAX,
  DIARY_LINES_MAX,
  DIARY_NOTE_MAX,
  DIARY_PHOTOS_MAX,
  isShelfId,
  isTestimonyShelf,
  kstDateOf,
  personalInfoKinds,
  SHELF_IDS,
  STORIES_PER_DAY,
  STORY_BODY_MAX,
  STORY_HIDE_REPORTS,
  STORY_PROMPTS,
  STORY_REACTIONS,
  STORY_REPORT_REASONS,
  STORY_TITLE_MAX,
  STORY_VISIBILITIES,
  type ShelfCounts,
  type ShelfId,
  type DiaryLineMeta,
  type StoryDetail,
  type StoryItem,
  type StoryReaction,
  type StoryReportReason,
  type StoryVisibility,
} from '../../shared/protocol.js';
import type { DailyWord } from './dailyWord.js';
import type { DB } from './db.js';
import { diaryLines } from './diary.js';
import type { FootprintService } from './footprints.js';
import { HttpError } from './http.js';
import type { GroupService } from './services.js';
import type { ShotService } from './shots.js';

const DAY_MS = 86_400_000;
export const PAGE_SIZE = 20;
/** Longest 글쓰기 금지 an admin can set (days). */
export const MAX_STORY_BAN_DAYS = 365;

interface StoryRow {
  id: number;
  user_id: number;
  kind: 'testimony' | 'diary';
  shelf: ShelfId;
  title: string;
  parts: string;
  note: string;
  ref: string | null;
  verse: string | null;
  visibility: StoryVisibility;
  group_id: number | null;
  kst_date: string;
  created_at: number;
  updated_at: number;
  hidden_at: number | null;
  review: 'kept' | 'restored' | null;
  reviewed_at: number | null;
  nickname: string | null;
  group_name: string | null;
  readers: number;
  photos: number;
  r_grace: number;
  r_same: number;
  r_pray: number;
  is_read: number;
  is_bookmarked: number;
  line_meta: string | null;
}

/** Everything a list or detail needs, for one viewer (-1 = guest). */
const SELECT = `SELECT s.*, u.nickname AS nickname, g.name AS group_name,
  (SELECT COUNT(*) FROM story_reads r WHERE r.story_id = s.id) AS readers,
  (SELECT COUNT(*) FROM diary_photos p WHERE p.story_id = s.id) AS photos,
  (SELECT COUNT(*) FROM story_reactions x WHERE x.story_id = s.id AND x.type = 'grace') AS r_grace,
  (SELECT COUNT(*) FROM story_reactions x WHERE x.story_id = s.id AND x.type = 'same') AS r_same,
  (SELECT COUNT(*) FROM story_reactions x WHERE x.story_id = s.id AND x.type = 'pray') AS r_pray,
  EXISTS (SELECT 1 FROM story_reads r WHERE r.story_id = s.id AND r.user_id = @viewer) AS is_read,
  EXISTS (SELECT 1 FROM story_bookmarks b WHERE b.story_id = s.id AND b.user_id = @viewer) AS is_bookmarked
  FROM stories s JOIN users u ON u.id = s.user_id LEFT JOIN groups g ON g.id = s.group_id`;

/** Server-side visibility, as SQL: mine, or not hidden and (public | anonymous | my group). */
export const VISIBLE = `(s.user_id = @viewer OR (s.hidden_at IS NULL AND (s.visibility IN ('public', 'anonymous')
  OR (s.visibility = 'group' AND s.group_id IN (SELECT m.group_id FROM group_members m WHERE m.user_id = @viewer)))))`;

const excerptOf = (text: string, n = 80) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return [...t].length > n ? `${[...t].slice(0, n).join('')}…` : t;
};

/** "11월 12일의 일기" */
const diaryTitle = (date: string) => {
  const [, m, d] = date.split('-').map(Number);
  return `${m}월 ${d}일의 일기`;
};

export interface DiaryDraft {
  date: string;
  word: { ref: string; text: string } | null;
  lines: { key: string; minute: number; text: string }[];
  photos: ReturnType<ShotService['list']>;
  existing: StoryDetail | null;
  defaultVisibility: StoryVisibility;
  groups: { id: number; name: string }[];
  footprintsOn: boolean;
}

/**
 * 이야기 도서관: 🙏 나의 하나님 이야기 (testimonies, written by hand) and
 * 📔 오늘의 일기 (one per day, drafted from 발자취 with fixed templates), with
 * 💛 공감, 🔖 책갈피, unique readers, reports (auto-hide), admin review and a
 * writing ban. Visibility is decided here for every list, detail and photo.
 * ✉️ 답장 편지 (L-B) lives in LetterService and asks `book()` here who may see a book.
 */
export class LibraryService {
  now: () => number = () => Date.now();

  constructor(
    private readonly db: DB,
    private readonly groups: GroupService,
    private readonly daily: DailyWord | null,
    private readonly footprints: FootprintService,
    private readonly shots: ShotService,
  ) {}

  private viewer(id: number | null): number {
    return id ?? -1;
  }

  private row(id: number, viewerId: number | null): StoryRow | undefined {
    return this.db.prepare(`${SELECT} WHERE s.id = @id`).get({ id, viewer: this.viewer(viewerId) }) as StoryRow | undefined;
  }

  private visibleTo(s: StoryRow, viewerId: number | null, admin = false): boolean {
    if (admin) return true;
    if (viewerId !== null && s.user_id === viewerId) return true;
    if (s.hidden_at !== null) return false;
    if (s.visibility === 'public' || s.visibility === 'anonymous') return true;
    if (s.visibility === 'group') return viewerId !== null && s.group_id !== null && this.groups.isMember(viewerId, s.group_id);
    return false;
  }

  private parts(s: StoryRow): string[] {
    try {
      const p = JSON.parse(s.parts) as unknown;
      return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private lineMeta(s: StoryRow): (DiaryLineMeta | null)[] | null {
    if (s.kind !== 'diary' || !s.line_meta) return null;
    try {
      const m = JSON.parse(s.line_meta) as unknown;
      return Array.isArray(m) ? m.map((x) => (x && typeof x === 'object' && typeof x.key === 'string' && typeof x.minute === 'number' ? { key: x.key, minute: x.minute } : null)) : null;
    } catch {
      return null;
    }
  }

  private item(s: StoryRow, viewerId: number | null, admin = false): StoryItem {
    const mine = viewerId !== null && s.user_id === viewerId;
    const anonymous = s.visibility === 'anonymous';
    const parts = this.parts(s);
    return {
      id: s.id,
      kind: s.kind,
      shelf: s.shelf,
      title: s.title,
      excerpt: excerptOf([...parts, s.note].filter(Boolean).join(' ')),
      // Anonymous: only the author (and the admin review screen) ever sees the nickname.
      author: anonymous && !mine && !admin ? ANONYMOUS_NAME : (s.nickname ?? '알 수 없음'),
      visibility: s.visibility,
      group: s.visibility === 'group' ? (s.group_name ?? (mine ? '(사라진 모임)' : '모임')) : null,
      date: s.kst_date,
      createdAt: new Date(s.created_at).toISOString(),
      updatedAt: new Date(s.updated_at).toISOString(),
      reactions: { grace: s.r_grace, same: s.r_same, pray: s.r_pray },
      readers: s.readers,
      read: !!s.is_read,
      bookmarked: !!s.is_bookmarked,
      mine,
      hidden: s.hidden_at !== null,
      photos: s.photos,
    };
  }

  private detailOf(s: StoryRow, viewerId: number | null, admin = false): StoryDetail {
    const mine = viewerId !== null && s.user_id === viewerId;
    const myReactions =
      viewerId === null
        ? []
        : (this.db.prepare('SELECT type FROM story_reactions WHERE story_id = ? AND user_id = ?').all(s.id, viewerId) as { type: StoryReaction }[]).map((r) => r.type);
    const photoIds = (this.db.prepare('SELECT shot_id FROM diary_photos WHERE story_id = ? ORDER BY ord').all(s.id) as { shot_id: number }[]).map((r) => r.shot_id);
    return {
      ...this.item(s, viewerId, admin),
      parts: this.parts(s),
      note: s.note,
      ref: s.ref,
      verse: s.verse,
      photoIds,
      lineMeta: this.lineMeta(s),
      myReactions,
      groupId: mine ? s.group_id : null,
    };
  }

  // ------------------------------------------------------------------ reading

  /** Books on one shelf this viewer may see, newest first, PAGE_SIZE per page. */
  list(viewerId: number | null, shelfRaw: unknown, pageRaw: unknown) {
    if (!isShelfId(shelfRaw)) throw new HttpError(404, 'not_found', '서가를 찾을 수 없어요.');
    const page = Math.max(0, Math.min(500, Math.floor(Number(pageRaw) || 0)));
    const rows = this.db
      .prepare(`${SELECT} WHERE s.shelf = @shelf AND ${VISIBLE} ORDER BY s.created_at DESC, s.id DESC LIMIT @limit OFFSET @offset`)
      .all({ shelf: shelfRaw, viewer: this.viewer(viewerId), limit: PAGE_SIZE + 1, offset: page * PAGE_SIZE }) as StoryRow[];
    return { shelf: shelfRaw, page, hasMore: rows.length > PAGE_SIZE, items: rows.slice(0, PAGE_SIZE).map((s) => this.item(s, viewerId)) };
  }

  /** How many books stand on each shelf for this viewer (the 3D shelves and the WS push). */
  shelfCounts(viewerId: number | null): ShelfCounts {
    const rows = this.db
      .prepare(`SELECT s.shelf AS shelf, COUNT(*) AS n FROM stories s WHERE ${VISIBLE} GROUP BY s.shelf`)
      .all({ viewer: this.viewer(viewerId) }) as { shelf: ShelfId; n: number }[];
    const out = Object.fromEntries(SHELF_IDS.map((id) => [id, 0])) as ShelfCounts;
    for (const r of rows) if (isShelfId(r.shelf)) out[r.shelf] = r.n;
    out.today = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM stories s WHERE s.kst_date = @today AND ${VISIBLE}`).get({ viewer: this.viewer(viewerId), today: kstDateOf(this.now()) }) as {
        n: number;
      }
    ).n;
    return out;
  }

  /** 🆕 오늘 꽂힌 책. */
  today(viewerId: number | null): StoryItem[] {
    const rows = this.db
      .prepare(`${SELECT} WHERE s.kst_date = @today AND ${VISIBLE} ORDER BY s.created_at DESC LIMIT 40`)
      .all({ viewer: this.viewer(viewerId), today: kstDateOf(this.now()) }) as StoryRow[];
    return rows.map((s) => this.item(s, viewerId));
  }

  /** 이번 주 많이 공감받은 책 (공감 given in the last 7 days). */
  popular(viewerId: number | null): StoryItem[] {
    const rows = this.db
      .prepare(
        `${SELECT} WHERE ${VISIBLE} AND s.hidden_at IS NULL AND EXISTS (SELECT 1 FROM story_reactions x WHERE x.story_id = s.id AND x.created_at >= @since)
         ORDER BY (SELECT COUNT(*) FROM story_reactions x WHERE x.story_id = s.id AND x.created_at >= @since) DESC, s.created_at DESC LIMIT 10`,
      )
      .all({ viewer: this.viewer(viewerId), since: this.now() - 7 * DAY_MS }) as StoryRow[];
    return rows.map((s) => this.item(s, viewerId));
  }

  /** 나의 서재: my testimonies, my diaries, my bookmarks (only still visible ones). */
  mine(userId: number) {
    const own = this.db.prepare(`${SELECT} WHERE s.user_id = @viewer ORDER BY s.created_at DESC LIMIT 500`).all({ viewer: userId }) as StoryRow[];
    const marks = this.db
      .prepare(`${SELECT} JOIN story_bookmarks bm ON bm.story_id = s.id AND bm.user_id = @viewer WHERE ${VISIBLE} ORDER BY bm.created_at DESC LIMIT 500`)
      .all({ viewer: userId }) as StoryRow[];
    return {
      stories: own.filter((s) => s.kind === 'testimony').map((s) => this.item(s, userId)),
      diaries: own.filter((s) => s.kind === 'diary').map((s) => this.item(s, userId)),
      bookmarks: marks.map((s) => this.item(s, userId)),
    };
  }

  /** Same 404 for missing and not allowed (no existence leak). */
  private visible(id: number, viewerId: number | null, admin = false): StoryRow {
    const s = this.row(id, viewerId);
    if (!s || !this.visibleTo(s, viewerId, admin)) throw new HttpError(404, 'not_found', '책을 찾을 수 없어요.');
    return s;
  }

  /** The book as LetterService needs it, if this viewer may see it (else the same 404). */
  book(id: number, viewerId: number | null, admin = false) {
    const s = this.visible(id, viewerId, admin);
    return { id: s.id, userId: s.user_id, kind: s.kind, title: s.title, visibility: s.visibility, hidden: s.hidden_at !== null };
  }

  /** Writing ban (글쓰기 금지) also covers letters. */
  assertCanWrite(userId: number) {
    this.checkBan(userId);
  }

  /** Same personal-info check as books (409 until confirmed). */
  assertNoPersonal(text: string, confirmed: unknown) {
    this.personal(text, confirmed, '보낼까요');
  }

  /** Open a book: counts this reader once (never the author) and leaves a 발자취. */
  detail(id: number, viewerId: number | null, admin = false): StoryDetail {
    const s = this.visible(id, viewerId, admin);
    if (viewerId !== null && s.user_id !== viewerId && this.visibleTo(s, viewerId)) {
      const now = this.now();
      const added = this.db.prepare('INSERT OR IGNORE INTO story_reads (story_id, user_id, created_at) VALUES (?, ?, ?)').run(id, viewerId, now).changes;
      this.footprints.event(viewerId, 'story_read', `${kstDateOf(now)}:${id}`, { storyId: id });
      if (added) return this.detailOf(this.row(id, viewerId)!, viewerId, admin);
    }
    return this.detailOf(s, viewerId, admin);
  }

  /** May this viewer fetch that screenshot? Owner always; others only through a diary they may read. */
  canSeeShot(shotId: number, ownerId: number, viewerId: number | null, admin = false): boolean {
    if (admin || (viewerId !== null && viewerId === ownerId)) return true;
    const ids = (this.db.prepare('SELECT story_id FROM diary_photos WHERE shot_id = ?').all(shotId) as { story_id: number }[]).map((r) => r.story_id);
    return ids.some((sid) => {
      const s = this.row(sid, viewerId);
      return !!s && this.visibleTo(s, viewerId);
    });
  }

  // ------------------------------------------------------------------ writing

  private checkBan(userId: number) {
    const u = this.db.prepare('SELECT story_ban_until FROM users WHERE id = ?').get(userId) as { story_ban_until: number | null } | undefined;
    if (u?.story_ban_until && u.story_ban_until > this.now()) {
      const d = new Date(u.story_ban_until + 9 * 3600_000);
      throw new HttpError(403, 'story_banned', `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일까지 도서관에 글을 쓸 수 없어요.`);
    }
  }

  private visibility(userId: number, body: Record<string, unknown>): { visibility: StoryVisibility; groupId: number | null } {
    const v = body.visibility;
    if (typeof v !== 'string' || !(STORY_VISIBILITIES as readonly string[]).includes(v)) throw new HttpError(400, 'bad_visibility', '공개 범위를 골라 주세요.');
    if (v !== 'group') return { visibility: v as StoryVisibility, groupId: null };
    const gid = Number(body.groupId);
    if (!Number.isInteger(gid) || !this.groups.isMember(userId, gid)) throw new HttpError(403, 'not_member', '함께하는 모임에만 나눌 수 있어요.');
    return { visibility: 'group', groupId: gid };
  }

  /** Phone numbers, e-mails, resident numbers: 409 until the author says 그래도 올리기. */
  private personal(text: string, confirmed: unknown, verb = '올릴까요') {
    const kinds = personalInfoKinds(text);
    if (kinds.length && confirmed !== true) {
      throw new HttpError(409, 'personal_info', `${kinds.join(', ')}처럼 보이는 내용이 있어요. 다른 사람이 볼 수 있어요. 그래도 ${verb}?`);
    }
  }

  private testimonyFields(body: Record<string, unknown>) {
    const title = typeof body.title === 'string' ? cleanText(body.title) : '';
    if ([...title].length < 1 || [...title].length > STORY_TITLE_MAX) throw new HttpError(400, 'bad_title', `제목은 1~${STORY_TITLE_MAX}자로 적어 주세요.`);
    if (!isTestimonyShelf(body.shelf)) throw new HttpError(400, 'bad_shelf', '꽂을 서가를 골라 주세요.');
    const raw = Array.isArray(body.parts) ? body.parts : [];
    if (raw.length !== STORY_PROMPTS.length) throw new HttpError(400, 'bad_parts', '세 가지 질문에 답해 주세요.');
    const parts = raw.map((p) => (typeof p === 'string' ? cleanMultiline(p) : ''));
    const total = parts.reduce((n, p) => n + [...p].length, 0);
    if (total < 10) throw new HttpError(400, 'too_short', '조금만 더 적어 주세요.');
    if (total > STORY_BODY_MAX) throw new HttpError(400, 'too_long', `본문은 모두 합쳐 ${STORY_BODY_MAX}자까지 쓸 수 있어요.`);
    let ref: string | null = null;
    let verse: string | null = null;
    if (typeof body.ref === 'string' && body.ref.trim()) {
      const hit = this.daily?.lookup(body.ref.slice(0, 40));
      if (!hit) throw new HttpError(400, 'bad_ref', '성경 구절을 찾지 못했어요. 예: 요한복음 3:16, 시편 23:1-3');
      ref = hit.ref;
      verse = hit.text;
    }
    return { title, shelf: body.shelf, parts, ref, verse };
  }

  createTestimony(userId: number, body: Record<string, unknown>): StoryDetail {
    this.checkBan(userId);
    const f = this.testimonyFields(body);
    const vis = this.visibility(userId, body);
    this.personal([f.title, ...f.parts].join('\n'), body.confirmPersonal);
    const now = this.now();
    const today = kstDateOf(now);
    // Counted on write (taking a book back off the shelf doesn't give the slot back).
    const n = (this.db.prepare('SELECT count FROM story_days WHERE user_id = ? AND kst_date = ?').get(userId, today) as { count: number } | undefined)?.count ?? 0;
    if (n >= STORIES_PER_DAY) throw new HttpError(429, 'too_many', `이야기는 하루에 ${STORIES_PER_DAY}권까지 꽂을 수 있어요.`);
    this.db
      .prepare('INSERT INTO story_days (user_id, kst_date, count) VALUES (?, ?, 1) ON CONFLICT (user_id, kst_date) DO UPDATE SET count = count + 1')
      .run(userId, today);
    const info = this.db
      .prepare(
        `INSERT INTO stories (user_id, kind, shelf, title, parts, note, ref, verse, visibility, group_id, kst_date, created_at, updated_at)
         VALUES (?, 'testimony', ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(userId, f.shelf, f.title, JSON.stringify(f.parts), f.ref, f.verse, vis.visibility, vis.groupId, today, now, now);
    this.db.prepare('DELETE FROM story_drafts WHERE user_id = ?').run(userId);
    return this.detailOf(this.row(Number(info.lastInsertRowid), userId)!, userId);
  }

  updateTestimony(userId: number, id: number, body: Record<string, unknown>): StoryDetail {
    const s = this.row(id, userId);
    if (!s || s.user_id !== userId || s.kind !== 'testimony') throw new HttpError(404, 'not_found', '내 이야기만 고칠 수 있어요.');
    this.checkBan(userId);
    const f = this.testimonyFields(body);
    const vis = this.visibility(userId, body);
    this.personal([f.title, ...f.parts].join('\n'), body.confirmPersonal);
    this.db
      .prepare('UPDATE stories SET shelf = ?, title = ?, parts = ?, ref = ?, verse = ?, visibility = ?, group_id = ?, updated_at = ? WHERE id = ?')
      .run(f.shelf, f.title, JSON.stringify(f.parts), f.ref, f.verse, vis.visibility, vis.groupId, this.now(), id);
    return this.detailOf(this.row(id, userId)!, userId);
  }

  /** The author takes a book off the shelf (testimony or diary). Its photos stay in the album. */
  delete(userId: number, id: number) {
    const r = this.db.prepare('DELETE FROM stories WHERE id = ? AND user_id = ?').run(id, userId);
    if (!r.changes) throw new HttpError(404, 'not_found', '내 책만 뺄 수 있어요.');
  }

  getDraft(userId: number): unknown {
    const r = this.db.prepare('SELECT draft, updated_at FROM story_drafts WHERE user_id = ?').get(userId) as { draft: string; updated_at: number } | undefined;
    return r ? { draft: JSON.parse(r.draft) as unknown, updatedAt: new Date(r.updated_at).toISOString() } : { draft: null, updatedAt: null };
  }

  /** One draft per user, plain strings only (임시 저장 of the testimony form). */
  saveDraft(userId: number, body: Record<string, unknown>) {
    const d = (body.draft ?? {}) as Record<string, unknown>;
    const s = (v: unknown, max: number) => (typeof v === 'string' ? [...v.replace(/\r\n?/g, '\n')].slice(0, max).join('') : '');
    const draft = {
      title: s(d.title, STORY_TITLE_MAX * 2),
      parts: (Array.isArray(d.parts) ? d.parts : []).slice(0, STORY_PROMPTS.length).map((p) => s(p, STORY_BODY_MAX)),
      shelf: isTestimonyShelf(d.shelf) ? d.shelf : null,
      ref: s(d.ref, 40),
      step: Number.isInteger(d.step) ? Math.max(0, Math.min(5, d.step as number)) : 0,
    };
    const now = this.now();
    this.db
      .prepare('INSERT INTO story_drafts (user_id, draft, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET draft = excluded.draft, updated_at = excluded.updated_at')
      .run(userId, JSON.stringify(draft), now);
    return { draft, updatedAt: new Date(now).toISOString() };
  }

  deleteDraft(userId: number) {
    this.db.prepare('DELETE FROM story_drafts WHERE user_id = ?').run(userId);
  }

  // ------------------------------------------------------------------ 📔 오늘의 일기

  private defaultVisibility(userId: number): StoryVisibility {
    return this.groups.list(userId).length ? 'group' : 'private';
  }

  diaryDraft(userId: number): DiaryDraft {
    const date = kstDateOf(this.now());
    const fp = this.footprints.day(userId, date);
    const word = this.daily ? this.daily.forDate(date) : null;
    const existingRow = this.db.prepare("SELECT id FROM stories WHERE user_id = ? AND kind = 'diary' AND kst_date = ?").get(userId, date) as { id: number } | undefined;
    return {
      date,
      word: word ? { ref: word.ref, text: word.text } : null,
      lines: diaryLines(fp.events, fp.minutes).map((l) => ({ key: l.key, minute: l.minute, text: l.text })),
      photos: this.shots.list(userId, date),
      existing: existingRow ? this.detailOf(this.row(existingRow.id, userId)!, userId) : null,
      defaultVisibility: this.defaultVisibility(userId),
      groups: this.groups.list(userId).map((g) => ({ id: g.id, name: g.name })),
      footprintsOn: this.footprints.enabled(userId),
    };
  }

  /** Publish (or replace) today's diary: the text exactly as the author left it, sanitised. */
  publishDiary(userId: number, body: Record<string, unknown>): StoryDetail {
    this.checkBan(userId);
    const now = this.now();
    const date = kstDateOf(now);
    const rawLines = Array.isArray(body.lines) ? body.lines : [];
    if (rawLines.length > DIARY_LINES_MAX) throw new HttpError(400, 'too_long', `일기는 ${DIARY_LINES_MAX}줄까지 쓸 수 있어요.`);
    // Each line's source (key + minute) from today's template draft, when the client says which one it was.
    const fp = this.footprints.day(userId, date);
    const known = new Map(diaryLines(fp.events, fp.minutes).map((l) => [l.key, l.minute]));
    const rawMeta = Array.isArray(body.lineKeys) ? body.lineKeys : [];
    const pairs = rawLines
      .map((l, i) => {
        const key = rawMeta[i];
        const minute = typeof key === 'string' ? known.get(key) : undefined;
        return { text: typeof l === 'string' ? cleanText(l) : '', meta: typeof key === 'string' && minute !== undefined ? { key, minute } : null };
      })
      .filter((p) => p.text.length > 0);
    const lines = pairs.map((p) => p.text);
    const lineMeta = pairs.some((p) => p.meta) ? JSON.stringify(pairs.map((p) => p.meta)) : null;
    if (lines.some((l) => [...l].length > DIARY_LINE_MAX)) throw new HttpError(400, 'too_long', `한 줄은 ${DIARY_LINE_MAX}자까지 쓸 수 있어요.`);
    const note = typeof body.note === 'string' ? cleanMultiline(body.note) : '';
    if ([...note].length > DIARY_NOTE_MAX) throw new HttpError(400, 'too_long', `오늘 한 줄은 ${DIARY_NOTE_MAX}자까지 쓸 수 있어요.`);
    if (!lines.length && !note) throw new HttpError(400, 'empty', '한 줄이라도 남겨 주세요.');
    const vis = body.visibility === undefined ? { visibility: this.defaultVisibility(userId), groupId: null as number | null } : this.visibility(userId, body);
    if (vis.visibility === 'group' && vis.groupId === null) vis.groupId = this.groups.list(userId)[0]?.id ?? null;
    if (vis.visibility === 'group' && vis.groupId === null) vis.visibility = 'private';
    const photoIds = [...new Set((Array.isArray(body.photoIds) ? body.photoIds : []).filter((x): x is number => Number.isInteger(x)))];
    if (photoIds.length > DIARY_PHOTOS_MAX) throw new HttpError(400, 'too_many_photos', `사진은 ${DIARY_PHOTOS_MAX}장까지 넣을 수 있어요.`);
    for (const pid of photoIds) if (!this.shots.get(userId, pid)) throw new HttpError(400, 'bad_photo', '내 사진만 넣을 수 있어요.');
    this.personal([...lines, note].join('\n'), body.confirmPersonal);
    const word = this.daily ? this.daily.forDate(date) : null;
    const id = this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM stories WHERE user_id = ? AND kind = 'diary' AND kst_date = ?").get(userId, date) as { id: number } | undefined;
      let sid: number;
      if (existing) {
        sid = existing.id;
        this.db
          .prepare('UPDATE stories SET parts = ?, line_meta = ?, note = ?, visibility = ?, group_id = ?, ref = ?, verse = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(lines), lineMeta, note, vis.visibility, vis.groupId, word?.ref ?? null, word?.text ?? null, now, sid);
        this.db.prepare('DELETE FROM diary_photos WHERE story_id = ?').run(sid);
      } else {
        sid = Number(
          this.db
            .prepare(
              `INSERT INTO stories (user_id, kind, shelf, title, parts, line_meta, note, ref, verse, visibility, group_id, kst_date, created_at, updated_at)
               VALUES (?, 'diary', 'diary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(userId, diaryTitle(date), JSON.stringify(lines), lineMeta, note, word?.ref ?? null, word?.text ?? null, vis.visibility, vis.groupId, date, now, now).lastInsertRowid,
        );
      }
      const add = this.db.prepare('INSERT INTO diary_photos (story_id, shot_id, ord) VALUES (?, ?, ?)');
      photoIds.forEach((pid, i) => add.run(sid, pid, i));
      return sid;
    })();
    return this.detailOf(this.row(id, userId)!, userId);
  }

  // ------------------------------------------------------------------ 공감, 책갈피, 신고

  react(userId: number, id: number, typeRaw: unknown): StoryDetail {
    if (typeof typeRaw !== 'string' || !(STORY_REACTIONS as readonly string[]).includes(typeRaw)) throw new HttpError(400, 'bad_type', '공감 종류가 올바르지 않아요.');
    this.visible(id, userId);
    const has = this.db.prepare('SELECT 1 FROM story_reactions WHERE story_id = ? AND user_id = ? AND type = ?').get(id, userId, typeRaw);
    if (has) this.db.prepare('DELETE FROM story_reactions WHERE story_id = ? AND user_id = ? AND type = ?').run(id, userId, typeRaw);
    else this.db.prepare('INSERT INTO story_reactions (story_id, user_id, type, created_at) VALUES (?, ?, ?, ?)').run(id, userId, typeRaw, this.now());
    return this.detailOf(this.row(id, userId)!, userId);
  }

  bookmark(userId: number, id: number): { bookmarked: boolean } {
    this.visible(id, userId);
    const r = this.db.prepare('DELETE FROM story_bookmarks WHERE user_id = ? AND story_id = ?').run(userId, id);
    if (r.changes) return { bookmarked: false };
    this.db.prepare('INSERT INTO story_bookmarks (user_id, story_id, created_at) VALUES (?, ?, ?)').run(userId, id, this.now());
    return { bookmarked: true };
  }

  report(userId: number, id: number, reasonRaw: unknown): { duplicate: boolean; hidden: boolean; changed: boolean } {
    if (typeof reasonRaw !== 'string' || !(STORY_REPORT_REASONS as readonly string[]).includes(reasonRaw)) throw new HttpError(400, 'bad_reason', '신고 이유를 골라 주세요.');
    const s = this.visible(id, userId);
    if (s.user_id === userId) throw new HttpError(400, 'own_story', '내 책은 신고할 수 없어요.');
    return this.db.transaction(() => {
      const added = this.db.prepare('INSERT OR IGNORE INTO story_reports (story_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?)').run(id, userId, reasonRaw as StoryReportReason, this.now()).changes;
      const { n } = this.db.prepare('SELECT COUNT(*) n FROM story_reports WHERE story_id = ?').get(id) as { n: number };
      let changed = false;
      if (added && n >= STORY_HIDE_REPORTS && s.hidden_at === null && s.review === null) {
        this.db.prepare('UPDATE stories SET hidden_at = ? WHERE id = ?').run(this.now(), id);
        changed = true;
      }
      return { duplicate: added === 0, hidden: changed || s.hidden_at !== null, changed };
    })();
  }

  // ------------------------------------------------------------------ admin

  adminList() {
    const rows = this.db
      .prepare(
        `${SELECT} WHERE s.hidden_at IS NOT NULL OR EXISTS (SELECT 1 FROM story_reports r WHERE r.story_id = s.id)
         ORDER BY (s.review IS NULL) DESC, (SELECT MAX(created_at) FROM story_reports r WHERE r.story_id = s.id) DESC LIMIT 200`,
      )
      .all({ viewer: -1 }) as StoryRow[];
    const reasons = this.db.prepare('SELECT reason, COUNT(*) n FROM story_reports WHERE story_id = ? GROUP BY reason');
    const ban = this.db.prepare('SELECT story_ban_until FROM users WHERE id = ?');
    const now = this.now();
    return rows.map((s) => {
      const b = (ban.get(s.user_id) as { story_ban_until: number | null }).story_ban_until;
      return {
        ...this.detailOf(s, null, true),
        author: s.nickname ?? '',
        anonymous: s.visibility === 'anonymous',
        reporters: Object.values(Object.fromEntries((reasons.all(s.id) as { reason: string; n: number }[]).map((x) => [x.reason, x.n]))).reduce((a, n) => a + n, 0),
        reasons: Object.fromEntries((reasons.all(s.id) as { reason: string; n: number }[]).map((x) => [x.reason, x.n])),
        review: s.review,
        authorBanUntil: b && b > now ? b : null,
      };
    });
  }

  /** 복구 · 숨김 유지 · 삭제 · 글쓰기 금지 n일. */
  adminAction(id: number, action: unknown, rawDays: unknown) {
    const s = this.db.prepare('SELECT id, user_id, hidden_at FROM stories WHERE id = ?').get(id) as { id: number; user_id: number; hidden_at: number | null } | undefined;
    if (!s) throw new HttpError(404, 'not_found', '책을 찾을 수 없어요.');
    const now = this.now();
    if (action === 'restore') this.db.prepare("UPDATE stories SET hidden_at = NULL, review = 'restored', reviewed_at = ? WHERE id = ?").run(now, id);
    else if (action === 'hide') this.db.prepare("UPDATE stories SET hidden_at = COALESCE(hidden_at, ?), review = 'kept', reviewed_at = ? WHERE id = ?").run(now, now, id);
    else if (action === 'delete') this.db.prepare('DELETE FROM stories WHERE id = ?').run(id);
    else if (action === 'ban') {
      const days = Number(rawDays);
      if (!Number.isInteger(days) || days < 1 || days > MAX_STORY_BAN_DAYS) throw new HttpError(400, 'bad_days', `1~${MAX_STORY_BAN_DAYS}일 사이로 정해 주세요.`);
      this.db.prepare('UPDATE users SET story_ban_until = ? WHERE id = ?').run(now + days * DAY_MS, s.user_id);
    } else throw new HttpError(400, 'bad_action', '알 수 없는 조치예요.');
    return { ok: true };
  }

  // ------------------------------------------------------------------ 내 데이터

  export(userId: number) {
    const own = this.db.prepare(`${SELECT} WHERE s.user_id = @viewer ORDER BY s.created_at`).all({ viewer: userId }) as StoryRow[];
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    const u = this.db.prepare('SELECT story_ban_until FROM users WHERE id = ?').get(userId) as { story_ban_until: number | null } | undefined;
    return {
      books: own.map((s) => ({ ...this.detailOf(s, userId), hiddenAt: iso(s.hidden_at), reportsReceived: (this.db.prepare('SELECT COUNT(*) n FROM story_reports WHERE story_id = ?').get(s.id) as { n: number }).n })),
      reactionsGiven: (this.db.prepare('SELECT story_id, type, created_at FROM story_reactions WHERE user_id = ? ORDER BY created_at').all(userId) as { story_id: number; type: string; created_at: number }[]).map(
        (r) => ({ storyId: r.story_id, type: r.type, createdAt: iso(r.created_at) }),
      ),
      bookmarks: (this.db.prepare('SELECT story_id, created_at FROM story_bookmarks WHERE user_id = ? ORDER BY created_at').all(userId) as { story_id: number; created_at: number }[]).map((r) => ({
        storyId: r.story_id,
        createdAt: iso(r.created_at),
      })),
      booksRead: (this.db.prepare('SELECT story_id, created_at FROM story_reads WHERE user_id = ? ORDER BY created_at').all(userId) as { story_id: number; created_at: number }[]).map((r) => ({
        storyId: r.story_id,
        firstReadAt: iso(r.created_at),
      })),
      reportsMade: (this.db.prepare('SELECT story_id, reason, created_at FROM story_reports WHERE reporter_id = ? ORDER BY created_at').all(userId) as { story_id: number; reason: string; created_at: number }[]).map(
        (r) => ({ storyId: r.story_id, reason: r.reason, createdAt: iso(r.created_at) }),
      ),
      draft: (this.getDraft(userId) as { draft: unknown }).draft,
      writingPausedUntil: iso(u?.story_ban_until ?? null),
    };
  }
}
