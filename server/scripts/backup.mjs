// Online backup of the SQLite DB (safe while the server is running).
//   node scripts/backup.mjs            -> data/backups/worlds-YYYYMMDD-HHMMSS.db
//   WORLDS_DB=/path/to.db node scripts/backup.mjs
import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = process.env.WORLDS_DB ?? resolve(root, 'data/worlds.db');
if (!existsSync(src)) {
  console.error(`no database at ${src}`);
  process.exit(1);
}
// Backups go next to the database (data/backups locally, /data/backups in Docker).
const dir = resolve(dirname(src), 'backups');
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const dest = resolve(dir, `worlds-${stamp}.db`);
const db = new Database(src, { readonly: true });
await db.backup(dest);
db.close();
console.log(`backup written: ${dest}`);
