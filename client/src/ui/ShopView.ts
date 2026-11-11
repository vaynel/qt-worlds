import { PROP_IDS, PROP_SLOT_LABELS, PROPS, SHOP_DAILY_LIMIT, type PropId } from '../../../shared/protocol';
import { BLOCK_LABELS, minutesLeft, type ShopClient } from '../game/Shop';
import { button, el, Modal } from './dom';
import { propIcon } from './PropIcons';

const duration = (min: number) => (min % 60 === 0 ? `${min / 60}시간` : `${min}분`);

export interface ShopViewOptions {
  toast(text: string): void;
  needLogin(reason: string): void;
}

/**
 * "나눔 소품 가게" sheet: one card per prop with this window's stock, the
 * duration and [빌리기] (or why not). Everything is re-rendered from
 * ShopClient, which only holds what the server said.
 */
export class ShopView {
  private readonly modal = new Modal('shop-overlay', '나눔 소품 가게');
  private readonly cards = new Map<PropId, { root: HTMLElement; stock: HTMLElement; btn: HTMLButtonElement }>();
  private readonly headLine = el('p', 'shop-hours');
  private readonly countLine = el('p', 'shop-count');
  private readonly statusLine = el('p', 'groups-status shop-status');
  private built = false;

  constructor(
    private readonly shop: ShopClient,
    private readonly o: ShopViewOptions,
  ) {
    shop.onChange(() => {
      if (this.modal.isOpen) this.render();
    });
  }

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  open() {
    if (!this.built) this.build();
    this.statusLine.textContent = '';
    this.render();
    this.modal.open();
    // The UI never guesses: fetch the latest when the sheet opens.
    void this.shop.refresh();
  }

  close() {
    this.modal.close();
  }

  private build() {
    this.built = true;
    const sheet = this.modal.sheet;
    sheet.className = 'sheet shop-sheet';
    const top = el('header', 'book-top shop-top');
    const title = el('div', 'shop-title-wrap');
    title.append(el('span', 'shop-awning', ''), el('h2', 'book-title', '나눔 소품 가게'));
    const close = button('닫기', 'ghost', () => this.modal.close());
    close.id = 'shop-close';
    top.append(title, close);
    this.headLine.id = 'shop-hours';
    this.countLine.id = 'shop-count';
    this.statusLine.setAttribute('role', 'status');
    this.statusLine.id = 'shop-status';
    const intro = el('div', 'shop-intro');
    intro.append(this.headLine, this.countLine);
    const grid = el('ul', 'shop-grid');
    grid.id = 'shop-grid';
    for (const id of PROP_IDS) {
      const def = PROPS[id];
      const li = el('li', `shop-card${def.rare ? ' rare' : ''}`);
      li.dataset.item = id;
      const icon = el('span', 'shop-icon');
      icon.append(propIcon(id, 'shop-icon-img'));
      icon.setAttribute('aria-hidden', 'true');
      const info = el('div', 'shop-info');
      const name = el('strong', 'shop-name', def.name);
      if (def.rare) name.append(el('span', 'shop-rare', '희귀'));
      const stock = el('span', 'shop-stock');
      info.append(name, el('span', 'shop-blurb', def.blurb), el('span', 'shop-meta', `${duration(def.minutes)} 동안 · ${def.slot === 'effect' ? '발자국' : PROP_SLOT_LABELS[def.slot]}`), stock);
      const btn = button('빌리기', 'primary shop-rent', () => void this.rent(id));
      btn.id = `shop-rent-${id}`;
      li.append(icon, info, btn);
      grid.append(li);
      this.cards.set(id, { root: li, stock, btn });
    }
    const note = el('p', 'settings-note shop-note', `모두 무료예요. 문을 열 때마다 정해진 수량을 먼저 오신 분께 빌려 드려요. 하루 ${SHOP_DAILY_LIMIT}번, 한 번에 2개까지 (같은 자리는 1개). 일찍 반납해도 횟수와 수량은 돌아오지 않아요.`);
    sheet.append(top, intro, this.statusLine, grid, note);
  }

  private render() {
    const s = this.shop.status;
    const signedIn = this.shop.mine !== null;
    if (!s) this.headLine.textContent = '가게 소식을 불러오는 중…';
    else if (s.open) this.headLine.textContent = `지금 열려 있어요 · ${this.shop.closesLabel()}까지`;
    else this.headLine.textContent = `지금은 문을 닫았어요 · 다음 문 여는 시간 ${this.shop.nextOpenLabel()}`;
    this.headLine.classList.toggle('closed', !!s && !s.open);
    const used = this.shop.mine?.usedToday ?? 0;
    this.countLine.textContent = signedIn ? `오늘 내 대여 ${used}/${this.shop.mine?.dailyLimit ?? SHOP_DAILY_LIMIT}회` : '로그인하면 빌릴 수 있어요 (손님은 구경만 할 수 있어요)';
    for (const [id, c] of this.cards) {
      const st = s?.stock[id];
      c.stock.textContent = s?.open ? (st ? `이번 시간 남은 수량 ${st.remaining}/${st.total}` : '이번 시간 수량 확인 중') : '문을 열면 새로 들어와요';
      c.stock.classList.toggle('empty', !!s?.open && !!st && st.remaining <= 0);
      const why = this.shop.block(id);
      const renting = this.shop.rentals.find((r) => r.item === id);
      c.root.classList.toggle('renting', !!renting);
      c.btn.disabled = why !== null && why !== 'login';
      c.btn.textContent = why === null ? '빌리기' : why === 'renting' && renting ? `사용 중 · ${minutesLeft(this.shop.remainingMs(renting))}` : BLOCK_LABELS[why];
      c.btn.classList.toggle('blocked', why !== null);
      c.btn.dataset.block = why ?? '';
    }
  }

