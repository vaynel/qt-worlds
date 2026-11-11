import * as THREE from 'three';
import type { WordPassage } from '../../../shared/protocol';
import type { AudioEngine } from '../audio/AudioEngine';
import type { PlayerController } from '../entities/PlayerController';
import type { MeditationPlace, WordBookStore } from '../storage/WordBook';
import { Modal } from '../ui/dom';
import type { Hud } from '../ui/Hud';
import { MeditationView } from '../ui/MeditationView';
import { WordBookView, type BookTab } from '../ui/WordBookView';
import { WordCard } from '../ui/WordCard';
import { Letter } from '../world/Letter';

export type LetterState = 'none' | 'pending' | 'flying' | 'waiting' | 'opened';

export interface DevotionOptions {
  scene: THREE.Scene;
  camera: THREE.Camera;
  player: PlayerController;
  hud: Hud;
  audio: AudioEngine;
  store: WordBookStore;
  /** Where the player could meditate right now, or null. */
  meditationPlace: () => MeditationPlace | null;
  cameraYaw: () => number;
  now: () => number;
  needLogin: (reason: string) => void;
  lanternsChanged: () => void;
}

/**
 * Today's word: the letter that flies in once a day, the opened page, the
 * word book and the meditation flow. All persistence goes through the
 * WordBookStore interface.
 */
export class Devotion {
  word: WordPassage | null = null;
  letterState: LetterState = 'none';
  private letter: Letter | null = null;
  private readonly card = new WordCard();
  private readonly book: WordBookView;
  private readonly meditation: MeditationView;
  private readonly target = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private lastSaved: MeditationPlace | null = null;
  /** The meditation sheet was opened from 말씀 → 오늘: go back there after saving. */
  private backToBook = false;

  constructor(private readonly o: DevotionOptions) {
    this.book = new WordBookView(o.store, {
      needLogin: o.needLogin,
      lanternsChanged: o.lanternsChanged,
      word: () => this.word,
      meditate: () => this.meditateToday(true),
    });
    this.meditation = new MeditationView(o.store, o.needLogin);
    this.meditation.onSaved((place) => {
      this.lastSaved = place;
      o.hud.toast(`${place}에서의 묵상을 말씀 책에 담았어요.`, o.now(), 4);
      if (this.backToBook) void this.openBook('today');
      this.backToBook = false;
    });
  }

  /** New word from the server (on join, reconnect or at 00:00 KST). */
  async setWord(word: WordPassage) {
    if (this.word?.date === word.date && this.word.ref === word.ref) return;
    this.word = word;
    this.clearLetter();
    const opened = await this.o.store.isLetterOpened(word.date);
    this.letterState = opened ? 'opened' : 'pending';
    this.o.hud.setWordNew(!opened);
  }

  private clearLetter() {
    this.letter?.dispose();
    this.letter = null;
    this.o.hud.setLetter(false);
  }

  /** allowLetter: false while indoors or busy; the letter waits until outside. */
  update(dt: number, elapsed: number, allowLetter: boolean) {
    if (this.letterState === 'pending' && allowLetter && !Modal.anyOpen) {
      const p = this.o.player.position;
      const yaw = this.o.cameraYaw();
      const from = new THREE.Vector3(p.x - Math.sin(yaw) * 10, p.y + 26, p.z - Math.cos(yaw) * 10);
      this.letter = new Letter(from);
      this.o.scene.add(this.letter.group);
      this.letterState = 'flying';
      this.o.audio.chime();
    }
    if (!this.letter) return;
    if (!allowLetter) {
      this.letter.group.visible = false;
      this.o.hud.setLetter(false);
      return;
    }
    this.letter.group.visible = true;
    // Rest in front of the player, slightly to the right of the view.
    const p = this.o.player.position;
    const yaw = this.o.cameraYaw();
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    this.target.set(p.x + fx * 2.4 + fz * -0.9, p.y + 1.7, p.z + fz * 2.4 + fx * 0.9);
    this.letter.update(dt, elapsed, this.target);
    if (this.letter.state === 'waiting' && this.letterState === 'flying') this.letterState = 'waiting';
    this.o.hud.setLetter(this.letterState === 'waiting' && !Modal.anyOpen);
  }

  /** Canvas tap at client coords; true if it opened the letter. */
  tap(clientX: number, clientY: number, canvas: HTMLCanvasElement): boolean {
    if (!this.letter) return false;
    const rect = canvas.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.o.camera);
    if (this.raycaster.intersectObject(this.letter.hitTarget, false).length === 0) return false;
    void this.openLetter();
    return true;
  }

  async openLetter() {
    if (!this.word || !this.letter) return;
    this.clearLetter();
    this.letterState = 'opened';
    this.o.hud.setWordNew(false);
    await this.o.store.markLetterOpened(this.word.date);
    await this.o.store.saveWord(this.word);
    this.o.audio.page();
    this.card.open(this.word, {
      meditate: () => this.meditateToday(false),
      openBook: () => void this.openBook('today'),
    });
  }

  /**
   * HUD 말씀: 📖 나의 말씀 책 on the 오늘 tab. A letter that has not been
   * opened yet counts as read (the envelope only plays when the letter itself is opened).
   */
  async openWord() {
    if (this.word && this.letterState !== 'opened') {
      this.clearLetter();
      this.letterState = 'opened';
      this.o.hud.setWordNew(false);
      await this.o.store.markLetterOpened(this.word.date);
    }
    if (this.word) await this.o.store.saveWord(this.word);
    this.o.audio.page();
    await this.openBook('today');
  }

  async openBook(tab: BookTab = 'today') {
    await this.book.open(tab, this.word?.date);
  }

  /**
   * ✍️ 묵상하기 from today's word (letter page or 말씀 → 오늘): works anywhere.
   * The place follows where I am (골방 / 기도의 뜰 mat), otherwise 골방.
   */
  meditateToday(fromBook: boolean) {
    if (!this.word) {
      this.o.hud.toast('오늘의 말씀이 도착하면 묵상할 수 있어요.', this.o.now());
      return;
    }
    this.backToBook = fromBook;
    void this.o.store.saveWord(this.word);
    this.meditation.open(this.word, this.o.meditationPlace() ?? '골방');
  }

  meditate() {
    const place = this.o.meditationPlace();
    if (!this.word) {
      this.o.hud.toast('오늘의 말씀이 도착하면 묵상할 수 있어요.', this.o.now());
      return;
    }
    if (!place) {
      this.o.hud.toast('골방이나 기도의 뜰 자리에 앉으면 묵상할 수 있어요.', this.o.now());
      return;
    }
    this.backToBook = false;
    void this.o.store.saveWord(this.word);
    this.meditation.open(this.word, place);
  }

  /** The 말씀 책 tab while it is open (tests). */
  get bookTab(): BookTab | null {
    return this.book.currentTab;
  }

  describe() {
    return {
      word: this.word ? { date: this.word.date, ref: this.word.ref, text: this.word.text, before: this.word.before.length, after: this.word.after.length } : null,
      letter: this.letterState,
      modal: Modal.current?.name ?? null,
      lastSaved: this.lastSaved,
    };
  }
}
