// The weekly regret review as a swipe deck: right = worth it 💚, left = regret 💔. Your swipes teach the app what waste means for you.
import React, { useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, View } from 'react-native';
import { CATEGORY_EMOJI, DETECTOR_EMOJI, DETECTOR_LABEL } from '../../../shared/labels';
import { formatRupees } from '../../../shared/money';
import type { Tx } from '../../../shared/types';
import { api } from '../api';
import { useLoad } from '../hooks';
import type { ScreenProps } from '../state';
import { C } from '../theme';
import { Btn, Bubble, Card, ErrorText, Muted, Row, Screen, T, Tag, ND } from '../ui';
import { dayLabel } from '../util';

function SwipeCard({ item, behind, onJudge }: { item: Tx; behind: boolean; onJudge: (regret: boolean) => void }) {
  const x = useRef(new Animated.Value(0)).current;
  const judge = useRef(onJudge);
  judge.current = onJudge;
  const fling = (dir: 1 | -1) => Animated.timing(x, { toValue: dir * 560, duration: 190, useNativeDriver: ND }).start(() => judge.current(dir < 0));
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
    onPanResponderMove: (_, g) => x.setValue(g.dx),
    onPanResponderRelease: (_, g) => { if (Math.abs(g.dx) > 110) fling(g.dx > 0 ? 1 : -1); else Animated.spring(x, { toValue: 0, useNativeDriver: ND }).start(); },
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const worth = x.interpolate({ inputRange: [0, 90], outputRange: [0, 1], extrapolate: 'clamp' });
  const regret = x.interpolate({ inputRange: [-90, 0], outputRange: [1, 0], extrapolate: 'clamp' });
  const cat = CATEGORY_EMOJI[item.category_name ?? 'Other'] ?? '✨';
  return (
    <View style={{ gap: 16 }}>
      <View>
        {behind && <View style={{ position: 'absolute', left: 14, right: 14, top: 14, bottom: -10, borderRadius: 32, backgroundColor: C.violetSoft }} />}
        <Animated.View {...pan.panHandlers} style={{ transform: [{ translateX: x }, { rotate: x.interpolate({ inputRange: [-220, 0, 220], outputRange: ['-9deg', '0deg', '9deg'] }) }] }}>
          <Card style={{ alignItems: 'center', gap: 10, paddingVertical: 30, borderRadius: 32 }}>
            <Animated.View style={{ position: 'absolute', left: 16, top: 18, opacity: worth, transform: [{ rotate: '-12deg' }] }}><Tag text="💚 WORTH IT" fg="#fff" bg={C.mint} /></Animated.View>
            <Animated.View style={{ position: 'absolute', right: 16, top: 18, opacity: regret, transform: [{ rotate: '12deg' }] }}><Tag text="💔 REGRET" fg="#fff" bg={C.pink} /></Animated.View>
            <Bubble emoji={cat} bg={C.violetSoft} size={84} />
            <T size={26} w="black" center>{item.merchant_raw || item.category_name}</T>
            <T size={44} w="black" color={C.violet}>{formatRupees(item.amount_paise)}</T>
            <Muted>{item.category_name} · {dayLabel(item.occurred_at)} · {item.payment_method}</Muted>
            <Row style={{ flexWrap: 'wrap', justifyContent: 'center', gap: 6 }}>{item.flags?.map((d) => <Tag key={d} text={`${DETECTOR_EMOJI[d]} ${DETECTOR_LABEL[d]}`} fg="#C77F00" bg={C.sunSoft} />)}</Row>
          </Card>
        </Animated.View>
      </View>
      <Row>
        <Btn kind="danger" label="💔 Regret" onPress={() => fling(-1)} style={{ flex: 1 }} />
        <Btn kind="mint" label="Worth it 💚" onPress={() => fling(1)} style={{ flex: 1 }} />
      </Row>
    </View>
  );
}

export function Review({ version, bump }: ScreenProps) {
  const q = useLoad(() => api.weeklyReview(), [version]);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [tally, setTally] = useState({ worth: 0, regret: 0, regretPaise: 0 });
  const [err, setErr] = useState('');
  const items = (q.data ?? []).filter((t) => !done.has(t.id));
  const cur = items[0];

  const judge = async (regret: boolean) => {
    if (!cur) return;
    setDone((d) => new Set(d).add(cur.id)); // hide instantly; the refetch confirms it
    setTally((t) => (regret ? { ...t, regret: t.regret + 1, regretPaise: t.regretPaise + cur.amount_paise } : { ...t, worth: t.worth + 1 }));
    try { await api.regret(cur.id, regret); bump(); } catch (e: any) { setErr(e.message); }
  };

  return (
    <Screen refreshing={q.loading} onRefresh={bump}>
      <Muted center>Swipe right if it was worth it 💚, left if you regret it 💔</Muted>
      {cur ? (
        <>
          <T size={13} w="bold" color={C.violet} center>{items.length} left this week</T>
          <SwipeCard key={cur.id} item={cur} behind={items.length > 1} onJudge={judge} />
        </>
      ) : (
        <Card style={{ alignItems: 'center', paddingVertical: 36, gap: 6 }}>
          <T size={56}>{q.loading ? '⏳' : '🎉'}</T>
          <T size={22} w="black">{q.loading ? 'Loading…' : 'All caught up!'}</T>
          {!q.loading && <Muted center>No unjudged wants in the last 7 days. See you next week ✨</Muted>}
        </Card>
      )}
      {tally.worth + tally.regret > 0 && (
        <Card tint={C.violetSoft} style={{ gap: 4 }}>
          <T w="black">This session</T>
          <T>💚 {tally.worth} worth it · 💔 {tally.regret} regret ({formatRupees(tally.regretPaise)})</T>
          <Muted>Regrets become waste. After 2 at the same place, I'll warn you next time.</Muted>
        </Card>
      )}
      <ErrorText error={err || q.error} />
    </Screen>
  );
}
