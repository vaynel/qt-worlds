import type { PassageVerse, WordPassage } from '../../../shared/protocol';
import { button, el, koreanDate, Modal } from './dom';

export interface WordCardActions {
  meditate: () => void;
  openBook: () => void;
}

function verseLine(v: PassageVerse, className: string): HTMLParagraphElement {
  const p = el('p', className);
  p.append(el('sup', 'vnum', String(v.verse)), document.createTextNode(v.text));
  return p;
}

/** Today's verse with two dimmed verses on either side, then the reference (letter page and 말씀 → 오늘). */
export function wordPassage(word: WordPassage): HTMLElement[] {
  const body = el('div', 'word-body');
  for (const v of word.before) body.append(verseLine(v, 'ctx'));
  // A short range (e.g. 시편 23:2-3) shows every verse inside one highlighted block.
  const mainLines = word.lines && word.lines.length > 1 ? word.lines : [{ verse: word.verse, text: word.text }];
  const main = el('div', 'main');
  for (const l of mainLines) main.append(verseLine(l, 'main-line'));
  body.append(main);
  for (const v of word.after) body.append(verseLine(v, 'ctx'));
  const ref = el('p', 'word-ref');
  ref.append(el('strong', '', word.ref), el('span', 'word-translation', word.translation || '개역한글판'));
  return [body, ref];
}

/**
 * The opened letter (once a day): an envelope opens, then a page unfolds with
 * today's verse. Reopening later goes through 말씀 → 오늘.
 */
export class WordCard {
  private readonly modal = new Modal('word-overlay', '오늘의 말씀');

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  open(word: WordPassage, actions: WordCardActions, onClose?: () => void) {
    const sheet = this.modal.sheet;
    sheet.replaceChildren();
    sheet.className = 'sheet word-stage from-letter';

    const env = el('div', 'envelope');
    env.append(el('div', 'envelope-flap'), el('div', 'envelope-seal'));
    sheet.append(env);

    const page = el('article', 'word-page');
    const head = el('header', 'word-head');
    head.append(el('p', 'word-eyebrow', '오늘의 말씀'), el('p', 'word-date', koreanDate(word.date)));

    const actionsRow = el('div', 'word-actions');
    const book = button('말씀 책에서 보기', '', actions.openBook);
    book.id = 'word-to-book';
    actionsRow.append(button('✍️ 묵상하기', 'primary', actions.meditate), book, button('닫기', '', () => this.modal.close()));

    page.append(head, ...wordPassage(word), actionsRow);
    sheet.append(page);
    this.modal.open(onClose);
  }

  close() {
    this.modal.close();
  }
}
