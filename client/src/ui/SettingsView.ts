import type { AccountInfo } from '../../../shared/protocol';
import type { AudioEngine, AudioSettings } from '../audio/AudioEngine';
import { PRIVACY_PATH, TERMS_PATH } from '../config/legal';
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

/** Level-2 pages of ⚙ 설정 ('menu' is level 1). */
export type SettingsPage = 'menu' | 'sound' | 'notify' | 'account' | 'install' | 'admin';

const TITLES: Record<SettingsPage, string> = {
  menu: '설정',
  sound: '🔊 소리',
  notify: '🔔 알림',
  account: '👤 계정',
  install: '📲 앱 설치',
  admin: '🛠️ 관리',
};

export interface SettingsLook {
  /** 👕 꾸미기; `back` returns to this menu. */
  open: (back: () => void) => void;
  isAdmin: () => boolean;
  openAdmin: (tab?: 'outfits' | 'shop') => void;
}

/**
 * ⚙ 설정: a menu (level 1) whose items open a page (level 2) inside the same
 * sheet, with ← 뒤로. Esc or the backdrop closes everything; every open
 * starts at the menu unless a caller deep-links to a page.
 */
export class SettingsView {
  private readonly modal = new Modal('settings-overlay', '설정');
  private readonly consentSheet = new ConsentSheet();
  private readonly deleteSheet = new DeleteAccountSheet();
  private page: SettingsPage = 'menu';

  constructor(
    private readonly audio: AudioEngine,
    private readonly account: () => AccountInfo | null,
    private readonly onNickname: (name: string) => void,
    private readonly openGuide: () => void = () => undefined,
    private readonly install: InstallGuide | null = null,
    private readonly pushEnabled = false,
    private readonly look: SettingsLook | null = null,
  ) {
    // beforeinstallprompt may arrive late: refresh the menu / install page if open.
    onInstallChange(() => {
      if (this.modal.isOpen && (this.page === 'menu' || this.page === 'install')) this.render();
    });
    // Keep the sliders in sync when something else (the player) changes a level.
    audio.onSettingsChange((s) => {
      if (!this.modal.isOpen || this.page !== 'sound') return;
      for (const key of ['master', 'ambience', 'worship', 'ui', 'voice'] as const) {
        const input = this.modal.sheet.querySelector<HTMLInputElement>(`#vol-${key}`);
        if (input && document.activeElement !== input) input.value = String(s[key]);
        const out = input?.parentElement?.querySelector('.settings-value');
        if (out) out.textContent = `${s[key]}%`;
      }
      const mute = this.modal.sheet.querySelector<HTMLInputElement>('#vol-muted');
      if (mute) mute.checked = s.muted;
    });
  }

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  get currentPage(): SettingsPage | null {
    return this.modal.isOpen ? this.page : null;
  }

  /** Always starts at the menu; deep links (e.g. 'notify') open a page directly. */
  open(page: SettingsPage = 'menu') {
    this.page = this.available(page) ? page : 'menu';
    this.render();
    if (!this.modal.isOpen) this.modal.open();
  }

  private go(page: SettingsPage) {
    this.page = page;
    this.render();
    this.modal.sheet.scrollTop = 0;
    // Keyboard users land on the new page's first control.
    this.modal.sheet.querySelector<HTMLElement>(page === 'menu' ? '.settings-item' : '#settings-back')?.focus({ preventScroll: true });
  }

  private canInstall(): boolean {
    return !!this.install && !isStandalone() && !!installMode();
  }

  private available(page: SettingsPage): boolean {
    if (page === 'notify') return this.pushEnabled && !!this.install;
    if (page === 'install') return this.canInstall();
    if (page === 'admin') return !!this.look?.isAdmin();
    return true;
  }

  private render() {
    const sheet = this.modal.sheet;
    sheet.className = `sheet settings settings-at-${this.page}`;
    sheet.replaceChildren();
    const top = el('header', 'book-top settings-top');
    const close = button('닫기', 'ghost', () => this.modal.close());
    close.id = 'settings-close';
    if (this.page === 'menu') {
      top.append(el('h2', 'book-title', '⚙ 설정'), close);
    } else {
      const back = button('← 뒤로', 'ghost settings-back', () => this.go('menu'));
      back.id = 'settings-back';
      back.setAttribute('aria-label', '설정 목록으로 돌아가기');
      top.append(back, el('h2', 'book-title', TITLES[this.page]), close);
    }
    sheet.append(top);
    const body = el('div', `settings-body settings-page`);
    body.id = `settings-page-${this.page}`;
    body.append(...this.pageContent());
    sheet.append(body);
  }

  private pageContent(): HTMLElement[] {
    switch (this.page) {
      case 'sound':
        return this.soundPage(this.audio.settings);
      case 'notify':
        return [new NotifySettings(!!this.account(), this.install!).root];
      case 'account':
        return [this.accountPage()];
      case 'install':
        return this.installPage();
      case 'admin':
        return this.adminPage();
      default:
        return this.menu();
    }
  }

  // ------------------------------------------------------------ level 1

