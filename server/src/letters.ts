import {
  ANONYMOUS_NAME,
  BOOK_AUTHOR_NAME,
  cleanMultiline,
  LETTER_MAX,
  LETTER_REPLIES_MAX,
  STORY_HIDE_REPORTS,
  STORY_REPORT_REASONS,
  type InboxItem,
  type LetterMessage,
  type LettersOfBook,
  type LetterThread,
  type StoryReportReason,
  type StoryVisibility,
} from '../../shared/protocol.js';
import type { DB } from './db.js';
import { HttpError } from './http.js';
import { VISIBLE, type LibraryService } from './library.js';

interface Row {
  id: number;
  story_id: number;
  parent_id: number | null;
  user_id: number;
  anonymous: number;
  text: string;
  request_id: string | null;
  created_at: number;
  deleted_at: number | null;
  hidden_at: number | null;
  author_hidden_at: number | null;
  review: 'kept' | 'restored' | null;
  nickname: string | null;
}

interface Book {
  id: number;
  userId: number;
  kind: 'testimony' | 'diary';
  title: string;
  visibility: StoryVisibility;
  hidden: boolean;
}

/** Who should hear about a new letter or reply (the API turns this into a push and a WS badge). */
export interface LetterNotice {
  userId: number;
  storyId: number;
  letterId: number;
  /** 'letter' = new letter on my book; 'reply' = an answer in a thread I'm part of. */
  kind: 'letter' | 'reply';
  /** The recipient is the book's author ('letters' pref) or the letter's writer ('replies' pref). */
  recipientRole: 'author' | 'writer';
}

export interface LetterResult {
  thread: LetterThread;
  /** false: an idempotent replay of the same requestId (nothing new was written). */
  created: boolean;
  notice: LetterNotice | null;
}

const SELECT = 'SELECT l.*, u.nickname AS nickname FROM story_letters l JOIN users u ON u.id = l.user_id';
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const excerptOf = (text: string, n = 60) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return [...t].length > n ? `${[...t].slice(0, n).join('')}…` : t;
};

/**
 * ✉️ 답장 편지 (L-B): short letters (LETTER_MAX) under a book anyone who can see
 * it may write, and a one-level thread per letter where the book's author and
 * the letter's writer take turns (LETTER_REPLIES_MAX replies). Letters follow
 * the book's visibility (모임 books: members only; 나만 books: none). Anonymous
 * books show their author as 글쓴이, and 익명으로 보내기 letters show their writer
 * as 익명의 성도, to everyone but that person (admins see names). No account id
 * ever leaves this class. Reads are tracked per thread (📬 받은 편지 badge).
 */
export class LetterService {
  now: () => number = () => Date.now();

  constructor(
    private readonly db: DB,
    private readonly library: LibraryService,
  ) {}

  // ------------------------------------------------------------------ shaping

  private rows(storyId: number): Row[] {
    return this.db.prepare(`${SELECT} WHERE l.story_id = ? ORDER BY l.id`).all(storyId) as Row[];
  }

  private one(id: number): Row | undefined {
    return this.db.prepare(`${SELECT} WHERE l.id = ?`).get(id) as Row | undefined;
  }

  /** Name shown for one message, masked for anonymous books and anonymous letters. */
  private name(r: Row, letter: Row, book: Book, viewerId: number | null, admin: boolean): string {
    const mine = viewerId !== null && r.user_id === viewerId;
    const nick = r.nickname ?? '알 수 없음';
    if (mine || admin) return nick;
    if (r.user_id === book.userId) return book.visibility === 'anonymous' ? BOOK_AUTHOR_NAME : nick;
    return letter.anonymous ? ANONYMOUS_NAME : nick;
  }

