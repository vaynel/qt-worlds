import { PROPS, REPORT_LABELS, SHOP_STOCK_MAX, type PropId, type ReportReason } from '../../../shared/protocol';
import { api, ApiError } from '../net/api';
import { button, el, Modal } from './dom';
import { drawThumb } from './OutfitPainter';
import { propIcon } from './PropIcons';

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
interface ShopOverview {
  date: string;
  now: number;
  activeNow: number;
  windows: {
    win: number;
    start: string;
    end: string;
    state: 'past' | 'open' | 'upcoming';
    released: boolean;
    rentals: number;
    items: { item: PropId; total: number; remaining: number; rented: number }[];
  }[];
  defaults: { item: PropId; stock: number; base: number }[];
}

export class AdminView {
  private readonly modal = new Modal('admin-overlay', '운영 관리');
  private status: HTMLElement | null = null;
  private tab: 'outfits' | 'shop' = 'outfits';

  async open(tab: 'outfits' | 'shop' = this.tab) {
    this.tab = tab;
    this.modal.sheet.className = 'sheet admin-sheet';
    this.modal.sheet.replaceChildren(el('p', 'settings-note admin-loading', '불러오는 중…'));
    this.modal.open();
    await this.reload();
  }

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  private reload() {
    return this.tab === 'shop' ? this.loadShop() : this.load();
  }

  /** Header with the two admin areas. */
  private top(title: string): HTMLElement {
    const top = el('header', 'book-top admin-top');
    const tabs = el('div', 'admin-tabs');
    for (const [key, label] of [
      ['outfits', '옷 그림'],
      ['shop', '소품 가게'],
    ] as const) {
      const b = button(label, 'chip', () => void this.open(key));
      b.id = `admin-tab-${key}`;
      b.setAttribute('aria-pressed', String(this.tab === key));
      tabs.append(b);
    }
    top.append(el('h2', 'book-title', title), tabs, button('닫기', 'ghost', () => this.modal.close()));
    return top;
  }

  // ------------------------------------------------------------------ 나눔 소품 가게

  private async loadShop() {
    let o: ShopOverview;
    try {
      o = await api<ShopOverview>('GET', '/api/admin/shop');
    } catch (err) {
      this.modal.sheet.replaceChildren(el('p', 'settings-note', err instanceof ApiError ? err.message : '불러오지 못했어요.'));
      return;
    }
    if (!this.modal.isOpen) return;
    this.renderShop(o);
  }

  private renderShop(o: ShopOverview, note = '') {
    const sheet = this.modal.sheet;
    sheet.replaceChildren();
    this.status = el('p', 'groups-status');
    this.status.setAttribute('role', 'status');
    this.status.textContent = note;
    const body = el('div', 'admin-body admin-shop');
    body.id = 'admin-shop';
    body.append(
      el('p', 'settings-note', `${o.date} (한국 시간) · 지금 쓰는 중인 소품 ${o.activeNow}개. 지나간 시간대는 바꿀 수 없어요. 열려 있는 시간대의 수량을 줄여도 이미 빌려 간 수만큼은 남아요.`),
      this.status,
    );
    const save = async (path: string, payload: Record<string, unknown>, done: string) => {
      try {
        const next = await api<ShopOverview>('PUT', path, payload);
        this.renderShop(next, done);
      } catch (err) {
        if (this.status) this.status.textContent = err instanceof ApiError ? err.message : '저장하지 못했어요.';
      }
    };
    const num = (value: number, label: string) => {
      const input = el('input', 'admin-days admin-stock');
      input.type = 'number';
      input.min = '0';
      input.max = String(SHOP_STOCK_MAX);
      input.value = String(value);
      input.setAttribute('aria-label', label);
      return input;
    };
    for (const w of o.windows) {
      const sec = el('section', `admin-window ${w.state}`);
      sec.dataset.win = String(w.win);
      const stateLabel = w.state === 'open' ? '지금 열림' : w.state === 'past' ? (w.released ? '지남' : '지남 (열리지 않음)') : w.released ? '예정 (수량 정함)' : '예정';
      sec.append(el('p', 'settings-section', `${w.start}–${w.end} · ${stateLabel} · 대여 ${w.rentals}건`));
      const table = el('table', 'admin-shop-table');
      const head = el('tr');
      for (const h of ['소품', '남음 / 수량', '빌려 감', w.state === 'past' ? '' : '수량 바꾸기']) head.append(el('th', '', h));
      table.append(head);
      for (const it of w.items) {
        const tr = el('tr');
        tr.dataset.item = it.item;
        const def = PROPS[it.item];
        const name = el('td', 'admin-prop');
        name.append(propIcon(it.item, 'admin-prop-icon'), def.name);
        const unreleased = w.state === 'past' && !w.released;
        tr.append(name, el('td', 'admin-remaining', unreleased ? '-' : `${it.remaining} / ${it.total}`), el('td', '', String(it.rented)));
        const td = el('td');
        if (w.state !== 'past') {
          const input = num(it.total, `${w.start} ${def.name} 수량`);
          const ok = button('저장', 'chip admin-stock-save', () => void save('/api/admin/shop/stock', { win: w.win, item: it.item, total: Number(input.value) }, `${w.start} ${def.name} 수량을 ${input.value}개로 정했어요.`));
          td.append(input, ok);
        }
        tr.append(td);
        table.append(tr);
      }
      sec.append(table);
      body.append(sec);
    }
    const defs = el('section', 'admin-window defaults');
    defs.append(el('p', 'settings-section', '기본 수량 (아직 열지 않은 시간대부터)'));
    const table = el('table', 'admin-shop-table');
    for (const d of o.defaults) {
      const tr = el('tr');
      tr.dataset.item = d.item;
      const def = PROPS[d.item];
      const input = num(d.stock, `${def.name} 기본 수량`);
      const td = el('td');
      td.append(input, button('저장', 'chip admin-default-save', () => void save('/api/admin/shop/defaults', { item: d.item, stock: Number(input.value) }, `${def.name} 기본 수량을 ${input.value}개로 정했어요.`)));
      const name = el('td', 'admin-prop');
      name.append(propIcon(d.item, 'admin-prop-icon'), def.name);
      tr.append(name, el('td', 'settings-hint', `처음 값 ${d.base}`), td);
      table.append(tr);
    }
    defs.append(table);
    body.append(defs);
    sheet.append(this.top('소품 가게 관리'), body);
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
    const top = this.top('옷 그림 관리');
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
