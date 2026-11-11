import { REPORT_LABELS, type ReportReason } from '../../../shared/protocol';
import { api, ApiError } from '../net/api';
import { button, el, Modal } from './dom';
import { drawThumb } from './OutfitPainter';

interface AdminOutfit {
  id: number;
  hash: string;
  pixels: string;
  owner: { id: number; nickname: string; strikes: number; banUntil: number | null };
  reporters: number;
  reasons: Partial<Record<ReportReason, number>>;
  hidden: boolean;
  review: 'kept' | 'restored' | null;
  worn: boolean;
  replaced: boolean;
  createdAt: number;
  lastReportAt: number | null;
}

const day = (ms: number) => {
  const d = new Date(ms + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};

/**
 * 옷 그림 관리 (admins only; the server checks every call and answers 404 to
 * everyone else): reported or hidden drawings with 숨김 유지 / 복구 / 그림 금지.
 */
export class AdminView {
  private readonly modal = new Modal('admin-overlay', '옷 그림 관리');
  private status: HTMLElement | null = null;

  async open() {
    this.modal.sheet.className = 'sheet admin-sheet';
    this.modal.sheet.replaceChildren(el('p', 'settings-note admin-loading', '불러오는 중…'));
    this.modal.open();
    await this.load();
  }

  private async load() {
    let list: AdminOutfit[];
    try {
      list = (await api<{ outfits: AdminOutfit[] }>('GET', '/api/admin/outfits')).outfits;
    } catch (err) {
      this.modal.sheet.replaceChildren(el('p', 'settings-note', err instanceof ApiError ? err.message : '불러오지 못했어요.'));
      return;
    }
    if (!this.modal.isOpen) return;
    const sheet = this.modal.sheet;
    sheet.replaceChildren();
    const top = el('header', 'book-top');
    top.append(el('h2', 'book-title', '옷 그림 관리'), button('닫기', 'ghost', () => this.modal.close()));
    this.status = el('p', 'groups-status');
    this.status.setAttribute('role', 'status');
    const body = el('div', 'admin-body');
    body.append(el('p', 'settings-note', '신고된 옷 그림이에요. 3명이 신고하면 자동으로 숨겨져요. 복구하면 숨김이 풀리고 그 사용자의 경고가 하나 줄어요.'), this.status);
    const ul = el('ul', 'admin-list');
    ul.id = 'admin-list';
    if (list.length === 0) body.append(el('p', 'settings-note', '살펴볼 그림이 없어요.'));
    for (const o of list) ul.append(this.card(o));
    body.append(ul);
    sheet.append(top, body);
  }

  private card(o: AdminOutfit): HTMLElement {
    const li = el('li', 'admin-item');
    li.dataset.id = String(o.id);
    const thumb = el('canvas', 'admin-thumb');
    thumb.width = thumb.height = 96;
    drawThumb(thumb, o.pixels, 0xf1e4c8);
    const info = el('div', 'admin-info');
    const state = o.hidden ? (o.review === 'kept' ? '숨김 (유지)' : '숨김') : o.review === 'restored' ? '보임 (복구됨)' : '보임';
    info.append(
      el('strong', 'admin-owner', o.owner.nickname || '(이름 없음)'),
      el('span', `admin-state ${o.hidden ? 'hidden' : ''}`, `${state}${o.replaced ? ' · 교체된 그림' : o.worn ? ' · 입는 중' : ''}`),
      el('span', '', `신고 ${o.reporters}명 · ${Object.entries(o.reasons).map(([k, n]) => `${REPORT_LABELS[k as ReportReason] ?? k} ${n}`).join(', ') || '-'}`),
      el('span', '', `경고 ${o.owner.strikes}${o.owner.banUntil ? ` · ${day(o.owner.banUntil)}까지 그림 금지` : ''}${o.lastReportAt ? ` · 마지막 신고 ${day(o.lastReportAt)}` : ''}`),
    );
    const actions = el('div', 'admin-actions');
    const act = async (action: 'hide' | 'restore' | 'ban', days?: number) => {
      try {
        await api('POST', `/api/admin/outfits/${o.id}`, { action, days });
        await this.load();
        if (this.status) this.status.textContent = action === 'hide' ? '숨김을 유지해요.' : action === 'restore' ? '복구했어요.' : `${days}일 동안 새 그림을 올릴 수 없게 했어요.`;
      } catch (err) {
        if (this.status) this.status.textContent = err instanceof ApiError ? err.message : '처리하지 못했어요.';
      }
    };
    const keep = button(o.hidden ? '숨김 유지' : '숨기기', 'chip', () => void act('hide'));
    keep.className = 'chip admin-hide';
    const restore = button('복구', 'chip admin-restore', () => void act('restore'));
    const days = el('input', 'admin-days');
    days.type = 'number';
    days.min = '1';
    days.max = '365';
    days.value = '7';
    days.setAttribute('aria-label', '그림 금지 일수');
    const ban = button('일 그림 금지', 'chip admin-ban', () => void act('ban', Number(days.value)));
    const banWrap = el('span', 'admin-ban-wrap');
    banWrap.append(days, ban);
    actions.append(keep, restore, banWrap);
    li.append(thumb, info, actions);
    return li;
  }
}