  private message(r: Row, letter: Row, book: Book, viewerId: number | null, admin: boolean): LetterMessage {
    const mine = viewerId !== null && r.user_id === viewerId;
    const deleted = r.deleted_at !== null;
    return {
      id: r.id,
      text: deleted ? '' : r.text,
      author: this.name(r, letter, book, viewerId, admin),
      role: r.user_id === book.userId ? 'author' : 'writer',
      mine,
      createdAt: new Date(r.created_at).toISOString(),
      deleted,
      reported: r.hidden_at !== null,
    };
  }

  /** May this viewer see this message at all (the book itself is already visible to them)? */
  private sees(r: Row, letter: Row, book: Book, viewerId: number | null, admin: boolean): boolean {
    if (admin) return true;
    const mine = viewerId !== null && r.user_id === viewerId;
    if (r.hidden_at !== null && !mine) return false;
    if (letter.hidden_at !== null && !(viewerId !== null && letter.user_id === viewerId)) return false;
    // Hidden by the book's author: only its writer (unaware) and the author (folded) still see it.
    if (letter.author_hidden_at !== null && viewerId !== letter.user_id && viewerId !== book.userId) return false;
    return true;
  }

  /** Last message that still counts for taking turns (deleted ones don't). */
  private turn(letter: Row, replies: Row[]): { lastUserId: number; total: number } {
    const live = [letter, ...replies].filter((r) => r.deleted_at === null);
    return { lastUserId: live.length ? live[live.length - 1].user_id : letter.user_id, total: replies.length };
  }

  private replyState(letter: Row, replies: Row[], book: Book, viewerId: number | null): { canReply: boolean; note: string | null } {
    if (viewerId === null || (viewerId !== book.userId && viewerId !== letter.user_id)) return { canReply: false, note: null };
    if (letter.deleted_at !== null) return { canReply: false, note: '지워진 편지에는 답장할 수 없어요.' };
    if (letter.hidden_at !== null || letter.author_hidden_at !== null || book.hidden || book.visibility === 'private') return { canReply: false, note: null };
    const t = this.turn(letter, replies);
    if (t.total >= LETTER_REPLIES_MAX) return { canReply: false, note: `답장은 ${LETTER_REPLIES_MAX}번까지 주고받을 수 있어요.` };
    if (t.lastUserId === viewerId) return { canReply: false, note: viewerId === book.userId ? '편지를 쓴 분의 답장을 기다리고 있어요.' : '글쓴이의 답장을 기다리고 있어요.' };
    return { canReply: true, note: null };
  }

  private readPointer(userId: number | null, letterId: number): number {
    if (userId === null) return Number.MAX_SAFE_INTEGER;
    return (this.db.prepare('SELECT read_id FROM letter_reads WHERE user_id = ? AND letter_id = ?').get(userId, letterId) as { read_id: number } | undefined)?.read_id ?? 0;
  }

  private unreadIn(letter: Row, replies: Row[], viewerId: number | null, book: Book): number {
    if (viewerId === null || (viewerId !== book.userId && viewerId !== letter.user_id)) return 0;
    if (letter.author_hidden_at !== null && viewerId === book.userId) return 0;
    const read = this.readPointer(viewerId, letter.id);
    return [letter, ...replies].filter((r) => r.user_id !== viewerId && r.deleted_at === null && r.hidden_at === null && r.id > read).length;
  }

  private thread(letter: Row, replies: Row[], book: Book, viewerId: number | null, admin: boolean): LetterThread | null {
    if (!this.sees(letter, letter, book, viewerId, admin)) return null;
    const shown = replies.filter((r) => this.sees(r, letter, book, viewerId, admin));
    // A letter its writer took back, with nothing left under it: just leave it out.
    if (!admin && letter.deleted_at !== null && shown.every((r) => r.deleted_at !== null)) return null;
    const state = this.replyState(letter, replies, book, viewerId);
    return {
      ...this.message(letter, letter, book, viewerId, admin),
      anonymous: letter.anonymous === 1,
      hiddenByAuthor: letter.author_hidden_at !== null,
      replies: shown.map((r) => this.message(r, letter, book, viewerId, admin)),
      canReply: state.canReply,
      replyNote: state.note,
      canHide: viewerId !== null && viewerId === book.userId,
      unread: this.unreadIn(letter, replies, viewerId, book),
    };
  }

