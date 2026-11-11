import type { WordPassage } from '../../../shared/protocol';
import { api, ApiError } from '../net/api';
import { GuestRestricted, type MeditationEntry, type SavedLantern, type WordBookPage, type WordBookStore } from '../storage/WordBook';
import { button, el, koreanDate, Modal } from './dom';
import type { GroupInfo } from './GroupsView';
import { wordPassage } from './WordCard';

export type BookTab = 'today' | 'mine' | 'saved';

const FIELDS: [keyof Pick<MeditationEntry, 'meditation' | 'feeling' | 'application'>, string][] = [
  ['meditation', '묵상'],
  ['feeling', '느낀 점'],
  ['application', '적용'],
];

export interface WordBookHooks {
  needLogin: (reason: string) => void;
  /** A lantern was lit or taken down from the book. */
  lanternsChanged: () => void;
  /** Today's word (null until the server sends it). */
  word: () => WordPassage | null;
  /** ✍️ 묵상하기 with today's word (opens the meditation sheet). */
  meditate: () => void;
}

/** One line of today's meditation for the 오늘 tab. */
function preview(m: MeditationEntry): string {
  const text = (m.meditation || m.feeling || m.application).replace(/\s+/g, ' ').trim();
  const chars = [...text];
  return chars.length > 70 ? `${chars.slice(0, 70).join('')}…` : text;
}

/**
 * 📖 나의 말씀 책 (the HUD 말씀 button), three tabs:
 *  - 오늘: today's verse, my meditation status, 묵상하기 and 등불로 나누기
 *  - 지난 말씀: one page per day (newest first) with that day's notes, which
 *    the owner can edit, delete or share as a lantern
 *  - 담아 둔 묵상: lanterns kept with 기록하기
 */
export class WordBookView {
  private readonly modal = new Modal('book-overlay', '나의 말씀 책');
  private pages: WordBookPage[] = [];
  private saved: SavedLantern[] = [];
  private index = 0;
  private tab: BookTab = 'today';
  private status: HTMLParagraphElement | null = null;

  constructor(
    private readonly store: WordBookStore,
    private readonly hooks: WordBookHooks,
  ) {}

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  get currentTab(): BookTab | null {
    return this.modal.isOpen ? this.tab : null;
  }

  async open(tab: BookTab = 'today', date?: string) {
    this.tab = tab;
    await this.reload(date);
    if (!this.modal.isOpen) this.modal.open();
  }

  private async reload(date?: string) {
    const keep = date ?? this.pages[this.index]?.date ?? this.hooks.word()?.date;
    try {
      [this.pages, this.saved] = await Promise.all([this.store.listPages(), this.store.listSaved()]);
    } catch (err) {
      this.pages = [];
      this.saved = [];
      this.render(err instanceof ApiError ? err.message : '말씀 책을 불러오지 못했어요.');
      return;
    }
    const at = keep ? this.pages.findIndex((p) => p.date === keep) : 0;
    this.index = Math.max(0, at);
    this.render();
  }

  private say(text: string) {
    if (this.status) this.status.textContent = text;
  }

  private render(error = '') {
    const sheet = this.modal.sheet;
    sheet.className = 'sheet book';
    sheet.replaceChildren();

    const top = el('header', 'book-top');
    const close = button('닫기', 'ghost', () => this.modal.close());
    close.id = 'book-close';
    top.append(el('h2', 'book-title', '📖 나의 말씀 책'), close);
    sheet.append(top);

    const tabs = el('div', 'book-tabs');
    tabs.setAttribute('role', 'tablist');
    const tab = (id: BookTab, label: string) => {
      const b = button(label, this.tab === id ? 'tab on' : 'tab', () => this.switchTab(id));
      b.id = `book-tab-${id}`;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', this.tab === id ? 'true' : 'false');
      tabs.append(b);
    };
    tab('today', '오늘');
    tab('mine', '지난 말씀');
    tab('saved', this.saved.length ? `담아 둔 묵상 ${this.saved.length}` : '담아 둔 묵상');
    sheet.append(tabs);
    if (error) sheet.append(el('p', 'groups-error', error));

    if (this.tab === 'today') this.renderToday(sheet);
    else if (this.store.kind === 'guest') this.renderGuest(sheet);
    else if (this.tab === 'saved') this.renderSaved(sheet);
    else this.renderMine(sheet);

    this.status = el('p', 'groups-status');
    this.status.setAttribute('role', 'status');
    sheet.append(this.status);
  }

