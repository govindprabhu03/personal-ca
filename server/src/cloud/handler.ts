// Runs the normal Express app on a database that lives, encrypted, in an object store, for hosts with no persistent disk (Vercel Functions).
//
// Each request: load the database (a conditional read, so nothing downloads while it is unchanged) -> run the ordinary app on it ->
// if the request changed anything, save it BEFORE the reply is released. The save names the version it replaces, so if another instance saved
// first, this request's work is thrown away and the client gets a retryable 503 (the phone keeps the change queued and retries with the same
// Idempotency-Key, so it is applied exactly once). The client is never told "saved" for something that was not.
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';
import { LlmClient } from '../ask/agent';
import { createApp } from '../app';
import { DB, openDb } from '../db';
import { decrypt, encrypt } from '../engine/crypto';
import { Logger, quietLogger } from '../log';
import * as svc from '../service';
import { ConflictError, Store } from './store';

const KEEP_OPS = 300; // remembered Idempotency-Keys: enough for any realistic offline queue
type Payload = { v: 1; id: string; snap: Record<string, unknown>; ops: Array<{ op_id: string; status: number; body: string; at: string }> };

const serverId = (db: DatabaseSync) => (db.prepare("SELECT value FROM meta WHERE key = 'server_id'").get() as unknown as { value: string }).value;
/** The database as plain, stable JSON (no timestamp that changes on every call), so "did this request change anything?" is a string comparison. */
function toJson(db: DatabaseSync): string {
  const { exported_at: _t, ...snap } = svc.exportTables(db) as Record<string, unknown>;
  const ops = db.prepare('SELECT op_id, status, body, at FROM sync_ops ORDER BY at DESC, op_id LIMIT ?').all(KEEP_OPS) as Payload['ops'];
  return JSON.stringify({ v: 1, id: serverId(db), snap, ops } satisfies Payload);
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** gzip, then AES-256-GCM under a key derived from `key` (the same scheme as the encrypted backups). */
const seal = (json: string, key: string) => Buffer.from(encrypt(gzipSync(json).toString('base64'), key), 'utf8');
const unseal = (data: Buffer, key: string): Payload => JSON.parse(gunzipSync(Buffer.from(decrypt(data.toString('utf8'), key), 'base64')).toString('utf8'));

function fromPayload(p: Payload | null): DatabaseSync {
  const db = openDb(':memory:');
  if (!p) return db;
  svc.importTables(db, p.snap as svc.Snapshot);
  const ins = db.prepare('INSERT OR IGNORE INTO sync_ops (op_id, status, body, at) VALUES (?, ?, ?, ?)');
  for (const o of p.ops) ins.run(o.op_id, o.status, o.body, o.at);
  db.prepare("UPDATE meta SET value = ? WHERE key = 'server_id'").run(p.id); // the identity travels with the data
  return db;
}

export interface CloudConfig { store: Store; dataKey: string; token: string; log?: Logger; llm?: LlmClient | null; trustProxy?: number; today?: () => string }
type Cache = { db: DatabaseSync; version: string; hash: string };
const why = (e: unknown) => `${(e as Error)?.name ?? 'Error'}: ${String((e as Error)?.message ?? e).slice(0, 200)}`; // what went wrong, never any data
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function createCloudHandler(cfg: CloudConfig) {
  const log = cfg.log ?? quietLogger;
  let current: DatabaseSync | null = null;
  // The app is built once, over a database handle that always points at whichever copy this request is using.
  const db = { prepare: (s: string) => current!.prepare(s), exec: (s: string) => current!.exec(s) } as unknown as DB;
  const app = createApp(db, { token: cfg.token, log, llm: cfg.llm, trustProxy: cfg.trustProxy, publicHealth: true, today: cfg.today });

  let cache: Cache | null = null, lastArchive = '';
  const drop = () => { try { cache?.db.close(); } catch { /* already closed */ } cache = null; };

  async function refresh(depth = 0): Promise<Cache> {
    const r = await cfg.store.load(cache?.version ?? null);
    if (r && 'unchanged' in r) return cache!; // (only ever answered when we sent a version, i.e. when we hold a cache)
    if (r) {
      const fresh = fromPayload(unseal(r.data, cfg.dataKey));
      drop();
      return (cache = { db: fresh, version: r.version, hash: sha(toJson(fresh)) });
    }
    // Nothing stored yet: create the database and save it at once, so its identity exists for every later instance.
    const fresh = fromPayload(null), json = toJson(fresh);
    try {
      const version = await cfg.store.save(seal(json, cfg.dataKey), null);
      drop();
      return (cache = { db: fresh, version, hash: sha(json) });
    } catch (e) {
      fresh.close();
      if (e instanceof ConflictError && depth < 2) return refresh(depth + 1); // another instance created it first: use theirs
      throw e;
    }
  }

  async function keepSpareCopy(sealed: Buffer) { // one spare copy a day, under the weekday's name: a week of history, nothing to prune
    const now = new Date(), day = now.toISOString().slice(0, 10);
    if (!cfg.store.archive || day === lastArchive) return;
    lastArchive = day;
    try { await cfg.store.archive(DAYS[now.getUTCDay()], sealed); } catch (e) { log.warn(`spare copy failed: ${(e as Error).message}`); }
  }

  // One request at a time per instance: a request owns the in-memory database from load to save.
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(f: () => Promise<T>): Promise<T> => { const p = tail.then(f, f); tail = p.catch(() => {}); return p; };

  const serve = (req: IncomingMessage, res: ServerResponse): Promise<void> => exclusive(async () => {
    const realEnd = res.end.bind(res) as (...a: unknown[]) => unknown;
    const reply = (status: number, error: string, code: string, detail?: string) => { // replaces whatever the app was about to send
      for (const h of ['content-length', 'etag', 'content-type']) res.removeHeader(h);
      res.statusCode = status; res.setHeader('content-type', 'application/json'); res.setHeader('retry-after', '2');
      realEnd(JSON.stringify({ error, code, ...(detail ? { detail } : {}) }));
    };

    let c: Cache;
    try { c = await refresh(); } catch (e) { drop(); log.error('data store unreachable (load)', e); return reply(503, 'The data store is not reachable right now. Try again in a moment.', 'storage', why(e)); }
    current = c.db;

    // Let the app run, but hold its reply (headers are only written when end() is called) until we know the change is safely stored.
    const held = await new Promise<unknown[]>((resolve) => {
      (res as unknown as { end: unknown }).end = (...args: unknown[]) => { resolve(args); return res; };
      app(req as never, res as never);
    });

    if (res.statusCode >= 500) { drop(); return void realEnd(...held); } // an unexpected failure: don't trust the in-memory copy any more
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '')) {
      const json = toJson(c.db), hash = sha(json);
      if (hash !== c.hash) {
        const sealed = seal(json, cfg.dataKey);
        try { c.version = await cfg.store.save(sealed, c.version); c.hash = hash; await keepSpareCopy(sealed); }
        catch (e) {
          drop();
          if (e instanceof ConflictError) { log.warn('save conflict: another instance saved first; the client will retry'); return reply(503, 'Another device was saving at the same moment. Try again.', 'conflict'); }
          log.error('data store unreachable (save)', e);
          return reply(503, 'Could not save to the data store. Nothing was changed; try again.', 'storage', why(e));
        }
      }
    }
    realEnd(...held);
  });

  return (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // "Is the process alive?" must not depend on storage (a hosting platform probes it), so it skips the database entirely.
    if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/api/health') { app(req as never, res as never); return Promise.resolve(); }
    return serve(req, res);
  };
}