  private threadOf(letterId: number, viewerId: number | null): LetterThread {
    const letter = this.one(letterId)!;
    const book = this.library.book(letter.story_id, viewerId);
    const replies = this.db.prepare(`${SELECT} WHERE l.parent_id = ? ORDER BY l.id`).all(letter.id) as Row[];
    return this.thread(letter, replies, book, viewerId, false)!;
  }

  // ------------------------------------------------------------------ reading

  /** ✉️ 편지 under one book, for this viewer. Marks the threads they're part of as read. */
  list(storyId: number, viewerId: number | null, admin = false): LettersOfBook & { markedRead: boolean } {
    const book = this.library.book(storyId, viewerId, admin);
    const all = this.rows(storyId);
    const letters = all.filter((r) => r.parent_id === null);
    const threads: LetterThread[] = [];
    for (const l of letters) {
      const t = this.thread(
        l,
        all.filter((r) => r.parent_id === l.id),
        book,
        viewerId,
        admin,
      );
      if (t) threads.push(t);
    }
    let note: string | null = null;
    let canWrite = false;
    if (book.visibility === 'private') note = '나만 보는 책에는 편지를 받을 수 없어요.';
    else if (book.hidden) note = '신고로 숨겨진 책에는 편지를 쓸 수 없어요.';
    else if (viewerId === null) note = '로그인하면 이 이야기에 편지를 쓸 수 있어요.';
    else if (viewerId === book.userId) note = '이 이야기에 온 편지에 답장할 수 있어요.';
    else canWrite = true;
    const marked = viewerId !== null && threads.some((t) => t.unread > 0);
    if (viewerId !== null) this.markThreads(viewerId, letters.filter((l) => threads.some((t) => t.id === l.id)).map((l) => l.id));
    const count = threads.filter((t) => !t.deleted && !t.hiddenByAuthor && !t.reported).length;
    return { storyId, count, canWrite, note, letters: threads, markedRead: marked };
  }

  /** Read pointer → newest message of each thread the viewer is a party of. */
  private markThreads(viewerId: number, letterIds: number[]) {
    const max = this.db.prepare('SELECT MAX(id) AS m FROM story_letters WHERE id = ? OR parent_id = ?');
    const set = this.db.prepare(
      'INSERT INTO letter_reads (user_id, letter_id, read_id) VALUES (?, ?, ?) ON CONFLICT (user_id, letter_id) DO UPDATE SET read_id = MAX(read_id, excluded.read_id)',
    );
    const party = this.db.prepare('SELECT 1 FROM story_letters l JOIN stories s ON s.id = l.story_id WHERE l.id = ? AND (l.user_id = ? OR s.user_id = ?)');
    this.db.transaction(() => {
      for (const id of letterIds) {
        if (!party.get(id, viewerId, viewerId)) continue;
        set.run(viewerId, id, (max.get(id, id) as { m: number }).m);
      }
    })();
  }

