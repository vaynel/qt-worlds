import type { WordPassage } from '../../../shared/protocol';
import { api, ApiError } from '../net/api';

export type MeditationPlace = '골방' | '기도의 뜰';

export interface MeditationFields {
  meditation: string;
  feeling: string;
  application: string;
}

export interface MeditationEntry extends MeditationFields {
  id: string;
  place: MeditationPlace;
  /** ISO timestamp. */
  createdAt: string;
  updatedAt?: string;
  /** Active lantern made from this meditation (server only). */
  lanternId?: number | null;
}

export interface WordBookPage {
  date: string;
  word: WordPassage;
  meditations: MeditationEntry[];
}

/** A lantern someone else shared that I kept with 기록하기 ("담아 둔 묵상"). */
export interface SavedLantern extends MeditationFields {
  lanternId: number;
  nickname: string;
  date: string;
  ref: string;
  verse: string;
  translation: string;
  savedAt: string;
}

/** Thrown when a guest tries to save: the UI turns it into a sign-up prompt. */
export class GuestRestricted extends Error {
  constructor() {
    super('로그인하면 말씀 책에 저장할 수 있어요.');
  }
}

/**
 * Storage boundary for 나의 말씀 책.
 *  - server: the signed-in account (SQLite via /api), same on every device
 *  - guest:  nothing is saved (sign-up prompt)
 *  - local:  M3 localStorage (offline "혼자 둘러보기", and the import source)
 */
export interface WordBookStore {
  readonly kind: 'server' | 'local' | 'guest';
  listPages(): Promise<WordBookPage[]>;
  getPage(date: string): Promise<WordBookPage | null>;
  saveWord(word: WordPassage): Promise<void>;
  addMeditation(word: WordPassage, entry: Omit<MeditationEntry, 'id' | 'createdAt'>): Promise<MeditationEntry>;
  updateMeditation(id: string, fields: MeditationFields): Promise<MeditationEntry>;
  deleteMeditation(id: string): Promise<void>;
  listSaved(): Promise<SavedLantern[]>;
  removeSaved(lanternId: number): Promise<void>;
  isLetterOpened(date: string): Promise<boolean>;
  markLetterOpened(date: string): Promise<void>;
}

const BOOK_KEY = 'worlds.wordbook.v1';
const LETTER_KEY = 'worlds.letterOpened.v1';

interface BookData {
  version: 1;
  pages: Record<string, WordBookPage>;
}

/** Storage can be unavailable (private mode, blocked site data): fall back to memory. */
class SafeStorage {
  private memory = new Map<string, string>();
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return this.memory.get(key) ?? null;
    }
  }
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      this.memory.set(key, value);
    }
  }
}

const storage = new SafeStorage();
const letterOpened = async (date: string) => storage.get(LETTER_KEY) === date;
const markLetter = async (date: string) => storage.set(LETTER_KEY, date);

export class LocalWordBookStore implements WordBookStore {
  readonly kind = 'local' as const;

  private read(): BookData {
    try {
      const raw = storage.get(BOOK_KEY);
      const data = raw ? (JSON.parse(raw) as BookData) : null;
      if (data && data.version === 1 && data.pages && typeof data.pages === 'object') return data;
    } catch {
      /* corrupted: start fresh */
    }
    return { version: 1, pages: {} };
  }

  private write(data: BookData): void {
    storage.set(BOOK_KEY, JSON.stringify(data));
  }

  /** Pages with at least one meditation (what is worth importing). */
  async importable(): Promise<WordBookPage[]> {
    return (await this.listPages()).filter((p) => p.meditations.length > 0);
  }

