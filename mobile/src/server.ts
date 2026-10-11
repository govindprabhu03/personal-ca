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

export { normaliseUrl } from '../../shared/serverUrl'; // shared with the tests: https addresses keep their own port
