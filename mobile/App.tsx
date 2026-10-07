import { Outfit_400Regular, Outfit_600SemiBold, Outfit_700Bold, Outfit_800ExtraBold, useFonts } from '@expo-google-fonts/outfit';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { Bootstrap } from '../shared/types';
import { api } from './src/api';
import { LockGate } from './src/lock';
import { getSync, ready, useSyncState } from './src/offline';
import { AddSheet } from './src/screens/AddSheet';
import { AskSheet } from './src/screens/AskSheet';
import { More } from './src/screens/More';
import { Report } from './src/screens/Report';
import { Review } from './src/screens/Review';
import { Savings } from './src/screens/Savings';
import { Today } from './src/screens/Today';
import { C, F, GRAD, shadow } from './src/theme';
import { Btn, Muted, T } from './src/ui';

const TABS = [
  { id: 'today', label: 'Today', icon: '🏠', title: 'Your day', View: Today },
  { id: 'review', label: 'Swipe', icon: '🃏', title: 'Worth it or regret?', View: Review },
  { id: 'report', label: 'Insights', icon: '📊', title: 'Your month', View: Report },
  { id: 'savings', label: 'Money', icon: '💰', title: 'Money moves', View: Savings },
  { id: 'more', label: 'More', icon: '⚙️', title: 'Settings & data', View: More },
] as const;
type TabId = (typeof TABS)[number]['id'];

const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Late night ✨' : h < 12 ? 'Good morning ☀️' : h < 17 ? 'Good afternoon 🌤️' : h < 22 ? 'Good evening 🌆' : 'Night owl 🦉'; };

function TabButton({ id, label, icon, active, onPress }: { id: string; label: string; icon: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 20, backgroundColor: active ? C.violetSoft : 'transparent' }}>
      <Text style={{ fontSize: 22 }}>{icon}</Text>
      <Text style={{ fontSize: 11, fontFamily: active ? F.bold : F.semi, color: active ? C.violet : C.sub }}>{label}</Text>
    </Pressable>
  );
}

