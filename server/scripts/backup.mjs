// Online backup of the SQLite DB (safe while the server is running), then pruning.
//   node scripts/backup.mjs            -> data/backups/worlds-YYYYMMDD-HHMMSS.db
//   WORLDS_DB=/path/to.db node scripts/backup.mjs
//   BACKUP_KEEP=14 (default): keep only the newest N backups; older ones are deleted.
// Deleted accounts and content therefore disappear from backups once N newer
// backups exist (about 14 days with one backup a day; see the 개인정보처리방침).
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_KEEP = 14;
const NAME = /^worlds-\d{8}-\d{6}\.db$/;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = process.env.WORLDS_DB ?? resolve(root, 'data/worlds.db');
if (!existsSync(src)) {
  console.error(`no database at ${src}`);
  process.exit(1);
}
const keepRaw = Number(process.env.BACKUP_KEEP ?? DEFAULT_KEEP);
const keep = Number.isInteger(keepRaw) && keepRaw >= 1 ? keepRaw : DEFAULT_KEEP;
if (process.env.BACKUP_KEEP !== undefined && keep !== keepRaw) console.warn(`BACKUP_KEEP=${process.env.BACKUP_KEEP} is not a whole number >= 1: using ${keep}`);

// Backups go next to the database (data/backups locally, /data/backups in Docker).
const dir = resolve(dirname(src), 'backups');
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const dest = resolve(dir, `worlds-${stamp}.db`);
const db = new Database(src, { readonly: true });
await db.backup(dest);
db.close();
console.log(`backup written: ${dest}`);

// Prune: only our own file names (the timestamp sorts chronologically); newest first.
const backups = readdirSync(dir).filter((f) => NAME.test(f)).sort().reverse();
const old = backups.slice(keep);
for (const f of old) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(resolve(dir, f + suffix), { force: true });
}
console.log(`backups kept: ${Math.min(backups.length, keep)} (BACKUP_KEEP=${keep}), deleted: ${old.length}`);
