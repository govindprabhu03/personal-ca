// Wires the local-first sync core to the phone: an on-device SQLite database (restored from an encrypted snapshot at start-up),
// persisted through AsyncStorage with every value AES-256-GCM encrypted (the key lives in the OS keystore).
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { initLocalDb } from '../../shared/core/localdb';
import { chunkedKv } from '../../shared/kv';
import { createSync, KV, Sync } from '../../shared/sync';
import { nowLocal } from '../../shared/time';
import { makeCipher } from './cipher';
import { DEFAULT_TOKEN, DEFAULT_URL } from './config';
import { openDriver } from './localdb';
import { loadServer } from './server';

const KEY_NAME = 'ca_cache_key';
const web = () => (globalThis as any).localStorage as Storage; // web is only a dev preview target; phones use the keystore

async function loadKey(): Promise<string> {
  const existing = Platform.OS === 'web' ? web().getItem(KEY_NAME) : await SecureStore.getItemAsync(KEY_NAME);
  if (existing && existing.length === 64) return existing;
  const hex = Array.from(Crypto.getRandomBytes(32), (b) => b.toString(16).padStart(2, '0')).join('');
  if (Platform.OS === 'web') web().setItem(KEY_NAME, hex); else await SecureStore.setItemAsync(KEY_NAME, hex);
  return hex;
}
let cipherReady: Promise<ReturnType<typeof makeCipher>> | null = null;
const cipher = () => (cipherReady ??= loadKey().then((k) => makeCipher(k, (n) => Crypto.getRandomBytes(n))));

const encryptedKv: KV = {
  async get(k) {
    const raw = await AsyncStorage.getItem('ca:' + k);
    if (raw === null) return null;
    try { return (await cipher()).decrypt(raw); } catch { return null; } // unreadable (tampered, or key lost) = treat as missing
  },
  async set(k, v) { await AsyncStorage.setItem('ca:' + k, (await cipher()).encrypt(v)); },
  async del(k) { await AsyncStorage.removeItem('ca:' + k); },
};

let instance: Sync | null = null;
export const getSync = (): Sync => { if (!instance) throw new Error('The on-device database is not ready yet'); return instance; };

/** Opens the on-device database, restores it from the encrypted snapshot, and loads the outbox. The app starts when this resolves. */
export const ready: Promise<Sync> = (async () => {
  const db = initLocalDb(await openDriver());
  const saved = await loadServer(); // an address the user entered on this phone beats every built-in default
  const s = createSync({ base: saved?.url ?? DEFAULT_URL, token: saved ? saved.token || undefined : DEFAULT_TOKEN, kv: chunkedKv(encryptedKv), fetch: (u, i) => fetch(u, i), uuid: () => Crypto.randomUUID(), now: nowLocal, db });
  await s.init();
  instance = s;
  return s;
})();

/** Live sync status for the UI: online?, changes waiting, anything the server refused, and `dataVersion` (bumps whenever the local data changed). */
export const useSyncState = () => { const s = getSync(); return useSyncExternalStore(s.subscribe, s.getSnapshot); };
