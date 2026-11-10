import { NICKNAME_MAX, cleanText, textLength, validateNickname } from '../../../shared/protocol';
import { api, ApiError, logout, startGoogleLogin, type AuthConfig, type Me } from '../net/api';

const STORAGE_KEY = 'worlds.nickname';

export type EntryChoice =
  | { mode: 'account'; nickname: string; userId: number }
  | { mode: 'guest'; nickname: string }
  | { mode: 'solo'; nickname: string };

const LOGIN_ERRORS: Record<string, string> = {
  bad_state: '로그인 요청이 만료되었어요. 다시 시도해 주세요.',
  bad_id_token: '로그인 정보를 확인하지 못했어요. 다시 시도해 주세요.',
  bad_nonce: '로그인 정보를 확인하지 못했어요. 다시 시도해 주세요.',
  denied: '로그인이 취소되었어요.',
  token_exchange: '로그인을 마치지 못했어요. 다시 시도해 주세요.',
  rate_limited: '잠시 후 다시 시도해 주세요.',
  signup_busy: '지금은 새로 가입하는 분이 많아요. 잠시 후 다시 시도해 주세요.',
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * Entry: "Google로 로그인" (server-side OIDC), the first-login 닉네임 정하기
 * step, a welcome-back state, and "로그인 없이 둘러보기" for guests.
 */
export class EntryScreen {
  private readonly root = $('entry');
  private readonly signedOut = $('entry-signed-out');
  private readonly nickForm = $<HTMLFormElement>('entry-nick');
  private readonly signedIn = $('entry-signed-in');
  private readonly guestForm = $<HTMLFormElement>('entry-form');
  private readonly guestInput = $<HTMLInputElement>('nickname');
  private readonly count = $('nickname-count');
  private readonly googleBtn = $<HTMLButtonElement>('btn-google');
  private readonly remember = $<HTMLInputElement>('remember');
  private readonly accountInput = $<HTMLInputElement>('account-nickname');
  private readonly agree = $<HTMLInputElement>('nick-agree');
  private readonly status = $('entry-status');
  private readonly fallback = $('entry-fallback');
  private me: Me = { user: null, needsNickname: false };
  private resolveChoice: ((c: EntryChoice) => void) | null = null;

  constructor() {
    try {
      this.guestInput.value = localStorage.getItem(STORAGE_KEY) ?? '';
    } catch {
      /* storage may be blocked */
    }
    this.updateCount();
    this.guestInput.addEventListener('input', () => {
      this.updateCount();
      this.setStatus('');
    });
    this.googleBtn.addEventListener('click', () => {
      this.setStatus('Google로 이동하고 있어요…', true);
      startGoogleLogin(this.remember.checked);
    });
    this.guestForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submitGuest();
    });
    this.nickForm.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submitNickname();
    });
    this.agree.addEventListener('change', () => {
      this.agree.closest('label')?.classList.remove('missing');
      this.setStatus('');
    });
    $('entry-continue').addEventListener('click', () => this.finishAccount());
    for (const b of document.querySelectorAll<HTMLButtonElement>('.entry-logout')) {
      b.addEventListener('click', () => void this.logout());
    }
    $('entry-retry').addEventListener('click', () => {
      this.fallback.hidden = true;
      if (this.me.user?.nickname) this.finishAccount();
      else this.submitGuest();
    });
    $('entry-solo').addEventListener('click', () => {
      const nickname = this.me.user?.nickname ?? validateNickname(this.guestInput.value) ?? '나그네';
      this.resolve({ mode: 'solo', nickname });
    });
  }

  /** Show the right pane for the current session. */
  setup(me: Me, config: AuthConfig, loginError: string | null, notice: string | null = null) {
    this.me = me;
    if (!config.ready) {
      this.googleBtn.disabled = true;
      this.googleBtn.querySelector('.google-label')!.textContent = 'Google 로그인 준비 중';
      this.googleBtn.title = '로그인 준비 중이에요. 지금은 로그인 없이 둘러볼 수 있어요.';
    }
    this.showPane();
    if (loginError) this.setStatus(LOGIN_ERRORS[loginError] ?? '로그인하지 못했어요. 다시 시도해 주세요.');
    else if (notice) this.setStatus(notice, true);
  }

  private showPane() {
    const user = this.me.user;
    this.signedOut.hidden = !!user;
    this.nickForm.hidden = !(user && !user.nickname);
    this.signedIn.hidden = !(user && user.nickname);
    if (user?.nickname) $('entry-name').textContent = user.nickname;
    if (user && !user.nickname) setTimeout(() => this.accountInput.focus(), 50);
  }

  private updateCount() {
    const n = textLength(cleanText(this.guestInput.value));
    this.count.textContent = `${n}/${NICKNAME_MAX}`;
    this.count.classList.toggle('over', n > NICKNAME_MAX);
  }

  private setStatus(text: string, info = false) {
    this.status.textContent = text;
    this.status.classList.toggle('info', info);
  }

  private busy(on: boolean) {
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('button')) {
      if (b.id !== 'btn-google' || on) b.disabled = on;
    }
    if (!on && this.googleBtn.title) this.googleBtn.disabled = true;
  }

  private resolve(choice: EntryChoice) {
    const fn = this.resolveChoice;
    this.resolveChoice = null;
    fn?.(choice);
  }

  private submitGuest() {
    const name = validateNickname(this.guestInput.value);
    if (!name) {
      this.setStatus(`닉네임을 1~${NICKNAME_MAX}자로 적어 주세요.`);
      this.guestInput.focus();
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, name);
    } catch {
      /* ignore */
    }
    this.guestInput.value = name;
    this.guestInput.blur();
    this.busy(true);
    this.setStatus('세상에 들어가는 중이에요…', true);
    this.resolve({ mode: 'guest', nickname: name });
  }

  private async submitNickname() {
    const name = validateNickname(this.accountInput.value);
    if (!name) {
      this.setStatus(`닉네임을 1~${NICKNAME_MAX}자로 적어 주세요.`);
      return;
    }
    // 만 14세 이상 + 이용약관/개인정보처리방침 동의 (the server checks it too).
    if (!this.agree.checked) {
      this.agree.closest('label')?.classList.add('missing');
      this.setStatus('만 14세 이상인지 확인하고 이용약관과 개인정보처리방침에 동의해 주세요.');
      return;
    }
    this.busy(true);
    try {
      const r = await api<{ user: { id: number; nickname: string } }>('POST', '/api/me/nickname', { nickname: name, agree: true });
      this.me = { user: r.user, needsNickname: false, needsConsent: false };
      this.finishAccount();
    } catch (err) {
      this.busy(false);
      this.setStatus(err instanceof ApiError ? err.message : '잠시 후 다시 시도해 주세요.');
    }
  }

  private finishAccount() {
    const user = this.me.user;
    if (!user?.nickname) return;
    this.busy(true);
    this.setStatus('세상에 들어가는 중이에요…', true);
    this.resolve({ mode: 'account', nickname: user.nickname, userId: user.id });
  }

  private async logout() {
    this.busy(true);
    try {
      await logout();
    } catch {
      /* ignore */
    }
    this.me = { user: null, needsNickname: false };
    this.busy(false);
    this.setStatus('로그아웃했어요.', true);
    this.showPane();
  }

  /** Wait for the player's choice. */
  ask(): Promise<EntryChoice> {
    this.busy(false);
    return new Promise((resolve) => (this.resolveChoice = resolve));
  }

  showError(message: string, offerSolo: boolean) {
    this.busy(false);
    this.setStatus(message);
    this.fallback.hidden = !offerSolo;
  }

  hide() {
    this.root.classList.add('done');
  }
}
