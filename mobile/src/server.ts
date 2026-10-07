// Which server this phone talks to, saved on the phone. The token sits in the OS keystore on a phone (localStorage only on the web preview).
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const KEY = 'ca_server';
const web = () => (globalThis as any).localStorage as Storage;
export interface ServerSettings { url: string; token: string }

export async function loadServer(): Promise<ServerSettings | null> {
  try {
    const raw = Platform.OS === 'web' ? web().getItem(KEY) : await SecureStore.getItemAsync(KEY);
    const s = raw ? JSON.parse(raw) : null;
    return s?.url ? { url: String(s.url), token: String(s.token ?? '') } : null;
  } catch { return null; }
}

export async function saveServer(s: ServerSettings): Promise<void> {
  const raw = JSON.stringify(s);
  if (Platform.OS === 'web') web().setItem(KEY, raw); else await SecureStore.setItemAsync(KEY, raw);
}

/** "192.168.0.150" or "192.168.0.150:8787/" -> "http://192.168.0.150:8787". People type it every way. */
export function normaliseUrl(input: string): string {
  let u = input.trim().replace(/\/+$/, '');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  if (!/:\d+$/.test(u.replace(/^https?:\/\//i, ''))) u += ':8787';
  return u;
}
