// The on-device database + local-first sync, tested end to end: the REAL phone-side code (node:sqlite standing in for expo-sqlite)
// talking to the REAL server, over a fetch whose "network" we can cut, or make lose the reply, on demand.
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { makeCipher } from '../../mobile/src/cipher';
import { initLocalDb, isLocalId, LOCAL_ID_BASE } from '../../shared/core/localdb';
import type { DB } from '../../shared/core/schema';
import * as svc from '../../shared/core/service';
import { chunkedKv, KV } from '../../shared/kv';
import { createSync, OfflineError } from '../../shared/sync';
import type { Tx } from '../../shared/types';
import { createApp } from '../src/app';
import { openDb } from '../src/db';

const memoryKv = (): KV & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: async (k) => data.get(k) ?? null, set: async (k, v) => { data.set(k, v); }, del: async (k) => { data.delete(k); } };
};
const phoneDb = () => initLocalDb(new DatabaseSync(':memory:') as unknown as DB);
const M = '2026-03', TODAY = '2026-03-10';

/** A fresh server + a controllable network + a factory for "phones". */
async function world(opts: { token?: string } = {}) {
  const serverDb = openDb(':memory:');
  const server = createApp(serverDb, { today: () => TODAY, token: opts.token }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const net = { offline: false, loseReplies: 0 };
  const fetchFn: Parameters<typeof createSync>[0]['fetch'] = async (url, init) => {
    if (net.offline) throw new TypeError('fetch failed');
    const res = await fetch(url, init);
    if (net.loseReplies > 0) { net.loseReplies--; await res.text(); throw new TypeError('connection reset'); } // the server DID process it
    return res;
  };
  let n = 0;
  const phone = (kv: KV = memoryKv(), db: DB = phoneDb(), token = opts.token) => ({
    kv, db, s: createSync({ base, token, kv, fetch: fetchFn, uuid: () => `op-${++n}-xxxxxxxx`, now: () => `${TODAY}T09:00:00`, db }),
  });
  const serverTxs = () => svc.listTxs(serverDb, M, TODAY);
  return { serverDb, base, net, phone, serverTxs, close: () => server.close() };
}
const tx = (merchant: string, paise: number, at: string) => ({ amount_paise: paise, merchant_raw: merchant, occurred_at: at });

describe('the on-device database', () => {
  it('works with NO server at all: a fresh phone reads, writes, and every number recomputes locally', async () => {
    const w = await world(); w.net.offline = true;
    const { s, db } = w.phone(); await s.init(); await s.ping();
    await s.run('addIncome', { amount_paise: 3000000, received_at: `${M}-01T09:00:00`, is_regular: true });
    await s.run('updateSettings', { fixed_needs_paise: 800000 });
    const t = await s.run<Tx>('addTx', tx('Zomato', 34000, `${M}-05T23:30:00`));
    expect([t.category_name, t.bucket, isLocalId(t.id)]).toEqual(['Food Delivery', 'want', true]);
    const sts = svc.safeToSpendFor(db, TODAY);
    expect([sts.income_paise, sts.fixed_needs_paise, sts.spent_so_far_paise, sts.savings_target_paise]).toEqual([3000000, 800000, 34000, 600000]);
    expect(svc.flagsFor(db, M, TODAY).map((f) => f.detector)).toContain('late_night'); // a detector, run on the phone
    expect(svc.reportFor(db, M, TODAY).totals.want).toBe(34000);
    expect(s.getSnapshot()).toMatchObject({ online: false, pending: expect.any(Array) });
    expect(s.getSnapshot().pending.map((o) => o.label)).toEqual(['Income · ₹30,000', 'Targets', 'Zomato · ₹340']);
    w.close();
  });

  it('computes EXACTLY what the server computes: same code, same numbers', async () => {
    const w = await world(); w.net.offline = true;
    const { s, db } = w.phone(); await s.init(); await s.ping();
    const ref = openDb(':memory:'); // the same actions applied straight to a server-side database
    const inc = { amount_paise: 3000000, received_at: `${M}-01T09:00:00`, is_regular: true };
    await s.run('addIncome', inc); svc.addIncome(ref, inc);
    await s.run('updateSettings', { fixed_needs_paise: 800000 }); svc.updateSettings(ref, { fixed_needs_paise: 800000 });
    for (const x of [tx('Zomato', 34000, `${M}-05T23:30:00`), tx('Rent', 600000, `${M}-02T10:00:00`), tx('Uber', 25000, `${M}-04T01:10:00`), tx('Chai', 2000, `${M}-06T16:00:00`)]) {
      await s.run('addTx', x); svc.createTx(ref, x);
    }
    const brief = (d: DB) => ({
      report: svc.reportFor(d, M, TODAY), safe: svc.safeToSpendFor(d, TODAY), savings: svc.savingsFor(d, TODAY),
      flags: svc.flagsFor(d, M, TODAY).map((f) => ({ d: f.detector, r: f.reason, a: f.amount_paise, n: f.tx_ids.length })),
      txs: svc.listTxs(d, M, TODAY).map((t) => [t.merchant_raw, t.category_name, t.bucket, t.amount_paise, t.occurred_at]),
    });
    expect(brief(db)).toEqual(brief(ref));
    w.close();
  });

  it('gives rows made on the phone ids from a separate range, and snapshots keep every id', () => {
    const db = phoneDb();
    const made = svc.addAccount(db, 'wallet', 'Wallet', 0).at(-1)!;
    expect([isLocalId(made.id), made.id >= LOCAL_ID_BASE, isLocalId(1)]).toEqual([true, true, false]);
    const snap = svc.exportTables(db);
    svc.importTables(db, snap);
    expect(svc.listAccounts(db).map((a) => a.id)).toEqual(snap.accounts.map((a: { id: number }) => a.id));
  });
});

describe('syncing', () => {
  it('sends everything to the server, then the phone replaces its rows with the real ones', async () => {
    const w = await world(); w.net.offline = true;
    const { s, db } = w.phone(); await s.init(); await s.ping();
    await s.run('addTx', tx('Sync A', 100, `${M}-05T10:00:00`));
    await s.run('addBulk', { items: [tx('Sync B', 200, `${M}-05T11:00:00`), tx('Sync C', 300, `${M}-05T12:00:00`)] });
    expect(svc.listTxs(db, M, TODAY).every((t) => isLocalId(t.id))).toBe(true);
    w.net.offline = false;
    await s.ping();
    expect(s.getSnapshot()).toMatchObject({ online: true, pending: [], syncing: false });
    const mine = svc.listTxs(db, M, TODAY), theirs = w.serverTxs();
    expect(mine.map((t) => t.id).sort()).toEqual(theirs.map((t) => t.id).sort());
    expect(mine.some((t) => isLocalId(t.id))).toBe(false); // no duplicates, no leftover local rows
    expect(mine.map((t) => t.merchant_raw).sort()).toEqual(['Sync A', 'Sync B', 'Sync C']);
    w.close();
  });

  it('NEVER double-applies when the server processed a change but the reply was lost', async () => {
    const w = await world(); w.net.offline = true;
    const { s, db } = w.phone(); await s.init(); await s.ping();
    await s.run('addTx', tx('Lost Reply', 5000, `${M}-07T10:00:00`));
    w.net.offline = false; w.net.loseReplies = 1;
    await s.flush(); // the server applies it, the reply never arrives
    expect(s.getSnapshot().pending).toHaveLength(1);
    await s.flush(); // replayed with the same Idempotency-Key
    expect(s.getSnapshot().pending).toEqual([]);
    await s.pull();
    expect(w.serverTxs().filter((t) => t.merchant_raw === 'Lost Reply')).toHaveLength(1);
    expect(svc.listTxs(db, M, TODAY).filter((t) => t.merchant_raw === 'Lost Reply')).toHaveLength(1);
    w.close();
  });

  it('a change the server refuses is listed, and the phone then agrees with the server', async () => {
    const w = await world();
    const doomed = svc.createTx(w.serverDb, tx('Doomed', 900, `${M}-06T10:00:00`));
    const { s, db } = w.phone(); await s.init(); await s.ping(); // phone now has it
    expect(svc.listTxs(db, M, TODAY).some((t) => t.id === doomed.id)).toBe(true);
    w.net.offline = true; await s.ping();
    await s.run('regret', { id: doomed.id, regret: true });
    expect(svc.listTxs(db, M, TODAY).find((t) => t.id === doomed.id)!.bucket).toBe('waste'); // applied locally at once
    svc.deleteTx(w.serverDb, doomed.id); // meanwhile, another device deleted it
    w.net.offline = false; await s.ping();
    const snap = s.getSnapshot();
    expect([snap.pending.length, snap.rejected.map((r) => r.op.label)]).toEqual([0, ['Regret tap']]);
    expect(snap.rejected[0].error).toContain('not found');
    expect(svc.listTxs(db, M, TODAY).some((t) => t.id === doomed.id)).toBe(false); // converged to the server's truth
    s.dismissRejected(snap.rejected[0].op.id);
    expect(s.getSnapshot().rejected).toEqual([]);
    w.close();
  });

  it('survives an app restart: the database copy and the outbox come back together', async () => {
    const w = await world();
    svc.createTx(w.serverDb, tx('Seed Tx', 700, `${M}-06T10:00:00`));
    const kv = memoryKv(), a = w.phone(kv); await a.s.init(); await a.s.ping();
    w.net.offline = true; await a.s.ping();
    await a.s.run('addTx', tx('Pending After Restart', 800, `${M}-06T11:00:00`));
    const b = w.phone(kv, phoneDb()); await b.s.init(); // "the app was killed and reopened" with a brand-new empty database
    expect(svc.listTxs(b.db, M, TODAY).map((t) => t.merchant_raw).sort()).toEqual(['Pending After Restart', 'Seed Tx']);
    expect(b.s.getSnapshot().pending.map((o) => o.label)).toEqual(['Pending After Restart · ₹8']);
    w.net.offline = false; await b.s.ping();
    expect(b.s.getSnapshot().pending).toEqual([]);
    expect(w.serverTxs().some((t) => t.merchant_raw === 'Pending After Restart')).toBe(true);
    w.close();
  });

  it('a refresh never overwrites changes the server has not seen yet', async () => {
    const w = await world(); w.net.offline = true;
    const { s, db } = w.phone(); await s.init(); await s.ping();
    await s.run('addTx', tx('Do Not Lose Me', 100, `${M}-08T10:00:00`));
    w.net.offline = false;
    expect(await s.pull()).toBe(false);
    expect(svc.listTxs(db, M, TODAY).some((t) => t.merchant_raw === 'Do Not Lose Me')).toBe(true);
    await s.flush();
    expect(await s.pull()).toBe(true);
    w.close();
  });

  it('a mistyped access token loses NOTHING: changes wait, the app says why, and they sync once the token is fixed', async () => {
    const w = await world({ token: 'the-right-token' });
    const kv = memoryKv();
    const bad = w.phone(kv, phoneDb(), 'a-typo'); await bad.s.init();
    await bad.s.run('addTx', tx('Typo Token', 100, `${M}-08T10:00:00`));
    await bad.s.flush(); await bad.s.pull();
    expect(bad.s.getSnapshot()).toMatchObject({ authFailed: true, rejected: [] }); // NOT dropped as "rejected"
    expect(bad.s.getSnapshot().pending).toHaveLength(1);
    expect(w.serverTxs()).toEqual([]);
    await expect(bad.s.remote('backup', { passphrase: 'abcdef' })).rejects.toMatchObject({ code: 'auth', message: expect.stringContaining('access token') });
    const good = w.phone(kv, phoneDb(), 'the-right-token'); await good.s.init(); // the same phone, token corrected, app restarted
    await good.s.ping();
    expect(good.s.getSnapshot()).toMatchObject({ authFailed: false, pending: [], rejected: [] });
    expect(w.serverTxs().map((t) => t.merchant_raw)).toEqual(['Typo Token']);
    w.close();
  });

  it('brings in changes made elsewhere (another phone, a statement import)', async () => {
    const w = await world();
    svc.createTx(w.serverDb, tx('From Another Device', 123, `${M}-08T10:00:00`));
    const { s, db } = w.phone(); await s.init(); await s.ping();
    expect(svc.listTxs(db, M, TODAY).some((t) => t.merchant_raw === 'From Another Device')).toBe(true);
    expect(s.getSnapshot().dataVersion).toBeGreaterThan(0);
    w.close();
  });

  it('things that need the server say so offline, and erase/restore refuse to run over unsent changes', async () => {
    const w = await world(); w.net.offline = true;
    const { s, db } = w.phone(); await s.init(); await s.ping();
    await expect(s.remote('backup', { passphrase: 'abcdef' })).rejects.toBeInstanceOf(OfflineError);
    await s.run('addTx', tx('Unsent', 100, `${M}-08T10:00:00`));
    await expect(s.remote('erase', {})).rejects.toThrow(/waiting to sync/);
    w.net.offline = false; await s.flush(); await s.pull();
    await s.remote('erase', {}); // online and nothing unsent: wipes the server, then the phone refreshes
    expect(w.serverTxs()).toEqual([]);
    expect(svc.listTxs(db, M, TODAY)).toEqual([]);
    w.close();
  });
});

describe('server idempotency', () => {
  it('applies a keyed write once and replays the stored answer; unkeyed writes behave as ever; 4xx and 204 are remembered too', async () => {
    const w = await world();
    const post = (key: string | null, body: unknown) => fetch(`${w.base}/api/transactions`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) });
    const body = tx('Idem Test', 1111, `${M}-02T10:00:00`);
    const a = await post('idem-key-0001', body), b = await post('idem-key-0001', body);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect((await a.json()).id).toBe((await b.json()).id);
    await post(null, tx('No Key', 2222, `${M}-02T10:00:00`)); await post(null, tx('No Key', 2222, `${M}-02T10:00:00`));
    expect(w.serverTxs().filter((t) => t.merchant_raw === 'Idem Test')).toHaveLength(1);
    expect(w.serverTxs().filter((t) => t.merchant_raw === 'No Key')).toHaveLength(2);
    const bad = await post('idem-key-0002', { amount_paise: -5 }), again = await post('idem-key-0002', { amount_paise: 100 });
    expect([bad.status, again.status]).toEqual([400, 400]);
    const del = (k: string) => fetch(`${w.base}/api/transactions/${w.serverTxs()[0].id}`, { method: 'DELETE', headers: { 'Idempotency-Key': k } });
    expect([(await del('idem-key-0003')).status, (await del('idem-key-0003')).status]).toEqual([204, 204]);
    w.close();
  });
});