  /** 📬 받은 편지: letters on my books and threads of my letters, newest activity first. */
  inbox(userId: number): { unread: number; items: InboxItem[] } {
    const letters = this.db
      .prepare(
        `${SELECT} JOIN stories s ON s.id = l.story_id
         WHERE l.parent_id IS NULL AND ((s.user_id = @viewer AND l.user_id <> @viewer AND l.author_hidden_at IS NULL) OR (l.user_id = @viewer AND s.user_id <> @viewer))
           AND (l.hidden_at IS NULL OR l.user_id = @viewer) AND ${VISIBLE}
         ORDER BY l.id DESC LIMIT 300`,
      )
      .all({ viewer: userId }) as Row[];
    const items: InboxItem[] = [];
    let unread = 0;
    const repliesOf = this.db.prepare(`${SELECT} WHERE l.parent_id = ? ORDER BY l.id`);
    for (const l of letters) {
      const book = this.library.book(l.story_id, userId);
      const replies = repliesOf.all(l.id) as Row[];
      const t = this.thread(l, replies, book, userId, false);
      if (!t) continue;
      const shown = [l, ...replies].filter((r) => this.sees(r, l, book, userId, false));
      const last = shown[shown.length - 1];
      unread += t.unread;
      items.push({
        letterId: l.id,
        storyId: book.id,
        storyTitle: book.title,
        storyKind: book.kind,
        role: book.userId === userId ? 'author' : 'writer',
        from: this.name(last, l, book, userId, false),
        excerpt: last.deleted_at !== null ? '삭제된 편지예요' : excerptOf(last.text),
        lastAt: new Date(last.created_at).toISOString(),
        messages: shown.filter((r) => r.deleted_at === null).length,
        unread: t.unread,
      });
    }
    items.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : b.letterId - a.letterId));
    return { unread, items: items.slice(0, 100) };
  }

  unreadCount(userId: number): number {
    return this.inbox(userId).unread;
  }

  /** 읽음: one thread, or every thread in 받은 편지. */
  markRead(userId: number, body: Record<string, unknown>): { unread: number } {
    if (body.all === true) this.markThreads(userId, this.inbox(userId).items.map((i) => i.letterId));
    else {
      const id = Number(body.letterId);
      if (!Number.isInteger(id)) throw new HttpError(400, 'bad_letter', '편지를 골라 주세요.');
      if (this.inbox(userId).items.some((i) => i.letterId === id)) this.markThreads(userId, [id]);
    }
    return { unread: this.unreadCount(userId) };
  }

  // ------------------------------------------------------------------ writing

  private text(body: Record<string, unknown>): string {
    const text = typeof body.text === 'string' ? cleanMultiline(body.text) : '';
    if (!text) throw new HttpError(400, 'empty', '편지 내용을 적어 주세요.');
    if ([...text].length > LETTER_MAX) throw new HttpError(400, 'too_long', `편지는 ${LETTER_MAX}자까지 쓸 수 있어요.`);
    return text;
  }

  private requestId(body: Record<string, unknown>): string | null {
    const r = body.requestId;
    if (r === undefined || r === null) return null;
    if (typeof r !== 'string' || !REQUEST_ID.test(r)) throw new HttpError(400, 'bad_request_id', '요청 번호가 올바르지 않아요.');
    return r;
  }

  /** Same requestId again (double tap, retry): the first result, nothing new written. */
  private replay(userId: number, requestId: string | null, storyId: number | null, parentId: number | null): LetterResult | null {
    if (!requestId) return null;
    const r = this.db.prepare('SELECT id, story_id, parent_id FROM story_letters WHERE user_id = ? AND request_id = ?').get(userId, requestId) as
      | { id: number; story_id: number; parent_id: number | null }
      | undefined;
    if (!r) return null;
    if ((storyId !== null && r.story_id !== storyId) || (parentId !== null && r.parent_id !== parentId)) {
      throw new HttpError(409, 'request_reused', '같은 요청 번호가 다른 편지에 쓰였어요.');
    }
    const top = r.parent_id ?? r.id;
    return { thread: this.threadOf(top, userId), created: false, notice: null };
  }

  /**
   * A new letter under a book. `beforeInsert` runs after validation and the
   * replay check (the API's rate limit, so replays never count).
   */
  write(userId: number, storyId: number, body: Record<string, unknown>, beforeInsert: () => void = () => undefined): LetterResult {
    const requestId = this.requestId(body);
    const again = this.replay(userId, requestId, storyId, null);
    if (again) return again;
    const book = this.library.book(storyId, userId);
    if (book.userId === userId) throw new HttpError(400, 'own_story', '내 이야기에는 편지 대신 답장을 남길 수 있어요.');
    if (book.visibility === 'private') throw new HttpError(404, 'not_found', '책을 찾을 수 없어요.');
    if (book.hidden) throw new HttpError(403, 'hidden', '신고로 숨겨진 책에는 편지를 쓸 수 없어요.');
    this.library.assertCanWrite(userId);
    const text = this.text(body);
    this.library.assertNoPersonal(text, body.confirmPersonal);
    beforeInsert();
    const id = this.db.transaction(() => {
      const info = this.db
        .prepare('INSERT INTO story_letters (story_id, parent_id, user_id, anonymous, text, request_id, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?)')
        .run(storyId, userId, body.anonymous === true ? 1 : 0, text, requestId, this.now());
      const lid = Number(info.lastInsertRowid);
      this.db.prepare('INSERT OR REPLACE INTO letter_reads (user_id, letter_id, read_id) VALUES (?, ?, ?)').run(userId, lid, lid);
      return lid;
    })();
    return {
      thread: this.threadOf(id, userId),
      created: true,
      notice: { userId: book.userId, storyId, letterId: id, kind: 'letter', recipientRole: 'author' },
    };
  }

  /** An answer in a letter's thread: only the book's author and the letter's writer, taking turns. */
  reply(userId: number, letterId: number, body: Record<string, unknown>, beforeInsert: () => void = () => undefined): LetterResult {
    const requestId = this.requestId(body);
    const again = this.replay(userId, requestId, null, letterId);
    if (again) return again;
    const letter = this.one(letterId);
    if (!letter || letter.parent_id !== null) throw new HttpError(404, 'not_found', '편지를 찾을 수 없어요.');
    const book = this.library.book(letter.story_id, userId);
    if (userId !== book.userId && userId !== letter.user_id) throw new HttpError(403, 'not_party', '이 편지를 쓴 분과 글쓴이만 답장할 수 있어요.');
    const replies = this.db.prepare(`${SELECT} WHERE l.parent_id = ? ORDER BY l.id`).all(letter.id) as Row[];
    const state = this.replyState(letter, replies, book, userId);
    if (!state.canReply) {
      const t = this.turn(letter, replies);
      if (t.total >= LETTER_REPLIES_MAX) throw new HttpError(409, 'thread_full', `답장은 ${LETTER_REPLIES_MAX}번까지 주고받을 수 있어요.`);
      if (letter.deleted_at === null && letter.hidden_at === null && letter.author_hidden_at === null && !book.hidden && t.lastUserId === userId) {
        throw new HttpError(409, 'not_your_turn', state.note ?? '상대의 답장을 기다려 주세요.');
      }
      throw new HttpError(403, 'closed', state.note ?? '이 편지에는 더 답장할 수 없어요.');
    }
    this.library.assertCanWrite(userId);
    const text = this.text(body);
    this.library.assertNoPersonal(text, body.confirmPersonal);
    beforeInsert();
    this.db.transaction(() => {
      const info = this.db
        .prepare('INSERT INTO story_letters (story_id, parent_id, user_id, anonymous, text, request_id, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)')
        .run(letter.story_id, letter.id, userId, text, requestId, this.now());
      this.markThreads(userId, [letter.id]);
      return Number(info.lastInsertRowid);
    })();
    const toAuthor = userId === letter.user_id;
    return {
      thread: this.threadOf(letter.id, userId),
      created: true,
      notice: { userId: toAuthor ? book.userId : letter.user_id, storyId: book.id, letterId: letter.id, kind: 'reply', recipientRole: toAuthor ? 'author' : 'writer' },
    };
  }

  /** Its writer takes a letter or reply back: the text is wiped, "삭제된 편지예요" stays in its place. */
  remove(userId: number, id: number): { storyId: number; parties: number[] } {
    const r = this.one(id);
    if (!r || r.user_id !== userId) throw new HttpError(404, 'not_found', '내가 쓴 편지만 지울 수 있어요.');
    if (r.deleted_at === null) this.db.prepare("UPDATE story_letters SET text = '', deleted_at = ? WHERE id = ?").run(this.now(), id);
    return { storyId: r.story_id, parties: this.parties(r) };
  }

  private parties(r: Row): number[] {
    const top = r.parent_id === null ? r : this.one(r.parent_id);
    const s = this.db.prepare('SELECT user_id FROM stories WHERE id = ?').get(r.story_id) as { user_id: number } | undefined;
    return [...new Set([top?.user_id, s?.user_id].filter((x): x is number => typeof x === 'number'))];
  }

  /** The book's author folds a letter (and its thread) away from everyone else, or unfolds it. */
  hide(userId: number, id: number, hidden: unknown): LetterThread {
    const r = this.one(id);
    if (!r || r.parent_id !== null) throw new HttpError(404, 'not_found', '편지를 찾을 수 없어요.');
    const book = this.library.book(r.story_id, userId);
    if (book.userId !== userId) throw new HttpError(404, 'not_found', '내 이야기에 온 편지만 숨길 수 있어요.');
    this.db.prepare('UPDATE story_letters SET author_hidden_at = ? WHERE id = ?').run(hidden === false ? null : this.now(), id);
    return this.threadOf(id, userId);
  }

  report(userId: number, id: number, reasonRaw: unknown): { duplicate: boolean; changed: boolean; storyId: number } {
    if (typeof reasonRaw !== 'string' || !(STORY_REPORT_REASONS as readonly string[]).includes(reasonRaw)) throw new HttpError(400, 'bad_reason', '신고 이유를 골라 주세요.');
    const r = this.one(id);
    if (!r) throw new HttpError(404, 'not_found', '편지를 찾을 수 없어요.');
    const book = this.library.book(r.story_id, userId);
    const letter = r.parent_id === null ? r : this.one(r.parent_id)!;
    if (!this.sees(r, letter, book, userId, false) || r.deleted_at !== null) throw new HttpError(404, 'not_found', '편지를 찾을 수 없어요.');
    if (r.user_id === userId) throw new HttpError(400, 'own_letter', '내 편지는 신고할 수 없어요.');
    return this.db.transaction(() => {
      const added = this.db.prepare('INSERT OR IGNORE INTO letter_reports (letter_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?)').run(id, userId, reasonRaw as StoryReportReason, this.now()).changes;
      const { n } = this.db.prepare('SELECT COUNT(*) n FROM letter_reports WHERE letter_id = ?').get(id) as { n: number };
      let changed = false;
      if (added && n >= STORY_HIDE_REPORTS && r.hidden_at === null && r.review === null) {
        this.db.prepare('UPDATE story_letters SET hidden_at = ? WHERE id = ?').run(this.now(), id);
        changed = true;
      }
      return { duplicate: added === 0, changed, storyId: r.story_id };
    })();
  }

  // ------------------------------------------------------------------ admin

  adminList() {
    const rows = this.db
      .prepare(
        `SELECT l.*, u.nickname AS nickname, s.title AS story_title, s.visibility AS story_visibility, s.user_id AS story_user,
           p.anonymous AS parent_anonymous
         FROM story_letters l JOIN users u ON u.id = l.user_id JOIN stories s ON s.id = l.story_id LEFT JOIN story_letters p ON p.id = l.parent_id
         WHERE l.hidden_at IS NOT NULL OR EXISTS (SELECT 1 FROM letter_reports r WHERE r.letter_id = l.id)
         ORDER BY (l.review IS NULL) DESC, (SELECT MAX(created_at) FROM letter_reports r WHERE r.letter_id = l.id) DESC LIMIT 200`,
      )
      .all() as (Row & { story_title: string; story_visibility: StoryVisibility; story_user: number; parent_anonymous: number | null })[];
    const reasons = this.db.prepare('SELECT reason, COUNT(*) n FROM letter_reports WHERE letter_id = ? GROUP BY reason');
    return rows.map((r) => {
      const rs = reasons.all(r.id) as { reason: string; n: number }[];
      const role = r.user_id === r.story_user ? 'author' : 'writer';
      return {
        id: r.id,
        storyId: r.story_id,
        storyTitle: r.story_title,
        reply: r.parent_id !== null,
        role,
        writer: r.nickname ?? '',
        // Shown masked to others: anonymous letter (or its writer's replies) / anonymous book's author.
        anonymous: role === 'author' ? r.story_visibility === 'anonymous' : (r.parent_id === null ? r.anonymous : (r.parent_anonymous ?? 0)) === 1,
        text: r.deleted_at !== null ? '' : r.text,
        deleted: r.deleted_at !== null,
        hidden: r.hidden_at !== null,
        review: r.review,
        reporters: rs.reduce((a, x) => a + x.n, 0),
        reasons: Object.fromEntries(rs.map((x) => [x.reason, x.n])),
        createdAt: new Date(r.created_at).toISOString(),
      };
    });
  }

  /** 복구 · 숨김 유지 · 삭제 (a letter's deletion takes its whole thread). */
  adminAction(id: number, action: unknown): { storyId: number; parties: number[] } {
    const r = this.one(id);
    if (!r) throw new HttpError(404, 'not_found', '편지를 찾을 수 없어요.');
    const parties = this.parties(r);
    const now = this.now();
    if (action === 'restore') this.db.prepare("UPDATE story_letters SET hidden_at = NULL, review = 'restored', reviewed_at = ? WHERE id = ?").run(now, id);
    else if (action === 'hide') this.db.prepare("UPDATE story_letters SET hidden_at = COALESCE(hidden_at, ?), review = 'kept', reviewed_at = ? WHERE id = ?").run(now, now, id);
    else if (action === 'delete') this.db.prepare('DELETE FROM story_letters WHERE id = ?').run(id);
    else throw new HttpError(400, 'bad_action', '알 수 없는 조치예요.');
    return { storyId: r.story_id, parties };
  }

  // ------------------------------------------------------------------ 내 데이터

  /** My own letters and replies (my words only), my letter reports. */
  export(userId: number) {
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    const mine = this.db
      .prepare(
        `SELECT l.*, s.title AS story_title, s.user_id = l.user_id AS on_own_book FROM story_letters l JOIN stories s ON s.id = l.story_id
         WHERE l.user_id = ? ORDER BY l.created_at`,
      )
      .all(userId) as (Row & { story_title: string; on_own_book: number })[];
    const reports = this.db.prepare('SELECT letter_id, reason, created_at FROM letter_reports WHERE reporter_id = ? ORDER BY created_at').all(userId) as {
      letter_id: number;
      reason: string;
      created_at: number;
    }[];
    return {
      lettersWritten: mine.map((r) => ({
        id: r.id,
        storyId: r.story_id,
        storyTitle: r.story_title,
        replyTo: r.parent_id,
        as: r.on_own_book ? '글쓴이 답장' : r.parent_id === null ? '편지' : '편지 쓴 분의 답장',
        anonymous: r.anonymous === 1,
        text: r.deleted_at !== null ? '' : r.text,
        createdAt: iso(r.created_at),
        deletedAt: iso(r.deleted_at),
        hiddenAfterReports: r.hidden_at !== null,
        hiddenByBookAuthor: r.author_hidden_at !== null,
      })),
      letterReportsMade: reports.map((r) => ({ letterId: r.letter_id, reason: r.reason, createdAt: iso(r.created_at) })),
      lettersReceivedOnMyBooks: (
        this.db.prepare('SELECT COUNT(*) n FROM story_letters l JOIN stories s ON s.id = l.story_id WHERE s.user_id = ? AND l.user_id <> ?').get(userId, userId) as { n: number }
      ).n,
    };
  }
}
