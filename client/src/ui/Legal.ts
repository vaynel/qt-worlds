import { cleanText, MIN_AGE, nicknameKey } from '../../../shared/protocol';
import { PRIVACY_PATH, TERMS_PATH } from '../config/legal';
import { api, ApiError } from '../net/api';
import { button, el, Modal } from './dom';

/**
 * M7 (개인정보 보호): links to /privacy and /terms, the one-time consent sheet
 * for accounts made before the terms existed, 내 데이터 내려받기 and 회원 탈퇴.
 */

const CONSENT_SHOWN_KEY = 'worlds.consent.shown';

/** Whether the signed-in account still has to agree to the current terms (set from /api/me). */
export const consent = {
  needed: false,
  listeners: new Set<() => void>(),
  set(needed: boolean) {
    this.needed = needed;
    for (const fn of this.listeners) fn();
  },
};

function link(href: string, label: string, id?: string): HTMLAnchorElement {
  const a = el('a', '', label);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  if (id) a.id = id;
  return a;
}

/** "개인정보처리방침 · 이용약관" (new tab). */
export function legalLinks(idPrefix = 'legal'): HTMLElement {
  const p = el('p', 'legal-links');
  p.append(link(PRIVACY_PATH, '개인정보처리방침', `${idPrefix}-privacy`), el('span', '', '·'), link(TERMS_PATH, '이용약관', `${idPrefix}-terms`));
  p.lastElementChild?.previousElementSibling?.setAttribute('aria-hidden', 'true');
  return p;
}

/** The same sentence as the sign-up checkbox, with both documents linked. */
function agreeLabel(id: string): { label: HTMLLabelElement; box: HTMLInputElement } {
  const label = el('label', 'entry-check entry-consent');
  const box = el('input');
  box.type = 'checkbox';
  box.id = id;
  const text = el('span');
  text.append(`만 ${MIN_AGE}세 이상이며, `, link(TERMS_PATH, '이용약관'), '과 ', link(PRIVACY_PATH, '개인정보처리방침'), '에 동의합니다');
  label.append(box, text);
  return { label, box };
}

// ---------------------------------------------------------------- consent sheet

export class ConsentSheet {
  private readonly modal = new Modal('consent-overlay', '약관 동의');

  /** Once per browser session (tab), unless opened on purpose (⚙ 설정). */
  static shownThisSession(): boolean {
    try {
      return sessionStorage.getItem(CONSENT_SHOWN_KEY) === '1';
    } catch {
      return false;
    }
  }

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  open(onAgreed?: () => void) {
    try {
      sessionStorage.setItem(CONSENT_SHOWN_KEY, '1');
    } catch {
      /* ignore */
    }
    const sheet = this.modal.sheet;
    sheet.className = 'sheet login-prompt consent-sheet';
    sheet.replaceChildren();
    const body = el('div', 'prompt-body consent-body');
    const status = el('p', 'groups-status');
    status.setAttribute('role', 'status');
    const { label, box } = agreeLabel('consent-agree');
    const agree = button('동의하기', 'primary', async () => {
      if (!box.checked) {
        label.classList.add('missing');
        status.textContent = `만 ${MIN_AGE}세 이상인지 확인하고 체크해 주세요.`;
        return;
      }
      agree.disabled = true;
      try {
        await api('POST', '/api/me/consent', { agree: true });
        consent.set(false);
        this.modal.close();
        onAgreed?.();
      } catch (err) {
        agree.disabled = false;
        status.textContent = err instanceof ApiError ? err.message : '잠시 후 다시 시도해 주세요.';
      }
    });
    agree.id = 'consent-accept';
    box.addEventListener('change', () => {
      label.classList.remove('missing');
      status.textContent = '';
    });
    const later = button('나중에', 'ghost', () => this.modal.close());
    later.id = 'consent-later';
    const actions = el('div', 'prompt-actions');
    actions.append(agree, later);
    body.append(
      el('p', 'prompt-title', '이용약관과 개인정보처리방침이 생겼어요'),
      el('p', '', 'QT 월드가 어떤 정보를 왜 보관하고 언제 지우는지 정리했어요. 묵상을 저장하고 등불·모임에 나누려면 한 번 동의해 주세요.'),
      el('p', 'prompt-small', '동의하지 않아도 지금처럼 둘러보고 읽을 수 있어요. 나중에 ⚙ 설정 → 계정에서 동의할 수 있어요.'),
      label,
      actions,
      status,
    );
    sheet.append(body);
    this.modal.open();
  }
}

