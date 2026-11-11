import { installMode, isStandalone, promptInstall } from '../pwa/pwa';
import { button, el, Modal } from './dom';

const OFFER_KEY = 'worlds.install.offered';

/** "📲 앱으로 설치하기": the browser prompt, or (iOS Safari) a short 홈 화면에 추가 guide. */
export class InstallGuide {
  private readonly modal = new Modal('install-overlay', '앱으로 설치하기');

  /** Run from a tap. */
  async install() {
    const mode = installMode();
    if (mode === 'prompt') await promptInstall();
    else if (mode === 'ios') this.iosGuide();
  }

  /** iOS has no install prompt: 공유 → 홈 화면에 추가. `forPush` explains why it matters for 알림. */
  iosGuide(forPush = false) {
    const sheet = this.modal.sheet;
    sheet.className = 'sheet login-prompt install-sheet';
    sheet.replaceChildren();
    const body = el('div', 'prompt-body');
    body.id = 'ios-install-guide';
    body.append(el('p', 'prompt-title', '📲 홈 화면에 추가하기'));
    body.append(
      el(
        'p',
        '',
        forPush
          ? 'iPhone·iPad에서는 홈 화면에 추가한 앱에서만 알림을 받을 수 있어요 (iOS 16.4 이상).'
          : '홈 화면에 추가하면 앱처럼 전체 화면으로 바로 열 수 있어요.',
      ),
    );
    const ol = el('ol', 'mic-steps install-steps');
    const share = el('li');
    share.append('Safari 아래(또는 위)의 ', el('span', 'ios-share-icon', '공유'), ' 버튼을 눌러요');
    ol.append(share, el('li', '', '목록을 내려 "홈 화면에 추가"를 눌러요'), el('li', '', '오른쪽 위 "추가"를 누르면 끝!'));
    body.append(ol);
    if (forPush) body.append(el('p', 'prompt-small', '홈 화면의 QT 월드 아이콘으로 연 뒤, ⚙ 설정 → 🔔 알림에서 켜 주세요.'));
    else body.append(el('p', 'prompt-small', 'Safari가 아닌 브라우저라면 Safari로 열어 주세요.'));
    const actions = el('div', 'prompt-actions');
    const ok = button('알겠어요', 'primary', () => this.modal.close());
    ok.id = 'ios-install-close';
    actions.append(ok);
    body.append(actions);
    sheet.append(body);
    this.modal.open();
  }

  /**
   * Once, gently, after the first-time guide: a small card, never repeated
   * (remembered on this device). Nothing when installed or not installable.
   */
  offerOnce() {
    if (isStandalone() || !installMode()) return;
    try {
      if (localStorage.getItem(OFFER_KEY)) return;
      localStorage.setItem(OFFER_KEY, String(Date.now()));
    } catch {
      return;
    }
    const card = el('div', 'install-offer card');
    card.id = 'install-offer';
    card.setAttribute('role', 'status');
    const text = el('span', 'install-offer-text');
    text.append(el('span', '', '홈 화면에 두고 앱처럼 열 수 있어요'), el('small', 'install-offer-hint', '설치와 👕 꾸미기는 언제든 ⚙ 설정에 있어요'));
    card.append(text);
    const close = () => card.remove();
    const yes = button('📲 앱으로 설치하기', 'primary', () => {
      close();
      void this.install();
    });
    yes.id = 'install-offer-yes';
    const no = button('괜찮아요', 'ghost', close);
    no.id = 'install-offer-no';
    card.append(yes, no);
    document.getElementById('app')!.append(card);
    setTimeout(close, 20_000);
  }
}
