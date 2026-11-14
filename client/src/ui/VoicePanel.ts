import type { VoiceClient } from '../voice/VoiceClient';
import { button, el, Modal } from './dom';

/**
 * Voice room UI: a compact chip usable from anywhere (mic toggle + open), and a
 * sheet with the participant list (speaking, muted, per-person volume, local
 * mute, and kick for the group creator or 🚩 신고 at the 🔥 campfire) and 나가기.
 */
export class VoicePanel {
  private readonly chip: HTMLDivElement;
  private readonly chipLabel: HTMLButtonElement;
  private readonly micBtn: HTMLButtonElement;
  private readonly modal = new Modal('voice-overlay', '음성 기도방');
  /** Rebuild the sheet only when its structure changes (taps must not land on replaced buttons). */
  private sheetKey = '';
  private chipKey = '';

  constructor(
    private readonly voice: VoiceClient,
    /** 💬: open the group chat (or the campfire chat) for people without a mic. */
    private readonly openChat: (groupId: number) => void = () => undefined,
    /** 🚩 음성 신고 (campfire only). */
    private readonly report: (peerId: string, name: string) => void = () => undefined,
  ) {
    this.chip = el('div', 'voice-chip');
    this.chip.id = 'voice-chip';
    this.chip.hidden = true;
    this.chipLabel = button('', 'voice-chip-label', () => this.open());
    this.chipLabel.id = 'voice-open';
    this.micBtn = button('', 'voice-mic', () => void this.voice.setMuted(!this.voice.muted));
    this.micBtn.id = 'voice-mic';
    const chat = button('💬', 'voice-chat', () => {
      if (this.voice.groupId !== null) this.openChat(this.voice.groupId);
    });
    chat.id = 'voice-chat';
    chat.setAttribute('aria-label', '대화 열기');
    chat.title = '대화';
    this.chip.append(this.chipLabel, this.micBtn, chat);
    this.chip.addEventListener('pointerdown', (e) => e.stopPropagation());
    document.getElementById('app')!.append(this.chip);
  }

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  open() {
    this.renderSheet();
    if (!this.modal.isOpen) this.modal.open();
  }

  /** Call whenever voice state changes. */
  update() {
    const v = this.voice;
    const active = v.active;
    this.chip.hidden = !active;
    document.body.classList.toggle('voice-on', active);
    if (!active) {
      if (this.modal.isOpen) this.modal.close();
      return;
    }
    const count = v.peerList().length + 1;
    const anyone = v.speaking || v.peerList().some((p) => p.speaking && !p.localMuted);
    this.chip.classList.toggle('speaking', anyone);
    const text = v.state === 'joining' ? '연결 중…' : v.campfire ? `🔥 모닥불 · ${count}명` : `${v.groupName} · ${count}명`;
    if (text !== this.chipKey) {
      this.chipKey = text;
      this.chipLabel.replaceChildren(el('span', 'voice-dot'), el('span', 'voice-chip-text', text));
    }
    this.chip.classList.toggle('campfire', v.campfire);
    this.micBtn.disabled = v.campfire && v.silenced;
    this.micBtn.textContent = v.muted ? '🔇' : '🎙️';
    this.micBtn.setAttribute('aria-label', v.muted ? '마이크 켜기' : '마이크 끄기');
    this.micBtn.setAttribute('aria-pressed', v.muted ? 'false' : 'true');
    this.micBtn.title = this.micBtn.getAttribute('aria-label')!;
    if (this.modal.isOpen) this.refreshSheet();
  }

  private structureKey(): string {
    const v = this.voice;
    return JSON.stringify([v.groupName, v.campfire, v.silencedUntil, v.owner, v.muted, v.peerList().map((p) => [p.id, p.name, p.owner, p.muted, p.localMuted, p.silenced])]);
  }

  /** Light update: speaking dots only, unless the structure changed. */
  private refreshSheet() {
    if (this.structureKey() !== this.sheetKey) return this.renderSheet();
    const v = this.voice;
    const sheet = this.modal.sheet;
    sheet.querySelector('.voice-row.me')?.classList.toggle('speaking', v.speaking);
    for (const p of v.peerList()) {
      sheet.querySelector(`.voice-row[data-peer="${CSS.escape(p.id)}"]`)?.classList.toggle('speaking', p.speaking && !p.localMuted);
    }
  }

