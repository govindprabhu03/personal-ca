// Local-first sync. The phone owns a real database (same schema, same service code as the server); the server is its replica of record.
//
//   READ    straight from the on-device database: instant, always works, every number is recomputed on the phone.
//   WRITE   (1) applied to the on-device database immediately via the same function the server runs, so safe-to-spend, flags,
//           reports and everything else update at once; (2) queued in an OUTBOX and sent to the server with a unique
//           Idempotency-Key, in order, as soon as it can be reached. A retry can never double-apply.
//   REFRESH once the server has received everything, the phone downloads a snapshot and replaces its own copy (so rows get their
//           real server ids and other devices' changes arrive). Never while changes are still waiting: nothing is ever overwritten
//           that the server hasn't seen.
//   NEEDS THE SERVER  import, backup, restore, erase, Ask your CA: run on the server first, then refresh.
//   REJECTED  if the server refuses a replayed change (4xx) it moves to a visible list; the next refresh makes the phone agree.
//
// Plain TypeScript with the database, storage and network injected, so this exact code is tested against the real server.
import { COMMANDS, CommandName } from './commands';
import { DB, wipe } from './core/schema';
import { exportTables, importTables } from './core/service';
import type { KV } from './kv';

export type { KV } from './kv';
export interface Op { id: string; cmd: CommandName; args: unknown; at: string; label: string }
export interface Rejected { op: Op; error: string }
/** authFailed: the server is reachable but refuses this app's access token. Nothing is dropped; changes wait until the token is fixed. */
export interface SyncSnapshot { online: boolean; syncing: boolean; pending: Op[]; rejected: Rejected[]; lastSync: string | null; dataVersion: number; authFailed: boolean }

export class ApiError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
export class OfflineError extends Error { constructor(message = "You're offline. This one needs a connection.") { super(message); } }
class NetworkError extends Error {}

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ status: number; ok: boolean; headers: { get(name: string): string | null }; text(): Promise<string> }>;
export interface SyncConfig { base: string; token?: string; kv: KV; fetch: FetchFn; uuid: () => string; now: () => string; db: DB; timeoutMs?: number }

