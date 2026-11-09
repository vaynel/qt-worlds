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
];

export function openDb(path = defaultDbPath()): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 3000');
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
