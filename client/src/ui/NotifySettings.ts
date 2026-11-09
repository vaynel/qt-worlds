import { api, ApiError } from '../net/api';
import { currentSubscription, notificationPermission, pushSupport, subscribePush } from '../pwa/pwa';
import { button, el } from './dom';
import type { InstallGuide } from './InstallGuide';
import { platform, type Platform } from './MicHelp';

export interface PushPrefs {
  daily: boolean;
  dailyTime: string;
  prayer: boolean;
}

const DENIED_STEPS: Record<Platform, { title: string; steps: string[] }> = {
  'ios-standalone': { title: 'iPhone · iPad (홈 화면 앱)', steps: ['설정 앱 → 알림 → QT 월드', '"알림 허용"을 켜요'] },
  'ios-safari': { title: 'iPhone · iPad', steps: ['홈 화면에 추가한 QT 월드 앱에서 다시 시도해 주세요'] },
  android: {
    title: 'Android (Chrome)',
    steps: ['주소창 왼쪽의 자물쇠(또는 설정) 아이콘 → 권한 → 알림 → 허용', '설치한 앱이라면: 앱 아이콘 길게 누르기 → 앱 정보 → 알림 → 허용'],
  },
  'desktop-chromium': { title: 'PC (Chrome · Edge)', steps: ['주소창 왼쪽의 자물쇠 아이콘을 눌러요', '알림 → 허용으로 바꾼 뒤 다시 확인해요'] },
  'desktop-safari': { title: 'Mac (Safari)', steps: ['메뉴 Safari → 설정 → 웹사이트 → 알림', '이 사이트를 "허용"으로 바꿔요'] },
  'desktop-firefox': { title: 'PC (Firefox)', steps: ['주소창 왼쪽의 자물쇠 아이콘을 눌러요', '알림 "차단됨"을 지우고 다시 확인해요'] },
  other: { title: '브라우저 설정', steps: ['브라우저의 사이트 설정에서 이 사이트의 알림을 허용해 주세요'] },
};

/** 05:00, 05:30, … every 30 minutes, starting at 05:00 (early risers first). */
const TIMES = Array.from({ length: 48 }, (_, i) => {
  const m = (300 + i * 30) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
});

