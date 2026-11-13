import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = Database.Database;

/** The server package directory (has package.json); works from src/ and dist/server/src/. */
export function serverRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    dir = resolve(dir, '..');
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
}

export function defaultDbPath(): string {
  return process.env.WORLDS_DB ?? resolve(serverRoot(), 'data/worlds.db');
}

/**
 * Versioned migrations. Append new entries; never edit an applied one.
 * The DB records the highest applied version in PRAGMA user_version.
 */
const MIGRATIONS: string[] = [
  // v1: accounts, sessions, word book, groups, lanterns, reactions
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    google_sub TEXT NOT NULL UNIQUE,
    email TEXT,
    email_verified INTEGER NOT NULL DEFAULT 0,
    nickname TEXT,
    nickname_key TEXT UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    persistent INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE wordbook_pages (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    word_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, date)
  );
  CREATE TABLE meditations (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    place TEXT NOT NULL,
    meditation TEXT NOT NULL DEFAULT '',
    feeling TEXT NOT NULL DEFAULT '',
    application TEXT NOT NULL DEFAULT '',
    client_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, client_id)
  );
  CREATE INDEX meditations_user_date ON meditations(user_id, date);
  CREATE TABLE groups (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE group_members (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE INDEX group_members_user ON group_members(user_id);
  CREATE TABLE lanterns (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    meditation_id INTEGER REFERENCES meditations(id) ON DELETE SET NULL,
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    slot INTEGER NOT NULL,
    date TEXT NOT NULL,
    ref TEXT NOT NULL,
    verse TEXT NOT NULL,
    translation TEXT NOT NULL,
    meditation TEXT NOT NULL,
    feeling TEXT NOT NULL,
    application TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    removed_at INTEGER
  );
  CREATE INDEX lanterns_active ON lanterns(removed_at, created_at);
  CREATE TABLE reactions (
    lantern_id INTEGER NOT NULL REFERENCES lanterns(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('amen', 'pray', 'record')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (lantern_id, user_id, type)
  );
  CREATE TABLE saved_lanterns (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lantern_id INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, lantern_id)
  );
  `,
  // v2: first-login guide shown (once per account, across devices)
  `ALTER TABLE users ADD COLUMN onboarded_at INTEGER;`,
  // v3: group text chat (kept 7 days) and per-user read pointers
  `
  CREATE TABLE group_messages (
    id INTEGER PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'msg' CHECK (kind IN ('msg', 'system')),
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER,
    hidden_at INTEGER
  );
  CREATE INDEX group_messages_group ON group_messages(group_id, id);
  CREATE INDEX group_messages_created ON group_messages(created_at);
  CREATE TABLE group_reads (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, user_id)
  );
  `,
  // v4: anonymous public lanterns (author kept internally, never sent to others)
  `ALTER TABLE lanterns ADD COLUMN anonymous INTEGER NOT NULL DEFAULT 0;`,
  // v5: Web Push (M6): device subscriptions and per-user notification preferences
  `
  CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_ok_at INTEGER
  );
  CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
  CREATE TABLE push_prefs (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    daily INTEGER NOT NULL DEFAULT 1,
    daily_time INTEGER NOT NULL DEFAULT 360,
    prayer INTEGER NOT NULL DEFAULT 1,
    last_daily_date TEXT,
    updated_at INTEGER NOT NULL
  );
  `,
  // v6: consent to 이용약관 / 개인정보처리방침 (만 14세 이상) at sign-up (M7)
  `
  ALTER TABLE users ADD COLUMN terms_agreed_at INTEGER;
  ALTER TABLE users ADD COLUMN terms_version TEXT;
  `,
  // v7: 꾸미기 (M8): appearance as validated palette indices, pixel outfits
  // (content-hashed, 3 slots, one worn), outfit reports, strikes and upload bans.
  `
  ALTER TABLE users ADD COLUMN appearance TEXT;
  ALTER TABLE users ADD COLUMN outfit_slot INTEGER;
  ALTER TABLE users ADD COLUMN outfit_strikes INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN outfit_ban_until INTEGER;
  CREATE TABLE outfits (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slot INTEGER CHECK (slot IS NULL OR (slot >= 0 AND slot < 3)),
    hash TEXT NOT NULL,
    pixels TEXT NOT NULL CHECK (length(pixels) = 256),
    created_at INTEGER NOT NULL,
    hidden_at INTEGER,
    review TEXT CHECK (review IS NULL OR review IN ('kept', 'restored')),
    reviewed_at INTEGER
  );
  CREATE UNIQUE INDEX outfits_user_slot ON outfits(user_id, slot) WHERE slot IS NOT NULL;
  CREATE TABLE outfit_reports (
    outfit_id INTEGER NOT NULL REFERENCES outfits(id) ON DELETE CASCADE,
    reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL CHECK (reason IN ('inappropriate', 'hate', 'other')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (outfit_id, reporter_id)
  );
  CREATE INDEX outfit_reports_reporter ON outfit_reports(reporter_id);
  `,
  // v8: 나눔 소품 가게 (M9): per-window stock, rentals with an idempotency key,
  // a log of every rent outcome (replays return it), per-day counts, admin
  // stock defaults, and the 소품 만료 알림 push preference.
  `
  CREATE TABLE shop_defaults (
    item TEXT PRIMARY KEY,
    stock INTEGER NOT NULL CHECK (stock >= 0 AND stock <= 99),
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE shop_stock (
    kst_date TEXT NOT NULL,
    win INTEGER NOT NULL CHECK (win >= 0 AND win < 3),
    item TEXT NOT NULL,
    total INTEGER NOT NULL CHECK (total >= 0),
    remaining INTEGER NOT NULL CHECK (remaining >= 0 AND remaining <= total),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (kst_date, win, item)
  );
  CREATE TABLE rentals (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL UNIQUE,
    item TEXT NOT NULL,
    slot TEXT NOT NULL,
    kst_date TEXT NOT NULL,
    win INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL CHECK (ends_at > started_at),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'returned', 'expired')),
    ended_at INTEGER,
    reminded_at INTEGER
  );
  CREATE UNIQUE INDEX rentals_one_item ON rentals(user_id, item) WHERE status = 'active';
  CREATE UNIQUE INDEX rentals_one_slot ON rentals(user_id, slot) WHERE status = 'active';
  CREATE INDEX rentals_active_ends ON rentals(status, ends_at);
  CREATE INDEX rentals_user ON rentals(user_id, kst_date);
  CREATE INDEX rentals_window ON rentals(kst_date, win);
  CREATE TABLE rental_days (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kst_date TEXT NOT NULL,
    count INTEGER NOT NULL CHECK (count >= 0 AND count <= 2),
    PRIMARY KEY (user_id, kst_date)
  );
  CREATE TABLE rental_requests (
    request_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item TEXT NOT NULL,
    rental_id INTEGER REFERENCES rentals(id) ON DELETE SET NULL,
    status INTEGER NOT NULL,
    error TEXT,
    message TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX rental_requests_created ON rental_requests(created_at);
  CREATE INDEX rental_requests_user ON rental_requests(user_id);
  ALTER TABLE push_prefs ADD COLUMN props INTEGER NOT NULL DEFAULT 1;
  `,
  // v9: 이야기 도서관 (L-A): 발자취 (private activity log: discrete events with a
  // stable key, and per-minute presence for time spent), in-world screenshots
  // (files on disk + rows), books (testimonies and diaries) with 공감, 책갈피,
  // unique readers, reports, one draft per user, and a writing ban.
  `
  ALTER TABLE users ADD COLUMN footprints_off INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN story_ban_until INTEGER;
  CREATE TABLE footprints (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kst_date TEXT NOT NULL,
    type TEXT NOT NULL,
    at INTEGER NOT NULL,
    key TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    UNIQUE (user_id, key)
  );
  CREATE INDEX footprints_user_date ON footprints(user_id, kst_date);
  CREATE INDEX footprints_at ON footprints(at);
  CREATE TABLE footprint_minutes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kst_date TEXT NOT NULL,
    kind TEXT NOT NULL,
    minute INTEGER NOT NULL CHECK (minute >= 0 AND minute < 1440),
    n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, kst_date, kind, minute)
  ) WITHOUT ROWID;
  CREATE TABLE screenshots (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file TEXT NOT NULL UNIQUE,
    kst_date TEXT NOT NULL,
    place TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX screenshots_user_date ON screenshots(user_id, kst_date);
  CREATE TABLE shot_days (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kst_date TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (user_id, kst_date)
  );
  CREATE TABLE stories (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('testimony', 'diary')),
    shelf TEXT NOT NULL,
    title TEXT NOT NULL,
    parts TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    ref TEXT,
    verse TEXT,
    visibility TEXT NOT NULL CHECK (visibility IN ('public', 'group', 'anonymous', 'private')),
    group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
    kst_date TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    hidden_at INTEGER,
    review TEXT CHECK (review IS NULL OR review IN ('kept', 'restored')),
    reviewed_at INTEGER
  );
  CREATE UNIQUE INDEX stories_one_diary ON stories(user_id, kst_date) WHERE kind = 'diary';
  CREATE INDEX stories_shelf ON stories(shelf, created_at);
  CREATE INDEX stories_user ON stories(user_id, created_at);
  CREATE TABLE diary_photos (
    story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    shot_id INTEGER NOT NULL REFERENCES screenshots(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    PRIMARY KEY (story_id, shot_id)
  );
  CREATE INDEX diary_photos_shot ON diary_photos(shot_id);
  CREATE TABLE story_reactions (
    story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('grace', 'same', 'pray')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (story_id, user_id, type)
  );
  CREATE TABLE story_bookmarks (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, story_id)
  );
  CREATE TABLE story_reads (
    story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (story_id, user_id)
  ) WITHOUT ROWID;
  CREATE TABLE story_reports (
    story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL CHECK (reason IN ('inappropriate', 'privacy', 'spam', 'other')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (story_id, reporter_id)
  );
  CREATE INDEX story_reports_reporter ON story_reports(reporter_id);
  CREATE TABLE story_days (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kst_date TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (user_id, kst_date)
  );
  CREATE TABLE story_drafts (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    draft TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // v10: ✉️ 답장 편지 (L-B): letters under a book and their replies in one table
  // (parent_id NULL = a letter; else a reply in that letter's thread). Deleting a
  // letter's writer or the book cascades the whole thread. Reports (3 distinct →
  // hidden), per-thread read pointers (📬 받은 편지, synced across devices),
  // 공감 push batching per book, and the new notification preferences
  // (📚 내 이야기 소식, ✉️ 새 편지, 💌 답장: default on; 📔 밤 일기 알림: default off, 21:00).
  // Diaries also keep each line's source kind and minute (the reader's timeline).
  `
  CREATE TABLE story_letters (
    id INTEGER PRIMARY KEY,
    story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES story_letters(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    anonymous INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    request_id TEXT,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER,
    hidden_at INTEGER,
    author_hidden_at INTEGER,
    review TEXT CHECK (review IS NULL OR review IN ('kept', 'restored')),
    reviewed_at INTEGER,
    UNIQUE (user_id, request_id)
  );
  CREATE INDEX story_letters_story ON story_letters(story_id, id);
  CREATE INDEX story_letters_parent ON story_letters(parent_id, id);
  CREATE INDEX story_letters_user ON story_letters(user_id, created_at);
  CREATE TABLE letter_reports (
    letter_id INTEGER NOT NULL REFERENCES story_letters(id) ON DELETE CASCADE,
    reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL CHECK (reason IN ('inappropriate', 'privacy', 'spam', 'other')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (letter_id, reporter_id)
  );
  CREATE INDEX letter_reports_reporter ON letter_reports(reporter_id);
  CREATE TABLE letter_reads (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    letter_id INTEGER NOT NULL REFERENCES story_letters(id) ON DELETE CASCADE,
    read_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, letter_id)
  ) WITHOUT ROWID;
  CREATE TABLE story_push (
    story_id INTEGER PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
    cursor_at INTEGER NOT NULL,
    last_sent_at INTEGER
  );
  ALTER TABLE stories ADD COLUMN line_meta TEXT;
  ALTER TABLE push_prefs ADD COLUMN library INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE push_prefs ADD COLUMN letters INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE push_prefs ADD COLUMN replies INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE push_prefs ADD COLUMN diary INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE push_prefs ADD COLUMN diary_time INTEGER NOT NULL DEFAULT 1260;
  ALTER TABLE push_prefs ADD COLUMN last_diary_date TEXT;
  `,
  // Library with two bookcases (🙏 하나님 이야기 = every testimony, 📔 일기 = every
  // diary): lists go by kind now. stories.shelf stays as it was (old topics kept).
  `
  CREATE INDEX IF NOT EXISTS stories_kind ON stories(kind, created_at);
  `,
  // v12 (perf audit 2026-11-13): the daily lantern limit (user_id + created_at)
  // and the hourly session sweep (expires_at) were full table scans.
  `
  CREATE INDEX IF NOT EXISTS lanterns_user ON lanterns(user_id, created_at);
  CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
  `,
];

export function openDb(path = defaultDbPath()): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  // Crash-safe under WAL (a power cut can lose only the last commits, never corrupt).
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 3000');
  // 파기: deleted rows are overwritten in the file, not just unlinked.
  db.pragma('secure_delete = ON');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