  private switchTab(tab: BookTab) {
    this.tab = tab;
    this.render();
  }

  private loginButton(id: string): HTMLButtonElement {
    const login = button('로그인하러 가기', 'primary', () => {
      this.modal.close();
      this.hooks.needLogin('로그인하면 묵상을 저장하고 어느 기기에서든 다시 볼 수 있어요.');
    });
    login.id = id;
    return login;
  }

  private renderGuest(sheet: HTMLElement) {
    const empty = el('div', 'book-empty');
    empty.append(el('p', 'book-empty-title', '로그인하면 나의 말씀 책을 만들 수 있어요.'), el('p', '', '날마다 받은 말씀과 묵상이 내 계정에 한 장씩 쌓여요.'));
    empty.append(this.loginButton('book-login'));
    sheet.append(empty);
  }

  /** 오늘: today's verse, whether I meditated on it today, and what to do next. */
  private renderToday(sheet: HTMLElement) {
    const word = this.hooks.word();
    const paper = el('article', 'book-page today-page');
    paper.id = 'book-today';
    sheet.append(paper);
    if (!word) {
      paper.append(el('p', 'book-none', '서버와 연결되면 오늘의 말씀을 받을 수 있어요.'));
      return;
    }
    paper.append(el('p', 'book-date', `오늘의 말씀 · ${koreanDate(word.date)}`), ...wordPassage(word));

    const status = el('div', 'today-status');
    status.id = 'today-status';
    const page = this.pages.find((p) => p.date === word.date);
    const latest = page?.meditations[page.meditations.length - 1] ?? null;
    if (latest) {
      status.classList.add('done');
      const count = page!.meditations.length;
      status.append(el('p', 'today-done', `✓ 오늘 ${latest.place}에서 묵상했어요${count > 1 ? ` · ${count}개` : ''}`), el('p', 'today-preview', preview(latest)));
    } else if (this.store.kind === 'guest') {
      status.append(el('p', 'today-none', '로그인하면 오늘의 묵상을 말씀 책에 저장하고 등불로 나눌 수 있어요.'));
    } else {
      status.append(el('p', 'today-none', '아직 오늘의 묵상을 적지 않았어요.'), el('p', 'today-hint', '천천히 두세 번 읽고, 마음에 머무는 말을 적어 보세요.'));
    }
    paper.append(status);

    const actions = el('div', 'today-actions');
    const med = button('✍️ 묵상하기', 'primary', () => this.hooks.meditate());
    med.id = 'today-meditate';
    actions.append(med);
    const shareBox = el('div', 'today-share-box');
    if (this.store.kind === 'server' || this.store.kind === 'guest') {
      const lit = !!latest?.lanternId;
      const share = button(lit ? '🏮 등불을 밝혔어요' : '🏮 등불로 나누기', 'today-share');
      share.id = 'today-share';
      share.disabled = !latest || lit;
      if (!latest) share.title = '오늘의 묵상을 담으면 등불로 나눌 수 있어요';
      share.addEventListener('click', () => {
        if (!latest) return;
        share.disabled = true;
        void this.share(shareBox, latest);
      });
      actions.append(share);
    }
    if (this.store.kind === 'guest') actions.append(this.loginButton('today-login'));
    paper.append(actions, shareBox);
  }

  private renderSaved(sheet: HTMLElement) {
    if (this.saved.length === 0) {
      const empty = el('div', 'book-empty');
      empty.append(el('p', 'book-empty-title', '담아 둔 묵상이 아직 없어요.'), el('p', '', '등불 언덕에서 마음에 닿은 등불에 "기록하기"를 눌러 보세요.'));
      sheet.append(empty);
      return;
    }
    for (const s of this.saved) {
      const paper = el('article', 'book-page saved');
      paper.append(el('p', 'book-date', `${s.nickname}의 등불 · ${koreanDate(s.date)}`), el('blockquote', 'book-verse', s.verse));
      const ref = el('p', 'book-ref');
      ref.append(el('strong', '', s.ref), el('span', 'word-translation', s.translation || '개역한글판'));
      paper.append(ref);
      for (const [key, label] of FIELDS) {
        if (!s[key]) continue;
        const row = el('div', 'book-field');
        row.append(el('span', 'book-field-label', label), el('p', 'book-field-text', s[key]));
        paper.append(row);
      }
      const remove = button('담아 둔 묵상에서 빼기', 'ghost', async () => {
        try {
          await this.store.removeSaved(s.lanternId);
          this.hooks.lanternsChanged();
          await this.reload();
        } catch (err) {
          this.say(err instanceof ApiError ? err.message : '잠시 후 다시 시도해 주세요.');
        }
      });
      paper.append(remove);
      sheet.append(paper);
    }
  }

