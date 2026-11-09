import { CHAT_MAX, textLength } from '../../../shared/protocol';

const MAX_LOG = 40;
const CHAT_COLLAPSED_KEY = 'worlds.chat.collapsed';

/**
 * Campfire chat: visible only inside the campfire circle. All text goes in
 * through textContent, never innerHTML.
 */
export class ChatPanel {
  private readonly root = document.getElementById('chat')!;
  private readonly log = document.getElementById('chat-log') as HTMLOListElement;
  private readonly form = document.getElementById('chat-form') as HTMLFormElement;
  private readonly input = document.getElementById('chat-input') as HTMLInputElement;
  private visible = false;
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
    // 작게: only the input and the latest lines; 닫기: put the keyboard away.
    const collapse = document.getElementById('chat-collapse') as HTMLButtonElement | null;
    collapse?.addEventListener('click', () => this.setCollapsed(!this.root.classList.contains('collapsed')));
    document.getElementById('chat-close')?.addEventListener('click', () => {
      this.input.blur();
      this.setCollapsed(true);
    });
    // Remember 작게/크게 across visits.
    let saved = false;
    try {
      saved = localStorage.getItem(CHAT_COLLAPSED_KEY) === '1';
    } catch {
      /* ignore */
    }
    if (saved) this.setCollapsed(true);
  }

  setCollapsed(collapsed: boolean) {
    this.root.classList.toggle('collapsed', collapsed);
    try {
      localStorage.setItem(CHAT_COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      /* storage blocked: still works for this visit */
    }
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

  focus() {
    if (this.visible) this.input.focus();
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
  }

  /** Text of the visible log, for tests. */
  lines(): string[] {
    return [...this.log.children].map((li) => li.textContent ?? '');
  }

  clear() {
    this.log.replaceChildren();
  }
}
