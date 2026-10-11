// Runs the normal Express app for MANY users on a host with no persistent disk (Vercel Functions). Each user's database lives, encrypted
// under their own key, as one file in an object store.
//
// Each request: authenticate (a signed sign-in token, verified before anything is loaded) -> load THAT user's database (a conditional
// read, so nothing downloads while it is unchanged) -> run the ordinary app on it -> if the request changed anything, save it BEFORE the
// reply is released. The save names the version it replaces, so if another instance saved first, this request's work is thrown away and
// the client gets a retryable 503 (the phone keeps the change queued and retries with the same Idempotency-Key, so it applies exactly
// once). The client is never told "saved" for something that was not.
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';
import { LlmClient } from '../ask/agent';
import { createApp } from '../app';
import { DB, openDb } from '../db';
import { decrypt, encrypt } from '../engine/crypto';
import { createLockout } from '../lockout';
import { Logger, quietLogger } from '../log';
import * as svc from '../service';
import { Authenticate, keyFor, tokenAuth } from './auth';
import { ConflictError, Store } from './store';

const KEEP_OPS = 300; // remembered Idempotency-Keys per user: enough for any realistic offline queue
const MAX_WARM_USERS = 8; // databases kept in memory per instance
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

export interface CloudConfig {
  authenticate: Authenticate;
  storeFor(userId: string): Store;
  keyFor(userId: string): string;
  log?: Logger; llm?: LlmClient | null; trustProxy?: number; today?: () => string;
}
/** Everything belongs to one owner who holds one shared token: the simple mode (and what the older tests use). */
export const singleOwner = (o: { store: Store; dataKey: string; token: string }): Pick<CloudConfig, 'authenticate' | 'storeFor' | 'keyFor'> =>
  ({ authenticate: tokenAuth(o.token), storeFor: () => o.store, keyFor: () => o.dataKey });
/** Many users, each signed in with a Supabase token, each with their own file and their own key (derived from the master key). */
export const perUser = (o: { authenticate: Authenticate; storeFor(userId: string): Store; masterKey: string }): Pick<CloudConfig, 'authenticate' | 'storeFor' | 'keyFor'> =>
  ({ authenticate: o.authenticate, storeFor: o.storeFor, keyFor: (u) => keyFor(o.masterKey, u) });

type Cache = { db: DatabaseSync; version: string; hash: string };
const why = (e: unknown) => `${(e as Error)?.name ?? 'Error'}: ${String((e as Error)?.message ?? e).slice(0, 200)}`; // what went wrong, never any data
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const pathOf = (req: IncomingMessage) => (req.url ?? '').split('?')[0];
const clientOf = (req: IncomingMessage) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '?';

