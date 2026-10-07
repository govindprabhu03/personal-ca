// The look: bright lilac canvas, white "sticker" cards, one violet→pink gradient for the hero moments, emoji as icons.
// Verdict colours stay friendly, never scary: Need = mint 🌱, Want = sunshine ✨, Waste = pink 🫠 (no red alarms).
import { Platform } from 'react-native';

export const C = {
  bg: '#F6F2FF', card: '#FFFFFF', ink: '#1E1B3A', sub: '#6E6A8A', line: '#EAE4FA',
  violet: '#7B5CFF', violetSoft: '#EDE8FF', pink: '#FF5FA2', pinkSoft: '#FFE4F0', mint: '#12C298', mintSoft: '#D9F8EE',
  sun: '#FFB82E', sunSoft: '#FFF1CC', sky: '#38B6FF', skySoft: '#DCF2FF', orange: '#FF8A4C', orangeSoft: '#FFE8DA',
};

export const GRAD = {
  hero: ['#7B5CFF', '#FF5FA2'], win: ['#12C298', '#38B6FF'], warn: ['#FFB82E', '#FF8A4C'], lilac: ['#7B5CFF', '#38B6FF'], night: ['#2B2160', '#7B5CFF'],
} as const;

export const F = { reg: 'Outfit_400Regular', semi: 'Outfit_600SemiBold', bold: 'Outfit_700Bold', black: 'Outfit_800ExtraBold' } as const;

export const bucketStyle = {
  need: { fg: '#0A9E7B', bg: C.mintSoft, emoji: '🌱', label: 'Need' },
  want: { fg: '#C77F00', bg: C.sunSoft, emoji: '✨', label: 'Want' },
  waste: { fg: '#E0245E', bg: C.pinkSoft, emoji: '🫠', label: 'Waste' },
  ignore: { fg: C.sub, bg: C.line, emoji: '🔕', label: 'Ignored' },
} as const;
export const bucketOf = (b: string) => bucketStyle[(b in bucketStyle ? b : 'ignore') as keyof typeof bucketStyle];

export const shadow: object = Platform.select({
  web: { boxShadow: '0 8px 24px rgba(123,92,255,0.13)' },
  default: { shadowColor: '#7B5CFF', shadowOpacity: 0.15, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 4 },
})!;
