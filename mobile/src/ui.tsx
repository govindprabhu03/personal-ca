// The UI kit: chunky, rounded, friendly. Screens are built only from these, so the whole app restyles from one file.
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useRef } from 'react';
import { Animated, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, TextInputProps, TextStyle, View, ViewStyle } from 'react-native';
import { formatRupees } from '../../shared/money';
import { bucketOf, C, F, GRAD, shadow } from './theme';

export const ND = Platform.OS !== 'web'; // native animation driver isn't available on web

type W = keyof typeof F;
export const T = ({ children, size = 15, w = 'reg', bold, color = C.ink, style, center }: { children?: React.ReactNode; size?: number; w?: W; bold?: boolean; color?: string; style?: TextStyle; center?: boolean }) => (
  <Text style={[{ color, fontSize: size, fontFamily: F[bold ? 'bold' : w] }, center && { textAlign: 'center' }, style]}>{children}</Text>
);
export const Muted = (p: { children?: React.ReactNode; size?: number; style?: TextStyle; center?: boolean }) => <T size={p.size ?? 13} color={C.sub} style={p.style} center={p.center}>{p.children}</T>;
export const Money = ({ paise, size = 15, bold, color, w }: { paise: number; size?: number; bold?: boolean; color?: string; w?: W }) => <T size={size} bold={bold} color={color} w={w}>{formatRupees(paise)}</T>;

export const Card = ({ children, style, tint }: { children: React.ReactNode; style?: ViewStyle; tint?: string }) => <View style={[s.card, shadow, tint ? { backgroundColor: tint } : null, style]}>{children}</View>;
export const Title = ({ children, emoji }: { children: React.ReactNode; emoji?: string }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
    {emoji ? <Text style={{ fontSize: 20 }}>{emoji}</Text> : null}
    <Text style={{ color: C.ink, fontSize: 18, fontFamily: F.black }}>{children}</Text>
  </View>
);
export const Row = ({ children, style }: { children: React.ReactNode; style?: ViewStyle }) => <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 10 }, style]}>{children}</View>;

