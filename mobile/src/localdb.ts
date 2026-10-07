// The phone's SQLite (native). An in-memory database: fast, and persisted by the sync core as an ENCRYPTED snapshot, which keeps
// AES-256-GCM protection without needing a SQLCipher build (so it also works in Expo Go). The web preview has its own driver (localdb.web.ts).
import * as SQLite from 'expo-sqlite';
import type { DB } from '../../shared/core/schema';

export async function openDriver(): Promise<DB> {
  const db = SQLite.openDatabaseSync(':memory:');
  return {
    exec: (sql) => db.execSync(sql),
    prepare: (sql) => ({
      all: (...p) => db.getAllSync<any>(sql, p as any),
      get: (...p) => db.getFirstSync<any>(sql, p as any) ?? undefined, // expo returns null for "no row", node:sqlite undefined
      run: (...p) => { const r = db.runSync(sql, p as any); return { changes: r.changes, lastInsertRowid: r.lastInsertRowId }; },
    }),
  };
}
