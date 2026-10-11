// Tax details saved on a phone (local-first) reach the server, and a second phone gets them.
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { initLocalDb } from '../../shared/core/localdb';
import type { DB } from '../../shared/core/schema';
import { getTaxInput } from '../../shared/core/tax/data';
import type { KV } from '../../shared/kv';
import { createSync } from '../../shared/sync';
import { createApp } from '../src/app';
import { openDb } from '../src/db';

const memoryKv = (): KV => { const m = new Map<string, string>(); return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, del: async (k) => { m.delete(k); } }; };

describe('tax details sync like everything else', () => {
  it('visible at once on the phone, then on the server, then on a second device', async () => {
    const serverDb = openDb(':memory:');
    const server = createApp(serverDb, { today: () => '2026-10-11' }).listen(0); await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const phone = () => { const db = initLocalDb(new DatabaseSync(':memory:') as unknown as DB); return { db, s: createSync({ base, kv: memoryKv(), fetch: (u, i) => fetch(u, i), uuid: () => randomUUID(), now: () => '2026-10-11T09:00:00', db }) }; };

    const a = phone(); await a.s.init(); await a.s.ping();
    await a.s.run('saveTax', { fy: '2025-26', input: { salary_gross: 1500000 * 100, tds: 90000 * 100 } });
    expect(getTaxInput(a.db, '2025-26').salary_gross).toBe(1500000 * 100);   // on the phone, instantly
    await a.s.flush();
    expect(getTaxInput(serverDb, '2025-26').tds).toBe(90000 * 100);          // on the server
    const b = phone(); await b.s.init(); await b.s.ping();
    expect(getTaxInput(b.db, '2025-26').salary_gross).toBe(1500000 * 100);   // on a second device
    server.close();
  });
});
