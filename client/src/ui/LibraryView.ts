import {
  DIARY_NOTE_MAX,
  DIARY_PHOTOS_MAX,
  SHELF_IDS,
  SHELVES,
  STORY_BODY_MAX,
  STORY_PROMPTS,
  STORY_REACTIONS,
  STORY_REACTION_LABELS,
  STORY_REPORT_LABELS,
  STORY_REPORT_REASONS,
  STORY_TITLE_MAX,
  TESTIMONY_SHELVES,
  VISIBILITY_LABELS,
  type ShelfId,
  type StoryDetail,
  type StoryItem,
  type StoryReportReason,
  type StoryVisibility,
  type TestimonyShelf,
} from '../../../shared/protocol';
import { api, ApiError } from '../net/api';
import { button, el, koreanDate, Modal } from './dom';

export interface ShotInfo {
  id: number;
  date: string;
  place: string;
  width: number;
  height: number;
  bytes: number;
  createdAt: string;
  url: string;
  inDiary: boolean;
}

interface DiaryDraft {
  date: string;
  word: { ref: string; text: string } | null;
  lines: { key: string; text: string }[];
  photos: ShotInfo[];
  existing: StoryDetail | null;
  defaultVisibility: StoryVisibility;
  groups: { id: number; name: string }[];
  footprintsOn: boolean;
}

interface TestimonyDraft {
  title: string;
  parts: string[];
  shelf: TestimonyShelf | null;
  ref: string;
  step: number;
}

export type LibraryList = ShelfId | 'today' | 'popular';
export type MineTab = 'stories' | 'diaries' | 'bookmarks' | 'album';

type Page =
  | { kind: 'shelf'; shelf: LibraryList }
  | { kind: 'story'; id: number }
  | { kind: 'mine'; tab: MineTab }
  | { kind: 'desk' }
  | { kind: 'write'; editId: number | null }
  | { kind: 'diary' }
  | { kind: 'report'; id: number };

export interface LibraryHooks {
  signedIn: () => boolean;
  needLogin: (reason: string) => void;
  toast: (text: string) => void;
  /** Books changed (refresh the 3D shelves). */
  changed: () => void;
}

