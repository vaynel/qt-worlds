import { CAMPFIRE_VOICE_ROOM, VOICE_REPORT_LABELS, VOICE_REPORT_REASONS, type VoiceReportReason } from '../../../shared/protocol';
import { api, ApiError } from '../net/api';
import type { VoiceClient } from '../voice/VoiceClient';
import { button, el, Modal } from './dom';

export interface CampfireVoiceHooks {
  /** null for guests and solo play. */
  voice: () => VoiceClient | null;
  signedIn: () => boolean;
  needLogin: (reason: string) => void;
  openPanel: () => void;
  toast: (text: string) => void;
}

/**
 * 🔥 모닥불 공개 음성: the "🎙️ 모닥불 음성 참여" button in the campfire chat
 * header, the one-room-at-a-time switch prompt, and the 🚩 음성 신고 sheet.
 * The voice itself is the group voice room's VoiceClient in campfire mode.
 */
export class CampfireVoiceUi {
  readonly joinBtn: HTMLButtonElement;
  private readonly confirmModal = new Modal('voice-switch-overlay', '음성 대화 옮기기');
  private readonly reportModal = new Modal('voice-report-overlay', '음성 신고');
  private key = '';

  constructor(private readonly hooks: CampfireVoiceHooks) {
    this.joinBtn = button('', 'ghost chat-head-btn campfire-voice-btn', () => void this.onJoinTap());
    this.joinBtn.id = 'campfire-voice-btn';
    // Like the other header buttons: don't blur the chat input first (the panel would jump).
    this.joinBtn.addEventListener('mousedown', (e) => e.preventDefault());
    document.getElementById('chat-collapse')?.before(this.joinBtn);
    this.update();
  }

  get reportOpen(): boolean {
    return this.reportModal.isOpen;
  }

  /** Voice state changed: the header button follows it. */
  update() {
    const v = this.hooks.voice();
    const state = v?.campfire && v.state !== 'idle' ? v.state : 'idle';
    if (state === this.key) return;
    this.key = state;
    this.joinBtn.classList.toggle('on', state !== 'idle');
    // <i>, not <span>: phones hide the header's hint span (.chat-head span).
    const text = el('i', 'cv-text');
    // Phones drop "모닥불 " (CSS) so the header row still fits at 360 px.
    if (state === 'idle') text.append(el('i', 'cv-long', '모닥불 '), '음성 참여');
    else text.textContent = state === 'in' ? '음성 참여 중' : '연결 중…';
    this.joinBtn.replaceChildren(el('i', 'cv-icon', '🎙️'), text);
    this.joinBtn.setAttribute('aria-label', state === 'in' ? '모닥불 음성 참여 중, 열기' : '모닥불 음성 참여');
  }

  /** Ask before leaving one voice room for the other. */
  confirmSwitch(text: string, ok: string): Promise<boolean> {
    return new Promise((resolve) => {
      let answered = false;
      const done = (v: boolean) => {
        if (answered) return;
        answered = true;
        resolve(v);
        if (this.confirmModal.isOpen) this.confirmModal.close();
      };
      const body = el('div', 'prompt-body');
      const yes = button(ok, 'primary', () => done(true));
      yes.id = 'voice-switch-ok';
      const no = button('그대로 있기', 'ghost', () => done(false));
      no.id = 'voice-switch-cancel';
      const actions = el('div', 'prompt-actions');
      actions.append(yes, no);
      body.append(el('p', 'prompt-title', '음성 대화는 한 곳에서만 할 수 있어요'), el('p', '', text), actions);
      this.confirmModal.sheet.className = 'sheet login-prompt';
      this.confirmModal.sheet.replaceChildren(body);
      this.confirmModal.open(() => done(false));
    });
  }

  async onJoinTap() {
    if (!this.hooks.signedIn()) return this.hooks.needLogin('로그인하면 함께 이야기할 수 있어요. 모닥불 곁에서 목소리로 이야기를 나눌 수 있어요.');
    const v = this.hooks.voice();
    if (!v) return;
    if (v.campfire && v.state !== 'idle') return this.hooks.openPanel();
    if (v.state !== 'idle' && !v.campfire) {
      const go = await this.confirmSwitch('모임 음성 기도방에서 나와 모닥불 음성에 참여할까요?', '모닥불 음성 참여');
      if (!go) return;
    }
    await v.join(CAMPFIRE_VOICE_ROOM);
  }

  /** 🚩 음성 신고: one speaker in the campfire voice room. */
  openReport(peerId: string, name: string) {
    if (!this.hooks.signedIn()) return this.hooks.needLogin('로그인하면 음성 신고를 할 수 있어요.');
    const sheet = this.reportModal.sheet;
    sheet.className = 'sheet report-sheet voice-report-sheet';
    sheet.replaceChildren();
    const top = el('header', 'book-top');
    top.append(el('h2', 'book-title', '🚩 음성 신고'), button('닫기', 'ghost report-close', () => this.reportModal.close()));
    const body = el('div', 'report-body');
    body.dataset.peer = peerId;
    body.append(
      el('p', '', `${name} 님의 말이 불편했나요? 신고한 사람은 알려지지 않아요.`),
      el('p', 'settings-note', '서로 다른 세 분이 10분 안에 신고하면 그분은 24시간 동안 모닥불 음성에서 말할 수 없어요 (듣기는 할 수 있어요). 목소리는 녹음되지 않아서, 지금 바로 🔇 나만 음소거도 할 수 있어요.'),
    );
    let reason: VoiceReportReason | null = null;
    const chips = el('div', 'look-styles report-reasons');
    chips.setAttribute('role', 'radiogroup');
    chips.setAttribute('aria-label', '신고 이유');
    const status = el('p', 'groups-status');
    status.setAttribute('role', 'status');
    const send = button('신고하기', 'primary', async () => {
      if (!reason) return;
      send.disabled = true;
      try {
        await api('POST', '/api/voice/campfire/report', { target: peerId, reason });
        status.textContent = '신고를 받았어요. 알려 주셔서 고마워요.';
        send.hidden = true;
      } catch (err) {
        send.disabled = false;
        status.textContent = err instanceof ApiError ? err.message : '보내지 못했어요. 잠시 후 다시 시도해 주세요.';
      }
    });
    send.id = 'voice-report-send';
    send.disabled = true;
    for (const r of VOICE_REPORT_REASONS) {
      const b = button(VOICE_REPORT_LABELS[r], 'chip big-chip', () => {
        reason = r;
        for (const x of chips.children) x.setAttribute('aria-checked', String(x === b));
        send.disabled = false;
      });
      b.id = `voice-report-reason-${r}`;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      chips.append(b);
    }
    const mute = button('🔇 나만 음소거', 'ghost', () => {
      this.hooks.voice()?.setPeerLocalMuted(peerId, true);
      this.hooks.toast(`${name} 님의 목소리를 나에게만 껐어요.`);
    });
    mute.id = 'voice-report-mute';
    const actions = el('div', 'prompt-actions');
    actions.append(send, mute, button('그만두기', 'ghost', () => this.reportModal.close()));
    body.append(chips, actions, status);
    sheet.append(top, body);
    this.reportModal.open();
  }
}
