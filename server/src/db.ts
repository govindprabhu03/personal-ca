// The server's database: Node's built-in node:sqlite (zero native build on Windows). The schema itself lives in shared/core/schema.ts
// because the phone builds the very same tables.
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../../shared/core/schema';

export type { DB } from '../../shared/core/schema';
export { wipe } from '../../shared/core/schema';

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  initSchema(db);
  db.exec("DELETE FROM sync_ops WHERE at < datetime('now', '-30 days')"); // a phone offline for over a month is not replaying old keys
  return db;
}