const LIST_TITLES: Record<'today' | 'popular', string> = { today: '🆕 오늘 꽂힌 책', popular: '💛 이번 주 많이 공감받은 책' };
const listTitle = (l: LibraryList) => (l === 'today' || l === 'popular' ? LIST_TITLES[l] : `${SHELVES[l].emoji} ${SHELVES[l].name}`);
const shortDate = (iso: string) => {
  const d = new Date(Date.parse(iso) + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`;
};
const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/**
 * 📚 이야기 도서관 sheets, one modal with pages: a shelf list (paged), the book
 * reader (공감, 책갈피, 신고, readers), 나의 서재 (my stories, my diaries,
 * bookmarks, 오늘 앨범), the ✍️ 쓰는 책상, the guided testimony form (draft
 * autosaved on the server) and the 📔 오늘의 일기 editor. Every text is set
 * with textContent; the server decides who may see what.
 */
export class LibraryView {
  private readonly modal = new Modal('library-overlay', '이야기 도서관');
  private page: Page = { kind: 'desk' };
  private history: Page[] = [];
  private status: HTMLParagraphElement | null = null;
  /** Last loaded list (tests and paging). */
  private items: StoryItem[] = [];
  private listPage = 0;
  private hasMore = false;
  private story: StoryDetail | null = null;
  private draft: TestimonyDraft = { title: '', parts: ['', '', ''], shelf: null, ref: '', step: 0 };
  private draftTimer = 0;
  private draftSavedAt: string | null = null;
  private diary: DiaryDraft | null = null;
  private diaryLines: string[] = [];
  private diaryNote = '';
  private diaryPhotos = new Set<number>();
  private visibility: StoryVisibility = 'public';
  private groupId: number | null = null;
  private groups: { id: number; name: string }[] = [];
  private personalWarning = '';
  private lastPublished: number | null = null;

  constructor(private readonly hooks: LibraryHooks) {}

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  describe() {
    return {
      open: this.modal.isOpen,
      page: this.modal.isOpen ? this.page.kind : null,
      list: this.page.kind === 'shelf' ? this.page.shelf : null,
      items: this.items.map((i) => ({ id: i.id, title: i.title, author: i.author, read: i.read, mine: i.mine, bookmarked: i.bookmarked, readers: i.readers })),
      hasMore: this.hasMore,
      story: this.story ? { id: this.story.id, readers: this.story.readers, reactions: this.story.reactions, mine: this.story.myReactions, bookmarked: this.story.bookmarked, hidden: this.story.hidden } : null,
      writeStep: this.page.kind === 'write' ? this.draft.step : null,
      draftSavedAt: this.draftSavedAt,
      diaryLines: this.page.kind === 'diary' ? [...this.diaryLines] : null,
      diaryVisibility: this.page.kind === 'diary' ? this.visibility : null,
      personalWarning: this.personalWarning,
      lastPublished: this.lastPublished,
    };
  }

  // ------------------------------------------------------------------ navigation

  private show(page: Page, push = true) {
    if (push && this.modal.isOpen) this.history.push(this.page);
    if (!push) this.history = [];
    this.page = page;
    this.personalWarning = '';
    if (!this.modal.isOpen) this.modal.open(() => this.flushDraft());
    void this.render();
  }

  private back() {
    const prev = this.history.pop();
    if (prev) {
      this.page = prev;
      void this.render();
    } else this.modal.close();
  }

  openShelf(shelf: LibraryList) {
    this.listPage = 0;
    this.show({ kind: 'shelf', shelf }, false);
  }

  openStory(id: number) {
    this.show({ kind: 'story', id }, this.modal.isOpen);
  }

  openMine(tab: MineTab = 'stories') {
    if (!this.hooks.signedIn()) return this.hooks.needLogin('로그인하면 내가 쓴 이야기와 일기, 책갈피를 나의 서재에 모아 볼 수 있어요.');
    this.show({ kind: 'mine', tab }, false);
  }

  openDesk() {
    this.show({ kind: 'desk' }, false);
  }

  openWrite(editId: number | null = null) {
    if (!this.hooks.signedIn()) return this.hooks.needLogin('로그인하면 나의 하나님 이야기를 써서 도서관에 꽂을 수 있어요.');
    if (editId !== null) this.editLoaded = null;
    else if (this.editLoaded !== null) {
      // Leaving an edit: start the new story from the saved draft, not the edited book.
      this.draft = { title: '', parts: ['', '', ''], shelf: null, ref: '', step: 0 };
      this.draftDirty = false;
      this.editLoaded = null;
    }
    this.show({ kind: 'write', editId }, this.modal.isOpen);
  }

  openDiary() {
    if (!this.hooks.signedIn()) return this.hooks.needLogin('로그인하면 오늘 QT 월드에서 보낸 하루가 일기로 써져요.');
    this.show({ kind: 'diary' }, this.modal.isOpen);
  }

  close() {
    this.modal.close();
  }

  private header(title: string, backable = this.history.length > 0): HTMLElement {
    const top = el('header', 'book-top lib-top');
    if (backable) {
      const b = button('← 뒤로', 'ghost', () => this.back());
      b.id = 'lib-back';
      top.append(b);
    }
    top.append(el('h2', 'book-title', title));
    const close = button('닫기', 'ghost', () => this.modal.close());
    close.id = 'lib-close';
    top.append(close);
    return top;
  }

  private say(text: string) {
    if (this.status) this.status.textContent = text;
  }

  private async render() {
    const sheet = this.modal.sheet;
    sheet.className = `sheet library lib-page-${this.page.kind}`;
    const body = el('div', 'lib-body');
    this.status = el('p', 'groups-status lib-status');
    this.status.setAttribute('role', 'status');
    const page = this.page;
    try {
      switch (page.kind) {
        case 'shelf':
          sheet.replaceChildren(this.header(listTitle(page.shelf)), body, this.status);
          await this.renderShelf(body, page.shelf);
          break;
        case 'story':
          sheet.replaceChildren(this.header('📖 책 읽기'), body, this.status);
          await this.renderStory(body, page.id);
          break;
        case 'mine':
          sheet.replaceChildren(this.header('📚 나의 서재'), body, this.status);
          await this.renderMine(body, page.tab);
          break;
        case 'desk':
          sheet.replaceChildren(this.header('✍️ 쓰는 책상'), body, this.status);
          this.renderDesk(body);
          break;
        case 'write':
          sheet.replaceChildren(this.header(page.editId ? '🙏 이야기 고치기' : '🙏 나의 하나님 이야기'), body, this.status);
          await this.renderWrite(body, page.editId);
          break;
        case 'diary':
          sheet.replaceChildren(this.header('📔 오늘의 일기'), body, this.status);
          await this.renderDiary(body);
          break;
        case 'report':
          sheet.replaceChildren(this.header('🚩 신고하기'), body, this.status);
          this.renderReport(body, page.id);
          break;
      }
    } catch (err) {
      body.replaceChildren(el('p', 'groups-error', message(err, '도서관을 불러오지 못했어요.')));
    }
  }

  // ------------------------------------------------------------------ lists

  private chips(current: LibraryList): HTMLElement {
    const row = el('div', 'lib-chips');
    row.setAttribute('role', 'tablist');
    const all: LibraryList[] = ['today', ...SHELF_IDS, 'popular'];
    for (const id of all) {
      const label = id === 'today' ? '🆕 오늘' : id === 'popular' ? '💛 이번 주' : `${SHELVES[id].emoji} ${SHELVES[id].name}`;
      const b = button(label, current === id ? 'tab on' : 'tab', () => this.openShelf(id));
      b.id = `lib-chip-${id}`;
      b.setAttribute('aria-selected', String(current === id));
      row.append(b);
    }
    return row;
  }

  private bookCard(s: StoryItem): HTMLElement {
    const card = button('', `lib-book${s.read ? ' read' : ''}${s.hidden ? ' hidden-book' : ''}`, () => this.openStory(s.id));
    card.dataset.id = String(s.id);
    const spine = el('span', `lib-spine shelf-${s.shelf}`);
    spine.setAttribute('aria-hidden', 'true');
    const text = el('span', 'lib-book-text');
    text.append(el('span', 'lib-book-title', s.title));
    const meta = el('span', 'lib-book-meta');
    meta.append(el('span', '', s.author), el('span', '', shortDate(s.createdAt)));
    if (s.visibility !== 'public') meta.append(el('span', 'lib-badge', s.visibility === 'group' ? `모임 · ${s.group ?? ''}` : VISIBILITY_LABELS[s.visibility]));
    text.append(meta, el('span', 'lib-book-excerpt', s.excerpt));
    const foot = el('span', 'lib-book-foot');
    const hearts = STORY_REACTIONS.reduce((n, r) => n + s.reactions[r], 0);
    foot.append(
      el('span', s.read ? 'lib-state read' : 'lib-state new', s.mine ? '내 책' : s.read ? '✓ 읽었어요' : '새 이야기'),
      el('span', '', `📖 ${s.readers}`),
      el('span', '', `💛 ${hearts}`),
    );
    if (s.bookmarked) foot.append(el('span', '', '🔖'));
    if (s.photos) foot.append(el('span', '', `📸 ${s.photos}`));
    if (s.hidden) foot.append(el('span', 'lib-badge warn', '신고로 숨겨짐'));
    text.append(foot);
    card.append(spine, text);
    return card;
  }

  private async renderShelf(body: HTMLElement, shelf: LibraryList) {
    body.append(this.chips(shelf));
    if (shelf !== 'today' && shelf !== 'popular') body.append(el('p', 'lib-blurb', SHELVES[shelf].blurb));
    const list = el('div', 'lib-list');
    list.id = 'lib-list';
    body.append(list);
    if (shelf === 'today' || shelf === 'popular') {
      const r = await api<{ items: StoryItem[] }>('GET', `/api/library/${shelf}`);
      this.items = r.items;
      this.hasMore = false;
    } else {
      const r = await api<{ items: StoryItem[]; hasMore: boolean }>('GET', `/api/library/shelves/${shelf}?page=${this.listPage}`);
      this.items = this.listPage === 0 ? r.items : [...this.items, ...r.items];
      this.hasMore = r.hasMore;
    }
    if (!this.items.length) list.append(el('p', 'book-none', shelf === 'popular' ? '이번 주에 공감받은 책이 아직 없어요.' : '아직 꽂힌 책이 없어요. 첫 이야기를 꽂아 보세요.'));
    for (const s of this.items) list.append(this.bookCard(s));
    if (this.hasMore) {
      const more = button('더 보기', '', () => {
        this.listPage++;
        void this.render();
      });
      more.id = 'lib-more';
      body.append(more);
    }
    const actions = el('div', 'lib-actions');
    const write = button('✍️ 이야기 쓰기', 'primary', () => this.openWrite());
    write.id = 'lib-write';
    const mine = button('📚 나의 서재', '', () => this.openMine());
    mine.id = 'lib-mine';
    actions.append(write, mine);
    body.append(actions);
  }

  // ------------------------------------------------------------------ reader

  private async renderStory(body: HTMLElement, id: number) {
    const s = await api<StoryDetail>('GET', `/api/library/stories/${id}`);
    this.story = s;
    const paper = el('article', `book-page lib-story kind-${s.kind}`);
    paper.id = 'lib-story';
    if (s.hidden && s.mine) {
      const n = el('p', 'lib-notice');
      n.id = 'lib-hidden-notice';
      n.textContent = '신고가 쌓여 이 책은 다른 분께 보이지 않아요. 운영자가 살펴본 뒤 다시 보이거나 숨김이 유지돼요.';
      paper.append(n);
    }
    paper.append(el('p', 'book-date', `${SHELVES[s.shelf].emoji} ${SHELVES[s.shelf].name} · ${s.kind === 'diary' ? koreanDate(s.date) : shortDate(s.createdAt)}`));
    paper.append(el('h3', 'lib-story-title', s.title));
    const by = el('p', 'lib-story-by');
    by.append(el('span', 'lib-author', s.author));
    if (s.visibility !== 'public') by.append(el('span', 'lib-badge', s.visibility === 'group' ? `모임 · ${s.group ?? ''}` : VISIBILITY_LABELS[s.visibility]));
    if (s.visibility === 'anonymous') by.append(el('span', 'lib-soft', '익명으로 쓰였어요'));
    paper.append(by);
    if (s.ref && s.verse) {
      const q = el('blockquote', 'lib-verse');
      q.append(el('span', 'lib-verse-text', s.verse), el('cite', '', s.ref));
      paper.append(q);
    }
    if (s.kind === 'testimony') {
      s.parts.forEach((p, i) => {
        if (!p) return;
        paper.append(el('p', 'lib-prompt', STORY_PROMPTS[i] ?? ''), el('p', 'lib-part', p));
      });
    } else {
      const ul = el('ul', 'lib-diary-lines');
      for (const line of s.parts) ul.append(el('li', '', line));
      paper.append(ul);
      if (s.photoIds.length) {
        const photos = el('div', 'lib-photos');
        for (const pid of s.photoIds) {
          const img = el('img', 'lib-photo');
          img.src = `/api/shots/${pid}`;
          img.alt = 'QT 월드에서 찍은 사진';
          img.loading = 'lazy';
          photos.append(img);
        }
        paper.append(photos);
      }
      if (s.note) paper.append(el('p', 'lib-note', `✏️ ${s.note}`));
    }
    const readers = el('p', 'lib-readers', `📖 ${s.readers}명이 읽었어요`);
    readers.id = 'lib-readers';
    paper.append(readers);
    body.append(paper);

    const reacts = el('div', 'lib-reacts');
    for (const r of STORY_REACTIONS) {
      const on = s.myReactions.includes(r);
      const b = button(`${r === 'grace' ? '💛' : r === 'same' ? '🤝' : '🙏'} ${STORY_REACTION_LABELS[r]} ${s.reactions[r]}`, on ? 'chip on' : 'chip', () => void this.react(s.id, r));
      b.id = `lib-react-${r}`;
      b.setAttribute('aria-pressed', String(on));
      reacts.append(b);
    }
    body.append(reacts);
    const actions = el('div', 'lib-actions');
    const mark = button(s.bookmarked ? '🔖 책갈피 빼기' : '🔖 책갈피', s.bookmarked ? 'chip on' : 'chip', () => void this.bookmark(s.id));
    mark.id = 'lib-bookmark';
    actions.append(mark);
    if (s.mine) {
      if (s.kind === 'testimony') {
        const edit = button('고치기', '', () => this.openWrite(s.id));
        edit.id = 'lib-edit';
        actions.append(edit);
      } else {
        const edit = button('일기 고치기', '', () => this.openDiary());
        edit.id = 'lib-edit';
        actions.append(edit);
      }
      const del = button('도서관에서 빼기', 'ghost danger', () => void this.remove(s.id));
      del.id = 'lib-delete';
      actions.append(del);
    } else {
      const rep = button('🚩 신고', 'ghost', () => {
        if (!this.hooks.signedIn()) return this.hooks.needLogin('로그인하면 불편한 글을 신고할 수 있어요.');
        this.show({ kind: 'report', id: s.id });
      });
      rep.id = 'lib-report';
      actions.append(rep);
    }
    body.append(actions);
    // ✉️ 답장 편지 (L-B) will be added below this point.
  }

  private async react(id: number, type: (typeof STORY_REACTIONS)[number]) {
    if (!this.hooks.signedIn()) return this.hooks.needLogin('로그인하면 마음에 닿은 이야기에 공감을 남길 수 있어요.');
    try {
      this.story = await api<StoryDetail>('POST', `/api/library/stories/${id}/reactions`, { type });
      await this.render();
    } catch (err) {
      this.say(message(err, '공감을 남기지 못했어요.'));
    }
  }

  private async bookmark(id: number) {
    if (!this.hooks.signedIn()) return this.hooks.needLogin('로그인하면 마음에 남은 이야기에 책갈피를 꽂아 둘 수 있어요.');
    try {
      const r = await api<{ bookmarked: boolean }>('POST', `/api/library/stories/${id}/bookmark`);
      this.hooks.toast(r.bookmarked ? '🔖 책갈피를 꽂았어요. 나의 서재에서 다시 볼 수 있어요.' : '책갈피를 뺐어요.');
      await this.render();
    } catch (err) {
      this.say(message(err, '책갈피를 꽂지 못했어요.'));
    }
  }

  private async remove(id: number) {
    if (!window.confirm('이 책을 도서관에서 뺄까요? 되돌릴 수 없어요.')) return;
    try {
      await api('DELETE', `/api/library/stories/${id}`);
      this.hooks.toast('책을 도서관에서 뺐어요.');
      this.hooks.changed();
      this.openMine(this.story?.kind === 'diary' ? 'diaries' : 'stories');
    } catch (err) {
      this.say(message(err, '빼지 못했어요.'));
    }
  }

  private renderReport(body: HTMLElement, id: number) {
    body.append(el('p', 'settings-note', '어떤 점이 불편했나요? 신고한 분은 작성자에게 알려지지 않아요. 서로 다른 세 분이 신고하면 운영자가 살펴볼 때까지 숨겨져요.'));
    let reason: StoryReportReason | null = null;
    const list = el('div', 'lib-reasons');
    for (const r of STORY_REPORT_REASONS) {
      const b = button(STORY_REPORT_LABELS[r], 'chip', () => {
        reason = r;
        for (const c of list.children) c.classList.toggle('on', c === b);
      });
      b.id = `lib-reason-${r}`;
      list.append(b);
    }
    const send = button('신고하기', 'primary', async () => {
      if (!reason) return this.say('신고 이유를 골라 주세요.');
      send.disabled = true;
      try {
        const r = await api<{ duplicate: boolean }>('POST', `/api/library/stories/${id}/report`, { reason });
        this.hooks.toast(r.duplicate ? '이미 신고한 책이에요.' : '신고를 받았어요. 고마워요.');
        this.hooks.changed();
        this.back();
      } catch (err) {
        send.disabled = false;
        this.say(message(err, '신고하지 못했어요.'));
      }
    });
    send.id = 'lib-report-send';
    body.append(list, send);
  }

  // ------------------------------------------------------------------ 나의 서재

  private async renderMine(body: HTMLElement, tab: MineTab) {
    const tabs = el('div', 'book-tabs');
    const labels: Record<MineTab, string> = { stories: '내 이야기', diaries: '내 일기', bookmarks: '🔖 책갈피', album: '📸 오늘 앨범' };
    for (const t of Object.keys(labels) as MineTab[]) {
      const b = button(labels[t], t === tab ? 'tab on' : 'tab', () => this.show({ kind: 'mine', tab: t }, false));
      b.id = `lib-mine-${t}`;
      tabs.append(b);
    }
    body.append(tabs);
    if (tab === 'album') return this.renderAlbum(body);
    const r = await api<{ stories: StoryItem[]; diaries: StoryItem[]; bookmarks: StoryItem[] }>('GET', '/api/library/mine');
    this.items = r[tab];
    const list = el('div', 'lib-list');
    list.id = 'lib-list';
    if (!this.items.length) {
      list.append(
        el('p', 'book-none', tab === 'stories' ? '아직 쓴 이야기가 없어요.' : tab === 'diaries' ? '아직 꽂은 일기가 없어요.' : '책갈피를 꽂은 책이 아직 없어요. 책을 읽다가 🔖를 눌러 보세요.'),
      );
    }
    for (const s of this.items) list.append(this.bookCard(s));
    body.append(list);
    const actions = el('div', 'lib-actions');
    if (tab === 'stories') {
      const w = button('✍️ 이야기 쓰기', 'primary', () => this.openWrite());
      w.id = 'lib-write';
      actions.append(w);
    } else if (tab === 'diaries') {
      const d = button('📔 오늘 일기 쓰기', 'primary', () => this.openDiary());
      d.id = 'lib-diary';
      actions.append(d);
    }
    body.append(actions);
  }

  private async renderAlbum(body: HTMLElement) {
    const r = await api<{ shots: ShotInfo[]; usedToday: number }>('GET', '/api/shots');
    body.append(el('p', 'settings-note', `오늘 ${r.usedToday}장 찍었어요 (하루 10장까지). 일기에 넣지 않은 사진은 30일 뒤 지워져요. 일기에 넣기 전에는 나만 볼 수 있어요.`));
    const grid = el('div', 'lib-album');
    grid.id = 'lib-album';
    if (!r.shots.length) grid.append(el('p', 'book-none', '아직 찍은 사진이 없어요. 화면 오른쪽 아래 📷 버튼(PC는 P 키)으로 찍어 보세요.'));
    for (const s of r.shots) {
      const fig = el('figure', 'lib-album-item');
      const img = el('img');
      img.src = s.url;
      img.alt = `${s.place} 사진`;
      img.loading = 'lazy';
      const cap = el('figcaption', '', `${shortDate(s.createdAt)} · ${s.place || 'QT 월드'}${s.inDiary ? ' · 일기에 넣음' : ''}`);
      const del = button('지우기', 'ghost', async () => {
        if (!window.confirm('이 사진을 지울까요?')) return;
        try {
          await api('DELETE', `/api/shots/${s.id}`);
          await this.render();
        } catch (err) {
          this.say(message(err, '지우지 못했어요.'));
        }
      });
      fig.append(img, cap, del);
      grid.append(fig);
    }
    body.append(grid);
  }

  // ------------------------------------------------------------------ 쓰는 책상

  private renderDesk(body: HTMLElement) {
    body.append(el('p', 'settings-note', '조용한 책상에 앉아 이야기를 남겨 보세요.'));
    const list = el('div', 'settings-menu lib-desk');
    const item = (id: string, icon: string, label: string, hint: string, fn: () => void) => {
      const b = button('', 'settings-item', fn);
      b.id = id;
      const t = el('span', 'settings-item-text');
      t.append(el('span', 'settings-item-label', label), el('span', 'settings-item-hint', hint));
      b.append(el('span', 'settings-item-icon', icon), t, el('span', 'settings-item-chev', '›'));
      list.append(b);
    };
    item('lib-desk-write', '🙏', '나의 하나님 이야기 쓰기', '세 가지 질문을 따라 간증을 써요', () => this.openWrite());
    item('lib-desk-diary', '📔', '오늘 일기 쓰기', '오늘의 발자취로 일기가 써져요. 고치고 한 줄 덧붙여요', () => this.openDiary());
    item('lib-desk-mine', '📚', '나의 서재', '내 이야기, 내 일기, 책갈피, 오늘 앨범', () => this.openMine());
    item('lib-desk-today', '🆕', '오늘 꽂힌 책', '오늘 도서관에 새로 꽂힌 책', () => this.openShelf('today'));
    body.append(list);
  }

  // ------------------------------------------------------------------ visibility picker

  private visibilityPicker(includeHint: string): HTMLElement {
    const box = el('div', 'lib-visibility');
    box.append(el('p', 'lib-label', '누구에게 보일까요?'));
    const row = el('div', 'lib-chips');
    const select = el('select', 'lib-group');
    select.id = 'lib-group';
    select.setAttribute('aria-label', '모임 고르기');
    for (const g of this.groups) {
      const o = el('option', '', g.name);
      o.value = String(g.id);
      select.append(o);
    }
    if (this.groupId !== null) select.value = String(this.groupId);
    select.addEventListener('change', () => (this.groupId = Number(select.value)));
    const sync = () => {
      for (const c of row.children) c.classList.toggle('on', (c as HTMLElement).dataset.v === this.visibility);
      select.hidden = this.visibility !== 'group';
    };
    for (const v of ['public', 'group', 'anonymous', 'private'] as StoryVisibility[]) {
      const b = button(VISIBILITY_LABELS[v], 'chip', () => {
        if (v === 'group' && !this.groups.length) return this.say('함께하는 모임이 있어야 모임에 나눌 수 있어요.');
        this.visibility = v;
        if (v === 'group' && this.groupId === null) this.groupId = this.groups[0]?.id ?? null;
        sync();
      });
      b.dataset.v = v;
      b.id = `lib-vis-${v}`;
      row.append(b);
    }
    sync();
    box.append(row, select, el('p', 'settings-note', includeHint));
    return box;
  }

  private warningBox(onConfirm: () => void): HTMLElement {
    const box = el('div', 'lib-warning');
    box.id = 'lib-personal-warning';
    box.hidden = !this.personalWarning;
    box.append(el('p', '', this.personalWarning));
    const ok = button('그래도 올리기', 'primary', onConfirm);
    ok.id = 'lib-personal-confirm';
    const fix = button('고칠게요', '', () => {
      this.personalWarning = '';
      box.hidden = true;
    });
    box.append(ok, fix);
    return box;
  }

  private async loadGroups() {
    try {
      this.groups = (await api<{ groups: { id: number; name: string }[] }>('GET', '/api/groups')).groups.map((g) => ({ id: g.id, name: g.name }));
    } catch {
      this.groups = [];
    }
  }

  // ------------------------------------------------------------------ 🙏 testimony form

  private async renderWrite(body: HTMLElement, editId: number | null) {
    await this.loadGroups();
    if (editId && this.editLoaded !== editId) {
      const s = await api<StoryDetail>('GET', `/api/library/stories/${editId}`);
      this.editLoaded = editId;
      this.draft = { title: s.title, parts: [...s.parts, '', '', ''].slice(0, 3), shelf: s.shelf === 'diary' ? null : s.shelf, ref: s.ref ?? '', step: 0 };
      this.visibility = s.visibility;
      this.groupId = s.groupId;
    } else if (!editId) {
      const d = await api<{ draft: TestimonyDraft | null; updatedAt: string | null }>('GET', '/api/library/draft').catch(() => ({ draft: null, updatedAt: null }));
      if (d.draft && !this.draftDirty) {
        this.draft = { title: d.draft.title ?? '', parts: [...(d.draft.parts ?? []), '', '', ''].slice(0, 3), shelf: d.draft.shelf ?? null, ref: d.draft.ref ?? '', step: d.draft.step ?? 0 };
        this.draftSavedAt = d.updatedAt;
      }
      if (!this.visibilityTouched) this.visibility = 'public';
    }
    this.renderWriteStep(body, editId);
  }

  private draftDirty = false;
  private editLoaded: number | null = null;
  private visibilityTouched = false;

  private scheduleDraft() {
    this.draftDirty = true;
    if (this.page.kind !== 'write' || this.page.editId) return;
    window.clearTimeout(this.draftTimer);
    this.draftTimer = window.setTimeout(() => void this.saveDraft(), 1200);
  }

  private async saveDraft() {
    window.clearTimeout(this.draftTimer);
    this.draftTimer = 0;
    try {
      const r = await api<{ updatedAt: string }>('PUT', '/api/library/draft', { draft: this.draft });
      this.draftSavedAt = r.updatedAt;
      const s = document.getElementById('lib-draft-state');
      if (s) s.textContent = '임시 저장했어요';
    } catch {
      /* the next keystroke tries again */
    }
  }

  private flushDraft() {
    if (this.draftTimer) void this.saveDraft();
  }

  private renderWriteStep(body: HTMLElement, editId: number | null) {
    const d = this.draft;
    const steps = STORY_PROMPTS.length;
    const total = () => d.parts.reduce((n, p) => n + [...p].length, 0);
    const progress = el('div', 'lib-steps');
    for (let i = 0; i <= steps; i++) progress.append(el('span', i === d.step ? 'on' : i < d.step ? 'done' : '', i < steps ? String(i + 1) : '✓'));
    body.append(progress);
    const counter = el('p', 'lib-count', `${total()} / ${STORY_BODY_MAX}자`);
    if (d.step < steps) {
      const i = d.step;
      body.append(el('p', 'lib-prompt-big', STORY_PROMPTS[i]));
      const ta = el('textarea', 'lib-textarea');
      ta.id = `lib-part-${i}`;
      ta.rows = 8;
      ta.value = d.parts[i];
      ta.placeholder = ['그때의 나, 그때의 마음을 떠올려 적어 보세요.', '어떤 말씀, 어떤 사람, 어떤 순간이었나요?', '오늘의 나는 어떻게 달라졌나요?'][i];
      ta.addEventListener('input', () => {
        d.parts[i] = ta.value;
        counter.textContent = `${total()} / ${STORY_BODY_MAX}자`;
        counter.classList.toggle('over', total() > STORY_BODY_MAX);
        this.scheduleDraft();
      });
      body.append(ta, counter);
    } else {
      const title = el('input', 'lib-input');
      title.id = 'lib-title';
      title.maxLength = STORY_TITLE_MAX * 2;
      title.placeholder = '제목 (예: 광야에서 들은 세미한 소리)';
      title.value = d.title;
      title.addEventListener('input', () => {
        d.title = title.value;
        this.scheduleDraft();
      });
      body.append(el('p', 'lib-label', '제목'), title, el('p', 'lib-label', '어느 서가에 꽂을까요?'));
      const shelves = el('div', 'lib-chips');
      for (const id of TESTIMONY_SHELVES) {
        const b = button(`${SHELVES[id].emoji} ${SHELVES[id].name}`, d.shelf === id ? 'chip on' : 'chip', () => {
          d.shelf = id;
          for (const c of shelves.children) c.classList.toggle('on', c === b);
          this.scheduleDraft();
        });
        b.id = `lib-shelf-${id}`;
        shelves.append(b);
      }
      const ref = el('input', 'lib-input');
      ref.id = 'lib-ref';
      ref.placeholder = '관련 성경 구절 (선택, 예: 시편 23:1-3)';
      ref.value = d.ref;
      ref.addEventListener('input', () => {
        d.ref = ref.value;
        this.scheduleDraft();
      });
      body.append(shelves, el('p', 'lib-label', '관련 성경 구절 (선택)'), ref);
      const picker = this.visibilityPicker('익명 공개는 다른 분께 "익명의 성도"로 보여요. 모임은 그 모임 사람만, 나만은 나만 볼 수 있어요.');
      picker.addEventListener('click', () => (this.visibilityTouched = true));
      body.append(picker, counter);
    }
    const publish = async (confirmPersonal: boolean) => {
      if (!d.shelf) return this.say('꽂을 서가를 골라 주세요.');
      try {
        const payload = { title: d.title, parts: d.parts, shelf: d.shelf, ref: d.ref, visibility: this.visibility, groupId: this.groupId, confirmPersonal };
        const s = editId ? await api<StoryDetail>('PUT', `/api/library/stories/${editId}`, payload) : await api<StoryDetail>('POST', '/api/library/stories', payload);
        window.clearTimeout(this.draftTimer);
        this.draftTimer = 0;
        this.draft = { title: '', parts: ['', '', ''], shelf: null, ref: '', step: 0 };
        this.draftDirty = false;
        this.visibilityTouched = false;
        this.lastPublished = s.id;
        this.hooks.toast(editId ? '이야기를 고쳤어요.' : `📚 ${SHELVES[s.shelf].name} 서가에 이야기를 꽂았어요.`);
        this.hooks.changed();
        this.history = [];
        this.show({ kind: 'story', id: s.id }, false);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'personal_info') {
          this.personalWarning = err.message;
          const w = document.getElementById('lib-personal-warning');
          if (w) {
            w.hidden = false;
            w.querySelector('p')!.textContent = err.message;
          }
          return;
        }
        this.say(message(err, '꽂지 못했어요.'));
      }
    };
    body.append(this.warningBox(() => void publish(true)));
    const nav = el('div', 'lib-actions');
    if (d.step > 0) {
      const prev = button('이전', '', () => {
        d.step--;
        this.scheduleDraft();
        void this.render();
      });
      prev.id = 'lib-prev';
      nav.append(prev);
    }
    if (d.step < steps) {
      const next = button('다음', 'primary', () => {
        d.step++;
        this.scheduleDraft();
        void this.render();
      });
      next.id = 'lib-next';
      nav.append(next);
    } else {
      const go = button(editId ? '고쳐서 꽂기' : '📚 도서관에 꽂기', 'primary', () => void publish(false));
      go.id = 'lib-publish';
      nav.append(go);
    }
    if (!editId) {
      const save = button('임시 저장', 'ghost', () => void this.saveDraft());
      save.id = 'lib-save-draft';
      nav.append(save);
    }
    body.append(nav);
    const state = el('p', 'lib-soft', this.draftSavedAt ? '임시 저장했어요' : '쓰는 동안 자동으로 임시 저장돼요');
    state.id = 'lib-draft-state';
    if (!editId) body.append(state);
  }

  // ------------------------------------------------------------------ 📔 diary

  private async renderDiary(body: HTMLElement) {
    const draft = await api<DiaryDraft>('GET', '/api/diary/draft');
    this.diary = draft;
    this.groups = draft.groups;
    const ex = draft.existing;
    this.diaryLines = ex ? [...ex.parts] : draft.lines.map((l) => l.text);
    this.diaryNote = ex?.note ?? '';
    this.diaryPhotos = new Set(ex?.photoIds ?? []);
    this.visibility = ex?.visibility ?? draft.defaultVisibility;
    this.groupId = ex?.groupId ?? (this.visibility === 'group' ? (draft.groups[0]?.id ?? null) : null);
    this.renderDiaryEditor(body);
  }

  private renderDiaryEditor(body: HTMLElement) {
    const draft = this.diary!;
    const paper = el('article', 'book-page lib-diary');
    paper.id = 'lib-diary';
    paper.append(el('p', 'book-date', `📔 ${koreanDate(draft.date)}`));
    if (draft.existing) paper.append(el('p', 'lib-soft', '오늘 일기를 이미 꽂았어요. 고치면 그 일기가 바뀌어요.'));
    if (!draft.footprintsOn) paper.append(el('p', 'lib-soft', '발자취 기록이 꺼져 있어서 오늘 한 일이 일기에 담기지 않아요. ⚙ 설정 → 📔 발자취에서 켤 수 있어요.'));
    if (draft.word) {
      const q = el('blockquote', 'lib-verse');
      q.append(el('span', 'lib-verse-text', draft.word.text), el('cite', '', `오늘의 말씀 · ${draft.word.ref}`));
      paper.append(q);
    }
    paper.append(el('p', 'lib-label', '자동으로 쓴 일기예요. 고치거나 빼도 돼요.'));
    const list = el('ol', 'lib-diary-edit');
    list.id = 'lib-diary-lines';
    this.diaryLines.forEach((line, i) => {
      const li = el('li');
      const input = el('textarea', 'lib-input lib-line');
      input.value = line;
      input.rows = 2;
      input.maxLength = 200;
      input.setAttribute('aria-label', `일기 ${i + 1}번째 줄`);
      input.addEventListener('input', () => (this.diaryLines[i] = input.value));
      const rm = button('✕', 'ghost lib-line-remove', () => {
        this.diaryLines.splice(i, 1);
        list.replaceChildren();
        body.replaceChildren();
        this.renderDiaryEditor(body);
      });
      rm.setAttribute('aria-label', `${i + 1}번째 줄 빼기`);
      li.append(input, rm);
      list.append(li);
    });
    if (!this.diaryLines.length) list.append(el('li', 'lib-soft', '남은 줄이 없어요. 오늘 한 줄을 적어 주세요.'));
    paper.append(list);
    paper.append(el('p', 'lib-label', '✏️ 오늘 한 줄'));
    const note = el('textarea', 'lib-textarea');
    note.id = 'lib-diary-note';
    note.rows = 3;
    note.maxLength = DIARY_NOTE_MAX * 2;
    note.placeholder = '오늘 마음에 남은 한 줄을 덧붙여 보세요.';
    note.value = this.diaryNote;
    note.addEventListener('input', () => (this.diaryNote = note.value));
    paper.append(note);
    if (draft.photos.length) {
      paper.append(el('p', 'lib-label', `📸 오늘 사진 (넣을 사진을 골라요, ${DIARY_PHOTOS_MAX}장까지)`));
      const grid = el('div', 'lib-pick');
      for (const p of draft.photos) {
        const b = button('', this.diaryPhotos.has(p.id) ? 'lib-pick-item on' : 'lib-pick-item', () => {
          if (this.diaryPhotos.has(p.id)) this.diaryPhotos.delete(p.id);
          else if (this.diaryPhotos.size < DIARY_PHOTOS_MAX) this.diaryPhotos.add(p.id);
          b.classList.toggle('on', this.diaryPhotos.has(p.id));
          b.setAttribute('aria-pressed', String(this.diaryPhotos.has(p.id)));
        });
        b.id = `lib-pick-${p.id}`;
        b.setAttribute('aria-pressed', String(this.diaryPhotos.has(p.id)));
        const img = el('img');
        img.src = p.url;
        img.alt = `${p.place} 사진`;
        b.append(img);
        grid.append(b);
      }
      paper.append(grid, el('p', 'lib-soft', '고른 사진만 일기와 함께 보여요. 고르지 않은 사진은 나만 볼 수 있어요.'));
    }
    body.append(paper);
    body.append(this.visibilityPicker('기본은 모임이에요(모임이 없으면 나만). 다른 분의 이름이나 모닥불에서 나눈 말은 일기에 넣지 않아요.'));
    const publish = async (confirmPersonal: boolean) => {
      try {
        const s = await api<StoryDetail>('POST', '/api/diary', {
          lines: this.diaryLines,
          note: this.diaryNote,
          photoIds: [...this.diaryPhotos],
          visibility: this.visibility,
          groupId: this.groupId,
          confirmPersonal,
        });
        this.lastPublished = s.id;
        this.hooks.toast('📔 오늘의 일기를 발자취 서가에 꽂았어요.');
        this.hooks.changed();
        this.history = [];
        this.show({ kind: 'story', id: s.id }, false);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'personal_info') {
          this.personalWarning = err.message;
          const w = document.getElementById('lib-personal-warning');
          if (w) {
            w.hidden = false;
            w.querySelector('p')!.textContent = err.message;
          }
          return;
        }
        this.say(message(err, '일기를 꽂지 못했어요.'));
      }
    };
    body.append(this.warningBox(() => void publish(true)));
    const actions = el('div', 'lib-actions');
    const go = button(draft.existing ? '고쳐서 꽂기' : '📔 일기 꽂기', 'primary', () => void publish(false));
    go.id = 'lib-diary-publish';
    actions.append(go);
    const reset = button('처음 초안으로', 'ghost', () => {
      this.diaryLines = draft.lines.map((l) => l.text);
      body.replaceChildren();
      this.renderDiaryEditor(body);
    });
    reset.id = 'lib-diary-reset';
    actions.append(reset);
    body.append(actions);
  }
}
