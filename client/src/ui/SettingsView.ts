import type { AccountInfo } from '../../../shared/protocol';
import type { AudioEngine, AudioSettings } from '../audio/AudioEngine';
import { api, ApiError, logout, startGoogleLogin } from '../net/api';
import { installMode, isStandalone, onInstallChange } from '../pwa/pwa';
import { button, el, Modal } from './dom';
import type { InstallGuide } from './InstallGuide';
import { NotifySettings } from './NotifySettings';
import { consent, ConsentSheet, DeleteAccountSheet, downloadMyData, legalLinks } from './Legal';

type SliderKey = 'master' | 'ambience' | 'worship' | 'ui' | 'voice';

const SLIDERS: { key: SliderKey; label: string; hint: string }[] = [
  { key: 'master', label: '전체', hint: '모든 소리의 크기' },
  { key: 'ambience', label: '환경음', hint: '바람, 모닥불, 골방의 고요한 소리' },
  { key: 'worship', label: '찬양', hint: '찬양 영상의 소리' },
  { key: 'ui', label: '효과음', hint: '편지 종소리, 책장 넘기는 소리' },
  { key: 'voice', label: '음성', hint: '음성 기도방에서 들리는 목소리' },
];

/** ⚙ 설정: volume sliders and a mute switch, saved in localStorage. */
export class SettingsView {
  private readonly modal = new Modal('settings-overlay', '설정');
  private readonly consentSheet = new ConsentSheet();
  private readonly deleteSheet = new DeleteAccountSheet();

  constructor(
    private readonly audio: AudioEngine,
    private readonly account: () => AccountInfo | null,
    private readonly onNickname: (name: string) => void,
    private readonly openGuide: () => void = () => undefined,
    private readonly install: InstallGuide | null = null,
    private readonly pushEnabled = false,
    private readonly look: { open: () => void; isAdmin: () => boolean; openAdmin: () => void } | null = null,
  ) {
    // beforeinstallprompt may arrive late: refresh the button if settings are open.
    onInstallChange(() => {
      if (this.modal.isOpen) this.render(this.audio.settings);
    });
    // Keep the sliders in sync when something else (the player) changes a level.
    audio.onSettingsChange((s) => {
      if (!this.modal.isOpen) return;
      for (const key of ['master', 'ambience', 'worship', 'ui', 'voice'] as const) {
        const input = this.modal.sheet.querySelector<HTMLInputElement>(`#vol-${key}`);
        if (input && document.activeElement !== input) input.value = String(s[key]);
        const out = input?.parentElement?.querySelector('.settings-value');
        if (out) out.textContent = `${s[key]}%`;
      }
    });
  }

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  open() {
    this.render(this.audio.settings);
    this.modal.open();
  }

