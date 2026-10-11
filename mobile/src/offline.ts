// Wires the local-first sync core to the phone: an on-device SQLite database (restored from an encrypted snapshot at start-up),
// persisted through AsyncStorage with every value AES-256-GCM encrypted (the key lives in the OS keystore; see vault.ts).
import * as Crypto from 'expo-crypto';
import { useSyncExternalStore } from 'react';
import { initLocalDb } from '../../shared/core/localdb';
import { chunkedKv } from '../../shared/kv';
import { createSync, Sync } from '../../shared/sync';
import { nowLocal } from '../../shared/time';
import { getAccessToken } from './auth';
import { ACCOUNT_MODE, CLOUD_URL, DEFAULT_TOKEN, DEFAULT_URL } from './config';
import { openDriver } from './localdb';
import { loadServer } from './server';
import { encryptedKv } from './vault';

let instance: Sync | null = null;
export const getSync = (): Sync => { if (!instance) throw new Error('The on-device database is not ready yet'); return instance; };

/** Opens the on-device database, restores it from the encrypted snapshot, and loads the outbox. The app starts when this resolves. */
export const ready: Promise<Sync> = (async () => {
  const db = initLocalDb(await openDriver());
  const saved = ACCOUNT_MODE ? null : await loadServer(); // an address the user entered on this phone beats every built-in default (not used when signing in with an account)
  const s = createSync({
    ...(ACCOUNT_MODE ? { base: CLOUD_URL, getToken: getAccessToken } : { base: saved?.url ?? DEFAULT_URL, token: saved ? saved.token || undefined : DEFAULT_TOKEN }),
    kv: chunkedKv(encryptedKv), fetch: (u, i) => fetch(u, i), uuid: () => Crypto.randomUUID(), now: nowLocal, db,
  });
  await s.init();
  instance = s;
  return s;
})();

/** Live sync status for the UI: online?, changes waiting, anything the server refused, and `dataVersion` (bumps whenever the local data changed). */
export const useSyncState = () => { const s = getSync(); return useSyncExternalStore(s.subscribe, s.getSnapshot); };
