import React, { useState } from 'react';
import { View } from 'react-native';
import { CATEGORY_EMOJI } from '../../../shared/labels';
import { formatRupees } from '../../../shared/money';
import type { MonthlyReport } from '../../../shared/types';
import { api } from '../api';
import { useLoad } from '../hooks';
import type { ScreenProps } from '../state';
import { C, GRAD } from '../theme';
import { Bar, Btn, Bubble, Card, Chip, ErrorText, Hero, Money, Muted, Row, Screen, T, Tag, Title } from '../ui';
import { monthLabel, shiftMonth } from '../util';

const vibe = (r: MonthlyReport): [string, string] =>
  r.income_paise <= 0 ? ['🌱', 'Just getting started']
  : r.pct.savings >= r.targets.savings ? ['🦸', 'Savings Hero']
  : r.pct.waste >= 5 ? ['🕵️', 'Leak Hunter in training']
  : r.pct.want > r.targets.want ? ['🍰', 'Treat-yourself mode']
  : ['😌', 'Balanced & chill'];

// needs/wants are CEILINGS (over = amber); savings is a FLOOR (under = amber).
function Split({ emoji, label, pct, target, ceiling }: { emoji: string; label: string; pct: number; target: number; ceiling: boolean }) {
  const good = ceiling ? pct <= target : pct >= target;
  const color = good ? C.mint : C.sun;
  return (
    <View style={{ gap: 7 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T w="bold">{emoji} {label}</T>
        <T w="black" color={good ? '#0A9E7B' : '#C77F00'}>{pct}% <Muted size={12}>/ {ceiling ? '≤' : '≥'} {target}%</Muted></T>
      </Row>
      <Bar value={pct} target={target} color={color} />
    </View>
  );
}

const Delta = ({ label, paise }: { label: string; paise: number }) => (
  <Row style={{ justifyContent: 'space-between' }}>
    <Muted size={14}>{label}</Muted>
    <T w="black" size={14} color={paise > 0 ? '#E0245E' : paise < 0 ? '#0A9E7B' : C.sub}>{paise > 0 ? '▲ ' : paise < 0 ? '▼ ' : ''}{formatRupees(Math.abs(paise))}</T>
  </Row>
);

export function Report({ data, version, bump }: ScreenProps) {
  const [month, setMonth] = useState(data.today.slice(0, 7));
  const q = useLoad(() => api.report(month), [version, month]);
  const subs = useLoad(() => api.subscriptions(), [version]);
  const r = q.data;
  const [emoji, label] = r ? vibe(r) : ['', ''];
  const monthly = (subs.data ?? []).filter((x) => !x.unused).reduce((a, x) => a + x.amount_paise, 0);

  return (
    <Screen>
      <Row style={{ justifyContent: 'space-between' }}>
        <Btn kind="soft" label="‹" onPress={() => setMonth(shiftMonth(month, -1))} style={{ paddingHorizontal: 18 }} />
        <T size={18} w="black">{monthLabel(month)}</T>
        <Btn kind="soft" label="›" onPress={() => setMonth(shiftMonth(month, 1))} disabled={month >= data.today.slice(0, 7)} style={{ paddingHorizontal: 18 }} />
      </Row>
      <ErrorText error={q.error} />
      {r && (
        <>
          <Hero colors={r.saved_paise >= 0 ? GRAD.win : GRAD.warn}>
            <T size={14} w="semi" color="#FFFFFFCC">{r.saved_paise >= 0 ? 'You kept' : 'You went over by'}</T>
            <T size={50} w="black" color="#fff" style={{ lineHeight: 58 }}>{formatRupees(Math.abs(r.saved_paise))}</T>
            <T w="semi" color="#fff">{r.saved_paise >= 0 ? 'Nice, that is money working for future you 🎉' : "It happens, and next month is a fresh start 💛"}</T>
            <Row style={{ marginTop: 8, gap: 18 }}>
              <View><T size={12} color="#FFFFFFB3">Income</T><T w="black" color="#fff">{formatRupees(r.income_paise)}</T></View>
              <View><T size={12} color="#FFFFFFB3">Spent</T><T w="black" color="#fff">{formatRupees(r.spent_paise)}</T></View>
            </Row>
          </Hero>

          <Card tint={C.violetSoft}>
            <Row><T size={34}>{emoji}</T><View><Muted size={12}>Your money vibe this month</Muted><T size={18} w="black">{label}</T></View></Row>
          </Card>

          <Card style={{ gap: 16 }}>
            <Title emoji="🎯">Your split vs your goals</Title>
            {r.income_paise <= 0 ? <Muted>Log income for this month to see your percentages.</Muted> : (
              <>
                <Split emoji="🌱" label="Needs" pct={r.pct.need} target={r.targets.need} ceiling />
                <Split emoji="✨" label="Wants (incl. waste)" pct={r.pct.want} target={r.targets.want} ceiling />
                <Split emoji="🏦" label="Savings" pct={r.pct.savings} target={r.targets.savings} ceiling={false} />
                <Muted size={12}>🫠 Of the wants, {formatRupees(r.totals.waste)} was waste ({r.pct.waste}% of income). The black tick is your target.</Muted>
              </>
            )}
          </Card>

          <Card>
            <Title emoji="🕳️">Top leaks</Title>
            {r.top_leaks.length === 0 && <Muted>No leaks this month. Nothing flagged and no regrets 🙌</Muted>}
            {r.top_leaks.map((l) => (
              <Row key={l.label} style={{ alignItems: 'flex-start' }}>
                <Bubble emoji={CATEGORY_EMOJI[l.label] ?? '✨'} bg={C.pinkSoft} />
                <View style={{ flex: 1, gap: 4 }}>
                  <T w="bold">{l.label} <Muted size={12}>· {l.count}×</Muted></T>
                  <Row style={{ flexWrap: 'wrap', gap: 5 }}>{l.reasons.map((x) => <Tag key={x} text={x} fg="#C77F00" bg={C.sunSoft} />)}</Row>
                </View>
                <Money paise={l.amount_paise} w="black" />
              </Row>
            ))}
          </Card>

          <Card>
            <Title emoji="📆">vs {monthLabel(r.prev_month)}</Title>
            <Delta label="🌱 Needs" paise={r.vs_prev.need} />
            <Delta label="✨ Wants" paise={r.vs_prev.want} />
            <Delta label="🫠 Waste" paise={r.vs_prev.waste} />
            <Delta label="💸 Total spent" paise={r.vs_prev.spent} />
          </Card>
        </>
      )}

      <Card>
        <Title emoji="📺">Subscriptions & recurring</Title>
        {subs.data?.length === 0 && <Muted>I'll list anything that charges you monthly once I've seen it 3 times.</Muted>}
        {!!subs.data?.length && <Muted>About {formatRupees(monthly)} a month on repeat. Tap “I don't use this” to turn one into waste.</Muted>}
        {subs.data?.map((x) => (
          <View key={x.merchant} style={{ gap: 8 }}>
            <Row>
              <Bubble emoji={CATEGORY_EMOJI[x.category ?? 'Subscriptions'] ?? '📺'} bg={x.unused ? C.pinkSoft : C.skySoft} />
              <View style={{ flex: 1 }}>
                <T w="bold">{x.merchant}</T>
                <Muted size={12}>{x.days_until < 0 ? `was due ${-x.days_until} days ago` : x.days_until === 0 ? 'renews today' : `renews in ${x.days_until} days`} · {formatRupees(x.yearly_paise)}/yr</Muted>
              </View>
              <T w="black">{formatRupees(x.amount_paise)}</T>
            </Row>
            {x.bucket !== 'need' && (
              <View style={{ flexDirection: 'row' }}>
                <Chip label={x.unused ? '🫠 Marked as waste (undo)' : "🙅 I don't use this"} active={x.unused} color={C.pink}
                  onPress={async () => { await api.markSubscription(x.merchant, !x.unused); bump(); }} />
              </View>
            )}
          </View>
        ))}
        <ErrorText error={subs.error} />
      </Card>
    </Screen>
  );
}