  private accountSection(): HTMLElement {
    const box = el('div', 'settings-account');
    box.append(el('p', 'settings-section', '계정'));
    const acc = this.account();
    box.id = 'settings-account';
    if (!acc) {
      box.append(el('p', 'settings-note', '로그인 없이 둘러보는 중이에요. 로그인하면 묵상을 저장하고 등불과 모임을 쓸 수 있어요.'));
      const g = button('', 'google-btn', () => startGoogleLogin(true));
      g.append(el('span', 'google-g'), el('span', 'google-label', 'Google로 로그인'));
      box.append(g, legalLinks('settings'));
      return box;
    }
    if (consent.needed) {
      const agree = button('약관 보고 동의하기', 'primary', () => this.consentSheet.open());
      agree.id = 'settings-consent';
      box.append(el('p', 'settings-note', '이용약관과 개인정보처리방침에 동의하면 묵상을 저장하고 나눌 수 있어요.'), agree);
    }
    const form = el('form', 'groups-form');
    const input = el('input');
    input.id = 'settings-nickname';
    input.type = 'text';
    input.maxLength = 24;
    input.value = acc.nickname;
    input.setAttribute('aria-label', '닉네임');
    const save = button('닉네임 바꾸기', '');
    save.type = 'submit';
    form.append(input, save);
    const status = el('p', 'groups-status');
    status.setAttribute('role', 'status');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api<{ user: { nickname: string } }>('POST', '/api/me/nickname', { nickname: input.value });
        this.onNickname(r.user.nickname);
        status.textContent = '바꿨어요. 다른 분들께는 다시 들어오면 새 이름으로 보여요.';
      } catch (err) {
        status.textContent = err instanceof ApiError ? err.message : '잠시 후 다시 시도해 주세요.';
      }
    });
    const out = button('로그아웃', 'ghost', async () => {
      try {
        await logout();
      } finally {
        location.reload();
      }
    });
    out.id = 'settings-logout';

    // 정보주체 권리: 열람 (내려받기), 삭제 (탈퇴).
    const dataStatus = el('p', 'groups-status');
    dataStatus.setAttribute('role', 'status');
    const exportBtn = button('내 데이터 내려받기', '', async () => {
      exportBtn.disabled = true;
      dataStatus.textContent = '준비하고 있어요…';
      try {
        await downloadMyData();
        dataStatus.textContent = '내 데이터를 JSON 파일로 내려받았어요.';
      } catch (err) {
        dataStatus.textContent = err instanceof ApiError ? err.message : '잠시 후 다시 시도해 주세요.';
      } finally {
        exportBtn.disabled = false;
      }
    });
    exportBtn.id = 'settings-export';
    const del = button('회원 탈퇴', 'ghost danger', () => this.deleteSheet.open(acc));
    del.id = 'settings-delete';
    const row = el('div', 'settings-legal-row');
    row.append(exportBtn, out, del);
    box.append(
      form,
      status,
      row,
      dataStatus,
      el('p', 'settings-note', '묵상, 등불, 모임 등 내 계정의 기록을 파일로 받을 수 있어요. 탈퇴하면 모두 바로 지워져요.'),
      legalLinks('settings'),
    );
    return box;
  }

  /** 📲 앱으로 설치하기: hidden when already installed or not installable here. */
  private installSection(): HTMLElement | null {
    const install = this.install;
    if (!install || isStandalone()) return null;
    const mode = installMode();
    if (!mode) return null;
    const box = el('div', 'settings-account');
    box.id = 'settings-install';
    const b = button('📲 앱으로 설치하기', '', () => void install.install());
    b.id = 'settings-install-btn';
    box.append(
      el('p', 'settings-section', '앱'),
      b,
      el('p', 'settings-note', mode === 'ios' ? '공유 버튼 → "홈 화면에 추가"로 앱처럼 쓸 수 있어요.' : '홈 화면이나 바탕화면에서 바로 열 수 있어요.'),
    );
    return box;
  }

  private render(s: AudioSettings) {
    const sheet = this.modal.sheet;
    sheet.className = 'sheet settings';
    sheet.replaceChildren();
    const top = el('header', 'book-top');
    top.append(el('h2', 'book-title', '설정'), button('닫기', 'ghost', () => this.modal.close()));
    sheet.append(top);

    const body = el('div', 'settings-body');
    body.append(el('p', 'settings-section', '소리'));
    for (const { key, label, hint } of SLIDERS) {
      const row = el('label', 'settings-row');
      const name = el('span', 'settings-name', label);
      const value = el('output', 'settings-value', `${s[key]}%`);
      const input = el('input', 'settings-slider');
      input.type = 'range';
      input.min = '0';
      input.max = '100';
      input.step = '1';
      input.value = String(s[key]);
      input.id = `vol-${key}`;
      input.setAttribute('aria-label', `${label} 음량`);
      input.addEventListener('input', () => {
        value.textContent = `${input.value}%`;
        this.audio.update({ [key]: Number(input.value) });
      });
      const line = el('div', 'settings-line');
      line.append(name, value);
      row.append(line, input, el('span', 'settings-hint', hint));
      body.append(row);
    }

    const mute = el('label', 'settings-toggle');
    const box = el('input');
    box.type = 'checkbox';
    box.id = 'vol-muted';
    box.checked = s.muted;
    box.addEventListener('change', () => {
      this.audio.unlock();
      this.audio.update({ muted: box.checked });
    });
    mute.append(box, el('span', '', '모든 소리 끄기'));
    body.append(mute, el('p', 'settings-note', '소리 설정은 이 기기에 저장돼요.'));
    const guide = button('사용 안내 다시 보기', '', () => {
      this.modal.close();
      this.openGuide();
    });
    guide.id = 'settings-guide';
    const help = el('div', 'settings-account');
    help.append(el('p', 'settings-section', '사용 안내'), guide);
    body.append(help);
    if (this.look) {
      const look = this.look;
      const box = el('div', 'settings-account');
      box.id = 'settings-look';
      const b = button('👕 꾸미기', '', () => {
        this.modal.close();
        look.open();
      });
      b.id = 'settings-look-btn';
      box.append(el('p', 'settings-section', '꾸미기'), b, el('p', 'settings-note', '옷과 목도리 색, 피부, 머리 모양을 고르고 옷에 그림을 그릴 수 있어요. 로그인하면 저장돼요.'));
      if (look.isAdmin()) {
        const a = button('옷 그림 관리', '', () => {
          this.modal.close();
          look.openAdmin();
        });
        a.id = 'settings-admin';
        box.append(a);
      }
      body.append(box);
    }
    const app = this.installSection();
    if (app) body.append(app);
    if (this.pushEnabled) body.append(new NotifySettings(!!this.account(), this.install!).root);
    body.append(this.accountSection());
    sheet.append(body);
  }
}