export function Btn({ label, onPress, kind = 'primary', disabled, style }: { label: string; onPress: () => void; kind?: 'primary' | 'soft' | 'ghost' | 'danger' | 'mint'; disabled?: boolean; style?: ViewStyle }) {
  const k = { primary: [C.violet, '#fff', C.violet], soft: [C.violetSoft, C.violet, C.violetSoft], ghost: ['transparent', C.ink, C.line], danger: [C.pink, '#fff', C.pink], mint: [C.mint, '#fff', C.mint] }[kind];
  return (
    <Pressable onPress={onPress} disabled={disabled} style={({ pressed }) => [s.btn, { backgroundColor: k[0], borderColor: k[2], opacity: disabled ? 0.4 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }, style]}>
      <Text style={{ color: k[1], fontFamily: F.bold, fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}

export const Chip = ({ label, active, onPress, color = C.violet }: { label: string; active?: boolean; onPress: () => void; color?: string }) => (
  <Pressable onPress={onPress} style={({ pressed }) => [s.chip, active && { backgroundColor: color + '22', borderColor: color }, { transform: [{ scale: pressed ? 0.96 : 1 }] }]}>
    <Text style={{ color: active ? color : C.sub, fontSize: 13, fontFamily: active ? F.bold : F.semi }}>{label}</Text>
  </Pressable>
);
export const Chips = ({ children }: { children: React.ReactNode }) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{children}</View>;

export const Tag = ({ text, fg, bg }: { text: string; fg: string; bg: string }) => (
  <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3, alignSelf: 'flex-start' }}>
    <Text style={{ color: fg, fontSize: 11, fontFamily: F.bold }}>{text}</Text>
  </View>
);
export const BucketTag = ({ bucket }: { bucket: string }) => { const b = bucketOf(bucket); return <Tag text={`${b.emoji} ${b.label}`} fg={b.fg} bg={b.bg} />; };

export const Bubble = ({ emoji, bg = C.violetSoft, size = 44 }: { emoji: string; bg?: string; size?: number }) => (
  <View style={{ width: size, height: size, borderRadius: size * 0.36, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
    <Text style={{ fontSize: size * 0.5 }}>{emoji}</Text>
  </View>
);

export function Field({ label, ...p }: TextInputProps & { label: string }) {
  return (
    <View style={{ gap: 5 }}>
      <Text style={{ color: C.sub, fontSize: 13, fontFamily: F.semi }}>{label}</Text>
      <TextInput placeholderTextColor="#A9A4C4" {...p} style={[s.input, p.style]} />
    </View>
  );
}

/** Thick rounded progress bar, with an optional target tick. */
export function Bar({ value, target, color = C.violet, track = C.line, height = 12 }: { value: number; target?: number; color?: string; track?: string; height?: number }) {
  const clamp = (n: number) => `${Math.max(0, Math.min(100, n))}%` as const;
  return (
    <View style={{ height, backgroundColor: track, borderRadius: height }}>
      <View style={{ width: clamp(value), height, borderRadius: height, backgroundColor: color }} />
      {target !== undefined && <View style={{ position: 'absolute', left: clamp(target), top: -3, width: 3, height: height + 6, borderRadius: 2, backgroundColor: C.ink }} />}
    </View>
  );
}

/** The big gradient moment: safe-to-spend, monthly win, savings. */
export function Hero({ children, colors = GRAD.hero, style }: { children: React.ReactNode; colors?: readonly [string, string, ...string[]]; style?: ViewStyle }) {
  return (
    <LinearGradient colors={colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[{ borderRadius: 30, padding: 22, overflow: 'hidden', gap: 6 }, shadow, style]}>
      <View style={{ position: 'absolute', right: -40, top: -50, width: 170, height: 170, borderRadius: 85, backgroundColor: '#FFFFFF22' }} />
      <View style={{ position: 'absolute', left: -30, bottom: -60, width: 130, height: 130, borderRadius: 65, backgroundColor: '#FFFFFF18' }} />
      {children}
    </LinearGradient>
  );
}

/** Pops in with a little spring: success states should feel good. */
export function Pop({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const v = useRef(new Animated.Value(0.6)).current;
  useEffect(() => { Animated.spring(v, { toValue: 1, friction: 5, tension: 120, useNativeDriver: ND }).start(); }, [v]);
  return <Animated.View style={[{ transform: [{ scale: v }], opacity: v.interpolate({ inputRange: [0.6, 1], outputRange: [0, 1] }) }, style]}>{children}</Animated.View>;
}

/** A burst of emoji floating up: the celebration for logging something. */
export function Burst({ emojis = ['🎉', '✨', '💜', '🌟', '🎊'] }: { emojis?: string[] }) {
  const parts = useRef(Array.from({ length: 14 }, (_, i) => ({ v: new Animated.Value(0), x: (Math.random() - 0.5) * 260, e: emojis[i % emojis.length], r: (Math.random() - 0.5) * 80 }))).current;
  useEffect(() => { Animated.stagger(25, parts.map((p) => Animated.timing(p.v, { toValue: 1, duration: 1100, useNativeDriver: ND }))).start(); }, [parts]);
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 30, alignItems: 'center', height: 0 }}>
      {parts.map((p, i) => (
        <Animated.Text key={i} style={{ position: 'absolute', fontSize: 22, opacity: p.v.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 1, 0] }),
          transform: [{ translateX: p.v.interpolate({ inputRange: [0, 1], outputRange: [0, p.x] }) }, { translateY: p.v.interpolate({ inputRange: [0, 1], outputRange: [0, -150 - (i % 4) * 25] }) }, { rotate: p.v.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${p.r}deg`] }) }] }}>{p.e}</Animated.Text>
      ))}
    </View>
  );
}

export function Screen({ children, refreshing, onRefresh }: { children: React.ReactNode; refreshing?: boolean; onRefresh?: () => void }) {
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingTop: 6, paddingBottom: 130, gap: 14 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={C.violet} /> : undefined}>
      {children}
    </ScrollView>
  );
}

export const ErrorText = ({ error }: { error?: string }) => error ? (
  <View style={{ backgroundColor: C.pinkSoft, borderRadius: 14, padding: 10 }}><T size={13} color="#C21B52" w="semi">😕 {error}</T></View>
) : null;

const s = StyleSheet.create({
  card: { backgroundColor: C.card, borderRadius: 26, padding: 16, gap: 12 },
  btn: { borderRadius: 999, borderWidth: 2, paddingVertical: 13, paddingHorizontal: 20, alignItems: 'center' },
  chip: { borderRadius: 999, borderWidth: 2, borderColor: C.line, backgroundColor: '#fff', paddingHorizontal: 13, paddingVertical: 7 },
  input: { backgroundColor: C.bg, borderColor: C.line, borderWidth: 2, borderRadius: 16, color: C.ink, fontSize: 16, fontFamily: F.semi, paddingHorizontal: 14, paddingVertical: 11 },
});