  private renderMine(sheet: HTMLElement) {
    if (this.pages.length === 0) {
      const empty = el('div', 'book-empty');
      empty.append(el('p', 'book-empty-title', '아직 담긴 말씀이 없어요.'), el('p', '', '오늘의 말씀을 열면 이 책에 날마다 한 장씩 쌓여요.'));
      sheet.append(empty);
      return;
    }
    const page = this.pages[this.index];
    const paper = el('article', 'book-page');
    paper.append(el('p', 'book-date', koreanDate(page.date)), el('blockquote', 'book-verse', page.word.text));
    const ref = el('p', 'book-ref');
    ref.append(el('strong', '', page.word.ref), el('span', 'word-translation', page.word.translation || '개역한글판'));
    paper.append(ref);
    if (page.meditations.length === 0) paper.append(el('p', 'book-none', '아직 이 말씀으로 묵상을 적지 않았어요.'));
    for (const m of page.meditations) paper.append(this.note(m));
    sheet.append(paper);

    const nav = el('footer', 'book-nav');
    // Older days on the left, newer on the right; the count runs 1 (oldest) … N (newest).
    const older = button('‹ 이전 날', '', () => this.go(1));
    older.id = 'book-prev-day';
    const newer = button('다음 날 ›', '', () => this.go(-1));
    newer.id = 'book-next-day';
    older.disabled = this.index >= this.pages.length - 1;
    newer.disabled = this.index === 0;
    nav.append(older, el('span', 'book-count', `${this.pages.length - this.index} / ${this.pages.length}장`), newer);
    sheet.append(nav);
  }

  private note(m: MeditationEntry): HTMLElement {
    const note = el('section', 'book-note');
    note.dataset.id = m.id;
    const time = new Date(m.createdAt);
    const hh = time.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Seoul' });
    note.append(el('p', 'book-note-head', `${m.place}에서 · ${hh}${m.updatedAt && m.updatedAt !== m.createdAt ? ' · 고침' : ''}`));
    for (const [key, label] of FIELDS) {
      if (!m[key]) continue;
      const row = el('div', 'book-field');
      row.append(el('span', 'book-field-label', label), el('p', 'book-field-text', m[key]));
      note.append(row);
    }
    const actions = el('div', 'note-actions');
    actions.append(
      button('고치기', 'ghost note-edit', () => this.edit(note, m)),
      button('지우기', 'ghost note-delete', () => this.confirmDelete(actions, m)),
    );
    if (this.store.kind === 'server') {
      if (m.lanternId) {
        actions.append(
          button('등불 내리기', 'ghost note-unshare', async () => {
            try {
              await api('DELETE', `/api/lanterns/${m.lanternId}`);
              this.hooks.lanternsChanged();
              await this.reload();
              this.say('등불을 내렸어요.');
            } catch (err) {
              this.say(err instanceof ApiError ? err.message : '잠시 후 다시 시도해 주세요.');
            }
          }),
        );
      } else {
        actions.append(button('등불로 나누기', 'primary note-share', () => void this.share(note, m)));
      }
    }
    note.append(actions);
    return note;
  }

  private edit(note: HTMLElement, m: MeditationEntry) {
    note.replaceChildren(el('p', 'book-note-head', `${m.place}에서 쓴 묵상 고치기`));
    const areas = {} as Record<(typeof FIELDS)[number][0], HTMLTextAreaElement>;
    for (const [key, label] of FIELDS) {
      const area = el('textarea', 'med-input');
      area.id = `edit-${key}`;
      area.value = m[key];
      area.rows = 3;
      area.maxLength = 2000;
      area.setAttribute('aria-label', label);
      areas[key] = area;
      const row = el('div', 'book-field');
      row.append(el('span', 'book-field-label', label), area);
      note.append(row);
    }
    const actions = el('div', 'note-actions');
    const save = button('저장', 'primary', async () => {
      save.disabled = true;
      try {
        await this.store.updateMeditation(m.id, {
          meditation: areas.meditation.value.trim(),
          feeling: areas.feeling.value.trim(),
          application: areas.application.value.trim(),
        });
        await this.reload();
        this.say('고쳤어요.');
      } catch (err) {
        save.disabled = false;
        this.fail(err);
      }
    });
    save.id = 'edit-save';
    actions.append(save, button('취소', 'ghost', () => this.render()));
    note.append(actions);
  }

