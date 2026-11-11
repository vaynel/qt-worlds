import { OUTFIT_CELLS, OUTFIT_PALETTE, OUTFIT_SIZE, OUTFIT_TRANSPARENT } from '../../../shared/protocol';
import { button, el } from './dom';

export type PaintTool = 'pen' | 'fill' | 'erase';
const N = OUTFIT_SIZE;
const UNDO_MAX = 30;
const SYMBOLS = '0123456789abcdef';

export const EMPTY_OUTFIT = OUTFIT_TRANSPARENT.repeat(OUTFIT_CELLS);

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** Draw a drawing (or nothing) onto a small canvas, transparent cells in the robe colour. */
export function drawThumb(canvas: HTMLCanvasElement, pixels: string | null, robe: number) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const s = canvas.width / N;
  ctx.fillStyle = hex(robe);
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!pixels) return;
  for (let i = 0; i < OUTFIT_CELLS; i++) {
    const idx = SYMBOLS.indexOf(pixels[i]);
    if (idx < 0) continue;
    ctx.fillStyle = hex(OUTFIT_PALETTE[idx]);
    ctx.fillRect((i % N) * s, Math.floor(i / N) * s, Math.ceil(s), Math.ceil(s));
  }
}

/**
 * 옷 그리기: a 16×16 grid painted with the fixed 16-colour palette.
 * Tools: 칠하기 (drag), 채우기 (flood fill), 지우기, 좌우대칭, 되돌리기/다시
 * (30 steps), 전체 지우기. The grid has touch-action: none, so dragging paints
 * instead of scrolling or pinch-zooming.
 */
export class OutfitPainter {
  readonly root = el('div', 'painter');
  private readonly canvas = el('canvas', 'painter-grid');
  private readonly ctx: CanvasRenderingContext2D;
  private cells: string[] = EMPTY_OUTFIT.split('');
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  tool: PaintTool = 'pen';
  color = 2;
  mirror = false;
  private robe = 0xf1e4c8;
  private cell = 20;
  private stroke: { id: number; last: number } | null = null;
  private readonly swatches: HTMLButtonElement[] = [];
  private readonly toolBtns = new Map<PaintTool, HTMLButtonElement>();
  private readonly mirrorBtn: HTMLButtonElement;
  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;
  private disabled = false;

  constructor(private readonly onChange: (pixels: string) => void) {
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.id = 'painter-grid';
    this.canvas.setAttribute('aria-label', '옷 그림판 16×16칸');
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointercancel', this.onUp);
    // No long-press menu or text selection while painting.
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    const palette = el('div', 'painter-palette');
    palette.setAttribute('role', 'radiogroup');
    palette.setAttribute('aria-label', '물감');
    OUTFIT_PALETTE.forEach((c, i) => {
      const b = button('', 'swatch', () => {
        this.color = i;
        if (this.tool === 'erase') this.setTool('pen');
        this.refreshUi();
      });
      b.style.background = hex(c);
      b.dataset.index = String(i);
      b.setAttribute('aria-label', `물감 ${i + 1}`);
      this.swatches.push(b);
      palette.append(b);
    });

    const tools = el('div', 'painter-tools');
    const tool = (t: PaintTool, label: string) => {
      const b = button(label, 'chip', () => this.setTool(t));
      b.id = `paint-${t}`;
      this.toolBtns.set(t, b);
      tools.append(b);
    };
    tool('pen', '칠하기');
    tool('fill', '채우기');
    tool('erase', '지우기');
    this.mirrorBtn = button('↔ 좌우대칭', 'chip', () => {
      this.mirror = !this.mirror;
      this.refreshUi();
      this.render();
    });
    this.mirrorBtn.id = 'paint-mirror';
    tools.append(this.mirrorBtn);

    const history = el('div', 'painter-tools');
    this.undoBtn = button('↶ 되돌리기', 'chip', () => this.undo());
    this.undoBtn.id = 'paint-undo';
    this.redoBtn = button('↷ 다시', 'chip', () => this.redo());
    this.redoBtn.id = 'paint-redo';
    const clear = button('전체 지우기', 'chip ghost-chip', () => {
      if (this.cells.every((c) => c === OUTFIT_TRANSPARENT)) return;
      this.snapshot();
      this.cells = EMPTY_OUTFIT.split('');
      this.changed();
    });
    clear.id = 'paint-clear';
    history.append(this.undoBtn, this.redoBtn, clear);

    this.root.append(this.canvas, palette, tools, history);
    this.refreshUi();
  }

  get pixels(): string {
    return this.cells.join('');
  }

  get isEmpty(): boolean {
    return this.cells.every((c) => c === OUTFIT_TRANSPARENT);
  }

  get history(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }

  /** Load a drawing (resets history). */
  load(pixels: string | null) {
    this.cells = (pixels ?? EMPTY_OUTFIT).split('');
    this.undoStack = [];
    this.redoStack = [];
    this.refreshUi();
    this.render();
  }

  setRobe(robe: number) {
    this.robe = robe;
    this.render();
  }

  setDisabled(disabled: boolean) {
    this.disabled = disabled;
    this.root.classList.toggle('disabled', disabled);
  }

