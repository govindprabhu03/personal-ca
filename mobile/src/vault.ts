// Encrypted storage shared by the on-device data and the sign-in session: every value is AES-256-GCM encrypted before it touches
// AsyncStorage, and the key lives in the OS keystore (SecureStore) on a phone.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { KV } from '../../shared/sync';
import { makeCipher } from './cipher';

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

export const encryptedKv: KV = {
  async get(k) {
    const raw = await AsyncStorage.getItem('ca:' + k);
    if (raw === null) return null;
    try { return (await cipher()).decrypt(raw); } catch { return null; } // unreadable (tampered, or key lost) = treat as missing
  },
  async set(k, v) { await AsyncStorage.setItem('ca:' + k, (await cipher()).encrypt(v)); },
  async del(k) { await AsyncStorage.removeItem('ca:' + k); },
};
