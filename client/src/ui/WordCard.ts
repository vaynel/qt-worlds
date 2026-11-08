import type { PassageVerse, WordPassage } from '../../../shared/protocol';
import { button, el, koreanDate, Modal } from './dom';

export interface WordCardActions {
  /** Present only where meditation is possible right now. */
  meditate?: () => void;
  openBook: () => void;
}

function verseLine(v: PassageVerse, className: string): HTMLParagraphElement {
  const p = el('p', className);
  p.append(el('sup', 'vnum', String(v.verse)), document.createTextNode(v.text));
  return p;
}

/**
 * The opened letter: an envelope opens, then a page unfolds with today's verse
 * and two dimmed verses on either side for context.
 */
export class WordCard {
  private readonly modal = new Modal('word-overlay', '오늘의 말씀');

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  open(word: WordPassage, actions: WordCardActions, fromLetter: boolean, onClose?: () => void) {
    const sheet = this.modal.sheet;
    sheet.replaceChildren();
    sheet.className = `sheet word-stage${fromLetter ? ' from-letter' : ''}`;

    if (fromLetter) {
      const env = el('div', 'envelope');
      env.append(el('div', 'envelope-flap'), el('div', 'envelope-seal'));
      sheet.append(env);
    }

    const page = el('article', 'word-page');
    const head = el('header', 'word-head');
    head.append(el('p', 'word-eyebrow', '오늘의 말씀'), el('p', 'word-date', koreanDate(word.date)));
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

    const actionsRow = el('div', 'word-actions');
    if (actions.meditate) {
      actionsRow.append(button('묵상하기', 'primary', () => actions.meditate?.()));
    }
    actionsRow.append(button('말씀 책', '', actions.openBook), button('닫기', '', () => this.modal.close()));
    const hint = actions.meditate ? null : el('p', 'word-hint', '골방이나 기도의 뜰 자리에 앉으면 이 말씀으로 묵상할 수 있어요.');

    page.append(head, body, ref);
    if (hint) page.append(hint);
    page.append(actionsRow);
    sheet.append(page);
    this.modal.open(onClose);
  }

  close() {
    this.modal.close();
  }
}
