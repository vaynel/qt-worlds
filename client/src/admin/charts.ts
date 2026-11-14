// Hand-rolled SVG charts for the 운영 통계 page (no libraries: the CSP is self-only).
// Colours come from CSS classes (f1/l1 … q1…q7) so light and dark mode swap in one place.
// Every chart has a title (aria-label), a hover/tap/keyboard tooltip, and the caller
// adds a table view, so no value is reachable by colour or hover alone.

const NS = 'http://www.w3.org/2000/svg';

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, cls?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (cls) e.setAttribute('class', cls);
  return e;
}

export const fmtNum = (n: number) => n.toLocaleString('ko-KR');
/** '2026-11-14' → '11/14' */
export const shortDate = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

// ------------------------------------------------------------------ tooltip

export interface TipRow {
  value: string;
  label: string;
  /** Series slot for the line key (1..3), or none. */
  slot?: number;
}

const tip = () => document.getElementById('st-tip') as HTMLDivElement;

export function showTip(x: number, y: number, head: string, rows: TipRow[]) {
  const t = tip();
  t.replaceChildren();
  if (head) {
    const h = document.createElement('div');
    h.className = 'tip-head';
    h.textContent = head;
    t.append(h);
  }
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'tip-row';
    if (r.slot) {
      const k = document.createElement('span');
      k.className = `tip-key k${r.slot}`;
      row.append(k);
    }
    const b = document.createElement('b');
    b.textContent = r.value;
    const s = document.createElement('span');
    s.textContent = r.label;
    row.append(b, s);
    t.append(row);
  }
  t.hidden = false;
  const w = t.offsetWidth;
  const h = t.offsetHeight;
  const left = Math.min(Math.max(8, x + 14), window.innerWidth - w - 8);
  const top = y - h - 12 < 8 ? y + 16 : y - h - 12;
  t.style.left = `${left}px`;
  t.style.top = `${top}px`;
}

export function hideTip() {
  tip().hidden = true;
}

// ------------------------------------------------------------------ axes

/** Clean upper bound and step for a y axis of counts (about 4 ticks, integers only). */
export function niceScale(max: number, ticks = 4): { top: number; step: number } {
  if (max <= 0) return { top: 4, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag);
  return { top: Math.ceil(max / step) * step, step };
}

const compact = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}K` : fmtNum(n));

interface Frame {
  svg: SVGSVGElement;
  w: number;
  h: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  x: (i: number) => number;
  y: (v: number) => number;
  band: number;
}

function frame(host: HTMLElement, title: string, labels: string[], maxValue: number, height: number, centered: boolean, estimatedUntil: number): Frame {
  const w = Math.max(240, Math.floor(host.clientWidth || 300));
  const { top: yTop, step } = niceScale(maxValue);
  const left = Math.max(22, String(compact(yTop)).length * 7 + 8);
  const right = 6;
  const top = 8;
  const bottom = 20;
  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${height}`, height, role: 'img', 'aria-label': title });
  const n = labels.length;
  const plotW = w - left - right;
  const band = plotW / Math.max(1, n);
  const x = centered ? (i: number) => left + band * (i + 0.5) : (i: number) => left + (n <= 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const y = (v: number) => top + (height - top - bottom) * (1 - v / yTop);
  // Days before collection began: a grey band (numbers there are best-effort backfills).
  if (estimatedUntil > 0) {
    const x1 = centered ? left + band * Math.min(estimatedUntil, n) : x(Math.min(estimatedUntil, n - 1));
    svg.append(svgEl('rect', { x: left, y: top, width: Math.max(0, x1 - left), height: height - top - bottom }, 'st-est-band'));
    if (x1 - left > 70) {
      const t = svgEl('text', { x: left + 4, y: top + 11 }, 'st-est-label');
      t.textContent = '수집 전 (추정)';
      svg.append(t);
    }
  }
  for (let v = 0; v <= yTop; v += step) {
    const yy = Math.round(y(v)) + 0.5;
    svg.append(svgEl('line', { x1: left, x2: w - right, y1: yy, y2: yy }, v === 0 ? 'st-axis-line' : 'st-grid-line'));
    const t = svgEl('text', { x: left - 6, y: yy + 4, 'text-anchor': 'end' }, 'st-tick');
    t.textContent = compact(v);
    svg.append(t);
  }
  // About six date labels, always the first and the last.
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 58))));
  for (let i = 0; i < n; i++) {
    if (i % every !== 0 && i !== n - 1) continue;
    if (i !== n - 1 && n - 1 - i < every * 0.6) continue;
    const t = svgEl('text', { x: x(i), y: height - 5, 'text-anchor': i === 0 && !centered ? 'start' : i === n - 1 && !centered ? 'end' : 'middle' }, 'st-tick');
    t.textContent = labels[i];
    svg.append(t);
  }
  return { svg, w, h: height, left, right, top, bottom, x, y, band };
}

