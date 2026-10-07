// App lock: PIN (stored in the OS keystore on a phone) + biometrics when available. Re-locks when the app goes to the background,
// and covers the screen while the app is inactive so the app-switcher thumbnail never shows your amounts.
import { LinearGradient } from 'expo-linear-gradient';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, Platform, StyleSheet, TextInput, View } from 'react-native';
import { C, F, GRAD } from './theme';
import { Btn, ErrorText, Muted, T } from './ui';

const KEY = 'ca_pin';
const web = () => (globalThis as any).localStorage as Storage; // web is only a dev preview target; phones use SecureStore
const kvGet = async () => (Platform.OS === 'web' ? web().getItem(KEY) : SecureStore.getItemAsync(KEY));
const kvSet = async (v: string) => (Platform.OS === 'web' ? web().setItem(KEY, v) : SecureStore.setItemAsync(KEY, v));
const kvDel = async () => (Platform.OS === 'web' ? web().removeItem(KEY) : SecureStore.deleteItemAsync(KEY));

const Ctx = createContext({ hasPin: false, setPin: async (_: string) => {}, clearPin: async () => {} });
export const useLock = () => useContext(Ctx);

export function LockGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [pin, setPinState] = useState<string | null>(null);
  const [locked, setLocked] = useState(true);
  const [active, setActive] = useState(true);
  const [entry, setEntry] = useState('');
  const [err, setErr] = useState('');
  const pinRef = useRef<string | null>(null);
  pinRef.current = pin;

  useEffect(() => { kvGet().then((p) => { setPinState(p); setLocked(!!p); setReady(true); }).catch(() => setReady(true)); }, []);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => { setActive(st === 'active'); if (st === 'background' && pinRef.current) setLocked(true); });
    return () => sub.remove();
  }, []);

  const bio = useCallback(async () => {
    if (Platform.OS === 'web') return;
    if (!(await LocalAuthentication.hasHardwareAsync()) || !(await LocalAuthentication.isEnrolledAsync())) return;
    if ((await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock Personal CA', disableDeviceFallback: true })).success) setLocked(false);
  }, []);
  useEffect(() => { if (ready && pin && locked && active) bio(); }, [ready, pin, locked, active, bio]);

  const ctx = {
    hasPin: !!pin,
    setPin: async (p: string) => { await kvSet(p); setPinState(p); },
    clearPin: async () => { await kvDel(); setPinState(null); },
  };
  const tryPin = () => { if (entry === pin) { setLocked(false); setEntry(''); setErr(''); } else { setErr('Wrong PIN, try again'); setEntry(''); } };

  if (!ready) return <View style={{ flex: 1, backgroundColor: C.bg }} />;
  return (
    <Ctx.Provider value={ctx}>
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        {children}
        {pin && locked && (
          <LinearGradient colors={GRAD.night} style={[StyleSheet.absoluteFill, s.lock]}>
            <T size={64}>🔒</T>
            <T size={28} w="black" color="#fff">Personal CA</T>
            <Muted>Enter your PIN to peek at your money</Muted>
            <TextInput value={entry} onChangeText={setEntry} secureTextEntry keyboardType="number-pad" maxLength={6} autoFocus onSubmitEditing={tryPin}
              style={s.pin} placeholder="••••" placeholderTextColor="#FFFFFF66" />
            <ErrorText error={err} />
            <Btn label="Unlock" onPress={tryPin} style={{ width: 220, backgroundColor: '#fff', borderColor: '#fff' }} />
            {Platform.OS !== 'web' && <Btn kind="ghost" label="Use biometrics" onPress={bio} style={{ width: 220, borderColor: '#FFFFFF55' }} />}
          </LinearGradient>
        )}
        {!active && <View style={[StyleSheet.absoluteFill, { backgroundColor: C.bg }]} />}
      </View>
    </Ctx.Provider>
  );
}

const s = StyleSheet.create({
  lock: { alignItems: 'center', justifyContent: 'center', gap: 14 },
  pin: { backgroundColor: '#FFFFFF1F', borderColor: '#FFFFFF44', borderWidth: 2, borderRadius: 20, color: '#fff', fontSize: 30, fontFamily: F.black, letterSpacing: 10, textAlign: 'center', width: 220, paddingVertical: 12 },
});
