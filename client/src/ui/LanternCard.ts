import { REACTION_LABELS, REACTION_TYPES, type LanternDetail, type ReactionType } from '../../../shared/protocol';
import { api, ApiError } from '../net/api';
import { button, el, koreanDate, Modal } from './dom';

const FIELDS: [keyof Pick<LanternDetail, 'meditation' | 'feeling' | 'application'>, string][] = [
  ['meditation', '묵상'],
  ['feeling', '느낀 점'],
  ['application', '적용'],
];

/** Reading card for one lantern, with 아멘 / 기도하기 / 기록하기. */
export class LanternCard {
  private readonly modal = new Modal('lantern-overlay', '등불');
  private status: HTMLParagraphElement | null = null;

  constructor(
    private readonly signedIn: () => boolean,
    private readonly needLogin: (reason: string) => void,
    private readonly onChanged: () => void,
  ) {}

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  async open(id: number) {
    try {
      const d = await api<LanternDetail>('GET', `/api/lanterns/${id}`);
      this.render(d);
      if (!this.modal.isOpen) this.modal.open();
    } catch (err) {
      throw err instanceof ApiError ? err : new ApiError(0, 'error', '등불을 열지 못했어요.');
    }
  }

  private render(d: LanternDetail) {
    const sheet = this.modal.sheet;
    sheet.className = 'sheet lantern-card';
    sheet.replaceChildren();
    const top = el('header', 'book-top');
    const title = el('div', 'lantern-title');
    const heading = d.anonymous ? (d.mine ? '내 등불 · 익명으로 나눴어요' : '익명의 등불') : `${d.nickname}의 등불`;
    title.append(el('strong', '', heading), el('span', d.group ? 'pill group' : 'pill', d.group ? `비공개 · ${d.group}` : d.anonymous ? '공개 · 익명' : '공개'));
    top.append(title, button('닫기', 'ghost', () => this.modal.close()));
    sheet.append(top);

    const paper = el('article', 'book-page');
    paper.append(el('p', 'book-date', koreanDate(d.date)), el('blockquote', 'book-verse', d.verse));
    const ref = el('p', 'book-ref');
    ref.append(el('strong', '', d.ref), el('span', 'word-translation', d.translation || '개역한글판'));
    paper.append(ref);
    for (const [key, label] of FIELDS) {
      if (!d[key]) continue;
      const row = el('div', 'book-field');
      row.append(el('span', 'book-field-label', label), el('p', 'book-field-text', d[key]));
      paper.append(row);
    }
    sheet.append(paper);

    const reacts = el('div', 'reactions');
    for (const type of REACTION_TYPES) {
      const on = d.myReactions.includes(type);
      const b = button(`${REACTION_LABELS[type]} ${d.counts[type]}`, on ? 'react on' : 'react', () => void this.toggle(d.id, type));
      b.id = `react-${type}`;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      reacts.append(b);
    }
    sheet.append(reacts);

    if (d.mine) {
      const own = el('div', 'lantern-own');
      own.append(el('p', 'lantern-prayed', d.counts.pray > 0 ? `${d.counts.pray}명이 이 묵상을 위해 기도하고 있어요.` : '아직 기도한 사람이 없어요.'));
      const down = button('등불 내리기', 'ghost danger', async () => {
        try {
          await api('DELETE', `/api/lanterns/${d.id}`);
          this.onChanged();
          this.modal.close();
        } catch (err) {
          this.say(err instanceof ApiError ? err.message : '잠시 후 다시 시도해 주세요.');
        }
      });
      down.id = 'lantern-remove';
      own.append(down);
      sheet.append(own);
    }
    this.status = el('p', 'groups-status');
    this.status.setAttribute('role', 'status');
    sheet.append(this.status);
  }

  private say(text: string) {
    if (this.status) this.status.textContent = text;
  }

  private async toggle(id: number, type: ReactionType) {
    if (!this.signedIn()) {
      this.modal.close();
      this.needLogin('로그인하면 아멘, 기도하기, 기록하기로 마음을 나눌 수 있어요.');
      return;
    }
    try {
      const d = await api<LanternDetail>('POST', `/api/lanterns/${id}/reactions`, { type });
      this.render(d);
      if (type === 'record') this.say(d.myReactions.includes('record') ? '나의 말씀 책 "담아 둔 묵상"에 담았어요.' : '담아 둔 묵상에서 뺐어요.');
      this.onChanged();
    } catch (err) {
      this.say(err instanceof ApiError ? err.message : '잠시 후 다시 시도해 주세요.');
    }
  }
}
