// Web preview only: real SQLite compiled to WebAssembly (sql.js), loaded from a CDN when the app starts, so the browser preview
// runs the exact same on-device-database flow as a phone. Phones use expo-sqlite (localdb.ts). The preview needs internet for this one file.
import type { DB } from '../../shared/core/schema';

const CDN = 'https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/';
const g = globalThis as any;

const loadScript = (src: string) => new Promise<void>((resolve, reject) => {
  const el = g.document.createElement('script');
  el.src = src; el.onload = () => resolve();
  el.onerror = () => reject(new Error('Could not load the on-device database engine (sql.js). The web preview needs internet for this.'));
  g.document.head.appendChild(el);
});

export async function openDriver(): Promise<DB> {
  // our own copy first (works offline, and is what the Windows .exe serves), the CDN only as a fallback
  let base = '/sqljs/';
  if (!g.initSqlJs) {
    try { await loadScript(`${base}sql-wasm.js`); } catch { base = CDN; await loadScript(`${base}sql-wasm.js`); }
  }
  const SQL = await g.initSqlJs({ locateFile: (f: string) => base + f });
  const db = new SQL.Database();
  const clean = (p: unknown[]) => p.map((v) => (v === undefined ? null : v));
  const rows = (sql: string, p: unknown[]): any[] => {
    const st = db.prepare(sql);
    try { st.bind(clean(p)); const out: any[] = []; while (st.step()) out.push(st.getAsObject()); return out; } finally { st.free(); }
  };
  return {
    exec: (sql) => { db.exec(sql); },
    prepare: (sql) => ({
      all: (...p) => rows(sql, p),
      get: (...p) => rows(sql, p)[0],
      run: (...p) => { db.run(sql, clean(p)); return { changes: db.getRowsModified(), lastInsertRowid: db.exec('SELECT last_insert_rowid()')[0].values[0][0] as number }; },
    }),
  };
}