  /** Cell size from the available width: at least 16 px, at most 26 px. */
  layout(width: number) {
    this.cell = Math.max(16, Math.min(26, Math.floor(width / N)));
    const px = this.cell * N;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.style.width = `${px}px`;
    this.canvas.style.height = `${px}px`;
    this.canvas.width = Math.round(px * dpr);
    this.canvas.height = Math.round(px * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  get cellSize(): number {
    return this.cell;
  }

  setTool(t: PaintTool) {
    this.tool = t;
    this.refreshUi();
  }

  private refreshUi() {
    for (const [t, b] of this.toolBtns) b.setAttribute('aria-pressed', String(t === this.tool));
    this.swatches.forEach((b, i) => b.setAttribute('aria-checked', String(i === this.color && this.tool !== 'erase')));
    this.swatches.forEach((b) => b.setAttribute('role', 'radio'));
    this.mirrorBtn.setAttribute('aria-pressed', String(this.mirror));
    this.undoBtn.disabled = this.undoStack.length === 0;
    this.redoBtn.disabled = this.redoStack.length === 0;
  }

  private snapshot() {
    this.undoStack.push(this.pixels);
    if (this.undoStack.length > UNDO_MAX) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.redoStack.push(this.pixels);
    this.cells = prev.split('');
    this.changed();
  }

  redo() {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(this.pixels);
    this.cells = next.split('');
    this.changed();
  }

  private changed() {
    this.refreshUi();
    this.render();
    this.onChange(this.pixels);
  }

  private get ink(): string {
    return this.tool === 'erase' ? OUTFIT_TRANSPARENT : SYMBOLS[this.color];
  }

  private set(i: number, v: string): boolean {
    let changed = false;
    const put = (j: number) => {
      if (this.cells[j] !== v) {
        this.cells[j] = v;
        changed = true;
      }
    };
    put(i);
    if (this.mirror) put(Math.floor(i / N) * N + (N - 1 - (i % N)));
    return changed;
  }

  /** 4-neighbour flood fill from cell i (and its mirror twin when 좌우대칭 is on). */
  private fill(start: number, v: string): boolean {
    const flood = (i: number) => {
      const from = this.cells[i];
      if (from === v) return false;
      const stack = [i];
      while (stack.length) {
        const j = stack.pop()!;
        if (this.cells[j] !== from) continue;
        this.cells[j] = v;
        const x = j % N;
        if (x > 0) stack.push(j - 1);
        if (x < N - 1) stack.push(j + 1);
        if (j >= N) stack.push(j - N);
        if (j < OUTFIT_CELLS - N) stack.push(j + N);
      }
      return true;
    };
    const a = flood(start);
    const b = this.mirror ? flood(Math.floor(start / N) * N + (N - 1 - (start % N))) : false;
    return a || b;
  }

  private cellAt(e: PointerEvent): number {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * N);
    const y = Math.floor(((e.clientY - r.top) / r.height) * N);
    if (x < 0 || y < 0 || x >= N || y >= N) return -1;
    return y * N + x;
  }

  private readonly onDown = (e: PointerEvent) => {
    e.preventDefault();
    if (this.disabled || this.stroke) return;
    const i = this.cellAt(e);
    if (i < 0) return;
    const before = this.pixels;
    if (this.tool === 'fill') {
      if (this.fill(i, this.ink)) {
        this.undoStack.push(before);
        if (this.undoStack.length > UNDO_MAX) this.undoStack.shift();
        this.redoStack = [];
        this.changed();
      }
      return;
    }
    this.canvas.setPointerCapture?.(e.pointerId);
    this.stroke = { id: e.pointerId, last: i };
    // One undo step per stroke, pushed only if the stroke changes something.
    this.strokeBefore = before;
    if (this.set(i, this.ink)) this.render();
  };

  private strokeBefore = '';

  private readonly onMove = (e: PointerEvent) => {
    const s = this.stroke;
    if (!s || e.pointerId !== s.id) return;
    const i = this.cellAt(e);
    if (i < 0 || i === s.last) return;
    // Fill the gap between the last cell and this one (fast drags skip cells).
    const x0 = s.last % N;
    const y0 = Math.floor(s.last / N);
    const x1 = i % N;
    const y1 = Math.floor(i / N);
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    let changed = false;
    for (let k = 1; k <= steps; k++) {
      const x = Math.round(x0 + ((x1 - x0) * k) / steps);
      const y = Math.round(y0 + ((y1 - y0) * k) / steps);
      changed = this.set(y * N + x, this.ink) || changed;
    }
    s.last = i;
    if (changed) this.render();
  };

  private readonly onUp = (e: PointerEvent) => {
    const s = this.stroke;
    if (!s || e.pointerId !== s.id) return;
    this.stroke = null;
    if (this.pixels !== this.strokeBefore) {
      this.undoStack.push(this.strokeBefore);
      if (this.undoStack.length > UNDO_MAX) this.undoStack.shift();
      this.redoStack = [];
      this.changed();
    }
  };

  render() {
    const c = this.ctx;
    const s = this.cell;
    const size = s * N;
    c.fillStyle = hex(this.robe);
    c.fillRect(0, 0, size, size);
    for (let i = 0; i < OUTFIT_CELLS; i++) {
      const idx = SYMBOLS.indexOf(this.cells[i]);
      if (idx < 0) continue;
      c.fillStyle = hex(OUTFIT_PALETTE[idx]);
      c.fillRect((i % N) * s, Math.floor(i / N) * s, s, s);
    }
    c.strokeStyle = 'rgba(74, 52, 38, 0.16)';
    c.lineWidth = 1;
    c.beginPath();
    for (let k = 1; k < N; k++) {
      c.moveTo(k * s + 0.5, 0);
      c.lineTo(k * s + 0.5, size);
      c.moveTo(0, k * s + 0.5);
      c.lineTo(size, k * s + 0.5);
    }
    c.stroke();
    if (this.mirror) {
      c.strokeStyle = 'rgba(200, 100, 74, 0.75)';
      c.lineWidth = 2;
      c.setLineDash([5, 4]);
      c.beginPath();
      c.moveTo(size / 2, 0);
      c.lineTo(size / 2, size);
      c.stroke();
      c.setLineDash([]);
    }
  }
}