  private item(id: string, icon: string, label: string, hint: string, onClick: () => void, extra?: HTMLElement): HTMLButtonElement {
    const b = button('', 'settings-item', onClick);
    b.id = `settings-nav-${id}`;
    const text = el('span', 'settings-item-text');
    text.append(el('span', 'settings-item-label', label), el('span', 'settings-item-hint', hint));
    b.append(el('span', 'settings-item-icon', icon), text);
    if (extra) b.append(extra);
    b.append(el('span', 'settings-item-chev', '›'));
    b.lastElementChild?.setAttribute('aria-hidden', 'true');
    b.firstElementChild?.setAttribute('aria-hidden', 'true');
    return b;
  }

  private menu(): HTMLElement[] {
    const list = el('nav', 'settings-menu');
    list.setAttribute('aria-label', '설정 목록');
    const acc = this.account();
    if (this.look) {
      const look = this.look;
      list.append(
        this.item('look', '👕', '꾸미기', '옷·목도리 색, 머리 모양, 옷 그리기', () => {
          this.modal.close();
          look.open(() => this.open('menu'));
        }),
      );
    }
    list.append(this.item('sound', '🔊', '소리', '음량과 모든 소리 끄기', () => this.go('sound')));
    if (this.available('notify')) list.append(this.item('notify', '🔔', '알림', '오늘의 말씀, 기도 알림', () => this.go('notify')));
    const needs = acc && consent.needed ? el('span', 'settings-item-flag', '동의 필요') : undefined;
    list.append(this.item('account', '👤', '계정', acc ? `${acc.nickname} · 닉네임, 내 데이터, 로그아웃` : '로그인하기', () => this.go('account'), needs));
    if (this.canInstall()) list.append(this.item('install', '📲', '앱 설치', '홈 화면에서 앱처럼 열기', () => this.go('install')));
    list.append(
      this.item('guide', '❓', '사용 안내', '처음 안내를 다시 보기', () => {
        this.modal.close();
        this.openGuide();
      }),
    );
    if (this.available('admin')) list.append(this.item('admin', '🛠️', '관리', '옷 그림 관리, 소품 가게 관리', () => this.go('admin')));

    const legal = el('div', 'settings-menu-legal');
    const link = (href: string, text: string, id: string) => {
      const a = el('a', 'settings-item settings-link');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.id = id;
      a.append(el('span', 'settings-item-icon', '📄'), el('span', 'settings-item-label', text), el('span', 'settings-item-chev', '↗'));
      a.firstElementChild?.setAttribute('aria-hidden', 'true');
      a.lastElementChild?.setAttribute('aria-hidden', 'true');
      return a;
    };
    legal.append(link(PRIVACY_PATH, '개인정보처리방침', 'settings-privacy'), link(TERMS_PATH, '이용약관', 'settings-terms'));
    return [list, legal];
  }

  // ------------------------------------------------------------ level 2

  private soundPage(s: AudioSettings): HTMLElement[] {
    const out: HTMLElement[] = [];
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
      out.push(row);
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
    out.push(mute, el('p', 'settings-note', '소리 설정은 이 기기에 저장돼요.'));
    return out;
  }

  private accountPage(): HTMLElement {
    const box = el('div', 'settings-account');
    box.id = 'settings-account';
    const acc = this.account();
    if (!acc) {
      box.append(el('p', 'settings-note', '로그인 없이 둘러보는 중이에요. 로그인하면 묵상을 저장하고 등불과 모임을 쓸 수 있어요.'));
      const g = button('', 'google-btn', () => startGoogleLogin(true));
      g.id = 'settings-login';
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
      el('p', 'settings-section', '닉네임'),
      form,
      status,
      el('p', 'settings-section settings-section-gap', '내 데이터'),
      row,
      dataStatus,
      el('p', 'settings-note', '묵상, 등불, 모임 등 내 계정의 기록을 파일로 받을 수 있어요. 탈퇴하면 모두 바로 지워져요.'),
      legalLinks('settings'),
    );
    return box;
  }

  /** 📲 앱으로 설치하기 (only listed when installable and not already installed). */
  private installPage(): HTMLElement[] {
    const install = this.install;
    const mode = installMode();
    if (!install || !mode || isStandalone()) return [el('p', 'settings-note', '이미 앱으로 열려 있거나, 이 브라우저에서는 설치할 수 없어요.')];
    const box = el('div', 'settings-account');
    box.id = 'settings-install';
    const b = button('📲 앱으로 설치하기', 'primary', () => void install.install());
    b.id = 'settings-install-btn';
    box.append(b, el('p', 'settings-note', mode === 'ios' ? '공유 버튼 → "홈 화면에 추가"로 앱처럼 쓸 수 있어요.' : '홈 화면이나 바탕화면에서 바로 열 수 있어요.'));
    return [box];
  }

  private adminPage(): HTMLElement[] {
    const look = this.look;
    if (!look?.isAdmin()) return [el('p', 'settings-note', '관리자만 볼 수 있어요.')];
    const box = el('div', 'settings-account settings-admin-list');
    const a = button('옷 그림 관리', '', () => {
      this.modal.close();
      look.openAdmin();
    });
    a.id = 'settings-admin';
    const shopAdmin = button('소품 가게 관리', '', () => {
      this.modal.close();
      look.openAdmin('shop');
    });
    shopAdmin.id = 'settings-admin-shop';
    box.append(a, el('p', 'settings-note', '신고된 옷 그림을 보고 숨김·복구·그림 금지를 정해요.'), shopAdmin, el('p', 'settings-note', '소품 가게의 시간대별 수량을 정해요.'));
    return [box];
  }
}
