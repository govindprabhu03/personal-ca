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