  private renderSheet() {
    const v = this.voice;
    this.sheetKey = this.structureKey();
    const sheet = this.modal.sheet;
    // Keep slider focus while re-rendering live updates.
    const focusedId = (document.activeElement as HTMLElement | null)?.dataset?.peer;
    sheet.className = 'sheet voice-sheet';
    sheet.replaceChildren();
    const top = el('header', 'book-top');
    top.append(el('h2', 'book-title', v.campfire ? '🔥 모닥불 음성' : `🎙️ ${v.groupName || '음성 기도방'}`), button('닫기', 'ghost', () => this.modal.close()));
    sheet.append(top);
    const body = el('div', 'voice-body');
    if (v.campfire) {
      body.append(
        el('p', 'settings-note', '모닥불 곁에 있는 분들이 함께 듣는 공개 대화예요. 녹음하거나 저장하지 않아요. 서로의 IP 주소가 보이지 않도록 Cloudflare 중계 서버를 거쳐요. 처음엔 마이크가 꺼져 있어요.'),
      );
      if (v.silenced) body.append(el('p', 'settings-note voice-silenced', '신고가 쌓여서 지금은 말할 수 없어요. 듣기는 계속할 수 있어요.'));
    } else {
      body.append(el('p', 'settings-note', '모임 사람만 들어올 수 있어요. 녹음하거나 저장하지 않아요. 처음엔 마이크가 꺼져 있어요.'));
    }

    const list = el('ul', 'voice-list');
    const me = el('li', `voice-row me${v.speaking ? ' speaking' : ''}`);
    me.append(el('span', 'voice-dot'), el('span', 'voice-name', '나'));
    const mic = button(v.muted ? '🔇 마이크 켜기' : '🎙️ 마이크 끄기', v.muted ? 'primary' : '', () => void v.setMuted(!v.muted));
    mic.id = 'voice-sheet-mic';
    mic.disabled = v.campfire && v.silenced;
    me.append(mic);
    list.append(me);

    for (const p of v.peerList()) {
      const li = el('li', `voice-row${p.speaking && !p.localMuted ? ' speaking' : ''}`);
      li.dataset.peer = p.id;
      li.append(
        el('span', 'voice-dot'),
        el('span', 'voice-name', `${p.name}${p.owner ? ' · 방장' : ''}`),
        el('span', 'voice-state', p.silenced ? '🚫' : p.muted ? '🔇' : '🎙️'),
      );
      const vol = el('input', 'voice-vol');
      vol.type = 'range';
      vol.min = '0';
      vol.max = '100';
      vol.value = String(p.volume);
      vol.dataset.peer = p.id;
      vol.setAttribute('aria-label', `${p.name} 음량`);
      vol.addEventListener('input', () => v.setPeerVolume(p.id, Number(vol.value)));
      const lm = button(p.localMuted ? '듣기' : '음소거', 'ghost voice-localmute', () => v.setPeerLocalMuted(p.id, !p.localMuted));
      lm.setAttribute('aria-label', p.localMuted ? `${p.name} 다시 듣기` : `${p.name} 나만 음소거`);
      li.append(vol, lm);
      if (v.campfire) {
        const flag = button('🚩', 'ghost voice-report', () => this.report(p.id, p.name));
        flag.dataset.peer = p.id;
        flag.setAttribute('aria-label', `${p.name} 음성 신고`);
        flag.title = '음성 신고';
        li.append(flag);
      } else if (v.owner) {
        const kick = button('내보내기', 'ghost danger voice-kick', () => v.kick(p.id));
        kick.dataset.peer = p.id;
        li.append(kick);
      }
      list.append(li);
    }
    body.append(list);
    const leave = button(v.campfire ? '모닥불 음성 나가기' : '음성 기도방 나가기', 'danger', () => {
      v.leave();
      this.modal.close();
    });
    leave.id = 'voice-leave';
    body.append(leave);
    sheet.append(body);
    if (focusedId) sheet.querySelector<HTMLInputElement>(`input[data-peer="${CSS.escape(focusedId)}"]`)?.focus();
  }
}