describe('storage helpers', () => {
  it('chunkedKv stores big values as pieces, rewrites cleanly, and treats a missing piece as missing', async () => {
    const inner = memoryKv(), kv = chunkedKv(inner, 10);
    await kv.set('k', 'x'.repeat(95));
    expect([...inner.data.keys()].filter((k) => k.startsWith('k#') && k !== 'k#n')).toHaveLength(10);
    expect(await kv.get('k')).toBe('x'.repeat(95));
    await kv.set('k', 'short');
    expect([...inner.data.keys()].sort()).toEqual(['k#0', 'k#n']);
    expect(await kv.get('k')).toBe('short');
    await kv.set('k', 'y'.repeat(30)); inner.data.delete('k#1');
    expect(await kv.get('k')).toBeNull();
    await kv.del('k');
    expect(inner.data.size).toBe(0);
    expect(await kv.get('nope')).toBeNull();
  });

  const key = randomBytes(32).toString('hex');
  it('encryption at rest round-trips, never repeats a token, and hides the plaintext', () => {
    const c = makeCipher(key, (len) => randomBytes(len));
    const secret = JSON.stringify({ merchant: 'Swiggy', amount: 125050 });
    const a = c.encrypt(secret), b = c.encrypt(secret);
    expect(c.decrypt(a)).toBe(secret);
    expect(a).not.toBe(b);
    expect(a).not.toContain('Swiggy');
  });
  it('encryption detects tampering and refuses the wrong key', () => {
    const c = makeCipher(key, (len) => randomBytes(len));
    const token = c.encrypt('hello');
    expect(() => c.decrypt(token.slice(0, -2) + (token.endsWith('00') ? '01' : '00'))).toThrow();
    expect(() => makeCipher(randomBytes(32).toString('hex'), (l) => randomBytes(l)).decrypt(token)).toThrow();
    expect(() => makeCipher('abcd', (l) => randomBytes(l))).toThrow();
  });
});
