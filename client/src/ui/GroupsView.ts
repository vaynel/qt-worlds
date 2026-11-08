import { api, ApiError } from '../net/api';
import { button, el, Modal } from './dom';

export interface GroupInfo {
  id: number;
  name: string;
  code: string;
  members: number;
  owner: boolean;
}

/** 모임: create (server makes the code), join by code, leave, list. */
export class GroupsView {
  private readonly modal = new Modal('groups-overlay', '모임');
  private status: HTMLParagraphElement | null = null;

  constructor(private readonly onChanged: () => void) {}

  async open() {
    await this.render();
    if (!this.modal.isOpen) this.modal.open();
  }

  private say(text: string, ok = false) {
    if (!this.status) return;
    this.status.textContent = text;
    this.status.classList.toggle('ok', ok);
  }

  private async render(message = '', ok = false) {
    const sheet = this.modal.sheet;
    sheet.className = 'sheet groups';
    sheet.replaceChildren();
    const top = el('header', 'book-top');
    top.append(el('h2', 'book-title', '모임'), button('닫기', 'ghost', () => this.modal.close()));
    sheet.append(top);
    const body = el('div', 'groups-body');
    body.append(el('p', 'settings-note', '모임 코드를 나눈 사람끼리만 비공개 등불을 볼 수 있어요.'));

    let groups: GroupInfo[] = [];
    try {
      groups = (await api<{ groups: GroupInfo[] }>('GET', '/api/groups')).groups;
    } catch (err) {
      body.append(el('p', 'groups-error', err instanceof ApiError ? err.message : '모임을 불러오지 못했어요.'));
    }
    const list = el('ul', 'groups-list');
    if (groups.length === 0) list.append(el('li', 'groups-empty', '아직 함께하는 모임이 없어요.'));
    for (const g of groups) {
      const li = el('li', 'group-item');
      const info = el('div', 'group-info');
      info.append(el('strong', '', g.name), el('span', 'group-meta', `${g.members}명${g.owner ? ' · 내가 만든 모임' : ''}`));
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
          this.onChanged();
          await this.render(`${g.name} 모임에서 나왔어요.`, true);
        } catch (err) {
          this.say(err instanceof ApiError ? err.message : '잠시 후 다시 시도해 주세요.');
        }
      });
      li.append(info, code, copy, leave);
      list.append(li);
    }
    body.append(list);

    const create = el('form', 'groups-form');
    const name = el('input');
    name.id = 'group-name';
    name.type = 'text';
    name.maxLength = 40;
    name.placeholder = '새 모임 이름 (예: 수요 큐티반)';
    create.append(name, button('만들기', 'primary'));
    (create.lastChild as HTMLButtonElement).type = 'submit';
    create.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const g = await api<GroupInfo>('POST', '/api/groups', { name: name.value });
        this.onChanged();
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
    join.append(code, button('참여하기', 'primary'));
    (join.lastChild as HTMLButtonElement).type = 'submit';
    join.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const g = await api<GroupInfo>('POST', '/api/groups/join', { code: code.value });
        this.onChanged();
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
    if (message) this.say(message, ok);
  }
}