/**
 * Hover/tap/keyboard layer over a whole plot: snaps to the nearest index and
 * calls `on(i, clientX, clientY)`, or `on(-1)` when the pointer leaves.
 */
function scrubber(f: Frame, n: number, centered: boolean, title: string, on: (i: number, cx?: number, cy?: number) => void) {
  const hit = svgEl('rect', { x: f.left, y: 0, width: f.w - f.left - f.right, height: f.h, tabindex: 0, 'aria-label': `${title}: 화살표 키로 날짜별 값을 볼 수 있어요` }, 'st-hit');
  let current = -1;
  const indexAt = (clientX: number) => {
    const r = f.svg.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * f.w;
    const i = centered ? Math.floor((px - f.left) / f.band) : Math.round(((px - f.left) / (f.w - f.left - f.right)) * (n - 1));
    return Math.max(0, Math.min(n - 1, i));
  };
  const move = (e: PointerEvent) => {
    current = indexAt(e.clientX);
    on(current, e.clientX, e.clientY);
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') on(-1);
  });
  hit.addEventListener('blur', () => on(-1));
  hit.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    current = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : Math.max(0, Math.min(n - 1, (current < 0 ? n - 1 : current) + (e.key === 'ArrowLeft' ? -1 : 1)));
    const r = f.svg.getBoundingClientRect();
    on(current, r.left + (f.x(current) / f.w) * r.width, r.top + 10);
  });
  hit.addEventListener('focus', () => {
    if (current < 0) current = n - 1;
    const r = f.svg.getBoundingClientRect();
    on(current, r.left + (f.x(current) / f.w) * r.width, r.top + 10);
  });
  f.svg.append(hit);
}

export interface Series {
  name: string;
  /** Categorical slot 1..3 (fixed per entity, never by rank). */
  slot: number;
  values: number[];
}

