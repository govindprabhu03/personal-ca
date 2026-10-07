// The phone's database: the same schema and the same service code as the server, running on an on-device SQLite.
// Rows created on the phone get ids from a high range, so they can never be mistaken for (or collide with) server ids.
// After a sync they are replaced by the server's own rows.
import { DB, initSchema } from './schema';

export const LOCAL_ID_BASE = 4_000_000_000_000_000; // below 2^53 (9.007e15), so still exact in JS and SQLite
/** True for a row that only exists on this phone so far. Such rows are shown, but not editable until they sync. */
export const isLocalId = (id: number | null | undefined): boolean => typeof id === 'number' && id >= LOCAL_ID_BASE;

let counter = 0;
export const nextLocalId = () => LOCAL_ID_BASE + Date.now() * 100 + (counter++ % 100);

// INSERTs that rely on the database to pick the id (the service never names it) get a local id injected.
// An INSERT that already names `id` (snapshot import) is left alone.
const NEEDS_ID = /^\s*INSERT\s+INTO\s+(accounts|income|transactions|goals|wishlist|bills|iou_entries)\s*\(\s*(?!id\b)/i;

export function withLocalIds(inner: DB, newId: () => number = nextLocalId): DB {
  return {
    exec: (sql) => inner.exec(sql),
    prepare(sql) {
      if (!NEEDS_ID.test(sql)) return inner.prepare(sql);
      const st = inner.prepare(sql.replace('(', '(id, ').replace(/VALUES\s*\(/i, 'VALUES (?, '));
      return { all: (...p) => st.all(newId(), ...p), get: (...p) => st.get(newId(), ...p), run: (...p) => st.run(newId(), ...p) };
    },
  };
}

/** Create the tables, seed the defaults, and return the id-aware database. `driver` is node:sqlite, expo-sqlite or sql.js behind the tiny DB interface. */
export function initLocalDb(driver: DB): DB {
  driver.exec('PRAGMA foreign_keys = ON');
  initSchema(driver);
  return withLocalIds(driver);
}
