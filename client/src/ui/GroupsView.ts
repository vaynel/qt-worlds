import { GROUP_CHAT_MAX, textLength, type GroupMessage } from '../../../shared/protocol';
import { api, ApiError } from '../net/api';
import { button, el, Modal } from './dom';

export interface GroupInfo {
  id: number;
  name: string;
  code: string;
  members: number;
  owner: boolean;
  /** People in the group's voice prayer room right now. */
  voice?: number;
  /** Unread chat messages (server-side read pointer, synced across devices). */
  unread?: number;
}

export interface GroupsHooks {
  /** Membership changed (create/join/leave). */
  onChanged: () => void;
  onVoice: (groupId: number) => void;
  onVoiceLeave: () => void;
  currentVoice: () => number | null;
  /** Unread counts changed (HUD badge). */
  onUnread: (total: number) => void;
}

const WEEK_MS = 7 * 86_400_000;

function clock(iso: string): string {
  const d = new Date(iso);
  const h = Number(d.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Seoul' })) % 24;
  const m = d.toLocaleString('en-US', { minute: '2-digit', timeZone: 'Asia/Seoul' }).padStart(2, '0');
  return `${h < 12 ? '오전' : '오후'} ${h % 12 === 0 ? 12 : h % 12}:${m}`;
}

/**
 * 모임: list (create / join by code), then a group panel with two tabs:
 * 💬 대화 (group chat) and 🎙️ 음성 기도방. Everything is members-only on the
 * server; text is always rendered with textContent.
 */
export class GroupsView {
  private readonly modal = new Modal('groups-overlay', '모임');
  private status: HTMLParagraphElement | null = null;
  private groups: GroupInfo[] = [];
  private unread = new Map<number, number>();
  /** Open group panel (null = list). */
  private current: number | null = null;
  private tab: 'chat' | 'voice' = 'chat';
  private messages: GroupMessage[] = [];
  private hasMore = false;
  private listEl: HTMLOListElement | null = null;
  private myId: number | null = null;
  private readTimer = 0;

  constructor(private readonly hooks: GroupsHooks) {}

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  setMe(userId: number | null) {
    this.myId = userId;
  }

  /** Initial unread counts (also refreshed whenever the list loads). */
  async refreshUnread() {
    try {
      this.groups = (await api<{ groups: GroupInfo[] }>('GET', '/api/groups')).groups;
      this.unread = new Map(this.groups.map((g) => [g.id, g.unread ?? 0]));
      this.emitUnread();
    } catch {
      /* not signed in */
    }
  }

  private emitUnread() {
    let total = 0;
    for (const n of this.unread.values()) total += n;
    this.hooks.onUnread(total);
  }

  async open(groupId?: number, tab: 'chat' | 'voice' = 'chat') {
    if (groupId !== undefined) {
      this.current = groupId;
      this.tab = tab;
    } else {
      this.current = null;
    }
    await this.render();
    if (!this.modal.isOpen) this.modal.open(() => (this.current = null));
  }

  private say(text: string, ok = false) {
    if (!this.status) return;
    this.status.textContent = text;
    this.status.classList.toggle('ok', ok);
  }

  private async render(message = '', ok = false) {
    try {
      this.groups = (await api<{ groups: GroupInfo[] }>('GET', '/api/groups')).groups;
      this.unread = new Map(this.groups.map((g) => [g.id, g.unread ?? 0]));
      this.emitUnread();
    } catch (err) {
      this.groups = [];
      message = err instanceof ApiError ? err.message : '모임을 불러오지 못했어요.';
    }
    if (this.current !== null && !this.groups.some((g) => g.id === this.current)) this.current = null;
    if (this.current !== null) await this.renderGroup();
    else this.renderList();
    if (message) this.say(message, ok);
  }

  // ---------------------------------------------------------------- list

  private renderList() {
    const sheet = this.modal.sheet;
    sheet.className = 'sheet groups';
    sheet.replaceChildren();
    const top = el('header', 'book-top');
    top.append(el('h2', 'book-title', '모임'), button('닫기', 'ghost', () => this.modal.close()));
    sheet.append(top);
    const body = el('div', 'groups-body');
    body.append(el('p', 'settings-note', '모임 코드를 나눈 사람끼리만 대화하고, 음성으로 기도하고, 비공개 등불을 볼 수 있어요.'));

    const list = el('ul', 'groups-list');
    if (this.groups.length === 0) list.append(el('li', 'groups-empty', '아직 함께하는 모임이 없어요.'));
    for (const g of this.groups) {
      const li = el('li', 'group-item');
      const info = el('button', 'group-open');
      info.type = 'button';
      info.dataset.group = String(g.id);
      const unread = this.unread.get(g.id) ?? 0;
      const title = el('strong', '', g.name);
      if (unread > 0) {
        const badge = el('span', 'badge', unread > 99 ? '99+' : String(unread));
        badge.setAttribute('aria-label', `읽지 않은 메시지 ${unread}개`);
        title.append(badge);
      }
      info.append(title, el('span', 'group-meta', `${g.members}명${g.owner ? ' · 내가 만든 모임' : ''} · 💬 대화 열기`));
      info.addEventListener('click', () => void this.open(g.id, 'chat'));
      const code = el('code', 'group-code', g.code);
      code.title = '모임 코드';
      const copy = button('코드 복사', '', () => {
        void navigator.clipboard?.writeText(g.code).then(
          () => this.say(`${g.code} 코드를 복사했어요.`, true),
          () => this.say(`모임 코드: ${g.code}`, true),
        );
      });
      const leave = button('나가기', 'ghost', async () => {
        try {
          await api('POST', `/api/groups/${g.id}/leave`);
          this.hooks.onChanged();
          await this.render(`${g.name} 모임에서 나왔어요.`, true);
        } catch (err) {
          this.say(err instanceof ApiError ? err.message : '잠시 후 다시 시도해 주세요.');
        }
      });
      li.append(info, code, copy, leave, this.voiceButton(g));
      list.append(li);
    }
    body.append(list);

    const create = el('form', 'groups-form');
    const name = el('input');
    name.id = 'group-name';
    name.type = 'text';
    name.maxLength = 40;
    name.placeholder = '새 모임 이름 (예: 수요 큐티반)';
    const mk = button('만들기', 'primary');
    mk.type = 'submit';
    create.append(name, mk);
    create.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const g = await api<GroupInfo>('POST', '/api/groups', { name: name.value });
        this.hooks.onChanged();
        await this.render(`'${g.name}' 모임을 만들었어요. 코드 ${g.code}를 나눠 주세요.`, true);
      } catch (err) {
        this.say(err instanceof ApiError ? err.message : '잠시 후 다시 시도해 주세요.');
      }
    });

    const join = el('form', 'groups-form');
    const code = el('input');
    code.id = 'group-code';
    code.type = 'text';
    code.maxLength = 12;
    code.placeholder = '모임 코드 6자리';
    code.autocapitalize = 'characters';
    const jb = button('참여하기', 'primary');
    jb.type = 'submit';
    join.append(code, jb);
    join.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const g = await api<GroupInfo>('POST', '/api/groups/join', { code: code.value });
        this.hooks.onChanged();
        await this.render(`'${g.name}' 모임에 함께하게 되었어요.`, true);
      } catch (err) {
        this.say(err instanceof ApiError ? err.message : '잠시 후 다시 시도해 주세요.');
      }
    });

    body.append(el('p', 'settings-section', '모임 만들기'), create, el('p', 'settings-section', '코드로 참여하기'), join);
    this.status = el('p', 'groups-status');
    this.status.setAttribute('role', 'status');
    body.append(this.status);
    sheet.append(body);
  }

  private voiceButton(g: GroupInfo): HTMLButtonElement {
    const inRoom = this.hooks.currentVoice() === g.id;
    const voice = button(
      inRoom ? '🎙️ 음성 기도방에 있어요' : `🎙️ 음성 기도방 들어가기 · ${g.voice ?? 0}명`,
      inRoom ? 'voice-join on' : 'voice-join primary',
      () => {
        this.modal.close();
        this.hooks.onVoice(g.id);
      },
    );
    voice.dataset.group = String(g.id);
    voice.disabled = inRoom;
    return voice;
  }

  // ---------------------------------------------------------------- group panel

  private async renderGroup() {
    const g = this.groups.find((x) => x.id === this.current)!;
    const sheet = this.modal.sheet;
    sheet.className = 'sheet groups group-panel';
    sheet.replaceChildren();
    const top = el('header', 'book-top');
    const back = button('‹ 모임 목록', 'ghost', () => void this.open());
    back.id = 'group-back';
    top.append(back, el('h2', 'book-title', g.name), button('닫기', 'ghost', () => this.modal.close()));
    sheet.append(top);

    const tabs = el('div', 'book-tabs');
    tabs.setAttribute('role', 'tablist');
    const tChat = button('💬 대화', this.tab === 'chat' ? 'tab on' : 'tab', () => this.switchTab('chat'));
    tChat.id = 'group-tab-chat';
    const tVoice = button(`🎙️ 음성 기도방 · ${g.voice ?? 0}명`, this.tab === 'voice' ? 'tab on' : 'tab', () => this.switchTab('voice'));
    tVoice.id = 'group-tab-voice';
    tabs.append(tChat, tVoice);
    sheet.append(tabs);

    if (this.tab === 'voice') {
      const body = el('div', 'groups-body');
      body.append(el('p', 'settings-note', '모임 사람만 들어올 수 있어요. 녹음하거나 저장하지 않아요. 처음엔 마이크가 꺼져 있어요. 마이크가 없어도 💬 대화로 함께할 수 있어요.'));
      const inRoom = this.hooks.currentVoice() === g.id;
      body.append(this.voiceButton(g));
      if (inRoom) body.append(button('음성 기도방 나가기', 'danger', () => {
        this.hooks.onVoiceLeave();
        void this.render();
      }));
      this.status = el('p', 'groups-status');
      body.append(this.status);
      sheet.append(body);
      return;
    }

    // 💬 대화
    const wrap = el('div', 'gchat');
    this.listEl = el('ol', 'gchat-list');
    this.listEl.id = 'gchat-list';
    this.listEl.setAttribute('aria-live', 'polite');
    wrap.append(this.listEl);
    const form = el('form', 'gchat-form');
    const input = el('textarea', 'gchat-input');
    input.id = 'gchat-input';
    input.rows = 1;
    input.maxLength = GROUP_CHAT_MAX;
    input.placeholder = '모임에 한마디 남겨 보세요';
    input.setAttribute('aria-label', '모임 대화 입력');
    input.addEventListener('keydown', (e) => {
      // Enter sends; Shift+Enter makes a new line.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    input.addEventListener('focus', () => setTimeout(() => input.scrollIntoView({ block: 'end' }), 250));
    const send = button('보내기', 'primary');
    send.type = 'submit';
    send.id = 'gchat-send';
    form.append(input, send);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      if (textLength(text) > GROUP_CHAT_MAX) return this.say(`${GROUP_CHAT_MAX}자까지 보낼 수 있어요.`);
      send.disabled = true;
      try {
        const m = await api<GroupMessage>('POST', `/api/groups/${g.id}/messages`, { text });
        input.value = '';
        this.receive(m);
        this.say('');
      } catch (err) {
        this.say(err instanceof ApiError ? err.message : '보내지 못했어요.');
      } finally {
        send.disabled = false;
      }
    });
    this.status = el('p', 'groups-status gchat-status');
    this.status.setAttribute('role', 'status');
    wrap.append(this.status, form);
    sheet.append(wrap);
    await this.loadMessages(g.id, null);
  }

  private switchTab(tab: 'chat' | 'voice') {
    this.tab = tab;
    void this.render();
  }

  private async loadMessages(groupId: number, before: number | null) {
    try {
      const r = await api<{ messages: GroupMessage[]; hasMore: boolean }>(
        'GET',
        `/api/groups/${groupId}/messages${before ? `?before=${before}` : ''}`,
      );
      this.messages = before ? [...r.messages, ...this.messages] : r.messages;
      this.hasMore = r.hasMore;
    } catch (err) {
      this.say(err instanceof ApiError ? err.message : '대화를 불러오지 못했어요.');
    }
    this.renderMessages(!before);
    if (!before) this.markRead();
  }

  private renderMessages(scrollToEnd: boolean) {
    const list = this.listEl;
    if (!list) return;
    const keep = list.scrollHeight - list.scrollTop;
    list.replaceChildren();
    if (this.hasMore) {
      const more = button('이전 대화 더 보기', 'ghost gchat-more', () => {
        if (this.current !== null) void this.loadMessages(this.current, this.messages[0]?.id ?? null);
      });
      more.id = 'gchat-more';
      const row = el('li', 'gchat-more-row');
      row.append(more);
      list.append(row);
    }
    if (this.messages.length === 0) list.append(el('li', 'gchat-empty', '아직 대화가 없어요. 먼저 인사해 보세요. (7일 동안 보관돼요)'));
    const owner = this.groups.find((g) => g.id === this.current)?.owner ?? false;
    let prev: GroupMessage | null = null;
    for (const m of this.messages) {
      if (m.kind === 'system') {
        list.append(el('li', 'gsys', m.text));
        prev = null;
        continue;
      }
      const cont = prev !== null && prev.userId === m.userId && Date.parse(m.createdAt) - Date.parse(prev.createdAt) < 5 * 60_000;
      const mine = m.userId === this.myId;
      const li = el('li', `gmsg${cont ? ' cont' : ''}${mine ? ' mine' : ''}`);
      li.dataset.id = String(m.id);
      if (!cont) {
        const head = el('div', 'gmsg-head');
        head.append(el('strong', '', m.nickname), el('span', 'gmsg-time', clock(m.createdAt)));
        li.append(head);
      }
      const text = el('p', 'gmsg-text');
      if (m.deleted) {
        text.textContent = '삭제된 메시지예요';
        text.classList.add('gone');
      } else if (m.hidden) {
        text.textContent = '모임장이 가린 메시지예요';
        text.classList.add('gone');
      } else {
        text.textContent = m.text; // plain text only
      }
      li.append(text);
      if (!m.deleted && !m.hidden && (mine || owner)) {
        const actions = el('div', 'gmsg-actions');
        if (mine) {
          const del = button('삭제', 'ghost gmsg-delete', () => void this.act(`/api/groups/${m.groupId}/messages/${m.id}`, 'DELETE'));
          del.dataset.id = String(m.id);
          actions.append(del);
        } else if (owner) {
          const hide = button('가리기', 'ghost gmsg-hide', () => void this.act(`/api/groups/${m.groupId}/messages/${m.id}/hide`, 'POST'));
          hide.dataset.id = String(m.id);
          actions.append(hide);
        }
        li.append(actions);
      }
      list.append(li);
      prev = m;
    }
    if (scrollToEnd) list.scrollTop = list.scrollHeight;
    else list.scrollTop = list.scrollHeight - keep;
  }

  private async act(path: string, method: string) {
    try {
      const m = await api<GroupMessage>(method, path);
      this.update(m);
    } catch (err) {
      this.say(err instanceof ApiError ? err.message : '잠시 후 다시 시도해 주세요.');
    }
  }

  // ---------------------------------------------------------------- live updates

  private viewing(groupId: number): boolean {
    return this.modal.isOpen && this.current === groupId && this.tab === 'chat' && document.visibilityState === 'visible';
  }

  /** A new message pushed over the WebSocket (members only). */
  receive(m: GroupMessage) {
    if (this.viewing(m.groupId)) {
      if (!this.messages.some((x) => x.id === m.id)) {
        this.messages.push(m);
        if (Date.parse(this.messages[0]?.createdAt ?? '') < Date.now() - WEEK_MS) this.messages.shift();
        this.renderMessages(true);
      }
      this.markRead();
      return;
    }
    if (m.kind === 'msg' && m.userId !== this.myId) {
      this.unread.set(m.groupId, (this.unread.get(m.groupId) ?? 0) + 1);
      this.emitUnread();
    }
  }

  update(m: GroupMessage) {
    const i = this.messages.findIndex((x) => x.id === m.id);
    if (i >= 0) {
      this.messages[i] = m;
      if (this.viewing(m.groupId)) this.renderMessages(false);
    }
    if ((m.deleted || m.hidden) && !this.viewing(m.groupId)) void this.refreshUnread();
  }

  /** Read on another device (or here): the badge follows the server pointer. */
  readElsewhere(groupId: number) {
    void this.refreshUnread().then(() => {
      if (this.modal.isOpen && this.current === null) this.renderList();
    });
    if (this.viewing(groupId)) this.unread.set(groupId, 0);
  }

  private markRead() {
    const gid = this.current;
    if (gid === null) return;
    const last = this.messages[this.messages.length - 1]?.id ?? 0;
    this.unread.set(gid, 0);
    this.emitUnread();
    window.clearTimeout(this.readTimer);
    this.readTimer = window.setTimeout(() => {
      void api('POST', `/api/groups/${gid}/read`, { lastId: last }).catch(() => undefined);
    }, 300);
  }
}