function Main() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<TabId>('today');
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const [asking, setAsking] = useState(false);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // ---- on-device database + sync lifecycle ----
  const sync = getSync();
  const snap = useSyncState();
  useEffect(() => { sync.ping(); }, [sync]);                                            // catch up with the server, then refresh the local copy
  useEffect(() => {                                                                     // coming back to the app: refresh again
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') { sync.requestPull(); sync.ping(); } });
    return () => sub.remove();
  }, [sync]);
  useEffect(() => {                                                                     // while offline or waiting, keep knocking (cheap /health ping)
    const t = setInterval(() => { const s = sync.getSnapshot(); if (!s.online || s.pending.length) sync.ping(); }, 15000);
    return () => clearInterval(t);
  }, [sync]);
  useEffect(() => { bump(); }, [snap.dataVersion, bump]);                               // the on-device data changed (a tap, or a refresh): every screen re-reads, instantly

  useEffect(() => { api.bootstrap().then((d) => { setData(d); setError(''); }, (e) => setError(String(e?.message ?? e))); }, [version]);

  if (!data)
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 12 }}>
        <T size={56}>💜</T>
        <T size={28} w="black">Personal CA</T>
        {error ? (
          <>
            <T w="bold" color="#E0245E">Couldn't read your data 😕</T>
            <Muted center>{error}</Muted>
            <Btn label="Retry" onPress={bump} />
          </>
        ) : <Muted>Loading your money vibes…</Muted>}
      </View>
    );

  const cur = TABS.find((t) => t.id === tab)!;
  const Active = cur.View;
  const left = TABS.slice(0, 2), right = TABS.slice(2, 4);
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1, width: '100%', maxWidth: 640, alignSelf: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: 10, paddingBottom: 8 }}>
          <View style={{ flex: 1 }}>
            <T size={13} w="semi" color={C.sub}>{greeting()}</T>
            <T size={26} w="black">{cur.title}</T>
          </View>
          {(!snap.online || snap.authFailed || snap.syncing || snap.pending.length > 0 || snap.rejected.length > 0) && (
            <Pressable onPress={() => setTab('more')} style={{ height: 40, borderRadius: 20, paddingHorizontal: 12, marginRight: 8, justifyContent: 'center', backgroundColor: snap.authFailed || snap.rejected.length ? C.pinkSoft : !snap.online ? C.skySoft : C.sunSoft }}>
              <Text style={{ fontSize: 13, fontFamily: F.bold, color: snap.authFailed || snap.rejected.length ? '#C21B52' : !snap.online ? '#1B6FA8' : '#8A5A00' }}>
                {snap.authFailed ? '🔑 Token' : !snap.online ? `📴 Offline${snap.pending.length ? ` · ${snap.pending.length}` : ''}` : snap.syncing ? '🔄 Syncing' : snap.pending.length ? `⏳ ${snap.pending.length}` : `⚠️ ${snap.rejected.length}`}
              </Text>
            </Pressable>
          )}
          <Pressable onPress={() => setAsking(true)} style={{ height: 40, borderRadius: 20, backgroundColor: C.violetSoft, paddingHorizontal: 12, marginRight: 8, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 5 }}>
            <Text style={{ fontSize: 17 }}>💬</Text><Text style={{ fontSize: 13, fontFamily: F.bold, color: C.violet }}>Ask</Text>
          </Pressable>
          <View style={{ backgroundColor: data.streak ? C.orangeSoft : C.line, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, marginRight: 8 }}>
            <T size={14} w="black" color={data.streak ? '#D9570F' : C.sub}>🔥 {data.streak}</T>
          </View>
          <Pressable onPress={() => setTab(tab === 'more' ? 'today' : 'more')} style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: tab === 'more' ? C.violetSoft : '#fff', alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 19 }}>{tab === 'more' ? '✕' : '⚙️'}</Text>
          </Pressable>
        </View>
        <Active data={data} version={version} bump={bump} />
      </View>

      <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: 12, alignItems: 'center' }}>
      <View style={[{ width: '100%', maxWidth: 560, flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 32, padding: 6, marginHorizontal: 14 }, shadow]}>
        {left.map((t) => <TabButton key={t.id} {...t} active={tab === t.id} onPress={() => setTab(t.id)} />)}
        <Pressable onPress={() => setAdding(true)} style={{ marginHorizontal: 6, marginTop: -30 }}>
          <LinearGradient colors={GRAD.hero} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[{ width: 62, height: 62, borderRadius: 31, alignItems: 'center', justifyContent: 'center', borderWidth: 4, borderColor: '#fff' }, shadow]}>
            <Text style={{ color: '#fff', fontSize: 34, fontFamily: F.black, lineHeight: 38 }}>+</Text>
          </LinearGradient>
        </Pressable>
        {right.map((t) => <TabButton key={t.id} {...t} active={tab === t.id} onPress={() => setTab(t.id)} />)}
      </View>
      </View>
      <AddSheet data={data} visible={adding} onClose={() => setAdding(false)} bump={bump} />
      <AskSheet visible={asking} onClose={() => setAsking(false)} />
    </View>
  );
}

export default function App() {
  const [fontsReady] = useFonts({ Outfit_400Regular, Outfit_600SemiBold, Outfit_700Bold, Outfit_800ExtraBold });
  // The app starts once the on-device database is open and restored from its encrypted snapshot.
  const [db, setDb] = useState<'loading' | 'ready' | string>('loading');
  useEffect(() => { ready.then(() => setDb('ready'), (e) => setDb(String(e?.message ?? e))); }, []);
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        {!fontsReady ? null : db === 'ready' ? <LockGate><Main /></LockGate> : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 12 }}>
            <T size={56}>💜</T>
            <T size={28} w="black">Personal CA</T>
            {db === 'loading' ? <Muted>Opening your on-device database…</Muted> : <><T w="bold" color="#E0245E">Couldn't open the on-device database 😕</T><Muted center>{db}</Muted></>}
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