export function createSync(cfg: SyncConfig) {
  const db = cfg.db, timeoutMs = cfg.timeoutMs ?? 8000;
  let base = cfg.base, token = cfg.token; // changeable at runtime: an installed APK learns its server address from the user
  let online = true, syncing = false, lastSync: string | null = null, dataVersion = 0, needPull = true, authFailed = false;
  let pending: SyncSnapshot['pending'] = [], rejected: Rejected[] = [];
  let snap: SyncSnapshot = { online, syncing, pending, rejected, lastSync, dataVersion, authFailed };
  const subs = new Set<() => void>();
  let flushing: Promise<void> | null = null;

  const emit = () => { snap = { online, syncing, pending: [...pending], rejected: [...rejected], lastSync, dataVersion, authFailed }; subs.forEach((f) => f()); };
  const setOnline = (v: boolean) => { if (v !== online) { online = v; emit(); } };
  const setAuth = (v: boolean) => { if (v !== authFailed) { authFailed = v; emit(); } };
  /** 401/403 = "I can't tell who you are": a configuration problem, never a verdict on the change itself. */
  const isAuth = (status: number) => status === 401 || status === 403;
  /** The database copy and the outbox are saved together in ONE value, so after a crash they always agree. */
  const persist = () => cfg.kv.set('state', JSON.stringify({ tables: exportTables(db), pending, rejected, lastSync }));

  // Local writes and refreshes take turns, so a refresh can never land in the middle of a write.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => { const p = chain.then(f); chain = p.catch(() => {}); return p; };

  async function net(method: string, path: string, body?: unknown, key?: string) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      if (!base) throw new Error('no server address set yet'); // becomes a NetworkError below: the app simply works offline
      const res = await cfg.fetch(`${base}/api${path}`, {
        method, signal: ctl.signal,
        headers: { 'content-type': 'application/json', ...(token ? { 'x-api-key': token } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, ok: res.ok, json: (res.headers.get('content-type') ?? '').includes('json'), text: await res.text() };
    } catch { throw new NetworkError(); } finally { clearTimeout(timer); }
  }
  const parse = (r: { json: boolean; text: string }) => (!r.text ? undefined : r.json ? JSON.parse(r.text) : r.text);
  const fail = (r: { status: number; text: string }): ApiError => {
    let e: any = {};
    try { e = JSON.parse(r.text); } catch { /* not JSON */ }
    if (isAuth(r.status)) return new ApiError(r.status, "The server didn't accept this app's access token. Check that EXPO_PUBLIC_API_TOKEN matches the server's CA_API_TOKEN, then restart Expo.", 'auth');
    return new ApiError(r.status, e.details?.join(', ') ?? e.error ?? `HTTP ${r.status}`, e.code);
  };

  /** A local-first action: applied to the on-device database now, queued for the server. Throws (and queues nothing) if the phone can't apply it. */
  function run<T = unknown>(cmd: CommandName, args: unknown): Promise<T> {
    return serial(async () => {
      const def = COMMANDS[cmd] as { local?: (db: DB, a: unknown) => unknown; label: (a: unknown) => string };
      if (!def.local) throw new Error(`${cmd} needs the server: use remote()`);
      const result = def.local(db, args);
      pending = [...pending, { id: cfg.uuid(), cmd, args, at: cfg.now(), label: def.label(args) }];
      dataVersion++;
      await persist();
      emit();
      if (online) void flush(); // we believe the server is reachable: send it off the caller's path
      return result as T;
    });
  }

  /** An action only the server can do. Offline = a clear error. On success the phone refreshes its own copy. */
  async function remote<T = unknown>(cmd: CommandName, args: unknown): Promise<T> {
    const def = COMMANDS[cmd] as { http: (a: unknown) => { method: string; path: string; body?: unknown }; pull?: boolean; destructive?: boolean };
    if (def.destructive || def.pull) { await flush(); if (pending.length) throw new OfflineError('Your earlier changes are still waiting to sync. Try again once they have.'); }
    const h = def.http(args);
    let r;
    try { r = await net(h.method, h.path, h.body, cfg.uuid()); } catch { setOnline(false); throw new OfflineError(); }
    setOnline(true);
    if (isAuth(r.status)) setAuth(true);
    if (!r.ok) throw fail(r);
    setAuth(false);
    const data = parse(r) as T;
    if (def.pull) { needPull = true; await pull(); }
    return data;
  }

  /** Send the outbox in order. Stops (to retry later) on network trouble or a 5xx; a 4xx moves that one change to `rejected`. */
  function flush(): Promise<void> {
    if (flushing) return flushing;
    if (!pending.length) return Promise.resolve();
    flushing = (async () => {
      syncing = true; emit();
      try {
        while (pending.length) {
          const op = pending[0], h = (COMMANDS[op.cmd] as { http: (a: unknown) => { method: string; path: string; body?: unknown } }).http(op.args);
          let r;
          try { r = await net(h.method, h.path, h.body, op.id); } catch { setOnline(false); break; }
          setOnline(true);
          if (isAuth(r.status)) { setAuth(true); break; } // wrong/missing token: keep EVERYTHING queued, retry once it is fixed
          if (r.status >= 500) break;
          setAuth(false);
          pending = pending.slice(1);
          if (!r.ok) rejected = [...rejected, { op, error: fail(r).message }];
          lastSync = cfg.now();
          needPull = true;
          await persist();
          emit();
        }
      } finally { syncing = false; flushing = null; emit(); }
    })();
    return flushing;
  }

  /** Replace the on-device copy with the server's snapshot. Skipped while anything is still waiting to be sent. */
  function pull(): Promise<boolean> {
    return serial(async () => {
      if (pending.length) return false;
      let r;
      try { r = await net('GET', '/snapshot'); } catch { setOnline(false); return false; }
      setOnline(true);
      if (isAuth(r.status)) { setAuth(true); return false; }
      if (!r.ok) return false;
      setAuth(false);
      importTables(db, JSON.parse(r.text));
      needPull = false; dataVersion++; lastSync = cfg.now();
      await persist();
      emit();
      return true;
    });
  }

  /** Cheap reachability check. If the server answers: send anything waiting, then refresh. */
  async function ping(): Promise<boolean> {
    try {
      await net('GET', '/health');
      setOnline(true);
      await flush();
      if (needPull && !pending.length) await pull();
    } catch { setOnline(false); }
    return online;
  }
  /** Ask for a refresh on the next ping (app start, coming to the foreground, the "Sync now" button). */
  const requestPull = () => { needPull = true; };

  async function init() {
    try {
      const s = JSON.parse((await cfg.kv.get('state')) ?? 'null');
      if (s) { if (s.tables) importTables(db, s.tables); pending = s.pending ?? []; rejected = s.rejected ?? []; lastSync = s.lastSync ?? null; }
    } catch { /* unreadable local state: start from the freshly seeded database and let the server refill it */ }
    needPull = true; dataVersion++;
    emit();
  }

  /** Forget everything on the phone and start from a clean seeded database. */
  async function clearAll() {
    wipe(db);
    pending = []; rejected = []; lastSync = null; needPull = true; dataVersion++;
    await cfg.kv.del('state');
    emit();
  }
  const dismissRejected = (opId: string) => { rejected = rejected.filter((r) => r.op.id !== opId); persist().catch(() => {}); emit(); };

  /** Point the app at a (new) server. Anything queued waits for it; the next ping refreshes from it. */
  function setServer(s: { base: string; token?: string }) {
    base = s.base; token = s.token || undefined;
    authFailed = false; needPull = true;
    emit();
  }
  const getServer = () => ({ base, token });

  return {
    db, run, remote, flush, pull, ping, init, clearAll, dismissRejected, requestPull, setServer, getServer,
    getSnapshot: () => snap,
    subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
  };
}
export type Sync = ReturnType<typeof createSync>;