  async listPages(): Promise<WordBookPage[]> {
    return Object.values(this.read().pages).sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  async getPage(date: string): Promise<WordBookPage | null> {
    return this.read().pages[date] ?? null;
  }

  async saveWord(word: WordPassage): Promise<void> {
    const data = this.read();
    const page = data.pages[word.date];
    data.pages[word.date] = { date: word.date, word, meditations: page?.meditations ?? [] };
    this.write(data);
  }

  async addMeditation(word: WordPassage, entry: Omit<MeditationEntry, 'id' | 'createdAt'>): Promise<MeditationEntry> {
    const data = this.read();
    const page = data.pages[word.date] ?? { date: word.date, word, meditations: [] };
    const full: MeditationEntry = {
      ...entry,
      id: `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      createdAt: new Date().toISOString(),
    };
    page.meditations.push(full);
    data.pages[word.date] = page;
    this.write(data);
    return full;
  }

  private find(id: string): { data: BookData; page: WordBookPage; index: number } {
    const data = this.read();
    for (const page of Object.values(data.pages)) {
      const index = page.meditations.findIndex((m) => m.id === id);
      if (index >= 0) return { data, page, index };
    }
    throw new Error('not found');
  }

  async updateMeditation(id: string, fields: MeditationFields): Promise<MeditationEntry> {
    const { data, page, index } = this.find(id);
    page.meditations[index] = { ...page.meditations[index], ...fields, updatedAt: new Date().toISOString() };
    this.write(data);
    return page.meditations[index];
  }

  async deleteMeditation(id: string): Promise<void> {
    const { data, page, index } = this.find(id);
    page.meditations.splice(index, 1);
    this.write(data);
  }

  async listSaved(): Promise<SavedLantern[]> {
    return [];
  }

  async removeSaved(): Promise<void> {
    /* local books have no saved lanterns */
  }

  isLetterOpened = letterOpened;
  markLetterOpened = markLetter;
}

interface ServerMeditation extends MeditationFields {
  id: number;
  date: string;
  place: MeditationPlace;
  createdAt: string;
  updatedAt: string;
  lanternId: number | null;
}

const fromServer = (m: ServerMeditation): MeditationEntry => ({ ...m, id: String(m.id) });

/** The signed-in account's book, kept on the server. */
export class ServerWordBookStore implements WordBookStore {
  readonly kind = 'server' as const;

  private async book() {
    return api<{
      pages: { date: string; word: WordPassage; meditations: ServerMeditation[] }[];
      saved: SavedLantern[];
    }>('GET', '/api/wordbook');
  }

  async listPages(): Promise<WordBookPage[]> {
    return (await this.book()).pages.map((p) => ({ date: p.date, word: p.word, meditations: p.meditations.map(fromServer) }));
  }

  async getPage(date: string): Promise<WordBookPage | null> {
    return (await this.listPages()).find((p) => p.date === date) ?? null;
  }

  async saveWord(word: WordPassage): Promise<void> {
    // The server stores its own copy of the verse for that date.
    await api('PUT', `/api/wordbook/pages/${encodeURIComponent(word.date)}`);
  }

  async addMeditation(word: WordPassage, entry: Omit<MeditationEntry, 'id' | 'createdAt'>): Promise<MeditationEntry> {
    const m = await api<ServerMeditation>('POST', '/api/wordbook/meditations', {
      date: word.date,
      place: entry.place,
      meditation: entry.meditation,
      feeling: entry.feeling,
      application: entry.application,
    });
    return fromServer(m);
  }

  async updateMeditation(id: string, fields: MeditationFields): Promise<MeditationEntry> {
    return fromServer(await api<ServerMeditation>('PATCH', `/api/wordbook/meditations/${encodeURIComponent(id)}`, fields));
  }

  async deleteMeditation(id: string): Promise<void> {
    await api('DELETE', `/api/wordbook/meditations/${encodeURIComponent(id)}`);
  }

  async listSaved(): Promise<SavedLantern[]> {
    return (await this.book()).saved;
  }

  async removeSaved(lanternId: number): Promise<void> {
    await api('DELETE', `/api/wordbook/saved/${lanternId}`);
  }

  /** Import the M3 local book once; duplicates are ignored server-side. */
  async importLocal(pages: WordBookPage[]): Promise<{ pagesAdded: number; meditationsAdded: number }> {
    return api('POST', '/api/wordbook/import', {
      pages: pages.map((p) => ({ date: p.date, meditations: p.meditations })),
    });
  }

  isLetterOpened = letterOpened;
  markLetterOpened = markLetter;
}

/** Guests can read today's word but nothing is kept. */
export class GuestWordBookStore implements WordBookStore {
  readonly kind = 'guest' as const;
  async listPages(): Promise<WordBookPage[]> {
    return [];
  }
  async getPage(): Promise<WordBookPage | null> {
    return null;
  }
  async saveWord(): Promise<void> {
    /* not kept for guests */
  }
  async addMeditation(): Promise<MeditationEntry> {
    throw new GuestRestricted();
  }
  async updateMeditation(): Promise<MeditationEntry> {
    throw new GuestRestricted();
  }
  async deleteMeditation(): Promise<void> {
    throw new GuestRestricted();
  }
  async listSaved(): Promise<SavedLantern[]> {
    return [];
  }
  async removeSaved(): Promise<void> {
    throw new GuestRestricted();
  }
  isLetterOpened = letterOpened;
  markLetterOpened = markLetter;
}

export { ApiError };
