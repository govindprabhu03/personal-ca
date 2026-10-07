import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { CATEGORY_EMOJI, DETECTOR_EMOJI, DETECTOR_LABEL } from '../../../shared/labels';
import { formatRupees } from '../../../shared/money';
import type { SafeToSpend } from '../../../shared/types';
import { api } from '../api';
import { useLoad } from '../hooks';
import { getSync, useSyncState } from '../offline';
import type { ScreenProps } from '../state';
import { bucketOf, C } from '../theme';
import { Bar, Btn, Bubble, BucketTag, Card, Chip, Chips, ErrorText, Hero, Money, Muted, Row, Screen, T, Title } from '../ui';
import { dayLabel } from '../util';
import { billWhen } from './Bills';

const mood = (s: SafeToSpend) =>
  s.needs_income ? 'Add your income in Money to unlock your daily number 💸'
  : s.status === 'over' ? `You're ${formatRupees(-s.remaining_paise)} over plan. Tomorrow is a fresh start 💜`
  : s.status === 'tight' ? `Easy does it today 😬  ${formatRupees(s.remaining_paise)} left this month`
  : `You're cruising 😎  ${formatRupees(s.remaining_paise)} left this month`;

export function Today({ data, version, bump }: ScreenProps) {
  const month = data.today.slice(0, 7);
  const sts = useLoad(() => api.safeToSpend(data.today), [version]);
  const flags = useLoad(() => api.flags(month), [version]);
  const txs = useLoad(() => api.transactions(month), [version]);
  const bills = useLoad(() => api.bills(), [version]);
  const ious = useLoad(() => api.ious(), [version]);
  // Every number here is computed by the on-device database, including changes the server hasn't received yet.
  const snap = useSyncState();
  const dueBills = (bills.data ?? []).filter((b) => b.status !== 'upcoming');
  const [open, setOpen] = useState<number | null>(null);
  const [why, setWhy] = useState(false);
  const s = sts.data;
  const pool = s ? s.income_paise - s.fixed_needs_paise - s.savings_target_paise : 0;
  const usedPct = s && pool > 0 ? (s.spent_so_far_paise / pool) * 100 : 0;
  const hero = s?.status === 'over' ? ([C.orange, C.pink] as const) : s?.status === 'tight' ? ([C.sun, C.orange] as const) : undefined;
  const fix = async (id: number, category_id: number) => { await api.patchTx(id, { category_id }); bump(); };

  return (
    <Screen refreshing={sts.loading} onRefresh={() => { getSync().requestPull(); getSync().ping(); bump(); }}> {/* pull down = sync with the server too, not just re-read the phone */}
      <Hero colors={hero}>
        <T size={14} w="semi" color="#FFFFFFCC">Safe to spend today</T>
        <T size={58} w="black" color="#fff" style={{ lineHeight: 66 }}>{s ? formatRupees(s.per_day_paise) : '…'}</T>
        {s && <T size={15} w="semi" color="#fff">{mood(s)}</T>}
        {snap.pending.length > 0 && <T size={12} w="semi" color="#FFFFFFCC">⏳ {snap.pending.length} change{snap.pending.length > 1 ? 's' : ''} waiting to sync. Already counted here, on your phone</T>}
        {s && pool > 0 && (
          <View style={{ gap: 6, marginTop: 8 }}>
            <Bar value={usedPct} color="#fff" track="#FFFFFF44" height={10} />
            <T size={12} color="#FFFFFFCC">{Math.round(usedPct)}% of this month's spending room used · {s.days_left} days to go</T>
          </View>
        )}
        <Pressable onPress={() => setWhy(!why)} style={{ marginTop: 6 }}><T size={12} w="bold" color="#FFFFFFCC">{why ? 'Hide the maths ▴' : 'How is this calculated? ▾'}</T></Pressable>
        {why && s && (
          <T size={12} color="#FFFFFFE6">
            {formatRupees(s.income_paise)} income{s.income_is_estimate ? ' (estimated)' : ''} − {formatRupees(s.fixed_needs_paise)} fixed needs − {formatRupees(s.savings_target_paise)} to savings − {formatRupees(s.spent_so_far_paise)} spent, split across {s.days_left} days.
          </T>
        )}
      </Hero>
      <ErrorText error={sts.error} />

      {s && (
        <Row style={{ gap: 10 }}>
          {[['💸', 'Spent', formatRupees(s.spent_so_far_paise), C.pinkSoft], ['🏦', 'Saving', `${formatRupees(s.savings_target_paise)}/mo`, C.mintSoft], ['📅', 'Days left', String(s.days_left), C.skySoft]].map(([e, l, v, bg]) => (
            <View key={l} style={{ flex: 1, backgroundColor: bg, borderRadius: 22, padding: 12, gap: 2 }}>
              <T size={20}>{e}</T><T size={16} w="black">{v}</T><Muted size={12}>{l}</Muted>
            </View>
          ))}
        </Row>
      )}

      {dueBills.length > 0 && (
        <View style={{ gap: 10 }}>
          <Title emoji="🔔">Coming up</Title>
          {dueBills.map((b) => (
            <Row key={b.id} style={{ backgroundColor: b.status === 'overdue' ? C.pinkSoft : C.sunSoft, borderRadius: 20, padding: 12 }}>
              <Bubble emoji={b.emoji} bg="#fff" size={40} />
              <View style={{ flex: 1 }}>
                <T w="black">{b.name} · {formatRupees(b.amount_paise)}</T>
                <T size={13} w="semi" color={b.status === 'overdue' ? '#C21B52' : C.sub}>{billWhen(b)}{b.status === 'overdue' ? ' · late fees are pure waste' : ''}</T>
              </View>
              <Btn kind="mint" label="Paid ✅" onPress={async () => { await api.payBill(b.id, true, b.name); bump(); }} style={{ paddingVertical: 8, paddingHorizontal: 14 }} />
            </Row>
          ))}
        </View>
      )}

      {!!ious.data && (ious.data.owed_to_me_paise > 0 || ious.data.i_owe_paise > 0) && (
        <Row style={{ backgroundColor: C.mintSoft, borderRadius: 20, padding: 12 }}>
          <T size={22}>🤝</T>
          <T size={14} w="semi" style={{ flex: 1 }}>
            {ious.data.owed_to_me_paise > 0 ? `Friends owe you ${formatRupees(ious.data.owed_to_me_paise)}` : ''}
            {ious.data.owed_to_me_paise > 0 && ious.data.i_owe_paise > 0 ? ' · ' : ''}
            {ious.data.i_owe_paise > 0 ? `you owe ${formatRupees(ious.data.i_owe_paise)}` : ''}
          </T>
        </Row>
      )}

      {!!flags.data?.length && (
        <View style={{ gap: 10 }}>
          <Title emoji="👀">Heads up</Title>
          {[...flags.data].sort((a, b) => b.amount_paise - a.amount_paise).slice(0, 4).map((f) => {
            const hard = f.detector === 'fee' || f.detector === 'double_charge';
            return (
              <Row key={f.detector + f.reason} style={{ backgroundColor: hard ? C.pinkSoft : C.sunSoft, borderRadius: 20, padding: 12, alignItems: 'flex-start' }}>
                <T size={22}>{DETECTOR_EMOJI[f.detector]}</T>
                <View style={{ flex: 1 }}><T size={13} w="bold">{DETECTOR_LABEL[f.detector]}</T><T size={13} color={C.sub}>{f.reason}</T></View>
              </Row>
            );
          })}
        </View>
      )}

      <Title emoji="🧾">Recent</Title>
      <Card>
        {txs.data?.length === 0 && (
          <View style={{ alignItems: 'center', gap: 6, paddingVertical: 14 }}><T size={40}>🚀</T><T w="bold">Nothing logged yet</T><Muted center>Tap the + and log your first spend to start a streak 🔥</Muted></View>
        )}
        {txs.data?.slice(0, 25).map((t) => {
          const b = bucketOf(t.bucket);
          return (
            <View key={t.id}>
              <Pressable onPress={() => { if (!t.pending) setOpen(open === t.id ? null : t.id); }}>
                <Row>
                  <Bubble emoji={CATEGORY_EMOJI[t.category_name ?? 'Other'] ?? '✨'} bg={b.bg} />
                  <View style={{ flex: 1 }}>
                    <T w="bold">{t.merchant_raw || t.category_name}</T>
                    <Muted size={12}>{t.category_name} · {dayLabel(t.occurred_at)} {t.flags?.map((d) => DETECTOR_EMOJI[d]).join('')}</Muted>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 4 }}>
                    <Money paise={t.amount_paise} w="black" />
                    {t.pending ? <T size={11} w="bold" color={C.violet}>⏳ waiting to sync</T> : t.needs_review ? <T size={11} w="bold" color="#C77F00">🤔 check me</T> : <BucketTag bucket={t.bucket} />}
                  </View>
                </Row>
              </Pressable>
              {open === t.id && (
                <View style={{ gap: 10, paddingVertical: 12 }}>
                  <Muted>{t.needs_review ? 'Not sure about this one. Tap the right category:' : 'Wrong category? Tap to fix. I learn from it ✨'}</Muted>
                  <Chips>{data.categories.map((c) => <Chip key={c.id} label={`${CATEGORY_EMOJI[c.name] ?? ''} ${c.name}`} active={c.id === t.category_id} onPress={() => fix(t.id, c.id)} />)}</Chips>
                  <Btn kind="ghost" label="Delete this entry" onPress={async () => { await api.deleteTx(t.id); setOpen(null); bump(); }} />
                </View>
              )}
            </View>
          );
        })}
        <ErrorText error={txs.error} />
      </Card>
    </Screen>
  );
}
