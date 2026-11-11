import { startGoogleLogin } from '../net/api';
import { button, el, Modal } from './dom';

/** Gentle sign-up nudge for guests who try to save or share. */
export class LoginPrompt {
  private readonly modal = new Modal('login-overlay', '로그인 안내');

  open(reason: string, note = '지금 적던 묵상은 이 기기에 임시로 남아 있어요. 로그인 후 다시 열면 이어서 쓸 수 있어요.') {
    const sheet = this.modal.sheet;
    sheet.className = 'sheet login-prompt';
    sheet.replaceChildren();
    const body = el('div', 'prompt-body');
    body.append(
      el('p', 'prompt-title', '로그인하면 오래 간직할 수 있어요'),
      el('p', '', reason),
    );
    if (note) body.append(el('p', 'prompt-small', note));
    const google = button('', 'google-btn', () => startGoogleLogin(true));
    google.append(el('span', 'google-g'), el('span', 'google-label', 'Google로 로그인'));
    google.setAttribute('aria-label', 'Google로 로그인');
    const later = button('나중에', 'ghost', () => this.modal.close());
    const actions = el('div', 'prompt-actions');
    actions.append(google, later);
    body.append(actions);
    sheet.append(body);
    this.modal.open();
  }
}
