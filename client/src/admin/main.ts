// 운영자 통계 (/admin): one standalone page for the operator. The server only serves it,
// and answers its API, for admins (404 for everyone else). Everything shown is an
// aggregate: counts, ratios and histograms. No text, names or per-person rows exist here.
import './admin.css';
import type { ActivityKey, AdminStats, AdminSystem, RetentionCell } from '../../../shared/stats';
import { columnChart, fmtNum, hbar, heatmap, hideTip, lineChart, seqClass, segmented, shortDate, type Series } from './charts';

type Range = 7 | 30 | 90;

const root = document.getElementById('admin') as HTMLElement;
const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode: per-visit only */
    }
  },
};

let range: Range = ([7, 30, 90] as const).find((r) => String(r) === store.get('st-range')) ?? 30;
let heatMode: 'avg' | 'max' = store.get('st-heat') === 'max' ? 'max' : 'avg';
let stats: AdminStats | null = null;
let system: AdminSystem | null = null;
/** Charts re-render when their width changes. */
let renders: (() => void)[] = [];

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()) as T;
}

async function load(fresh = false) {
  const btn = document.getElementById('st-refresh') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  root.setAttribute('aria-busy', 'true');
  try {
    const q = fresh ? '?fresh=1' : '';
    [stats, system] = await Promise.all([getJson<AdminStats>(`/api/admin/stats${q}`), getJson<AdminSystem>('/api/admin/stats/system')]);
    render();
  } catch (e) {
    if (!stats) {
      root.replaceChildren(el('p', 'st-error', (e as Error).message === '404' ? '찾을 수 없어요.' : '통계를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.'));
    }
  } finally {
    root.setAttribute('aria-busy', 'false');
    const b = document.getElementById('st-refresh') as HTMLButtonElement | null;
    if (b) b.disabled = false;
  }
}

