import {
  DEFAULT_APPEARANCE,
  HAIR_COLORS,
  HAIR_STYLES,
  OUTFIT_SLOTS,
  ROBE_COLORS,
  SCARF_COLORS,
  SKIN_COLORS,
  type Appearance,
} from '../../../shared/protocol';
import { TERMS_PATH } from '../config/legal';
import { avatarLook, outfitCache } from '../game/looks';
import { api, ApiError } from '../net/api';
import { AvatarPreview } from './AvatarPreview';
import { button, el, Modal } from './dom';
import { drawThumb, EMPTY_OUTFIT, OutfitPainter } from './OutfitPainter';

export interface SlotInfo {
  slot: number;
  id: number;
  hash: string;
  pixels: string;
  hidden: boolean;
  createdAt: number;
}

/** GET/PUT /api/me/look */
export interface MyLook {
  appearance: Appearance | null;
  worn: number | null;
  slots: (SlotInfo | null)[];
  banUntil: number | null;
  strikes: number;
}

type Tab = 'color' | 'hair' | 'draw';

const HAIR_LABELS: Record<(typeof HAIR_STYLES)[number], string> = {
  short: '짧은 머리',
  bob: '단발',
  long: '긴 머리',
  tied: '묶은 머리',
  bald: '민머리',
};

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