export function createCloudHandler(cfg: CloudConfig) {
  const log = cfg.log ?? quietLogger;
  let current: DatabaseSync | null = null;
  // The app is built once, over a database handle that always points at whichever user's copy this request is using.
  const db = { prepare: (s: string) => current!.prepare(s), exec: (s: string) => current!.exec(s) } as unknown as DB;
  const app = createApp(db, { log, llm: cfg.llm, trustProxy: cfg.trustProxy, publicHealth: true, today: cfg.today }); // no token of its own: this handler is the gate

  const caches = new Map<string, Cache>(); // most recently used last
  const archived = new Map<string, string>();
  const drop = (user: string) => { try { caches.get(user)?.db.close(); } catch { /* already closed */ } caches.delete(user); };
  const remember = (user: string, c: Cache) => {
    caches.delete(user); caches.set(user, c);
    while (caches.size > MAX_WARM_USERS) drop(caches.keys().next().value as string);
    return c;
  };

  async function refresh(user: string, depth = 0): Promise<Cache> {
    const store = cfg.storeFor(user), key = cfg.keyFor(user), had = caches.get(user);
    const r = await store.load(had?.version ?? null);
    if (r && 'unchanged' in r) return remember(user, had!); // (only ever answered when we sent a version, i.e. when we hold a cache)
    if (r) {
      const fresh = fromPayload(unseal(r.data, key));
      drop(user);
      return remember(user, { db: fresh, version: r.version, hash: sha(toJson(fresh)) });
    }
    // Nothing stored for this user yet: create their database and save it at once, so its identity exists for every later instance.
    const fresh = fromPayload(null), json = toJson(fresh);
    try {
      const version = await store.save(seal(json, key), null);
      drop(user);
      return remember(user, { db: fresh, version, hash: sha(json) });
    } catch (e) {
      fresh.close();
      if (e instanceof ConflictError && depth < 2) return refresh(user, depth + 1); // another instance created it first: use theirs
      throw e;
    }
  }

  async function keepSpareCopy(user: string, sealed: Buffer) { // one spare copy a day, under the weekday's name: a week of history, nothing to prune
    const store = cfg.storeFor(user), now = new Date(), day = now.toISOString().slice(0, 10);
    if (!store.archive || archived.get(user) === day) return;
    archived.set(user, day);
    try { await store.archive(DAYS[now.getUTCDay()], sealed); } catch (e) { log.warn(`spare copy failed: ${(e as Error).message}`); }
  }

  // One request at a time per instance: a request owns the in-memory database from load to save.
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(f: () => Promise<T>): Promise<T> => { const p = tail.then(f, f); tail = p.catch(() => {}); return p; };

  const refuse = (res: ServerResponse, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    res.statusCode = status;
    for (const [k, v] of Object.entries({ 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })) res.setHeader(k, v);
    res.end(JSON.stringify(body));
  };

  const serveUser = (user: string, req: IncomingMessage, res: ServerResponse): Promise<void> => exclusive(async () => {
    const realEnd = res.end.bind(res) as (...a: unknown[]) => unknown;
    const t0 = Date.now(); let tLoad = 0, tApp = 0, tSave = 0;
    const timing = () => res.setHeader('Server-Timing', `load;dur=${tLoad}, app;dur=${tApp}, save;dur=${tSave}`); // where the time went
    const reply = (status: number, error: string, code: string, detail?: string) => { // replaces whatever the app was about to send
      for (const h of ['content-length', 'etag', 'content-type']) res.removeHeader(h);
      res.statusCode = status; res.setHeader('content-type', 'application/json'); res.setHeader('retry-after', '2');
      timing();
      realEnd(JSON.stringify({ error, code, ...(detail ? { detail } : {}) }));
    };

    let c: Cache;
    try { c = await refresh(user); } catch (e) { drop(user); log.error('data store unreachable (load)', e); return reply(503, 'The data store is not reachable right now. Try again in a moment.', 'storage', why(e)); }
    current = c.db; tLoad = Date.now() - t0;

    // Let the app run, but hold its reply (headers are only written when end() is called) until we know the change is safely stored.
    const held = await new Promise<unknown[]>((resolve) => {
      (res as unknown as { end: unknown }).end = (...args: unknown[]) => { resolve(args); return res; };
      app(req as never, res as never);
    });
    tApp = Date.now() - t0 - tLoad;

    if (res.statusCode >= 500) { drop(user); timing(); return void realEnd(...held); } // an unexpected failure: don't trust the in-memory copy any more
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '')) {
      const json = toJson(c.db), hash = sha(json);
      if (hash !== c.hash) {
        const s0 = Date.now(), sealed = seal(json, cfg.keyFor(user));
        try { c.version = await cfg.storeFor(user).save(sealed, c.version); c.hash = hash; tSave = Date.now() - s0; await keepSpareCopy(user, sealed); }
        catch (e) {
          drop(user);
          if (e instanceof ConflictError) { log.warn('save conflict: another instance saved first; the client will retry'); return reply(503, 'Another device was saving at the same moment. Try again.', 'conflict', why(e)); }
          log.error('data store unreachable (save)', e);
          return reply(503, 'Could not save to the data store. Nothing was changed; try again.', 'storage', why(e));
        }
      }
    }
    timing();
    realEnd(...held);
  });

  const lockout = createLockout();
  const serve = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const who = clientOf(req), wait = lockout.retryAfter(who);
    if (wait) return refuse(res, 429, { error: 'Too many failed sign-in attempts. Wait a minute and try again.', code: 'locked' }, { 'retry-after': String(wait) });
    const principal = await cfg.authenticate(req).catch(() => null);
    if (!principal || 'denied' in principal) {
      if (lockout.fail(who)) log.warn(`locked out ${who} for 60s after repeated failed sign-ins`);
      if (principal) log.warn(`sign-in refused: ${principal.denied}`);
      return refuse(res, 401, { error: 'unauthorised', code: 'auth', ...(principal ? { detail: principal.denied } : {}) });
    }
    lockout.ok(who);
    return serveUser(principal.userId, req, res);
  };

  return (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // "Is the process alive?" and CORS preflights need no sign-in and no database, so they skip both (a hosting platform probes health).
    if ((req.method === 'GET' && pathOf(req) === '/api/health') || req.method === 'OPTIONS') { app(req as never, res as never); return Promise.resolve(); }
    return serve(req, res);
  };
}