// ------------------------------------------------------------------ helpers

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
const fullDate = (d: string) => {
  const wd = WEEKDAYS[(new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7];
  return `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일 (${wd})`;
};
const clock = (ms: number) => {
  const d = new Date(ms + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};
const ago = (ms: number, now: number) => {
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  if (m < 48 * 60) return `${Math.round(m / 60)}시간 전`;
  return `${Math.round(m / 1440)}일 전`;
};
const uptime = (s: number) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}일 ${h}시간` : h ? `${h}시간 ${m}분` : `${m}분`;
};
const bytes = (n: number) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

function section(id: string, title: string, desc: string): HTMLElement {
  const s = el('section', 'st-section');
  s.id = id;
  s.setAttribute('aria-labelledby', `${id}-h`);
  const h = el('h2', '', title);
  h.id = `${id}-h`;
  s.append(h, el('p', 'st-desc', desc));
  return s;
}

function tile(label: string, value: string, sub?: string, pending = false): HTMLElement {
  const t = el('div', 'st-tile');
  t.append(el('div', 'st-tile-label', label), el('div', `st-tile-value${pending ? ' is-pending' : ''}`, value));
  if (sub) t.append(el('div', 'st-tile-sub', sub));
  return t;
}

function legend(items: { name: string; slot: number }[], line = false): HTMLElement {
  const ul = el('ul', 'st-legend');
  for (const it of items) {
    const li = el('li');
    li.append(el('span', `st-key k${it.slot}${line ? ' is-line' : ''}`), document.createTextNode(it.name));
    ul.append(li);
  }
  return ul;
}

function card(title: string, wide = false, total?: string): { card: HTMLElement; chart: HTMLElement } {
  const c = el('div', `st-card${wide ? ' is-wide' : ''}`);
  const head = el('div', 'st-card-head');
  head.append(el('h3', '', title));
  if (total !== undefined) {
    const t = el('span', 'st-card-total');
    const [b, rest] = total.split('|');
    t.append(el('b', '', b), document.createTextNode(rest ?? ''));
    head.append(t);
  }
  const chart = el('div', 'st-chart');
  c.append(head, chart);
  return { card: c, chart };
}

/** 표로 보기: every charted value without hover or colour. */
function tableView(summary: string, headers: string[], rows: (string | number)[][]): HTMLElement {
  const d = el('details', 'st-details');
  d.append(el('summary', '', summary));
  const wrap = el('div', 'st-table-wrap');
  const table = el('table', 'st-table');
  const tr = el('tr');
  headers.forEach((h, i) => tr.append(el('th', i ? 'num' : '', h)));
  const thead = el('thead');
  thead.append(tr);
  const tbody = el('tbody');
  for (const r of rows) {
    const row = el('tr');
    r.forEach((v, i) => row.append(el('td', i ? 'num' : '', typeof v === 'number' ? fmtNum(v) : v)));
    tbody.append(row);
  }
  table.append(thead, tbody);
  wrap.append(table);
  d.append(wrap);
  return d;
}

function segButtons<T extends string | number>(label: string, options: { value: T; text: string }[], current: T, on: (v: T) => void): HTMLElement {
  const g = el('div', 'st-seg');
  g.setAttribute('role', 'group');
  g.setAttribute('aria-label', label);
  for (const o of options) {
    const b = el('button', '', o.text);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(o.value === current));
    b.dataset.value = String(o.value);
    b.addEventListener('click', () => on(o.value));
    g.append(b);
  }
  return g;
}

// ------------------------------------------------------------------ page

function render() {
  if (!stats || !system) return;
  const s = stats;
  hideTip();
  renders = [];
  const n = range;
  const days = s.days.slice(-n);
  const labels = days.map(shortDate);
  const full = days.map(fullDate);
  const estUntil = days.filter((d) => d < s.collectStart).length;
  const last = <T>(a: T[]) => a.slice(-n);

  const frag = document.createDocumentFragment();

  // ---------- header
  const head = el('header', 'st-head');
  const titles = el('div');
  titles.append(el('h1', '', 'QT 월드 운영 통계'), el('p', 'st-sub', '모두 숫자로만 모았어요. 사람들이 쓴 글과 이름은 여기에 나오지 않아요.'));
  const actions = el('div', 'st-actions');
  const updated = el('span', '', `${clock(s.generatedAt)} 기준`);
  updated.id = 'st-updated';
  const refresh = el('button', 'st-btn', '새로고침');
  refresh.type = 'button';
  refresh.id = 'st-refresh';
  refresh.addEventListener('click', () => void load(true));
  actions.append(updated, refresh);
  head.append(titles, actions);
  const sys = el('ul', 'st-system');
  sys.setAttribute('aria-label', '날씨/시스템 상태');
  const chip = (label: string, value: string, warn = false) => {
    const li = el('li', `st-chip${warn ? ' is-warn' : ''}`);
    li.append(document.createTextNode(`${label} `), el('b', '', value));
    sys.append(li);
  };
  chip('서버 가동', uptime(system.uptimeS));
  chip('DB', bytes(system.dbBytes));
  chip('백업', system.backups.count ? `${system.backups.count}개 · 마지막 ${ago(system.backups.lastAt ?? 0, system.generatedAt)}` : '없음', !system.backups.count || system.generatedAt - (system.backups.lastAt ?? 0) > 2 * 86_400_000);
  if (system.weather) chip('날씨 데이터', `${ago(system.weather.updatedAt, system.generatedAt)}${system.weather.stale ? ' (오래됨)' : ''}`, system.weather.stale);
  else chip('날씨 데이터', '꺼짐', true);
  chip('지금 접속', `${s.together.online}명`);
  frag.append(head, sys);

  // ---------- filter row (scopes 방문 and 나눔 활동)
  const filter = el('div', 'st-filter');
  filter.append(
    el('span', 'st-filter-label', '기간'),
    segButtons<Range>('기간', [{ value: 7, text: '7일' }, { value: 30, text: '30일' }, { value: 90, text: '90일' }], range, (v) => {
      range = v;
      store.set('st-range', String(v));
      render();
    }),
  );
  frag.append(filter);
  if (s.collectStart > s.days[0]) {
    const note = el('p', 'st-note');
    note.append(el('span', 'st-est-key'), document.createTextNode(`회색 영역: ${shortDate(s.collectStart)} 이전은 통계를 모으기 전이라 기존 기록(발자취, 로그인, 저장된 글의 날짜)으로 추정한 값이에요.`));
    frag.append(note);
  }

  // ---------- 1. 방문
  {
    const sec = section('st-visits', '방문', '로그인한 분은 하루 한 번 접속일만 세요. 둘러보기(게스트)는 아무 식별 정보 없이 접속 횟수만 세요.');
    const tiles = el('div', 'st-tiles');
    const lastOf = (a: number[]) => a[a.length - 1] ?? 0;
    tiles.append(
      tile('오늘 접속 (DAU)', `${fmtNum(lastOf(s.visits.dau))}명`),
      tile('7일 접속 (WAU)', `${fmtNum(lastOf(s.visits.wau))}명`),
      tile('30일 접속 (MAU)', `${fmtNum(lastOf(s.visits.mau))}명`),
      tile(`${n}일 새 가입`, `${fmtNum(sum(last(s.visits.signups)))}명`),
      tile(`${n}일 둘러보기 접속`, `${fmtNum(sum(last(s.visits.guestSessions)))}회`, `전체 접속 ${fmtNum(sum(last(s.visits.sessions)))}회`),
    );
    sec.append(tiles);
    const grid = el('div', 'st-grid is-two');
    const active = card('접속한 계정 수 (DAU · WAU · MAU)', true);
    const series: Series[] = [
      { name: 'DAU (하루)', slot: 1, values: last(s.visits.dau) },
      { name: 'WAU (7일)', slot: 2, values: last(s.visits.wau) },
      { name: 'MAU (30일)', slot: 3, values: last(s.visits.mau) },
    ];
    active.card.append(legend(series, true));
    renders.push(() => lineChart(active.chart, { title: '접속한 계정 수', labels, fullLabels: full, series, estimatedUntil: estUntil, unit: '명' }));
    const sign = card('새 가입', false, `${fmtNum(sum(last(s.visits.signups)))}|명`);
    renders.push(() => columnChart(sign.chart, { title: '하루 새 가입', labels, fullLabels: full, series: [{ name: '새 가입', slot: 1, values: last(s.visits.signups) }], estimatedUntil: 0, unit: '명' }));
    const guest = card('둘러보기(게스트) 접속', false, `${fmtNum(sum(last(s.visits.guestSessions)))}|회`);
    renders.push(() =>
      columnChart(guest.chart, { title: '하루 둘러보기 접속', labels, fullLabels: full, series: [{ name: '둘러보기 접속', slot: 1, values: last(s.visits.guestSessions) }], estimatedUntil: estUntil, unit: '회' }),
    );
    grid.append(active.card, sign.card, guest.card);
    sec.append(
      grid,
      tableView(
        '표로 보기',
        ['날짜', 'DAU', 'WAU', 'MAU', '새 가입', '둘러보기', '전체 접속'],
        days.map((d, i) => [shortDate(d), last(s.visits.dau)[i], last(s.visits.wau)[i], last(s.visits.mau)[i], last(s.visits.signups)[i], last(s.visits.guestSessions)[i], last(s.visits.sessions)[i]]).reverse(),
      ),
    );
    frag.append(sec);
  }

  // ---------- 2. 재방문 (headline)
  {
    const sec = section('st-retention', '재방문', '가입하고 1일째·7일째·30일째 되는 날에 다시 들어온 비율이에요. 그날이 아직 지나지 않았으면 "데이터 수집 중"으로 보여요.');
    const tiles = el('div', 'st-tiles');
    const o = s.retention.overall;
    const rtile = (label: string, c: RetentionCell) =>
      c.eligible
        ? tile(label, `${pct(c.active, c.eligible)}%`, `${fmtNum(c.eligible)}명 중 ${fmtNum(c.active)}명${c.partial ? ' · 일부만 측정' : ''}${c.estimated ? ' · 추정 포함' : ''}`)
        : tile(label, '데이터 수집 중', '아직 그날이 오지 않았어요', true);
    tiles.append(rtile('D1 재방문', o.d1), rtile('D7 재방문', o.d7), rtile('D30 재방문', o.d30), tile('최근 30일 가입', `${fmtNum(o.signups)}명`, '위 비율의 대상'));
    sec.append(tiles);
    const c = el('div', 'st-card');
    c.append(el('h3', '', '가입 주별 재방문 (코호트)'));
    const wrap = el('div', 'st-table-wrap');
    const table = el('table', 'st-table');
    table.id = 'st-cohort';
    const caption = el('caption', '', '가입한 주(월요일 시작)별로, 가입 후 그날 다시 들어온 비율');
    caption.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)';
    const thead = el('thead');
    const htr = el('tr');
    for (const [t, cls] of [
      ['가입 주', ''],
      ['인원', 'num'],
      ['D1', 'rc'],
      ['D7', 'rc'],
      ['D30', 'rc'],
    ]) {
      const th = el('th', cls, t);
      th.scope = 'col';
      htr.append(th);
    }
    thead.append(htr);
    const tbody = el('tbody');
    for (const row of s.retention.cohorts) {
      const tr = el('tr');
      const th = el('th', '', `${shortDate(row.week)}~`);
      th.scope = 'row';
      tr.append(th, el('td', 'num', `${fmtNum(row.size)}명`));
      for (const cell of [row.d1, row.d7, row.d30]) {
        const td = el('td', 'rc');
        if (!row.size) {
          td.className = 'rc is-wait';
          td.textContent = '–';
        } else if (!cell.eligible) {
          td.className = 'rc is-wait';
          td.textContent = '수집 중';
          td.title = '데이터 수집 중: 아직 그날이 지나지 않았어요';
        } else {
          const p = pct(cell.active, cell.eligible);
          td.className = `rc ${seqClass(p, 100)}`;
          td.textContent = `${cell.estimated ? '≈' : ''}${p}%${cell.partial ? '*' : ''}`;
          td.append(el('small', '', `${cell.active}/${cell.eligible}명`));
          td.title = `${cell.eligible}명 중 ${cell.active}명${cell.partial ? ' (일부만 측정됨)' : ''}${cell.estimated ? ' (수집 전 기록으로 추정)' : ''}`;
        }
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(caption, thead, tbody);
    wrap.append(table);
    c.append(
      wrap,
      el(
        'p',
        'st-note',
        `가입 주는 그 주 월요일부터 7일이에요. 수집 중 = 데이터 수집 중(아직 그날이 지나지 않음) · * 일부 인원만 그날이 지났어요 · ≈ ${shortDate(s.collectStart)} 이전 날짜는 발자취·로그인 기록으로 추정 · 진할수록 높은 비율`,
      ),
    );
    sec.append(c);
    frag.append(sec);
  }

  // ---------- 3. 첫날 흐름
  {
    const f = s.funnel;
    const sec = section('st-funnel', '첫날 흐름', `최근 ${f.windowDays}일 동안 가입한 계정이 가입 후 24시간 안에 어디까지 해 봤는지예요 (앞 단계를 모두 거친 경우만 세요).`);
    const c = el('div', 'st-card');
    c.append(el('h3', '', '가입 → 첫 입장 → 오늘의 편지 → 묵상 저장 → 등불 나누기'));
    const names: Record<string, string> = { signup: '가입 완료', entry: '월드 첫 입장', letter: '오늘의 편지 열기', meditation: '묵상 저장', lantern: '등불 나누기' };
    const ul = el('ul', 'st-bars');
    ul.id = 'st-funnel-bars';
    const top = f.steps[0]?.n ?? 0;
    f.steps.forEach((step, i) => {
      const li = el('li');
      const row = el('div', 'st-bar-top');
      const left = el('span');
      left.append(document.createTextNode(`${names[step.key]} `), el('b', '', `${fmtNum(step.n)}명`));
      const meta = el('span', 'st-bar-meta');
      if (i === 0) meta.textContent = '100%';
      else {
        const prev = f.steps[i - 1].n;
        meta.append(document.createTextNode(`가입의 ${pct(step.n, top)}% · `), el('span', 'st-drop', prev ? `앞 단계에서 ${100 - pct(step.n, prev)}% 줄어듦` : '앞 단계 없음'));
      }
      row.append(left, meta);
      li.append(row, hbar(step.n, top));
      ul.append(li);
    });
    c.append(ul);
    const notes: string[] = [];
    if (f.pending) notes.push(`아직 24시간이 지나지 않은 ${f.pending}명은 빠져 있어요.`);
    if (f.estimated) notes.push(`${shortDate(s.collectStart)} 이전 가입자의 단계는 기존 기록(말씀 책, 발자취)으로 추정했어요.`);
    if (!top) notes.push('아직 집계할 가입자가 없어요.');
    if (notes.length) c.append(el('p', 'st-note', notes.join(' ')));
    sec.append(c);
    frag.append(sec);
  }

  // ---------- 4. 나눔 활동 (small multiples)
  {
    const sec = section('st-activity', '나눔 활동', `하루에 몇 번 일어났는지만 세요 (${n}일). 글 내용은 저장된 곳에서 꺼내 오지 않아요.`);
    const grid = el('div', 'st-grid is-small');
    const a = s.activity;
    const lanternSeries: Series[] = [
      { name: '공개', slot: 1, values: last(a.lantern_public) },
      { name: '모임', slot: 2, values: last(a.lantern_group) },
      { name: '익명', slot: 3, values: last(a.lantern_anon) },
    ];
    const items: { title: string; series: Series[]; unit: string }[] = [
      { title: '묵상 저장', series: [{ name: '묵상', slot: 1, values: last(a.meditation) }], unit: '개' },
      { title: '등불', series: lanternSeries, unit: '개' },
      ...(
        [
          ['testimony', '하나님 이야기 (간증)', '편'],
          ['diary', '일기', '편'],
          ['letter', '편지', '통'],
          ['reply', '답장', '통'],
          ['chat_campfire', '모닥불 채팅', '건'],
          ['chat_group', '모임 채팅', '건'],
          ['react_pray', '기도하기', '번'],
          ['react_empathy', '공감 (아멘·은혜·나도)', '번'],
          ['emote', '표현 (이모티콘)', '번'],
          ['voice_campfire', '모닥불 음성 참여', '번'],
          ['voice_group', '모임 음성 기도방 참여', '번'],
          ['rental', '나눔 소품 대여', '번'],
        ] as [ActivityKey, string, string][]
      ).map(([k, title, unit]) => ({ title, series: [{ name: title, slot: 1, values: last(a[k]) }], unit })),
    ];
    for (const it of items) {
      const total = sum(it.series.flatMap((x) => x.values));
      const cc = card(it.title, false, `${fmtNum(total)}|${it.unit}`);
      cc.card.dataset.metric = it.title;
      if (it.series.length > 1) cc.card.append(legend(it.series));
      renders.push(() => columnChart(cc.chart, { title: it.title, labels, fullLabels: full, series: it.series, estimatedUntil: estUntil, height: 120, unit: it.unit }));
      grid.append(cc.card);
    }
    sec.append(grid);
    const keys: [ActivityKey, string][] = [
      ['meditation', '묵상'],
      ['lantern_public', '등불 공개'],
      ['lantern_group', '등불 모임'],
      ['lantern_anon', '등불 익명'],
      ['testimony', '간증'],
      ['diary', '일기'],
      ['letter', '편지'],
      ['reply', '답장'],
      ['chat_campfire', '모닥불 채팅'],
      ['chat_group', '모임 채팅'],
      ['react_pray', '기도하기'],
      ['react_empathy', '공감'],
      ['emote', '표현'],
      ['voice_campfire', '모닥불 음성'],
      ['voice_group', '모임 음성'],
      ['rental', '소품 대여'],
    ];
    sec.append(
      tableView(
        '표로 보기',
        ['날짜', ...keys.map(([, t]) => t)],
        days.map((d, i) => [shortDate(d), ...keys.map(([k]) => last(a[k])[i])]).reverse(),
      ),
    );
    frag.append(sec);
  }

  // ---------- 5. 함께하기
  {
    const t = s.together;
    const sec = section('st-together', '함께하기', `5분마다 접속 인원만 기록해요. 최근 ${t.weeks}주, 요일 × 시간(한국 시간)별 ${heatMode === 'avg' ? '평균' : '최대'} 동시 접속이에요.`);
    const tiles = el('div', 'st-tiles');
    tiles.append(
      tile('지금 접속', `${fmtNum(t.online)}명`),
      tile('최고 동시 접속', `${fmtNum(t.peak.players)}명`, t.peak.date ? `${shortDate(t.peak.date)} ${t.peak.hour}시` : '아직 기록이 없어요'),
    );
    sec.append(tiles);
    const c = el('div', 'st-card');
    const headRow = el('div', 'st-card-head');
    headRow.append(
      el('h3', '', '요일 × 시간 동시 접속'),
      segButtons<'avg' | 'max'>('평균 또는 최대', [{ value: 'avg', text: '평균' }, { value: 'max', text: '최대' }], heatMode, (v) => {
        heatMode = v;
        store.set('st-heat', v);
        render();
      }),
    );
    const chart = el('div', 'st-chart');
    chart.id = 'st-heatmap';
    const values = heatMode === 'avg' ? t.avg : t.max;
    const any = values.some((r) => r.some((v) => v !== null));
    c.append(headRow, chart);
    renders.push(() =>
      any
        ? heatmap(chart, { title: `요일 × 시간 ${heatMode === 'avg' ? '평균' : '최대'} 동시 접속`, rows: WEEKDAYS, rowNames: WEEKDAYS.map((w) => `${w}요일`), values, fmt: (v) => `${heatMode === 'avg' ? '평균' : '최대'} ${v}명` })
        : chart.replaceChildren(el('p', 'st-note', '아직 기록이 없어요. 5분마다 쌓여요.')),
    );
    const scale = el('div', 'st-scale');
    scale.append(document.createTextNode('적음'));
    for (let q = 1; q <= 7; q++) {
      const i = el('i');
      i.style.background = `var(--q${q})`;
      scale.append(i);
    }
    scale.append(document.createTextNode('많음 · 회색 = 기록 없음'));
    c.append(scale);
    sec.append(
      c,
      tableView(
        '표로 보기',
        ['요일', ...Array.from({ length: 24 }, (_, h) => `${h}시`)],
        WEEKDAYS.map((w, r) => [w, ...values[r].map((v) => (v === null ? '–' : String(v)))]),
      ),
    );
    frag.append(sec);
  }

  // ---------- 6. 기기·앱
  {
    const d = s.devices;
    const sec = section('st-devices', '기기·앱', '접속할 때 기기 종류(휴대폰·태블릿·컴퓨터)와 앱 설치 여부만 세요. 브라우저 정보는 보내지도 저장하지도 않아요. (최근 30일)');
    const grid = el('div', 'st-grid');
    const dev = card('기기 종류', false, `${fmtNum(d.mix.phone + d.mix.tablet + d.mix.desktop)}|회 접속`);
    dev.card.id = 'st-device-mix';
    const devParts = [
      { label: '휴대폰', value: d.mix.phone, slot: 1 },
      { label: '태블릿', value: d.mix.tablet, slot: 2 },
      { label: '컴퓨터', value: d.mix.desktop, slot: 3 },
    ];
    dev.card.append(legend(devParts.map((p) => ({ name: `${p.label} ${fmtNum(p.value)}`, slot: p.slot }))));
    renders.push(() => segmented(dev.chart, '기기 종류', devParts, '회'));
    const pwaTotal = d.pwa.standalone + d.pwa.browser;
    const pwa = card('홈 화면 앱으로 접속', false, `${pct(d.pwa.standalone, pwaTotal)}|%`);
    const pwaParts = [
      { label: '홈 화면 앱', value: d.pwa.standalone, slot: 1 },
      { label: '브라우저', value: d.pwa.browser, slot: 2 },
    ];
    pwa.card.append(legend(pwaParts.map((p) => ({ name: `${p.label} ${fmtNum(p.value)}`, slot: p.slot }))));
    renders.push(() => segmented(pwa.chart, '앱 설치 여부', pwaParts, '회'));
    const push = el('div', 'st-card');
    const pushHead = el('div', 'st-card-head');
    const pt = el('span', 'st-card-total');
    pt.append(el('b', '', fmtNum(d.pushUsers)), document.createTextNode('명'));
    pushHead.append(el('h3', '', '알림을 켠 계정'), pt);
    push.append(pushHead);
    const typeNames: Record<string, string> = { daily: '말씀 알림', prayer: '기도 알림', props: '소품 만료', library: '내 이야기 소식', letters: '새 편지', replies: '답장', diary: '밤 일기' };
    const ul = el('ul', 'st-bars');
    const maxType = Math.max(1, d.pushUsers);
    for (const [k, name] of Object.entries(typeNames)) {
      const v = d.pushTypes[k] ?? 0;
      const li = el('li');
      const row = el('div', 'st-bar-top');
      const left = el('span');
      left.append(document.createTextNode(`${name} `), el('b', '', `${fmtNum(v)}명`));
      row.append(left, el('span', 'st-bar-meta', `${pct(v, d.pushUsers)}%`));
      li.append(row, hbar(v, maxType));
      ul.append(li);
    }
    push.append(ul);
    grid.append(dev.card, pwa.card, push);
    sec.append(grid);
    frag.append(sec);
  }

  // ---------- 7. 관리 대기
  {
    const p = s.pending;
    const sec = section('st-pending', '관리 대기', '신고되거나 숨겨졌는데 아직 살펴보지 않은 것들이에요. 내용은 게임 안 ⚙ → 관리에서 봐요.');
    const tiles = el('div', 'st-tiles');
    const link = (t: HTMLElement, href: string, text: string) => {
      const a = el('a', '', text);
      a.href = href;
      t.append(a);
      return t;
    };
    tiles.append(
      link(tile('옷 그림 신고', `${fmtNum(p.outfits)}건`), '/?admin=outfits', '옷 그림 관리 열기 →'),
      link(tile('도서관 책 신고', `${fmtNum(p.books)}건`), '/?admin=library', '도서관 관리 열기 →'),
      link(tile('편지 신고', `${fmtNum(p.letters)}건`), '/?admin=library', '도서관 관리 열기 →'),
      link(tile('모닥불 음성 신고', `${fmtNum(p.voiceReported)}명`, `최근 30일 · 말하기 제한 중 ${fmtNum(p.voiceMuted)}명`), '/?admin=voice', '모닥불 음성 관리 열기 →'),
    );
    sec.append(tiles);
    frag.append(sec);
  }

  root.replaceChildren(frag);
  for (const r of renders) r();
}

// Re-draw the charts when the layout width changes (rotation, window resize).
let lastWidth = window.innerWidth;
let resizeTimer = 0;
window.addEventListener('resize', () => {
  if (window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    hideTip();
    for (const r of renders) r();
  }, 150);
});
// Tap outside a chart hides the tooltip (touch has no "leave").
document.addEventListener('pointerdown', (e) => {
  if (!(e.target as Element).closest?.('svg')) hideTip();
});
window.addEventListener('scroll', hideTip, { passive: true });

void load();
