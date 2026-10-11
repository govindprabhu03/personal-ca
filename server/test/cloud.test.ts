// The hosted (Vercel) server: the ordinary app, over a database kept encrypted in an object store. Tested with an in-memory store
// that has the same contract as Vercel Blob: versioned conditional saves, and failures we can inject.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { createCloudHandler } from '../src/cloud/handler';
import { memoryStore } from '../src/cloud/store';

const TOKEN = 'cloud-token-abcdefghijklmnop', KEY = 'cloud-data-key-abcdefghijklmnop';
const servers: http.Server[] = [];

/** One "function instance": its own handler (its own cache), sharing the store with the others, like separate warm containers would. */
async function instance(store: ReturnType<typeof memoryStore>, key = KEY) {
  const s = http.createServer(createCloudHandler({ store, dataKey: key, token: TOKEN, today: () => '2026-03-10' })).listen(0);
  servers.push(s);
  await new Promise((r) => s.once('listening', r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const call = (path: string, init: RequestInit & { json?: unknown; key?: string } = {}) => fetch(base + path, {
    method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
    headers: { 'x-api-key': TOKEN, ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.key ? { 'Idempotency-Key': init.key } : {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  const txs = async () => ((await (await call('/api/transactions?month=2026-03')).json()) as Array<{ merchant_raw: string }>).map((t) => t.merchant_raw).sort();
  const add = (merchant: string, key?: string) => call('/api/transactions', { json: { amount_paise: 1000, merchant_raw: merchant, occurred_at: '2026-03-09T10:00:00' }, key });
  return { call, txs, add };
}
afterAll(() => { servers.forEach((s) => s.close()); });

describe('the hosted server keeps its database in an object store', () => {
  it('survives a cold start: a brand-new instance sees the data and the same identity', async () => {
    const store = memoryStore();
    const a = await instance(store);
    const id1 = (await (await a.call('/api/identity')).json()) as { id: string; empty: boolean };
    expect(id1.empty).toBe(true);
    expect((await a.add('Chai Point')).status).toBe(201);

    const b = await instance(store); // a cold start: nothing cached
    expect(await b.txs()).toEqual(['Chai Point']);
    expect(((await (await b.call('/api/identity')).json()) as { id: string; empty: boolean })).toEqual({ id: id1.id, empty: false });
  });

  it('reads cost no writes, and an unchanged request saves nothing', async () => {
    const store = memoryStore();
    const a = await instance(store);
    await a.add('One');
    const saved = store.saves;
    await a.txs(); await a.call('/api/bootstrap'); await a.call('/api/safe-to-spend');
    expect(store.saves).toBe(saved);
    expect((await a.call('/api/transactions', { json: { amount_paise: -5 } })).status).toBe(400); // a rejected write changes nothing
    expect(store.saves).toBe(saved);
  });

  it('is encrypted at rest: no merchant name in the stored bytes, and the wrong key cannot read it', async () => {
    const store = memoryStore();
    const a = await instance(store);
    await a.add('Secret Biryani House');
    const raw = store.peek()!.data;
    expect(raw.toString('utf8')).not.toContain('Biryani');
    expect(raw.toString('latin1')).not.toContain('Biryani');
    const wrong = await instance(store, 'a-completely-different-data-key-0123');
    const r = await wrong.call('/api/bootstrap');
    expect([r.status, ((await r.json()) as { code: string }).code]).toEqual([503, 'storage']);
  });

  it('never lies about a save: if another instance saves first, this one answers a retryable 503 and persists nothing; the retry applies once', async () => {
    const store = memoryStore();
    const a = await instance(store), b = await instance(store);
    await a.txs(); await b.txs(); // both warm
    // B starts handling a write; in the gap between its load and its save, A (another warm container) saves a change of its own.
    store.beforeSave = async () => { store.beforeSave = undefined; expect((await a.add('From A')).status).toBe(201); };
    const lost = await b.add('From B', 'op-from-b-0001');
    expect([lost.status, ((await lost.json()) as { code: string }).code]).toEqual([503, 'conflict']);
    expect(await a.txs()).toEqual(['From A']); // B's change was NOT stored
    const retry = await b.add('From B', 'op-from-b-0001'); // the phone retries with the same key; B reloads first, so it builds on A's save
    expect(retry.status).toBe(201);
    expect(await a.txs()).toEqual(['From A', 'From B']);
    expect((await b.add('From B', 'op-from-b-0001')).status).toBe(201); // a further replay of the same key...
    expect(await a.txs()).toEqual(['From A', 'From B']);                 // ...is answered, never re-applied
  });

  it('an instance that is behind simply catches up: it reloads before it writes, so a stale copy never overwrites newer data', async () => {
    const store = memoryStore();
    const a = await instance(store), b = await instance(store);
    await a.txs(); await b.txs();
    await a.add('Newer');
    await b.add('Later');
    expect(await a.txs()).toEqual(['Later', 'Newer']);
  });

  it('a storage outage on save is a retryable 503 with nothing half-saved', async () => {
    const store = memoryStore();
    const a = await instance(store);
    await a.add('Before');
    store.failSaves = 1;
    const r = await a.add('During outage', 'op-outage-00001');
    expect([r.status, ((await r.json()) as { code: string }).code]).toEqual([503, 'storage']);
    expect(await a.txs()).toEqual(['Before']);
    expect((await a.add('During outage', 'op-outage-00001')).status).toBe(201);
    expect(await a.txs()).toEqual(['Before', 'During outage']);
  });

  it('remembers replayed keys across cold starts (the answer to a lost reply survives a restart)', async () => {
    const store = memoryStore();
    const a = await instance(store);
    const first = await a.add('Once Only', 'op-replay-000001');
    const b = await instance(store); // restart between the original request and the retry
    const again = await b.add('Once Only', 'op-replay-000001');
    expect([first.status, again.status]).toEqual([201, 201]);
    expect(await b.txs()).toEqual(['Once Only']);
  });

  it('health answers even when the store is down, while real requests say why they cannot be served', async () => {
    const broken = { saves: 0, loads: 0, failSaves: 0, beforeSave: undefined, archives: new Map(), peek: () => null, load: async () => { throw Object.assign(new Error('Access denied for this store'), { name: 'BlobAccessError' }); }, save: async () => '1' } as unknown as ReturnType<typeof memoryStore>;
    const a = await instance(broken);
    expect((await a.call('/api/health')).status).toBe(200);
    const r = await a.call('/api/bootstrap');
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: 'storage', detail: 'BlobAccessError: Access denied for this store' });
  });

  it('keeps one spare copy a day, and still refuses a wrong token', async () => {
    const store = memoryStore();
    const a = await instance(store);
    await a.add('Spare');
    expect(store.archives.size).toBe(1);
    await a.add('Spare 2');
    expect(store.archives.size).toBe(1); // same day: no second copy
    const noToken = await fetch(`http://127.0.0.1:${(servers[servers.length - 1].address() as AddressInfo).port}/api/bootstrap`);
    expect(noToken.status).toBe(401);
  });
});