/** Lines on one axis (same unit), crosshair tooltip with every series. */
export function lineChart(host: HTMLElement, o: { title: string; labels: string[]; fullLabels: string[]; series: Series[]; estimatedUntil: number; height?: number; unit?: string }) {
  const n = o.labels.length;
  const max = Math.max(0, ...o.series.flatMap((s) => s.values));
  const f = frame(host, o.title, o.labels, max, o.height ?? 220, false, o.estimatedUntil);
  for (const s of o.series) {
    const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${f.x(i).toFixed(1)},${f.y(v).toFixed(1)}`).join('');
    f.svg.append(svgEl('path', { d }, `st-line l${s.slot}`));
    // End marker on the latest value.
    f.svg.append(svgEl('circle', { cx: f.x(n - 1), cy: f.y(s.values[n - 1] ?? 0), r: 4 }, `st-dot f${s.slot}`));
  }
  const cross = svgEl('line', { y1: f.top, y2: f.h - f.bottom, visibility: 'hidden' }, 'st-cross');
  const dots = o.series.map((s) => svgEl('circle', { r: 4.5, visibility: 'hidden' }, `st-dot f${s.slot}`));
  f.svg.append(cross, ...dots);
  scrubber(f, n, false, o.title, (i, cx, cy) => {
    if (i < 0) {
      cross.setAttribute('visibility', 'hidden');
      dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
      return hideTip();
    }
    const xx = f.x(i);
    cross.setAttribute('x1', String(xx));
    cross.setAttribute('x2', String(xx));
    cross.setAttribute('visibility', 'visible');
    o.series.forEach((s, k) => {
      dots[k].setAttribute('cx', String(xx));
      dots[k].setAttribute('cy', String(f.y(s.values[i] ?? 0)));
      dots[k].setAttribute('visibility', 'visible');
    });
    showTip(
      cx ?? 0,
      cy ?? 0,
      o.fullLabels[i] + (i < o.estimatedUntil ? ' · 추정' : ''),
      o.series.map((s) => ({ value: `${fmtNum(s.values[i] ?? 0)}${o.unit ?? ''}`, label: s.name, slot: s.slot })),
    );
  });
  host.replaceChildren(f.svg);
}

/** Path for a column with 4 px rounded top corners and a square base. */
function colPath(x: number, y: number, w: number, h: number, r = 4): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/** Columns (stacked when several series), 2 px surface gaps between segments. */
export function columnChart(host: HTMLElement, o: { title: string; labels: string[]; fullLabels: string[]; series: Series[]; estimatedUntil: number; height?: number; unit?: string }) {
  const n = o.labels.length;
  const totals = o.labels.map((_, i) => o.series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const f = frame(host, o.title, o.labels, Math.max(0, ...totals), o.height ?? 160, true, o.estimatedUntil);
  const bw = Math.max(1, Math.min(24, f.band * (n > 40 ? 0.78 : 0.62)));
  const gap = f.band > 4 ? 2 : 0;
  const cols: SVGGElement[] = [];
  const plot = svgEl('g');
  for (let i = 0; i < n; i++) {
    const g = svgEl('g', {}, 'st-col');
    let base = f.y(0);
    const live = o.series.filter((s) => (s.values[i] ?? 0) > 0);
    live.forEach((s, k) => {
      const segH = f.y(0) - f.y(s.values[i]);
      const top = base - segH;
      const h = segH - (k > 0 ? gap : 0);
      if (h <= 0.3) return;
      const x = f.x(i) - bw / 2;
      if (k === live.length - 1) g.append(svgEl('path', { d: colPath(x, top, bw, h) }, `f${s.slot}`));
      else g.append(svgEl('rect', { x, y: top, width: bw, height: h }, `f${s.slot}`));
      base = top;
    });
    cols.push(g);
    plot.append(g);
  }
  f.svg.append(plot);
  scrubber(f, n, true, o.title, (i, cx, cy) => {
    if (i < 0) {
      plot.classList.remove('is-dim');
      cols.forEach((c) => c.classList.remove('is-on'));
      return hideTip();
    }
    plot.classList.add('is-dim');
    cols.forEach((c, k) => c.classList.toggle('is-on', k === i));
    const rows: TipRow[] = o.series.map((s) => ({ value: `${fmtNum(s.values[i] ?? 0)}${o.unit ?? ''}`, label: s.name, slot: o.series.length > 1 ? s.slot : undefined }));
    if (o.series.length > 1) rows.push({ value: `${fmtNum(totals[i])}${o.unit ?? ''}`, label: '합계' });
    showTip(cx ?? 0, cy ?? 0, o.fullLabels[i] + (i < o.estimatedUntil ? ' · 추정' : ''), rows);
  });
  host.replaceChildren(f.svg);
}

/** Sequential class q1..q7 for a value in 0..max (q0 = no data). */
export function seqClass(v: number | null, max: number): string {
  if (v === null || max <= 0) return 'q0';
  if (v <= 0) return 'q1';
  return `q${Math.min(7, 1 + Math.ceil((v / max) * 6))}`;
}

/** Weekday × hour heatmap. */
export function heatmap(host: HTMLElement, o: { title: string; rows: string[]; values: (number | null)[][]; fmt: (v: number) => string; rowNames: string[] }) {
  const w = Math.max(260, Math.floor(host.clientWidth || 300));
  const left = 24;
  const cols = 24;
  const cell = (w - left) / cols;
  const ch = Math.max(16, Math.min(28, cell));
  const top = 0;
  const h = top + ch * o.rows.length + 18;
  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, height: h, role: 'img', 'aria-label': o.title });
  const max = Math.max(0, ...o.values.flat().map((v) => v ?? 0));
  const rects: SVGRectElement[][] = [];
  o.rows.forEach((name, r) => {
    const t = svgEl('text', { x: 0, y: top + r * ch + ch / 2 + 4 }, 'st-tick');
    t.textContent = name;
    svg.append(t);
    rects.push([]);
    for (let c = 0; c < cols; c++) {
      const v = o.values[r][c];
      const rect = svgEl('rect', { x: left + c * cell, y: top + r * ch, width: cell, height: ch, rx: 3 }, `st-cell ${seqClass(v, max)}`);
      rects[r].push(rect);
      svg.append(rect);
    }
  });
  const every = cell < 16 ? 6 : 3;
  for (let c = 0; c < cols; c += every) {
    const t = svgEl('text', { x: left + c * cell + cell / 2, y: h - 4, 'text-anchor': 'middle' }, 'st-tick');
    t.textContent = `${c}시`;
    svg.append(t);
  }
  let on: SVGRectElement | null = null;
  let cur = { r: -1, c: -1 };
  const select = (r: number, c: number, cx: number, cy: number) => {
    on?.classList.remove('is-on');
    on = rects[r][c];
    on.classList.add('is-on');
    cur = { r, c };
    const v = o.values[r][c];
    showTip(cx, cy, `${o.rowNames[r]} ${c}시`, [{ value: v === null ? '기록 없음' : o.fmt(v), label: '' }]);
  };
  const clear = () => {
    on?.classList.remove('is-on');
    on = null;
    hideTip();
  };
  const at = (e: PointerEvent) => {
    const b = svg.getBoundingClientRect();
    const px = ((e.clientX - b.left) / b.width) * w;
    const py = ((e.clientY - b.top) / b.height) * h;
    const c = Math.floor((px - left) / cell);
    const r = Math.floor((py - top) / ch);
    if (c < 0 || c >= cols || r < 0 || r >= o.rows.length) return clear();
    select(r, c, e.clientX, e.clientY);
  };
  svg.addEventListener('pointermove', at);
  svg.addEventListener('pointerdown', at);
  svg.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && clear());
  svg.setAttribute('tabindex', '0');
  svg.addEventListener('blur', clear);
  svg.addEventListener('keydown', (e) => {
    const d: Record<string, [number, number]> = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
    const m = d[e.key];
    if (!m) return;
    e.preventDefault();
    const r = Math.max(0, Math.min(o.rows.length - 1, (cur.r < 0 ? 0 : cur.r) + m[0]));
    const c = Math.max(0, Math.min(cols - 1, (cur.c < 0 ? 0 : cur.c) + m[1]));
    const b = rects[r][c].getBoundingClientRect();
    select(r, c, b.left + b.width / 2, b.top);
  });
  host.replaceChildren(svg);
}

export interface Part {
  label: string;
  value: number;
  slot: number;
}

/** One whole split into parts: a tall segmented bar (28 px), shares printed inside when they fit. */
export function segmented(host: HTMLElement, title: string, parts: Part[], unit = '') {
  const w = Math.max(240, Math.floor(host.clientWidth || 300));
  const h = 28;
  const total = parts.reduce((a, p) => a + p.value, 0);
  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, height: h, role: 'img', 'aria-label': `${title}: ${parts.map((p) => `${p.label} ${fmtNum(p.value)}${unit}`).join(', ')}` });
  if (total <= 0) {
    svg.append(svgEl('rect', { x: 0, y: 0, width: w, height: h, rx: 4 }, 'st-track'));
    const t = svgEl('text', { x: 8, y: 18 }, 'st-tick');
    t.textContent = '아직 기록이 없어요';
    svg.append(t);
    host.replaceChildren(svg);
    return;
  }
  const live = parts.filter((p) => p.value > 0);
  const gaps = (live.length - 1) * 2;
  let x = 0;
  for (const p of live) {
    const pw = ((w - gaps) * p.value) / total;
    const g = svgEl('g');
    g.append(svgEl('rect', { x, y: 0, width: Math.max(1, pw), height: h, rx: 4 }, `f${p.slot}`));
    const share = `${Math.round((p.value / total) * 100)}%`;
    if (pw > share.length * 8 + 12) {
      const t = svgEl('text', { x: x + 8, y: 18 }, `st-seg-label ${p.slot === 3 ? 'on-light' : 'on-dark'}`);
      t.textContent = share;
      g.append(t);
    }
    const hit = svgEl('rect', { x, y: -4, width: Math.max(8, pw), height: h + 8, tabindex: 0, 'aria-label': `${p.label} ${fmtNum(p.value)}${unit} (${share})` }, 'st-hit');
    const show = (cx: number, cy: number) => showTip(cx, cy, title, [{ value: `${fmtNum(p.value)}${unit}`, label: `${p.label} · ${share}`, slot: p.slot }]);
    hit.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
    hit.addEventListener('pointerdown', (e) => show(e.clientX, e.clientY));
    hit.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && hideTip());
    hit.addEventListener('focus', () => {
      const b = hit.getBoundingClientRect();
      show(b.left + b.width / 2, b.top);
    });
    hit.addEventListener('blur', hideTip);
    g.append(hit);
    svg.append(g);
    x += pw + 2;
  }
  host.replaceChildren(svg);
}

/** A thin horizontal bar (one value of a max), for row lists like the funnel. */
export function hbar(value: number, max: number, slot = 1): SVGSVGElement {
  const svg = svgEl('svg', { viewBox: '0 0 100 10', preserveAspectRatio: 'none', height: 10, 'aria-hidden': 'true' });
  svg.append(svgEl('rect', { x: 0, y: 0, width: 100, height: 10 }, 'st-track'));
  if (value > 0 && max > 0) svg.append(svgEl('rect', { x: 0, y: 0, width: Math.max(0.8, (value / max) * 100), height: 10 }, `f${slot}`));
  return svg;
}
