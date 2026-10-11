import Constants from 'expo-constants';
import { Platform } from 'react-native';

// WHERE is the server? In order:
//   web preview from `expo start`   -> localhost:8787 (the dev API)
//   web UI served BY the Windows .exe -> the same address the page came from, and the exe hands the page its token
//   a phone in Expo Go               -> the PC's address Expo already knows
//   an installed APK                 -> nothing built in: you enter the PC's address once in More -> Connect to your PC
// (A saved address always wins over all of these: see server.ts.)
const g = globalThis as any;
const devHost = Constants.expoConfig?.hostUri?.split(':')[0];

export const DEFAULT_URL: string =
  process.env.EXPO_PUBLIC_API_URL ??
  (Platform.OS === 'web' ? (__DEV__ ? 'http://localhost:8787' : (g.location?.origin ?? 'http://localhost:8787')) : devHost ? `http://${devHost}:8787` : '');
export const DEFAULT_TOKEN: string | undefined = (Platform.OS === 'web' ? g.__CA_TOKEN__ : undefined) ?? process.env.EXPO_PUBLIC_API_TOKEN;

// ---- accounts (sign in with email or Google) ----
// The installed phone app signs people in, so each person's data is their own. The web version served by the PC program keeps using the PC's own
// access token (that PC is yours alone). EXPO_PUBLIC_ACCOUNTS=1 turns accounts on for the web preview too, for testing.
export const ACCOUNT_MODE: boolean = Platform.OS !== 'web' || process.env.EXPO_PUBLIC_ACCOUNTS === '1';
export const CLOUD_URL: string = process.env.EXPO_PUBLIC_CLOUD_URL ?? 'https://personal-ca-api-govind20.vercel.app';
// These two are PUBLIC by design (they only identify the project; every row of data is protected by the user's own sign-in token).
export const SUPABASE_URL = 'https://xjadceycmfimtftqnmja.supabase.co';
export const SUPABASE_KEY = 'sb_publishable__wKMwMfgg3cG7ZrtrWS3vA_kLTiUA1o';
