import { button, el, Modal } from './dom';

export type Platform = 'ios-safari' | 'ios-standalone' | 'android' | 'desktop-safari' | 'desktop-chromium' | 'desktop-firefox' | 'other';

export function platform(): Platform {
  const ua = navigator.userAgent;
  const iOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const standalone =
    (navigator as unknown as { standalone?: boolean }).standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  if (iOS) return standalone ? 'ios-standalone' : 'ios-safari';
  if (/Android/.test(ua)) return 'android';
  if (/Firefox\//.test(ua)) return 'desktop-firefox';
  if (/Edg\/|Chrome\//.test(ua)) return 'desktop-chromium';
  if (/Safari\//.test(ua)) return 'desktop-safari';
  return 'other';
}

const STEPS: Record<Platform, { title: string; steps: string[]; note?: string }> = {
  'ios-safari': {
    title: 'iPhone · iPad (Safari)',
    steps: ['주소창 왼쪽의 "aA"를 눌러요', '웹사이트 설정 → 마이크 → 허용', '또는 설정 앱 → Safari → 마이크에서 허용'],
  },
  'ios-standalone': {
    title: 'iPhone · iPad (홈 화면 앱)',
    steps: ['설정 앱 → Safari → 마이크 → 허용', '앱을 닫았다가 다시 열어 주세요'],
    note: '홈 화면에서 연 앱은 iOS 제한으로 실행할 때마다 다시 물어볼 수 있어요.',
  },
  android: {
    title: 'Android (Chrome)',
    steps: ['주소창 왼쪽의 자물쇠(또는 설정) 아이콘을 눌러요', '권한 → 마이크 → 허용'],
  },
  'desktop-chromium': {
    title: 'PC (Chrome · Edge)',
    steps: ['주소창 왼쪽의 자물쇠 아이콘을 눌러요', '마이크 → 허용으로 바꾼 뒤 다시 시도해요'],
  },
  'desktop-safari': {
    title: 'Mac (Safari)',
    steps: ['메뉴 Safari → 설정 → 웹사이트 → 마이크', '이 사이트를 "허용"으로 바꿔요'],
  },
  'desktop-firefox': {
    title: 'PC (Firefox)',
    steps: ['주소창 왼쪽의 마이크(또는 자물쇠) 아이콘을 눌러요', '"차단됨"을 지우고 다시 시도해요'],
  },
  other: {
    title: '브라우저 설정',
    steps: ['브라우저의 사이트 설정에서 이 사이트의 마이크를 허용해 주세요'],
  },
};

/** Pre-prompt and denied-help sheets for the voice room microphone. */
export class MicHelp {
  private readonly modal = new Modal('mic-overlay', '마이크');

  /** "prompt" state: explain first, then the browser asks (from this tap). */
  prePrompt(): Promise<boolean> {
    return new Promise((resolve) => {
      let answered = false;
      const done = (v: boolean) => {
        if (answered) return;
        answered = true;
        resolve(v);
      };
      const sheet = this.modal.sheet;
      sheet.className = 'sheet login-prompt mic-sheet';
      sheet.replaceChildren();
      const body = el('div', 'prompt-body');
      body.append(
        el('p', 'prompt-title', '🎤 마이크 켜기'),
        el('p', '', '기도방에서 말하려면 마이크가 필요해요. 다음 창에서 ‘허용’을 눌러 주세요.'),
        el('p', 'prompt-small', '듣기만 할 때는 마이크가 필요 없어요. 녹음하거나 저장하지 않아요.'),
      );
      const go = button('마이크 켜기', 'primary', () => {
        done(true);
        this.modal.close();
      });
      go.id = 'mic-allow';
      const later = button('듣기만 할게요', 'ghost', () => this.modal.close());
      const actions = el('div', 'prompt-actions');
      actions.append(go, later);
      body.append(actions);
      sheet.append(body);
      this.modal.open(() => done(false));
    });
  }

  /** "denied": device-specific steps, with 다시 시도. */
  help(): Promise<boolean> {
    return new Promise((resolve) => {
      let answered = false;
      const done = (v: boolean) => {
        if (answered) return;
        answered = true;
        resolve(v);
      };
      const p = STEPS[platform()];
      const sheet = this.modal.sheet;
      sheet.className = 'sheet login-prompt mic-sheet';
      sheet.replaceChildren();
      const body = el('div', 'prompt-body');
      body.append(el('p', 'prompt-title', '마이크가 꺼져 있어요'), el('p', '', '이 사이트의 마이크가 차단되어 있어요. 아래처럼 허용한 뒤 다시 시도해 주세요.'));
      body.append(el('p', 'settings-section', p.title));
      const ol = el('ol', 'mic-steps');
      for (const s of p.steps) ol.append(el('li', '', s));
      body.append(ol);
      if (p.note) body.append(el('p', 'prompt-small', p.note));
      body.append(el('p', 'prompt-small', '마이크 없이도 듣기와 💬 대화는 할 수 있어요.'));
      const retry = button('다시 시도', 'primary', () => {
        done(true);
        this.modal.close();
      });
      retry.id = 'mic-retry';
      const close = button('닫기', 'ghost', () => this.modal.close());
      const actions = el('div', 'prompt-actions');
      actions.append(retry, close);
      body.append(actions);
      sheet.append(body);
      this.modal.open(() => done(false));
    });
  }
}