  private async rent(id: PropId) {
    if (this.shop.block(id) === 'login') {
      this.modal.close();
      this.o.needLogin('로그인하면 나눔 소품 가게에서 소품을 무료로 빌릴 수 있어요.');
      return;
    }
    if (this.shop.block(id) !== null) return;
    this.statusLine.textContent = '';
    const def = PROPS[id];
    const out = await this.shop.rent(id);
    if (out.ok) {
      const msg = `${def.emoji} ${def.name}을(를) 빌렸어요 · ${duration(def.minutes)}`;
      this.statusLine.textContent = msg;
      this.o.toast(msg);
    } else {
      this.statusLine.textContent = out.message;
    }
  }
}

/**
 * HUD dock (top-left, under the place card): 🏪 shop chip while open (or the
 * next opening time in the plaza) and one chip per borrowed prop with the time
 * left and [반납] (tap twice to confirm).
 */
export class PropDock {
  readonly root = el('div', 'prop-dock');
  private readonly shopChip = button('', 'prop-chip shop-chip');
  private readonly list = el('div', 'prop-list');
  private confirmId: number | null = null;
  private confirmUntil = 0;
  private lastKey = '';
  private showClosed = false;

  constructor(
    private readonly shop: ShopClient,
    onShop: () => void,
    private readonly toast: (text: string) => void,
  ) {
    this.root.id = 'prop-dock';
    this.shopChip.id = 'shop-chip';
    this.shopChip.addEventListener('click', (e) => {
      e.preventDefault();
      onShop();
      this.shopChip.blur();
    });
    this.list.id = 'prop-list';
    this.root.append(this.shopChip, this.list);
    this.root.addEventListener('pointerdown', (e) => e.stopPropagation());
    document.getElementById('app')!.append(this.root);
    shop.onChange(() => this.update(true));
  }

  /** Show the "next opening" chip while closed (only near the plaza). */
  setNearPlaza(near: boolean) {
    if (near === this.showClosed) return;
    this.showClosed = near;
    this.update(true);
  }

  /** Called every frame; rewrites the DOM only when a label changes. */
  update(force = false) {
    const s = this.shop;
    const now = Date.now();
    if (this.confirmId !== null && now > this.confirmUntil) {
      this.confirmId = null;
      force = true;
    }
    const chips = s.rentals.map((r) => `${r.id}:${r.item}:${minutesLeft(s.remainingMs(r))}:${s.returning.has(r.id)}`);
    const shopText = s.open || (this.showClosed && s.status) ? '소품 가게' : '';
    const shopSub = s.open ? `${s.closesLabel()}까지 열림` : `${s.nextOpenLabel()}에 열어요`;
    const key = `${shopText}|${shopSub}|${chips.join(',')}|${this.confirmId}`;
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    this.shopChip.hidden = !shopText;
    const main = el('span', 'shop-chip-main');
    main.append(el('span', 'shop-awning mini'), shopText);
    this.shopChip.replaceChildren(main, el('span', 'shop-chip-sub', shopSub));
    this.shopChip.classList.toggle('closed', !s.open);
    this.shopChip.setAttribute('aria-label', s.open ? `나눔 소품 가게 열기 (${s.closesLabel()}까지)` : `나눔 소품 가게 · 다음 문 여는 시간 ${s.nextOpenLabel()}`);
    this.list.replaceChildren(
      ...s.rentals.map((r) => {
        const def = PROPS[r.item];
        const chip = el('div', 'prop-chip rental-chip');
        chip.dataset.item = r.item;
        const label = el('span', 'rental-label');
        label.append(propIcon(r.item, 'rental-icon'), el('span', 'rental-time', minutesLeft(s.remainingMs(r))));
        label.title = `${def.name} · ${minutesLeft(s.remainingMs(r))} 남음`;
        label.setAttribute('aria-label', `${def.name} ${minutesLeft(s.remainingMs(r))} 남음`);
        const confirming = this.confirmId === r.id;
        const back = button(s.returning.has(r.id) ? '…' : confirming ? '반납할까요?' : '반납', `rental-return${confirming ? ' confirm' : ''}`, () => void this.giveBack(r.id, def.name));
        back.id = `return-${r.item}`;
        back.disabled = s.returning.has(r.id);
        chip.append(label, back);
        return chip;
      }),
    );
    this.root.hidden = !shopText && s.rentals.length === 0;
  }

  private async giveBack(id: number, name: string) {
    if (this.confirmId !== id) {
      this.confirmId = id;
      this.confirmUntil = Date.now() + 4000;
      this.update(true);
      return;
    }
    this.confirmId = null;
    const out = await this.shop.giveBack(id);
    if (out.ok) this.toast(`${name}을(를) 반납했어요. 고마워요!`);
    else if (out.message) this.toast(out.message);
  }
}