  private confirmDelete(actions: HTMLElement, m: MeditationEntry) {
    actions.replaceChildren(el('span', 'note-confirm', m.lanternId ? '지우면 이 묵상의 등불도 내려가요. 지울까요?' : '이 묵상을 지울까요?'));
    const yes = button('지우기', 'danger', async () => {
      try {
        await this.store.deleteMeditation(m.id);
        if (m.lanternId) this.hooks.lanternsChanged();
        await this.reload();
        this.say('지웠어요.');
      } catch (err) {
        this.fail(err);
      }
    });
    yes.id = 'delete-confirm';
    actions.append(yes, button('그대로 두기', 'ghost', () => this.render()));
  }

  private async share(note: HTMLElement, m: MeditationEntry) {
    let groups: GroupInfo[] = [];
    try {
      groups = (await api<{ groups: GroupInfo[] }>('GET', '/api/groups')).groups;
    } catch {
      /* public only */
    }
    const form = el('form', 'share-form');
    form.append(el('p', 'book-note-head', '등불로 나누기 · 7일 동안 등불 언덕을 밝혀요'));
    const pub = el('label', 'share-option');
    const pubInput = el('input');
    pubInput.type = 'radio';
    pubInput.name = 'vis';
    pubInput.value = 'public';
    pubInput.checked = true;
    pubInput.id = 'share-public';
    pub.append(pubInput, el('span', '', '공개 · 누구나 볼 수 있어요'));
    form.append(pub);
    // 익명 (public only): others see "익명의 성도".
    const anon = el('label', 'share-option share-anon');
    anon.id = 'share-anon-row';
    const anonInput = el('input');
    anonInput.type = 'checkbox';
    anonInput.id = 'share-anon';
    const anonText = el('span', 'share-anon-text');
    anonText.append(el('span', '', '익명으로 나누기'), el('small', 'share-hint', "이름 대신 '익명의 성도'로 보여요"));
    anon.append(anonInput, anonText);
    form.append(anon);
    const priv = el('label', 'share-option');
    const privInput = el('input');
    privInput.type = 'radio';
    privInput.name = 'vis';
    privInput.value = 'group';
    privInput.id = 'share-group';
    privInput.disabled = groups.length === 0;
    const select = el('select', 'share-select');
    select.id = 'share-group-id';
    for (const g of groups) {
      const o = el('option', '', g.name);
      o.value = String(g.id);
      select.append(o);
    }
    select.disabled = groups.length === 0;
    select.addEventListener('change', () => {
      privInput.checked = true;
      syncAnon();
    });
    const syncAnon = () => {
      const isPublic = pubInput.checked;
      anon.hidden = !isPublic;
      anonInput.disabled = !isPublic;
      if (!isPublic) anonInput.checked = false;
    };
    pubInput.addEventListener('change', syncAnon);
    privInput.addEventListener('change', syncAnon);
    priv.append(privInput, el('span', '', groups.length ? '비공개 · 모임 사람만' : '비공개 · 먼저 모임에 함께해 주세요'), select);
    form.append(priv);
    const actions = el('div', 'note-actions');
    const go = button('나누기', 'primary');
    go.type = 'submit';
    go.id = 'share-submit';
    actions.append(go, button('취소', 'ghost', () => this.render()));
    form.append(actions);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      go.disabled = true;
      try {
        const visibility = privInput.checked ? 'group' : 'public';
        await api('POST', '/api/lanterns', {
          meditationId: Number(m.id),
          visibility,
          ...(visibility === 'group' ? { groupId: Number(select.value) } : { anonymous: anonInput.checked }),
        });
        this.hooks.lanternsChanged();
        await this.reload();
        this.say('등불을 밝혔어요. 등불 언덕에서 볼 수 있어요.');
      } catch (err) {
        go.disabled = false;
        this.fail(err);
      }
    });
    note.append(form);
  }

  private fail(err: unknown) {
    if (err instanceof GuestRestricted) {
      this.modal.close();
      this.hooks.needLogin(err.message);
      return;
    }
    this.say(err instanceof ApiError || err instanceof Error ? err.message : '잠시 후 다시 시도해 주세요.');
  }

  private go(delta: number) {
    this.index = Math.min(this.pages.length - 1, Math.max(0, this.index + delta));
    this.render();
  }
}
