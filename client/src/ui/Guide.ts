import { button, el, Modal } from './dom';
import { legalLinks } from './Legal';

const SVG_NS = 'http://www.w3.org/2000/svg';

interface Page {
  title: string;
  build: () => HTMLElement[];
}

const p = (text: string, cls = '') => el('p', cls, text);

function list(items: [string, string][]): HTMLElement {
  const ul = el('ul', 'guide-list');
  for (const [k, v] of items) {
    const li = el('li');
    li.append(el('strong', '', k), el('span', '', v));
    ul.append(li);
  }
  return ul;
}

/** Hand-drawn style mini map (SVG built in code, no image files). */
function miniMap(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 300 220');
  svg.setAttribute('class', 'guide-map');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '장소 지도: 광장을 가운데로 북쪽 등불 언덕, 서쪽 기도의 뜰, 동쪽 모닥불 모임터, 남서쪽 골방');
  const add = (tag: string, attrs: Record<string, string>, text?: string) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text) n.textContent = text;
    svg.append(n);
    return n;
  };
  add('rect', { x: '4', y: '4', width: '292', height: '212', rx: '18', fill: '#e9f0d6', stroke: '#c9b48c' });
  const plaza = { x: 150, y: 120 };
  const spots: [string, number, number, string][] = [
    ['등불 언덕', 150, 34, '#ffc46b'],
    ['기도의 뜰', 52, 112, '#8fb36a'],
    ['모닥불 모임터', 248, 112, '#e07a4a'],
    ['골방', 78, 190, '#c8644a'],
  ];
  for (const [, x, y] of spots) {
    add('path', { d: `M${plaza.x} ${plaza.y} L${x} ${y}`, stroke: '#d8bf8e', 'stroke-width': '7', 'stroke-linecap': 'round', fill: 'none' });
  }
  add('circle', { cx: String(plaza.x), cy: String(plaza.y), r: '20', fill: '#f4ead5', stroke: '#b09070', 'stroke-width': '2' });
  add('text', { x: String(plaza.x), y: String(plaza.y + 5), 'text-anchor': 'middle', 'font-size': '13', 'font-weight': '700', fill: '#4a3426' }, '광장');
  for (const [name, x, y, color] of spots) {
    add('circle', { cx: String(x), cy: String(y), r: '11', fill: color, stroke: '#fff8ea', 'stroke-width': '3' });
    const ty = y < 60 ? y - 16 : y + 26;
    add('text', { x: String(x), y: String(Math.min(212, ty)), 'text-anchor': 'middle', 'font-size': '12', 'font-weight': '700', fill: '#4a3426' }, name);
  }
  add('text', { x: '282', y: '24', 'text-anchor': 'end', 'font-size': '11', fill: '#8a6a50' }, '↑ 북쪽 (처음 바라보는 쪽)');
  return svg;
}

/**
 * First-time guide: six gentle pages. Shown once per account (server flag)
 * or once per device for guests; reopenable from ⚙ 설정 → 사용 안내.
 */
export class Guide {
  private readonly modal = new Modal('guide-overlay', '사용 안내');
  private page = 0;
  private finishHandler: ((started: boolean) => void) | null = null;
  private readonly pages: Page[];