const kstDay = (ms: number) => {
  const d = new Date(ms + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`;
};

/** "신고가 쌓여 옷 그림이 숨겨졌어요" with a link to the terms (DOM only, no HTML strings). */
export function hiddenNotice(extra = '다른 분들께는 그림 없는 옷으로 보여요. 그림을 고쳐서 저장하면 다시 보여요.'): HTMLElement {
  const box = el('div', 'outfit-hidden-note');
  box.append(el('strong', '', '신고가 쌓여 옷 그림이 숨겨졌어요'), el('span', '', extra));
  const a = el('a', '', '이용약관 보기');
  a.href = `${TERMS_PATH}#t7`;
  a.target = '_blank';
  a.rel = 'noopener';
  box.append(a);
  return box;
}

/**
 * 👕 꾸미기: live 3D preview (drag to turn) and three tabs — 색, 머리, 옷 그리기.
 * Saving sends palette indices and the worn slot; drawings go to their slot.
 * The slot you pick is the one you wear (or 입지 않기).
 */
export class CustomizeView {
  private readonly modal = new Modal('look-overlay', '꾸미기');
  private preview: AvatarPreview | null = null;
  private painter: OutfitPainter | null = null;
  private tab: Tab = 'color';
  private mine: MyLook | null = null;
  private appearance: Appearance = { ...DEFAULT_APPEARANCE };
  /** Selected slot (= worn after saving), or null for 입지 않기. */
  private slot: number | null = null;
  private drawing = EMPTY_OUTFIT;
  private drawingDirty = false;
  private lookDirty = false;
  private busy = false;
  private status: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private tabBtns = new Map<Tab, HTMLButtonElement>();
  /** An unsaved drawing survives closing the sheet by accident (until the page reloads). */
  private draft: { slot: number; pixels: string } | null = null;
  /** Opened from ⚙ 설정: "← 설정" goes back to the menu. */
  private back: (() => void) | null = null;

  constructor(private readonly onSaved: (mine: MyLook) => void) {}

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  async open(tab: Tab = 'color', back?: () => void) {
    this.tab = tab;
    this.back = back ?? null;
    let mine: MyLook;
    try {
      mine = await api<MyLook>('GET', '/api/me/look');
    } catch (err) {
      throw err instanceof ApiError ? err : new ApiError(0, 'network', '꾸미기를 열지 못했어요.');
    }
    this.mine = mine;
    this.appearance = { ...(mine.appearance ?? DEFAULT_APPEARANCE) };
    this.slot = mine.worn;
    for (const s of mine.slots) if (s) outfitCache.remember(s.id, s.pixels);
    this.loadSlotDrawing();
    const draft = this.draft;
    if (draft && draft.slot === this.slot) {
      this.drawing = draft.pixels;
      this.drawingDirty = true;
    }
    this.draft = null;
    this.lookDirty = false;
    this.render();
    if (this.drawingDirty) this.setStatus('저장하지 않은 그림을 이어서 그려요.');
    this.modal.open(() => this.teardown());
    // The canvas needs layout before the renderer sizes itself.
    requestAnimationFrame(() => {
      if (!this.modal.isOpen) return;
      this.preview = new AvatarPreview(this.modal.sheet.querySelector<HTMLCanvasElement>('#look-preview')!);
      this.refreshPreview();
      this.layoutPainter();
    });
  }

  close() {
    this.modal.close();
  }

  private teardown() {
    if (this.drawingDirty && this.slot !== null) this.draft = { slot: this.slot, pixels: this.drawing };
    this.preview?.dispose();
    this.preview = null;
    this.painter = null;
    window.removeEventListener('resize', this.layoutPainter);
  }

  private loadSlotDrawing() {
    const s = this.slot !== null ? this.mine?.slots[this.slot] : null;
    this.drawing = s?.pixels ?? EMPTY_OUTFIT;
    this.drawingDirty = false;
    this.painter?.load(this.slot === null ? null : this.drawing);
  }

  private readonly layoutPainter = () => {
    if (!this.painter || !this.body) return;
    // Leave room for the palette and tools under the grid on short screens.
    // The whole grid should fit in the scrolling area (cells never below 16 px).
    const w = this.body.clientWidth - 36;
    const h = this.body.clientHeight - 16;
    if (w > 0) this.painter.layout(Math.min(w, Math.max(16 * 16, h)));
  };

  private refreshPreview() {
    const look = avatarLook(this.appearance);
    const pixels = this.slot !== null && this.drawing !== EMPTY_OUTFIT ? this.drawing : null;
    this.preview?.setLook(look, pixels);
    this.painter?.setRobe(look.robe);
    this.renderSlots();
  }

  private setStatus(text: string) {
    if (this.status) this.status.textContent = text;
  }

  private render() {
    const sheet = this.modal.sheet;
    sheet.className = 'sheet look';
    sheet.replaceChildren();
    this.tabBtns.clear();
    const top = el('header', 'book-top');
    const toSettings = this.back;
    if (toSettings) {
      const b = button('← 설정', 'ghost settings-back look-back', () => {
        this.close();
        toSettings();
      });
      b.id = 'look-back';
      top.append(b);
    }
    top.append(el('h2', 'book-title', '👕 꾸미기'), button('닫기', 'ghost look-close', () => this.close()));

    const stage = el('div', 'look-stage');
    const canvas = el('canvas', 'look-preview');
    canvas.id = 'look-preview';
    canvas.setAttribute('aria-label', '내 모습 미리보기 (끌어서 돌려 보기)');
    const turnHint = el('span', 'look-hint', '끌어서 돌려 보기');
    const back = button('뒤로 돌기', 'chip look-turn', () => this.preview?.face((this.preview?.angle ?? 0) + Math.PI));
    stage.append(canvas, turnHint, back);

    const tabs = el('div', 'look-tabs');
    tabs.setAttribute('role', 'tablist');
    for (const [t, label] of [
      ['color', '색'],
      ['hair', '머리'],
      ['draw', '옷 그리기'],
    ] as [Tab, string][]) {
      const b = button(label, 'look-tab', () => this.switchTab(t));
      b.id = `look-tab-${t}`;
      b.setAttribute('role', 'tab');
      this.tabBtns.set(t, b);
      tabs.append(b);
    }

    this.body = el('div', 'look-body');
    const foot = el('div', 'look-foot');
    this.status = el('p', 'groups-status look-status');
    this.status.setAttribute('role', 'status');
    const save = button('저장하기', 'primary', () => void this.save());
    save.id = 'look-save';
    foot.append(this.status, save);

    sheet.append(top, stage, tabs, this.body, foot);
    this.switchTab(this.tab);
  }

  private switchTab(t: Tab) {
    this.tab = t;
    this.modal.sheet.classList.toggle('drawing', t === 'draw');
    for (const [k, b] of this.tabBtns) b.setAttribute('aria-selected', String(k === t));
    const body = this.body!;
    body.replaceChildren();
    this.painter = null;
    this.slotRow = null;
    if (t === 'color') this.buildColors(body);
    else if (t === 'hair') this.buildHair(body);
    else this.buildDraw(body);
    this.refreshPreview();
  }

  private swatchRow(label: string, colors: readonly number[], key: 'r' | 's' | 'k' | 'h'): HTMLElement {
    const row = el('div', 'look-row');
    row.append(el('p', 'settings-section', label));
    const list = el('div', 'look-swatches');
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', label);
    colors.forEach((c, i) => {
      const b = button('', 'swatch big', () => {
        this.appearance = { ...this.appearance, [key]: i };
        this.lookDirty = true;
        for (const x of list.children) x.setAttribute('aria-checked', String(x === b));
        this.refreshPreview();
      });
      b.style.background = hex(c);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', `${label} ${i + 1}`);
      b.setAttribute('aria-checked', String(this.appearance[key] === i));
      b.dataset.key = key;
      b.dataset.index = String(i);
      list.append(b);
    });
    row.append(list);
    return row;
  }

  private buildColors(body: HTMLElement) {
    body.append(
      this.swatchRow('겉옷', ROBE_COLORS, 'r'),
      this.swatchRow('목도리', SCARF_COLORS, 's'),
      this.swatchRow('피부', SKIN_COLORS, 'k'),
      this.swatchRow('머리색', HAIR_COLORS, 'h'),
    );
  }

  private buildHair(body: HTMLElement) {
    const list = el('div', 'look-styles');
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', '머리 모양');
    HAIR_STYLES.forEach((style, i) => {
      const b = button(HAIR_LABELS[style], 'chip big-chip', () => {
        this.appearance = { ...this.appearance, y: i };
        this.lookDirty = true;
        for (const x of list.children) x.setAttribute('aria-checked', String(x === b));
        this.refreshPreview();
      });
      b.id = `hair-${style}`;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(this.appearance.y === i));
      list.append(b);
    });
    body.append(el('p', 'settings-section', '머리 모양'), list, this.swatchRow('머리색', HAIR_COLORS, 'h'));
  }

  private slotRow: HTMLElement | null = null;

  private renderSlots() {
    const row = this.slotRow;
    if (!row || !this.mine) return;
    const robe = ROBE_COLORS[this.appearance.r];
    row.replaceChildren();
    const none = button('입지 않기', 'look-slot none', () => this.pickSlot(null));
    none.id = 'slot-none';
    none.setAttribute('aria-pressed', String(this.slot === null));
    row.append(none);
    for (let i = 0; i < OUTFIT_SLOTS; i++) {
      const saved = this.mine.slots[i];
      const b = button('', 'look-slot', () => this.pickSlot(i));
      b.id = `slot-${i}`;
      const thumb = el('canvas', 'slot-thumb');
      thumb.width = thumb.height = 48;
      const live = i === this.slot ? this.drawing : (saved?.pixels ?? null);
      drawThumb(thumb, live && live !== EMPTY_OUTFIT ? live : null, robe);
      b.append(thumb, el('span', '', `${i + 1}${saved?.hidden ? ' · 숨김' : saved ? '' : ' · 빈 칸'}`));
      b.setAttribute('aria-pressed', String(this.slot === i));
      b.setAttribute('aria-label', `옷 ${i + 1}${saved ? '' : ' (빈 칸)'}`);
      row.append(b);
    }
  }

  private pickSlot(slot: number | null) {
    if (slot === this.slot) return;
    if (this.drawingDirty && !confirm('저장하지 않은 그림이 있어요. 다른 칸으로 갈까요?')) return;
    this.slot = slot;
    this.lookDirty = true;
    this.loadSlotDrawing();
    this.buildDraw(this.body!);
    this.refreshPreview();
  }

  private buildDraw(body: HTMLElement) {
    body.replaceChildren();
    const mine = this.mine!;
    this.slotRow = el('div', 'look-slots');
    body.append(el('p', 'settings-section', '입을 옷'), this.slotRow);
    const current = this.slot !== null ? mine.slots[this.slot] : null;
    if (current?.hidden) body.append(hiddenNotice('다른 분들께는 그림 없는 옷으로 보여요. 고쳐서 저장하면 새 그림으로 다시 보여요.'));
    if (mine.banUntil) {
      body.append(el('p', 'look-ban', `신고가 쌓여 ${kstDay(mine.banUntil)}까지 새 그림을 저장할 수 없어요. 색과 머리는 바꿀 수 있어요.`));
    }
    if (this.slot === null) {
      body.append(el('p', 'settings-note', '그림 없는 옷을 입어요. 1~3번 칸을 고르면 옷에 그림을 그릴 수 있어요.'));
      this.painter = null;
      this.renderSlots();
      return;
    }
    this.painter = new OutfitPainter((pixels) => {
      this.drawing = pixels;
      this.drawingDirty = true;
      this.refreshPreview();
    });
    this.painter.load(this.drawing === EMPTY_OUTFIT ? null : this.drawing);
    this.painter.setRobe(ROBE_COLORS[this.appearance.r]);
    this.painter.setDisabled(!!mine.banUntil);
    body.append(this.painter.root, el('p', 'settings-note', '빈칸은 겉옷 색으로 보여요. 그림은 옷의 앞과 뒤에 들어가요. 다른 분들도 볼 수 있으니 서로를 배려해 주세요.'));
    this.renderSlots();
    window.removeEventListener('resize', this.layoutPainter);
    window.addEventListener('resize', this.layoutPainter);
    requestAnimationFrame(this.layoutPainter);
  }

  private async save() {
    if (this.busy || !this.mine) return;
    this.busy = true;
    this.setStatus('저장하고 있어요…');
    try {
      let mine = this.mine;
      let worn = this.slot;
      if (this.slot !== null && this.drawingDirty) {
        if (this.drawing === EMPTY_OUTFIT) {
          mine = await api<MyLook>('DELETE', `/api/me/outfits/${this.slot}`);
          worn = null;
        } else {
          mine = await api<MyLook>('PUT', `/api/me/outfits/${this.slot}`, { pixels: this.drawing });
        }
        this.drawingDirty = false;
      }
      if (worn !== null && !mine.slots[worn]) worn = null;
      mine = await api<MyLook>('PUT', '/api/me/look', { appearance: this.appearance, worn });
      this.mine = mine;
      this.slot = mine.worn;
      this.lookDirty = false;
      for (const s of mine.slots) if (s) outfitCache.remember(s.id, s.pixels);
      this.loadSlotDrawing();
      if (this.tab === 'draw') this.buildDraw(this.body!);
      this.refreshPreview();
      this.onSaved(mine);
      this.setStatus('저장했어요. 다른 분들께도 바로 보여요.');
    } catch (err) {
      this.setStatus(err instanceof ApiError ? err.message : '저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      this.busy = false;
    }
  }

  /** For tests. */
  describe() {
    return {
      open: this.modal.isOpen,
      tab: this.tab,
      slot: this.slot,
      appearance: { ...this.appearance },
      pixels: this.painter?.pixels ?? null,
      tool: this.painter?.tool ?? null,
      mirror: this.painter?.mirror ?? null,
      history: this.painter?.history ?? null,
      cell: this.painter?.cellSize ?? null,
      previewPattern: this.preview?.avatar.patternInfo?.pixels ?? null,
      previewStyle: this.preview?.avatar.currentLook.hairStyle ?? null,
      dirty: this.drawingDirty || this.lookDirty,
    };
  }
}
