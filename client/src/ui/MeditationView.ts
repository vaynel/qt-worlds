import type { WordPassage } from '../../../shared/protocol';
import { ApiError } from '../net/api';
import { GuestRestricted, type MeditationPlace, type WordBookStore } from '../storage/WordBook';
import { button, el, Modal } from './dom';

type FieldKey = 'meditation' | 'feeling' | 'application';

const STEPS: { key: 'word' | FieldKey; title: string; prompt: string; placeholder?: string }[] = [
  { key: 'word', title: '말씀', prompt: '천천히 두세 번 소리 내어 읽어 보세요. 마음에 머무는 단어가 있나요?' },
  {
    key: 'meditation',
    title: '묵상',
    prompt: '이 말씀이 오늘 나에게 무엇을 말하고 있나요?',
    placeholder: '마음에 머문 단어나 구절, 떠오르는 생각을 적어 보세요.',
  },
  {
    key: 'feeling',
    title: '느낀 점',
    prompt: '말씀 앞에 선 지금, 어떤 마음이 드나요?',
    placeholder: '감사, 위로, 회개, 소망… 솔직하게 적어도 괜찮아요.',
  },
  {
    key: 'application',
    title: '적용',
    prompt: '오늘 하루, 이 말씀으로 살아갈 작은 걸음 하나는 무엇일까요?',
    placeholder: '예: 오늘 만나는 사람에게 먼저 따뜻한 말을 건네기',
  },
];
const MAX_CHARS = 2000;
const DRAFT_KEY = 'worlds.meditationDraft.v1';

interface Draft {
  date: string;
  meditation: string;
  feeling: string;
  application: string;
}

/** 말씀 → 묵상 → 느낀 점 → 적용, saved into the word book. */
export class MeditationView {
  private readonly modal = new Modal('meditation-overlay', '묵상하기');
  private step = 0;
  private draft: Draft = { date: '', meditation: '', feeling: '', application: '' };
  private word: WordPassage | null = null;
  private place: MeditationPlace = '골방';
  private savedHandler: (place: MeditationPlace) => void = () => undefined;

  constructor(
    private readonly store: WordBookStore,
    private readonly needLogin: (reason: string) => void = () => undefined,
  ) {}

  onSaved(fn: (place: MeditationPlace) => void) {
    this.savedHandler = fn;
  }

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  open(word: WordPassage, place: MeditationPlace) {
    this.word = word;
    this.place = place;
    this.step = 0;
    this.draft = this.loadDraft(word.date);
    this.render();
    this.modal.open(() => this.saveDraft());
  }

  private loadDraft(date: string): Draft {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as Draft | null;
      if (d && d.date === date) return d;
    } catch {
      /* ignore */
    }
    return { date, meditation: '', feeling: '', application: '' };
  }

  private saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(this.draft));
    } catch {
      /* ignore */
    }
  }

  private clearDraft() {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
  }

  private render() {
    const word = this.word!;
    const sheet = this.modal.sheet;
    sheet.className = 'sheet meditation';
    sheet.replaceChildren();
    const s = STEPS[this.step];

    const top = el('header', 'med-top');
    const dots = el('ol', 'med-steps');
    STEPS.forEach((st, i) => {
      const li = el('li', i === this.step ? 'on' : i < this.step ? 'done' : '', st.title);
      if (i === this.step) li.setAttribute('aria-current', 'step');
      dots.append(li);
    });
    top.append(el('p', 'med-place', `${this.place}에서 묵상`), dots, button('닫기', 'ghost med-close', () => this.modal.close()));
    sheet.append(top);

    const body = el('div', 'med-body');
    const verse = el('blockquote', this.step === 0 ? 'med-verse big' : 'med-verse');
    verse.append(document.createTextNode(word.text));
    const ref = el('cite', 'med-ref', `${word.ref} · ${word.translation || '개역한글판'}`);
    verse.append(ref);
    body.append(verse, el('p', 'med-prompt', s.prompt));

    if (s.key !== 'word') {
      const key = s.key;
      const area = el('textarea', 'med-input');
      area.id = `med-${key}`;
      area.maxLength = MAX_CHARS;
      area.rows = 5;
      area.placeholder = s.placeholder ?? '';
      area.value = this.draft[key];
      area.setAttribute('aria-label', s.title);
      area.addEventListener('input', () => {
        this.draft[key] = area.value;
        this.saveDraft();
      });
      body.append(area);
      // Bring the field into view above the on-screen keyboard.
      area.addEventListener('focus', () => setTimeout(() => area.scrollIntoView({ block: 'center' }), 250));
    }
    sheet.append(body);

    const foot = el('footer', 'med-foot');
    const back = button('이전', '', () => this.go(-1));
    back.disabled = this.step === 0;
    foot.append(back);
    if (this.step < STEPS.length - 1) {
      foot.append(button('다음', 'primary', () => this.go(1)));
    } else {
      const save = button('말씀 책에 담기', 'primary med-save', () => void this.save(save));
      foot.append(save);
    }
    const status = el('p', 'med-status');
    status.id = 'med-status';
    status.setAttribute('role', 'status');
    sheet.append(foot, status);
  }

  private go(delta: number) {
    this.step = Math.min(STEPS.length - 1, Math.max(0, this.step + delta));
    this.render();
  }

  private async save(btn: HTMLButtonElement) {
    const { meditation, feeling, application } = this.draft;
    const status = this.modal.sheet.querySelector('#med-status');
    if (!meditation.trim() && !feeling.trim() && !application.trim()) {
      if (status) status.textContent = '한 줄이라도 적어 주시면 말씀 책에 담을게요.';
      return;
    }
    btn.disabled = true;
    try {
      await this.store.addMeditation(this.word!, {
        place: this.place,
        meditation: meditation.trim(),
        feeling: feeling.trim(),
        application: application.trim(),
      });
    } catch (err) {
      btn.disabled = false;
      if (err instanceof GuestRestricted) {
        // Keep the draft so it can be finished after signing in.
        this.saveDraft();
        this.modal.close();
        this.needLogin('로그인하면 묵상을 나의 말씀 책에 저장하고, 등불로 나눌 수 있어요.');
        return;
      }
      if (status) status.textContent = err instanceof ApiError ? err.message : '저장하지 못했어요. 잠시 후 다시 시도해 주세요.';
      return;
    }
    this.clearDraft();
    this.draft = { date: this.word!.date, meditation: '', feeling: '', application: '' };
    this.modal.close();
    this.savedHandler(this.place);
  }
}
