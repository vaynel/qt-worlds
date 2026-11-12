// Online backup of the SQLite DB (safe while the server is running), the 📸 photo
// mirror, then pruning.
//   node scripts/backup.mjs            -> data/backups/worlds-YYYYMMDD-HHMMSS.db
//                                         + data/backups/screenshots/ (photo mirror)
//   WORLDS_DB=/path/to.db node scripts/backup.mjs
//   WORLDS_SHOTS_DIR=/path/to/screenshots (default: <DB dir>/screenshots, like the server)
//   BACKUP_KEEP=14 (default): keep only the newest N backups; older ones are deleted.
// Deleted accounts and content therefore disappear from backups once N newer
// backups exist (about 14 days with one backup a day; see the 개인정보처리방침).
//
// Photos (B3): screenshot files never change after upload (random names), so
// backups/screenshots/ is ONE incremental mirror shared by all kept backups:
//   - new files are copied in (temp file + rename, so a crash never leaves half a photo);
//   - a mirrored file is removed only when it is gone from the live folder AND no
//     kept backup DB still lists it in its `screenshots` table.
// So restoring any kept backup DB together with the mirror serves every photo that
// DB knows about, and a deleted photo leaves the mirror when the last backup that
// still knew it is pruned (within BACKUP_KEEP backups). Safe to run repeatedly.
//
//   node scripts/backup.mjs --restore-photos <backup .db file>
//     copies the photos that backup DB lists from the mirror into the live photo
//     folder (only those: nothing deleted since comes back). See deploy/README.md.
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_KEEP = 14;
const NAME = /^worlds-\d{8}-\d{6}\.db$/;
/** Exactly the names ShotService writes. Nothing else in these folders is ever touched. */
const SHOT = /^[0-9a-f]{32}\.(webp|jpg)$/;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(process.env.WORLDS_DB ?? resolve(root, 'data/worlds.db'));
const shotsDir = resolve(process.env.WORLDS_SHOTS_DIR ?? resolve(dirname(src), 'screenshots'));
// Backups go next to the database (data/backups locally, /data/backups in Docker).
const dir = resolve(process.env.BACKUP_DIR ?? resolve(dirname(src), 'backups'));
const mirror = resolve(dir, 'screenshots');

/** Photo file names a database lists (empty for a DB from before L-A). */
function listedShots(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'screenshots'").get();
    if (!has) return [];
    return db
      .prepare('SELECT file FROM screenshots')
      .all()
      .map((r) => r.file)
      .filter((f) => SHOT.test(f));
  } finally {
    db.close();
  }
}

const shotFiles = (folder) => (existsSync(folder) ? readdirSync(folder).filter((f) => SHOT.test(f)) : []);

/** Copy one photo atomically (same file name, 0600). */
function copyShot(from, to) {
  const tmp = `${to}.tmp-${process.pid}`;
  copyFileSync(from, tmp);
  renameSync(tmp, to);
}

if (process.argv[2] === '--restore-photos') {
  const target = process.argv[3];
  if (!target) {
    console.error('usage: node scripts/backup.mjs --restore-photos <backup .db file>');
    process.exit(1);
  }
  const dbFile = existsSync(target) ? resolve(target) : resolve(dir, basename(target));
  if (!existsSync(dbFile)) {
    console.error(`no backup at ${target}`);
    process.exit(1);
  }
  mkdirSync(shotsDir, { recursive: true, mode: 0o700 });
  let copied = 0;
  let present = 0;
  const missing = [];
  for (const f of listedShots(dbFile)) {
    const to = resolve(shotsDir, f);
    if (existsSync(to)) {
      present++;
      continue;
    }
    const from = resolve(mirror, f);
    if (!existsSync(from)) {
      missing.push(f);
      continue;
    }
    copyShot(from, to);
    copied++;
  }
  console.log(`photos restored into ${shotsDir}: ${copied} copied, ${present} already there, ${missing.length} missing from the mirror`);
  process.exit(missing.length ? 2 : 0);
}

if (!existsSync(src)) {
  console.error(`no database at ${src}`);
  process.exit(1);
}
const keepRaw = Number(process.env.BACKUP_KEEP ?? DEFAULT_KEEP);
const keep = Number.isInteger(keepRaw) && keepRaw >= 1 ? keepRaw : DEFAULT_KEEP;
if (process.env.BACKUP_KEEP !== undefined && keep !== keepRaw) console.warn(`BACKUP_KEEP=${process.env.BACKUP_KEEP} is not a whole number >= 1: using ${keep}`);

mkdirSync(dir, { recursive: true });
// Names sort by time; a new backup always sorts after every existing one (two runs in
// the same second get the next second), so it is never the one pruned.
const fmt = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const parse = (name) => {
  const m = /^worlds-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/.exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
};
const newest = Math.max(0, ...readdirSync(dir).filter((f) => NAME.test(f)).map(parse));
const stamp = fmt(Math.max(Date.now(), newest + 1000));
const dest = resolve(dir, `worlds-${stamp}.db`);
const db = new Database(src, { readonly: true });
await db.backup(dest);
db.close();
console.log(`backup written: ${dest}`);

// Prune: only our own file names (the timestamp sorts chronologically); newest first.
const backups = readdirSync(dir).filter((f) => NAME.test(f) && f !== basename(dest)).sort().reverse();
backups.unshift(basename(dest));
const kept = backups.slice(0, keep);
const old = backups.slice(keep);
for (const f of old) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(resolve(dir, f + suffix), { force: true });
}
console.log(`backups kept: ${kept.length} (BACKUP_KEEP=${keep}), deleted: ${old.length}`);

// 📸 Photo mirror: copy what the new backup lists (and anything else live), then
// drop mirrored files no kept backup lists and the live folder no longer has.
mkdirSync(mirror, { recursive: true, mode: 0o700 });
// Leftovers of an interrupted copy.
for (const f of readdirSync(mirror)) if (/\.tmp-\d+$/.test(f)) rmSync(resolve(mirror, f), { force: true });
const live = new Set(shotFiles(shotsDir));
const mirrored = new Set(shotFiles(mirror));
let copied = 0;
let missing = 0;
for (const f of new Set([...listedShots(dest), ...live])) {
  if (mirrored.has(f)) continue;
  const from = resolve(shotsDir, f);
  if (!existsSync(from)) {
    // Deleted between the DB snapshot and now (e.g. 회원 탈퇴): nothing to keep.
    missing++;
    continue;
  }
  copyShot(from, resolve(mirror, f));
  mirrored.add(f);
  copied++;
}
const needed = new Set(live);
for (const f of kept) {
  try {
    for (const s of listedShots(resolve(dir, f))) needed.add(s);
  } catch (err) {
    // An unreadable backup: keep every photo rather than risk losing one it needs.
    console.warn(`could not read ${f} (${err.message}): keeping all mirrored photos this run`);
    for (const s of mirrored) needed.add(s);
  }
}
let removed = 0;
for (const f of mirrored) {
  if (needed.has(f)) continue;
  rmSync(resolve(mirror, f), { force: true });
  removed++;
}
let bytes = 0;
for (const f of shotFiles(mirror)) bytes += statSync(resolve(mirror, f)).size;
console.log(
  `photos mirrored in ${mirror}: ${copied} copied, ${removed} removed (no kept backup needs them), ${shotFiles(mirror).length} files (${(bytes / 1048576).toFixed(1)} MB)${missing ? `, ${missing} gone before copying` : ''}`,
);
