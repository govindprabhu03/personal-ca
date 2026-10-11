// The server's database: Node's built-in node:sqlite (zero native build on Windows). The schema itself lives in shared/core/schema.ts
// because the phone builds the very same tables.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../../shared/core/schema';
import { todayStr } from './engine/dates';

export type { DB } from '../../shared/core/schema';
export { wipe } from '../../shared/core/schema';

/**
 * Schema versioning (PRAGMA user_version). A file with no version is the original schema (version 1).
 * To change a table later: append ONE function to MIGRATIONS (it upgrades from version n+1 to n+2). initSchema() keeps creating the
 * latest shape for brand-new files, so a migration only has to transform OLD files. The file is copied aside before it runs.
 */
export const MIGRATIONS: Array<(db: DatabaseSync) => void> = [];
export const SCHEMA_VERSION = 1 + MIGRATIONS.length;

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** A consistent copy of a live database (safe while the server is running, WAL included). Refuses to overwrite. */
export function copyDb(db: DatabaseSync, to: string) {
  if (existsSync(to)) return false;
  db.exec(`VACUUM INTO ${sqlString(to)}`);
  return true;
}

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  const hasTables = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'transactions'").get();
  // no stamp + tables = a file from before versioning (v1); no stamp + no tables = brand new, created in the latest shape below
  const found = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version || (hasTables ? 1 : SCHEMA_VERSION);
  if (found > SCHEMA_VERSION) {
    db.close();
    throw new Error(`This data file was made by a newer Personal CA (data version ${found}; this program understands up to ${SCHEMA_VERSION}). Update the program instead of opening it with this older one.`);
  }
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  if (found < SCHEMA_VERSION && file !== ':memory:') copyDb(db, `${file}.before-v${SCHEMA_VERSION}.bak`);
  initSchema(db);
  // This database's identity: a phone remembers it, so it can tell "my server" from a new, reset or different one (and never overwrite its data from the latter).
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('server_id', ${sqlString(randomUUID())})`);
  for (let v = found; v < SCHEMA_VERSION; v++) MIGRATIONS[v - 1](db);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  db.exec("DELETE FROM sync_ops WHERE at < datetime('now', '-30 days')"); // a phone offline for over a month is not replaying old keys
  return db;
}

/** One dated copy per day in `dir` (ca-2026-10-11.db); the newest `keep` are kept. Returns the file written, or null if today's exists. */
export function dailyBackup(db: DatabaseSync, dir: string, keep = 14, today = todayStr()): string | null {
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `ca-${today}.db`);
  const made = copyDb(db, target);
  const all = readdirSync(dir).filter((f) => /^ca-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - keep))) { try { unlinkSync(path.join(dir, f)); } catch { /* in use */ } }
  return made ? target : null;
}