// ---------------------------------------------------------------- 내 데이터 내려받기

/** Fetch /api/me/export and hand it to the browser as a .json download. */
export async function downloadMyData(): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/me/export', { credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'network', '서버에 연결할 수 없어요.');
  }
  if (!res.ok) {
    const d = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, d.error ?? 'error', d.message ?? '내려받지 못했어요.');
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'qt-world-my-data.json';
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ---------------------------------------------------------------- 회원 탈퇴

/** Things only this device keeps for the account (cleared after 탈퇴). */
function forgetDevice(userId: number) {
  try {
    localStorage.removeItem('worlds.meditationDraft.v1');
    localStorage.removeItem(`worlds.imported.${userId}`);
    sessionStorage.removeItem(CONSENT_SHOWN_KEY);
  } catch {
    /* ignore */
  }
}

export class DeleteAccountSheet {
  private readonly modal = new Modal('delete-overlay', '회원 탈퇴');

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  open(account: { id: number; nickname: string }) {
    const sheet = this.modal.sheet;
    sheet.className = 'sheet login-prompt delete-sheet';
    sheet.replaceChildren();
    const body = el('div', 'prompt-body delete-body');
    const gone = el('ul');
    for (const t of [
      '계정(Google 계정 연결, 이메일, 닉네임)',
      '나의 말씀 책: 모든 묵상과 담아 둔 묵상',
      '내 등불: 모든 분의 화면에서 바로 꺼지고, 다른 분이 기록하기로 담은 사본도 지워져요',
      '내가 남긴 아멘·기도하기·기록하기',
      '내 모임 채팅 메시지와 모임 참여',
      '알림 구독과 로그인된 모든 기기',
    ]) {
      gone.append(el('li', '', t));
    }
    const input = el('input');
    input.type = 'text';
    input.id = 'delete-confirm';
    input.autocomplete = 'off';
    input.maxLength = 24;
    input.placeholder = account.nickname;
    input.setAttribute('aria-label', '확인을 위해 닉네임 입력');
    const status = el('p', 'groups-status');
    status.setAttribute('role', 'status');
    const matches = () => {
      const typed = cleanText(input.value);
      return typed !== '' && nicknameKey(typed) === nicknameKey(account.nickname);
    };
    const go = button('탈퇴하기', 'danger', async () => {
      if (!matches()) {
        status.textContent = '닉네임을 똑같이 적어 주세요.';
        return;
      }
      go.disabled = true;
      cancel.disabled = true;
      status.textContent = '지우고 있어요…';
      try {
        await api('POST', '/api/me/delete', { nickname: input.value });
        forgetDevice(account.id);
        location.replace('/?deleted=1');
      } catch (err) {
        go.disabled = !matches();
        cancel.disabled = false;
        status.textContent = err instanceof ApiError ? err.message : '잠시 후 다시 시도해 주세요.';
      }
    });
    go.id = 'delete-account';
    go.disabled = true;
    input.addEventListener('input', () => {
      go.disabled = !matches();
      status.textContent = '';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && matches()) go.click();
    });
    const cancel = button('그만두기', 'ghost', () => this.modal.close());
    cancel.id = 'delete-cancel';
    const actions = el('div', 'sheet-actions');
    actions.append(cancel, go);
    const confirmLabel = el('p', '');
    confirmLabel.append('확인을 위해 닉네임 ', el('strong', '', account.nickname), ' 을(를) 적어 주세요.');
    body.append(
      el('p', 'prompt-title', '회원 탈퇴'),
      el('p', '', '탈퇴하면 아래 내용이 바로 지워지고, 되돌릴 수 없어요.'),
      gone,
      el(
        'p',
        'prompt-small',
        '내가 만든 모임은 가장 오래 함께한 분이 모임장이 되고, 남은 분이 없으면 모임도 지워져요. 지운 정보는 백업에서도 약 14일 안에 사라져요. 남겨 두고 싶은 묵상이 있다면 먼저 “내 데이터 내려받기”를 해 주세요.',
      ),
      confirmLabel,
      input,
      actions,
      status,
    );
    sheet.append(body);
    this.modal.open();
    setTimeout(() => input.focus(), 60);
  }
}