function timeLabel(t: string): string {
  const [h, m] = t.split(':').map(Number);
  const ampm = h < 12 ? '오전' : '오후';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${ampm} ${h12}:${String(m).padStart(2, '0')}`;
}

/** ⚙ 설정 → 🔔 알림. Everything inline (the settings sheet stays open). */
export class NotifySettings {
  readonly root = el('div', 'settings-account notify-settings');
  private status = el('p', 'groups-status');

  constructor(
    private readonly signedIn: boolean,
    private readonly install: InstallGuide,
  ) {
    this.root.id = 'notify-settings';
    this.status.setAttribute('role', 'status');
    void this.render();
  }

  private head(...rest: (HTMLElement | string)[]) {
    this.root.replaceChildren(el('p', 'settings-section', '🔔 알림'), ...rest);
  }

  private say(text: string) {
    this.status.textContent = text;
  }

  async render() {
    if (!this.signedIn) {
      this.head(el('p', 'settings-note', '로그인하면 매일 아침 오늘의 말씀 알림을 받을 수 있어요.'));
      return;
    }
    const support = pushSupport();
    if (support === 'ios-needs-install') {
      const how = button('📲 홈 화면에 추가하는 방법', '', () => this.install.iosGuide(true));
      how.id = 'notify-ios-install';
      this.head(el('p', 'settings-note', 'iPhone·iPad에서는 홈 화면에 추가한 앱에서만 알림을 받을 수 있어요 (iOS 16.4 이상).'), how);
      return;
    }
    if (support === 'unsupported') {
      this.head(el('p', 'settings-note', '이 브라우저는 알림을 지원하지 않아요.'));
      return;
    }
    if (notificationPermission() === 'denied') return this.deniedHelp();
    const sub = await currentSubscription();
    if (!sub || notificationPermission() !== 'granted') return this.offer();
    // Keep the server in sync (e.g. another account used this device before).
    try {
      await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
      const prefs = await api<PushPrefs>('GET', '/api/push/prefs');
      this.controls(prefs);
    } catch (err) {
      this.head(this.status);
      this.say(err instanceof ApiError ? err.message : '알림 설정을 불러오지 못했어요.');
    }
  }

  private offer() {
    const on = button('🔔 알림 켜기', 'primary', () => this.prePrompt());
    on.id = 'notify-enable';
    this.head(el('p', 'settings-note', '오늘의 말씀이 도착하거나 누군가 내 등불을 위해 기도하면 알려 드려요.'), on, this.status);
  }

  /** Friendly explanation first; the browser asks only after 허용하고 켜기. */
  private prePrompt() {
    const box = el('div', 'notify-preprompt');
    box.id = 'notify-preprompt';
    box.append(
      el('p', 'prompt-title', '🕊️ 매일 말씀을 알려 드릴까요?'),
      el('p', '', '정한 시간에 오늘의 말씀이 도착했다고 알려 드려요. 다음 창에서 ‘허용’을 눌러 주세요.'),
      el('p', 'prompt-small', '알림에는 다른 사람의 묵상 내용이나 이름이 담기지 않아요. 언제든 끌 수 있어요.'),
    );
    const go = button('허용하고 켜기', 'primary', () => void this.enable(go));
    go.id = 'notify-allow';
    const later = button('나중에', 'ghost', () => void this.render());
    later.id = 'notify-later';
    const actions = el('div', 'prompt-actions');
    actions.append(go, later);
    box.append(actions);
    this.head(box, this.status);
  }

  private async enable(btn: HTMLButtonElement) {
    btn.disabled = true;
    this.say('');
    try {
      const { publicKey } = await api<{ publicKey: string }>('GET', '/api/push/key');
      const { permission, sub } = await subscribePush(publicKey);
      if (permission === 'denied') return this.deniedHelp();
      if (!sub) return this.render();
      await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
      await this.render();
      this.say('알림을 켰어요.');
    } catch (err) {
      btn.disabled = false;
      this.say(err instanceof ApiError ? err.message : '알림을 켜지 못했어요. 잠시 후 다시 시도해 주세요.');
    }
  }

  private deniedHelp() {
    const p = DENIED_STEPS[platform()];
    const box = el('div', 'notify-denied');
    box.id = 'notify-denied';
    box.append(el('p', 'prompt-title', '알림이 차단되어 있어요'), el('p', 'settings-note', '이 사이트의 알림이 꺼져 있어요. 아래처럼 허용한 뒤 다시 확인해 주세요.'));
    box.append(el('p', 'settings-section', p.title));
    const ol = el('ol', 'mic-steps');
    for (const s of p.steps) ol.append(el('li', '', s));
    box.append(ol);
    const again = button('다시 확인', '', () => void this.render());
    again.id = 'notify-recheck';
    box.append(again);
    this.head(box, this.status);
  }

  private controls(prefs: PushPrefs) {
    const save = async (patch: Partial<PushPrefs>) => {
      try {
        Object.assign(prefs, await api<PushPrefs>('PUT', '/api/push/prefs', { ...prefs, ...patch }));
        this.say('저장했어요.');
      } catch (err) {
        this.say(err instanceof ApiError ? err.message : '저장하지 못했어요.');
      }
    };
    const toggle = (id: string, label: string, checked: boolean, onChange: (v: boolean) => void) => {
      const row = el('label', 'settings-toggle');
      const box = el('input');
      box.type = 'checkbox';
      box.id = id;
      box.checked = checked;
      box.addEventListener('change', () => onChange(box.checked));
      row.append(box, el('span', '', label));
      return { row, box };
    };

    const time = el('select', 'notify-time');
    time.id = 'notify-time';
    time.setAttribute('aria-label', '말씀 알림 시간');
    for (const t of TIMES) {
      const o = el('option', '', timeLabel(t));
      o.value = t;
      time.append(o);
    }
    time.value = prefs.dailyTime;
    time.disabled = !prefs.daily;
    time.addEventListener('change', () => void save({ dailyTime: time.value }));

    const daily = toggle('notify-daily', '🕊️ 오늘의 말씀', prefs.daily, (v) => {
      time.disabled = !v;
      void save({ daily: v });
    });
    const timeRow = el('label', 'notify-time-row');
    timeRow.append(el('span', 'settings-hint', '매일 (한국 시간)'), time);
    const prayer = toggle('notify-prayer', '🤲 내 등불에 기도하기 반응', prefs.prayer, (v) => void save({ prayer: v }));

    const off = button('알림 끄기', 'ghost', async () => {
      off.disabled = true;
      try {
        const sub = await currentSubscription();
        if (sub) {
          await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
          await sub.unsubscribe().catch(() => undefined);
        }
        await this.render();
        this.say('이 기기의 알림을 껐어요.');
      } catch {
        off.disabled = false;
      }
    });
    off.id = 'notify-off';
    this.head(
      daily.row,
      timeRow,
      prayer.row,
      el('p', 'settings-note', '누가 기도했는지는 알려 드리지 않아요. 알림 설정은 내 계정에 저장돼요.'),
      off,
      this.status,
    );
  }
}