  constructor(private readonly isTouch: () => boolean) {
    this.pages = [
      {
        title: 'QT 월드에 오신 것을 환영해요',
        build: () => [
          p('매일 오늘의 말씀이 편지로 날아와요.'),
          p('말씀을 읽고 묵상하고, 함께 기도하고, 마음을 나누는 작은 세상이에요.'),
          p('천천히 둘러보세요. 서두르지 않아도 괜찮아요.', 'guide-soft'),
        ],
      },
      {
        title: '조작법',
        build: () =>
          this.isTouch()
            ? [
                list([
                  ['걷기', '왼쪽 아래 조이스틱 (끝까지 밀면 달리기)'],
                  ['둘러보기', '화면을 끌기'],
                  ['가까이/멀리', '두 손가락으로 벌리기·오므리기'],
                  ['행동', '화면에 나타나는 버튼 누르기 (앉기, 들어가기, 등불 읽기)'],
                ]),
              ]
            : [
                list([
                  ['걷기', 'WASD 또는 방향키'],
                  ['달리기', 'Shift'],
                  ['둘러보기', '마우스로 끌기'],
                  ['가까이/멀리', '마우스 휠'],
                  ['행동', 'E 키 (앉기, 들어가기, 등불 읽기) · 이야기는 Enter'],
                ]),
              ],
      },
      {
        title: '장소 지도',
        build: () => [
          miniMap() as unknown as HTMLElement,
          list([
            ['광장', '오늘의 말씀 편지가 내려오는 곳'],
            ['골방', '나만의 방. 다른 사람에게 보이지 않고 찬양과 함께 묵상해요'],
            ['기도의 뜰', '돗자리에 앉아 함께 조용히 기도해요. 기도하는 모습과 촛불이 보여요'],
            ['모닥불', '가까이 가면 채팅이 열려요. 근처 사람끼리 나눠요'],
            ['등불 언덕', '나눈 묵상이 등불로 밝혀져요. 아멘·기도하기·기록하기'],
          ]),
        ],
      },
      {
        title: '묵상하기',
        build: () => [
          p('골방에 들어가거나 기도의 뜰 돗자리에 앉으면 "묵상하기" 버튼이 보여요.'),
          el('p', 'guide-flow', '말씀 → 묵상 → 느낀 점 → 적용 → 말씀 책에 담기'),
          p('내 묵상은 나만 볼 수 있어요. 로그인하면 휴대폰과 PC에서 같은 말씀 책을 볼 수 있어요.', 'guide-soft'),
        ],
      },
      {
        title: '등불과 모임',
        build: () => [
          p('말씀 책에서 묵상 아래 "등불로 나누기"를 누르면 등불 언덕에 등불이 켜져요.'),
          list([
            ['공개', '누구나 볼 수 있어요'],
            ['비공개', '같은 모임 사람만 볼 수 있어요'],
          ]),
          p('상단의 "모임" 버튼에서 모임을 만들면 6자리 코드가 생겨요. 코드를 나누면 그 코드로 참여할 수 있어요.'),
          p('등불은 7일 동안 밝혀져 있어요.', 'guide-soft'),
        ],
      },
      {
        title: '상단 버튼',
        build: () => [
          list([
            ['오늘의 말씀', '오늘 받은 말씀을 언제든 다시 열어요'],
            ['말씀 책', '날마다 쌓인 말씀과 나의 묵상, 담아 둔 묵상'],
            ['모임', '모임 만들기 · 코드로 참여하기'],
            ['찬양', '찬양 플레이어 열기/닫기 (작게·크게, 목록, 음량)'],
            ['⚙ 설정', '소리, 닉네임, 사용 안내, 내 데이터 내려받기, 로그아웃'],
          ]),
          p('이제 시작해 볼까요?', 'guide-soft'),
          legalLinks('guide'),
        ],
      },
    ];
  }

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  /** started=true when finished with 시작하기, false for 건너뛰기/닫기. */
  open(onFinish?: (started: boolean) => void) {
    this.page = 0;
    this.finishHandler = onFinish ?? null;
    this.render();
    this.modal.open(() => {
      const fn = this.finishHandler;
      this.finishHandler = null;
      fn?.(false);
    });
  }

  private finish(started: boolean) {
    const fn = this.finishHandler;
    this.finishHandler = null;
    this.modal.close();
    fn?.(started);
  }

  private render() {
    const sheet = this.modal.sheet;
    sheet.className = 'sheet guide';
    sheet.replaceChildren();
    const page = this.pages[this.page];
    const top = el('header', 'guide-top');
    top.append(el('span', 'guide-step', `${this.page + 1} / ${this.pages.length}`), button('건너뛰기', 'ghost guide-skip', () => this.finish(false)));
    const body = el('article', 'guide-body');
    body.append(el('h2', 'guide-title', page.title), ...page.build());
    const dots = el('div', 'guide-dots');
    dots.setAttribute('aria-hidden', 'true');
    this.pages.forEach((_, i) => dots.append(el('span', i === this.page ? 'on' : '')));
    const nav = el('footer', 'guide-nav');
    const prev = button('이전', '', () => this.go(-1));
    prev.disabled = this.page === 0;
    prev.id = 'guide-prev';
    const last = this.page === this.pages.length - 1;
    const next = last ? button('시작하기', 'primary', () => this.finish(true)) : button('다음', 'primary', () => this.go(1));
    next.id = last ? 'guide-start' : 'guide-next';
    nav.append(prev, dots, next);
    sheet.append(top, body, nav);
  }

  private go(delta: number) {
    this.page = Math.max(0, Math.min(this.pages.length - 1, this.page + delta));
    this.render();
  }

  describe() {
    return { open: this.isOpen, page: this.page };
  }
}
