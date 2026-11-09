import { CHAT_MAX, textLength } from '../../../shared/protocol';

const MAX_LOG = 40;
const CHAT_COLLAPSED_KEY = 'worlds.chat.collapsed';
/** Folded away to a small "💬 모닥불 이야기" pill (remembered like 작게/크게). */
const CHAT_FOLDED_KEY = 'worlds.chat.folded';

/**
 * Campfire chat: visible only inside the campfire circle. All text goes in
 * through textContent, never innerHTML.
 */
export class ChatPanel {
  private readonly root = document.getElementById('chat')!;
  private readonly log = document.getElementById('chat-log') as HTMLOListElement;
  private readonly form = document.getElementById('chat-form') as HTMLFormElement;
  private readonly input = document.getElementById('chat-input') as HTMLInputElement;
  private readonly pill = document.getElementById('chat-pill') as HTMLButtonElement;
  private readonly badge = document.getElementById('chat-unread') as HTMLSpanElement;
  private visible = false;
  private folded = false;
  private unread = 0;
  private sendHandler: (text: string) => void = () => undefined;
  private focusHandler: (focused: boolean) => void = () => undefined;

  constructor() {
    this.input.maxLength = CHAT_MAX;
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.input.value.trim();
      if (!text || textLength(text) > CHAT_MAX) return;
      this.sendHandler(text);
      this.input.value = '';
    });
    this.input.addEventListener('focus', () => {
      document.body.classList.add('chatting');
      this.focusHandler(true);
    });
    this.input.addEventListener('blur', () => {
      document.body.classList.remove('chatting');
      // iOS can leave the page scrolled after the keyboard closes.
      window.scrollTo(0, 0);
      this.focusHandler(false);
    });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.input.blur();
    });
    // Don't let taps on the panel start camera drags.
    this.root.addEventListener('pointerdown', (e) => e.stopPropagation());
    // 작게/크게: size of the open panel. 접기: fold it away to the pill; the
    // pill unfolds it again at the size it had.
    const collapse = document.getElementById('chat-collapse') as HTMLButtonElement | null;
    collapse?.addEventListener('click', () => this.setCollapsed(!this.root.classList.contains('collapsed')));
    document.getElementById('chat-fold')?.addEventListener('click', () => this.setFolded(true));
    // While typing, a header tap must not blur the input first: the panel
    // would jump (keyboard layout) before the click lands.
    for (const id of ['chat-fold', 'chat-collapse']) {
      document.getElementById(id)?.addEventListener('mousedown', (e) => e.preventDefault());
    }
    this.pill.addEventListener('click', () => this.setFolded(false));
    // Remember 작게/크게 and 접기 across visits.
    if (load(CHAT_COLLAPSED_KEY) === '1') this.setCollapsed(true);
    if (load(CHAT_FOLDED_KEY) === '1') this.setFolded(true);
  }

  get isFolded(): boolean {
    return this.folded;
  }

  get unreadCount(): number {
    return this.unread;
  }

  /** Fold the whole panel away (only the pill stays) or bring it back. */
  setFolded(folded: boolean) {
    if (folded && this.focused) this.input.blur();
    this.folded = folded;
    this.root.classList.toggle('folded', folded);
    document.body.classList.toggle('chat-folded', folded);
    this.pill.setAttribute('aria-expanded', folded ? 'false' : 'true');
    save(CHAT_FOLDED_KEY, folded ? '1' : '0');
    if (!folded) {
      this.unread = 0;
      this.log.scrollTop = this.log.scrollHeight;
    }
    this.renderBadge();
  }

  private renderBadge() {
    this.badge.hidden = this.unread === 0;
    this.badge.textContent = this.unread > 99 ? '99+' : String(this.unread);
    this.pill.setAttribute('aria-label', this.unread ? `모닥불 이야기 펼치기, 새 이야기 ${this.unread}개` : '모닥불 이야기 펼치기');
  }

  setCollapsed(collapsed: boolean) {
    this.root.classList.toggle('collapsed', collapsed);
    save(CHAT_COLLAPSED_KEY, collapsed ? '1' : '0');
    const b = document.getElementById('chat-collapse');
    if (b) {
      b.textContent = collapsed ? '크게' : '작게';
      b.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
    }
    this.log.scrollTop = this.log.scrollHeight;
  }

  /** Tap outside the chat: dismiss the keyboard and restore the view. */
  blur() {
    if (this.focused) this.input.blur();
  }

  onSend(fn: (text: string) => void) {
    this.sendHandler = fn;
  }

  onFocusChange(fn: (focused: boolean) => void) {
    this.focusHandler = fn;
  }

  get focused(): boolean {
    return document.activeElement === this.input;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  setVisible(visible: boolean) {
    if (visible === this.visible) return;
    this.visible = visible;
    this.root.hidden = !visible;
    document.body.classList.toggle('chat-open', visible);
    if (!visible && this.focused) this.input.blur();
  }

  /** Enter key: open the chat to type (unfolding it if it was folded). */
  focus() {
    if (!this.visible) return;
    if (this.folded) this.setFolded(false);
    this.input.focus();
  }

  append(name: string, text: string, mine: boolean) {
    const li = document.createElement('li');
    if (mine) li.className = 'mine';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = name;
    const body = document.createElement('span');
    body.textContent = text;
    li.append(who, body);
    this.log.append(li);
    while (this.log.children.length > MAX_LOG) this.log.firstElementChild?.remove();
    this.log.scrollTop = this.log.scrollHeight;
    if (this.folded && !mine) {
      this.unread++;
      this.renderBadge();
    }
  }

  /** Text of the visible log, for tests. */
  lines(): string[] {
    return [...this.log.children].map((li) => li.textContent ?? '');
  }

  clear() {
    this.log.replaceChildren();
  }
}

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: still works for this visit */
  }
}
