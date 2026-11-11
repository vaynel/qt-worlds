import { REPORT_LABELS, REPORT_REASONS, type ReportReason } from '../../../shared/protocol';
import { outfitCache } from '../game/looks';
import { api, ApiError } from '../net/api';
import { button, el, Modal } from './dom';
import { drawThumb } from './OutfitPainter';

export interface PlayerSource {
  list(): { id: string; name: string; guest: boolean; outfitId: number | null }[];
  info(id: string): { name: string; guest: boolean; outfitId: number | null; patterned: boolean } | null;
}

/**
 * People here (tap the "함께 N명" line) and one person's card (tap an avatar
 * or name tag), with 🚩 옷 신고 for drawn outfits. Names are text only.
 * Reporting needs an account (guests are sent to the login prompt).
 */
export class ReportView {
  private readonly modal = new Modal('report-overlay', '함께 있는 사람');

  constructor(
    private readonly players: PlayerSource,
    private readonly signedIn: () => boolean,
    private readonly needLogin: (reason: string) => void,
  ) {}

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  private frame(title: string): HTMLElement {
    const sheet = this.modal.sheet;
    sheet.className = 'sheet report-sheet';
    sheet.replaceChildren();
    const top = el('header', 'book-top');
    top.append(el('h2', 'book-title', title), button('닫기', 'ghost report-close', () => this.modal.close()));
    const body = el('div', 'report-body');
    sheet.append(top, body);
    return body;
  }

  private reportButton(outfitId: number, name: string): HTMLButtonElement {
    const b = button('🚩 옷 신고', 'chip report-btn', () => this.openReport(outfitId, name));
    b.dataset.outfit = String(outfitId);
    return b;
  }

  private thumb(outfitId: number): HTMLCanvasElement {
    const c = el('canvas', 'slot-thumb');
    c.width = c.height = 40;
    drawThumb(c, outfitCache.get(outfitId) ?? null, 0xf1e4c8);
    return c;
  }

  /** Everyone in the world right now. */
  openList() {
    const body = this.frame('함께 있는 사람');
    const list = this.players.list();
    if (list.length === 0) body.append(el('p', 'settings-note', '지금은 혼자 있어요.'));
    const ul = el('ul', 'report-list');
    ul.id = 'players-list';
    for (const p of list) {
      const li = el('li', 'report-item');
      li.dataset.id = p.id;
      const name = el('span', 'report-name', p.name);
      if (p.guest) name.append(el('small', 'report-guest', ' 손님'));
      li.append(name);
      if (p.outfitId !== null) li.append(this.thumb(p.outfitId), this.reportButton(p.outfitId, p.name));
      ul.append(li);
    }
    body.append(ul, el('p', 'settings-note', '옷에 그린 그림이 불편하면 🚩로 알려 주세요. 여러 분이 신고하면 그림이 숨겨지고, 운영자가 살펴봐요.'));
    this.modal.open();
  }

  /** One person (tapped in the world). */
  openPlayer(id: string) {
    const p = this.players.info(id);
    if (!p) return;
    const body = this.frame(p.name);
    body.dataset.id = id;
    if (p.outfitId !== null && p.patterned) {
      const row = el('div', 'report-item');
      row.append(this.thumb(p.outfitId), el('span', 'report-name', '옷에 그림을 그려 입었어요'), this.reportButton(p.outfitId, p.name));
      body.append(row);
    } else {
      body.append(el('p', 'settings-note', p.guest ? '로그인하지 않고 둘러보는 분이에요.' : '그림 없는 옷을 입고 있어요.'));
    }
    const all = button('함께 있는 사람 모두 보기', 'ghost', () => this.openList());
    body.append(all);
    this.modal.open();
  }

  openReport(outfitId: number, name: string) {
    if (!this.signedIn()) return this.needLogin('로그인하면 불편한 옷 그림을 신고할 수 있어요.');
    const body = this.frame('🚩 옷 신고');
    body.append(el('p', '', `${name} 님의 옷 그림을 신고할까요? 신고한 사람은 알려지지 않아요.`), this.thumb(outfitId));
    let reason: ReportReason | null = null;
    const chips = el('div', 'look-styles report-reasons');
    chips.setAttribute('role', 'radiogroup');
    chips.setAttribute('aria-label', '신고 이유');
    const status = el('p', 'groups-status');
    status.setAttribute('role', 'status');
    const send = button('신고하기', 'primary', async () => {
      if (!reason) return;
      send.disabled = true;
      try {
        const r = await api<{ duplicate: boolean }>('POST', `/api/outfits/${outfitId}/report`, { reason });
        status.textContent = r.duplicate ? '이미 신고한 옷이에요. 고마워요.' : '신고를 받았어요. 알려 주셔서 고마워요.';
        send.hidden = true;
      } catch (err) {
        send.disabled = false;
        status.textContent = err instanceof ApiError ? err.message : '보내지 못했어요. 잠시 후 다시 시도해 주세요.';
      }
    });
    send.id = 'report-send';
    send.disabled = true;
    for (const r of REPORT_REASONS) {
      const b = button(REPORT_LABELS[r], 'chip big-chip', () => {
        reason = r;
        for (const x of chips.children) x.setAttribute('aria-checked', String(x === b));
        send.disabled = false;
      });
      b.id = `report-reason-${r}`;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      chips.append(b);
    }
    const actions = el('div', 'prompt-actions');
    actions.append(send, button('그만두기', 'ghost', () => this.modal.close()));
    body.append(chips, actions, status);
    if (!this.modal.isOpen) this.modal.open();
  }
}
