// The taxpayer profile ("salaried or something else"): stored per account, travels with the data, validated.
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import * as svc from '../../shared/core/service';
import { createApp } from '../src/app';
import { openDb } from '../src/db';

describe('taxpayer profile', () => {
  it('starts un-onboarded with safe defaults, and saves what the user answers', () => {
    const db = openDb(':memory:');
    expect(svc.getProfile(db)).toEqual({ taxpayer_types: [], residency: 'resident', age_group: 'under60', regime_pref: 'auto', onboarded: false });
    const p = svc.updateProfile(db, { taxpayer_types: ['salaried', 'investor', 'salaried'], age_group: 'senior', onboarded: true });
    expect(p).toEqual({ taxpayer_types: ['salaried', 'investor'], residency: 'resident', age_group: 'senior', regime_pref: 'auto', onboarded: true }); // de-duplicated
    expect(svc.bootstrap(db, '2026-03-10').profile.onboarded).toBe(true);
  });

  it('refuses unknown values instead of storing them', () => {
    const db = openDb(':memory:');
    for (const bad of [{ taxpayer_types: ['wizard'] }, { residency: 'martian' }, { age_group: 'ancient' }, { regime_pref: 'both' }]) {
      expect(() => svc.updateProfile(db, bad as never)).toThrow(/Unknown/);
    }
    expect(svc.getProfile(db).onboarded).toBe(false);
  });

  it('travels in the snapshot (so it follows the account to a new phone) and "erase everything" resets it', () => {
    const a = openDb(':memory:'); svc.updateProfile(a, { taxpayer_types: ['professional'], regime_pref: 'new', onboarded: true });
    const b = openDb(':memory:'); svc.importTables(b, svc.exportTables(a));
    expect(svc.getProfile(b)).toMatchObject({ taxpayer_types: ['professional'], regime_pref: 'new', onboarded: true });
    svc.eraseAll(b);
    expect(svc.getProfile(b)).toMatchObject({ taxpayer_types: [], onboarded: false });
    const old = svc.exportTables(a) as Record<string, unknown>; delete old.profile; // a backup made before profiles existed still restores
    expect(() => svc.importTables(openDb(':memory:'), old as never)).not.toThrow();
  });

  it('is saved through the API and validated there too', async () => {
    const s = createApp(openDb(':memory:'), {}).listen(0); await new Promise((r) => s.once('listening', r));
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const put = (b: unknown) => fetch(`${base}/api/profile`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const ok = await put({ taxpayer_types: ['business'], onboarded: true });
    expect([ok.status, (await ok.json()).taxpayer_types]).toEqual([200, ['business']]);
    expect((await put({ taxpayer_types: ['wizard'] })).status).toBe(400);
    s.close();
  });
});
