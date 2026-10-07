// Money moves: how much to save, goals, the cooling-off wishlist, income + cash wallets, and your own targets.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { formatRupees, parseRupees } from '../../../shared/money';
import type { AccountKind } from '../../../shared/types';
import { api } from '../api';
import { useLoad } from '../hooks';
import type { ScreenProps } from '../state';
import { C, GRAD } from '../theme';
import { Bar, Btn, Bubble, Card, Chip, Chips, ErrorText, Field, Hero, Money, Muted, Row, Screen, T, Title } from '../ui';
import { dayLabel } from '../util';
import { BillsSection } from './Bills';
import { FriendsSection } from './Friends';

const STAGE: Record<string, string> = { starter: 'Starter shield: 1 month of essentials', min: 'Building your safety net', max: 'Topping up the full cushion', done: 'Emergency fund complete 🎉' };
const GOAL_EMOJI = ['🎯', '💻', '📱', '🏖️', '🎧', '🚲', '🎓', '🎁'];

export function Savings({ data, version, bump }: ScreenProps) {
  const [seg, setSeg] = useState<'save' | 'bills' | 'friends'>('save');
  const plan = useLoad(() => api.savings(), [version]);
  const income = useLoad(() => api.income(data.today.slice(0, 7)), [version]);
  const goals = useLoad(() => api.goals(), [version]);
  const wish = useLoad(() => api.wishlist(), [version]);
  const st = data.settings;
  const [pct, setPct] = useState(String(st.savings_target_pct));
  const [fixed, setFixed] = useState(String(st.fixed_needs_paise / 100));
  const [saved, setSaved] = useState(String(st.emergency_saved_paise / 100));
  const [irr, setIrr] = useState(!!st.income_irregular);
  const [iAmt, setIAmt] = useState(''); const [iSrc, setISrc] = useState(''); const [iReg, setIReg] = useState(true);
  const [iAcc, setIAcc] = useState<number | undefined>(data.accounts[0]?.id);
  const [aName, setAName] = useState(''); const [aKind, setAKind] = useState<AccountKind>('wallet'); const [aOpen, setAOpen] = useState('');
  const [gName, setGName] = useState(''); const [gEmoji, setGEmoji] = useState('🎯'); const [gAmt, setGAmt] = useState(''); const [gMonths, setGMonths] = useState('');
  const [wName, setWName] = useState(''); const [wPrice, setWPrice] = useState(''); const [wHours, setWHours] = useState<24 | 48>(24);
  const [err, setErr] = useState('');

  const run = async (f: () => Promise<unknown>) => { try { setErr(''); await f(); bump(); } catch (e: any) { setErr(e.message); } };
  const need = (v: number | null, msg: string) => { if (v === null || v <= 0) throw new Error(msg); return v; };

  const p = plan.data;
  return (
    <Screen refreshing={plan.loading} onRefresh={bump}>
      <Row style={{ justifyContent: 'center' }}>
        <Chip label="🌱 Save" active={seg === 'save'} onPress={() => setSeg('save')} />
        <Chip label="🧾 Bills" active={seg === 'bills'} onPress={() => setSeg('bills')} color={C.orange} />
        <Chip label="🤝 Friends" active={seg === 'friends'} onPress={() => setSeg('friends')} color={C.mint} />
      </Row>
      {seg === 'bills' ? <BillsSection data={data} version={version} bump={bump} /> : seg === 'friends' ? <FriendsSection data={data} version={version} bump={bump} /> : (<>
      <ErrorText error={err || plan.error} />
      {p && (
        <Hero colors={GRAD.lilac}>
          <T size={14} w="semi" color="#FFFFFFCC">Start saving</T>
          <Row style={{ alignItems: 'flex-end', gap: 8 }}><T size={48} w="black" color="#fff" style={{ lineHeight: 56 }}>{formatRupees(p.start_at_paise)}</T><T color="#FFFFFFCC" style={{ marginBottom: 8 }}>/ month 🌱</T></Row>
          {p.stepped_down && <T size={13} color="#fff">Your full target is {formatRupees(p.monthly_target_paise)}/month. Start smaller and step up as income grows 📈</T>}
          {p.needs_data ? <T size={13} color="#FFFFFFE6">Log some spends (or set fixed needs below) so I can size your emergency shield.</T> : (
            <View style={{ gap: 6, marginTop: 8 }}>
              <T w="bold" color="#fff">🛡️ {STAGE[p.stage]}</T>
              <Bar value={p.next_target_paise ? (p.saved_paise / p.next_target_paise) * 100 : 0} color="#fff" track="#FFFFFF44" height={10} />
              <T size={12} color="#FFFFFFD9">{formatRupees(p.saved_paise)} of {formatRupees(p.next_target_paise)}{p.months_to_next ? ` · about ${p.months_to_next} month${p.months_to_next > 1 ? 's' : ''} to go` : ''}</T>
              <T size={11} color="#FFFFFFB3">Essentials ≈ {formatRupees(p.essential_monthly_paise)}/mo × {p.multiples.min}–{p.multiples.max} months{p.irregular ? ' (irregular income = bigger cushion)' : ''}.</T>
            </View>
          )}
        </Hero>
      )}

      <Title emoji="🎯">Goals</Title>
      {goals.data?.map((g) => {
        const pc = (g.saved_paise / g.target_paise) * 100;
        return (
          <Card key={g.id} style={{ gap: 10 }}>
            <Row>
              <Bubble emoji={g.emoji} />
              <View style={{ flex: 1 }}><T w="black">{g.name}</T><Muted size={12}>{formatRupees(g.saved_paise)} of {formatRupees(g.target_paise)}{g.monthly_needed_paise ? ` · ${formatRupees(g.monthly_needed_paise)}/mo to hit it` : ''}</Muted></View>
              <Pressable onPress={() => run(() => api.deleteGoal(g.id))}><T color={C.sub}>✕</T></Pressable>
            </Row>
            <Bar value={pc} color={pc >= 100 ? C.mint : C.violet} />
            {pc >= 100 ? <T w="bold" color="#0A9E7B">🎉 Goal reached!</T> : (
              <Chips>{[100, 500, 1000].map((n) => <Chip key={n} label={`+₹${n}`} onPress={() => run(() => api.contribute(g.id, n * 100))} color={C.mint} />)}</Chips>
            )}
          </Card>
        );
      })}
      <Card>
        <Title emoji="➕">New goal</Title>
        <Chips>{GOAL_EMOJI.map((e) => <Chip key={e} label={e} active={e === gEmoji} onPress={() => setGEmoji(e)} />)}</Chips>
        <Field label="What are you saving for?" value={gName} onChangeText={setGName} placeholder="New laptop, Goa trip…" />
        <Row><View style={{ flex: 1 }}><Field label="Target (₹)" value={gAmt} onChangeText={setGAmt} keyboardType="decimal-pad" /></View><View style={{ flex: 1 }}><Field label="In how many months?" value={gMonths} onChangeText={setGMonths} keyboardType="number-pad" placeholder="optional" /></View></Row>
        <Btn label="Create goal" onPress={() => run(async () => {
          const t = need(parseRupees(gAmt), 'Enter a target amount'); if (!gName.trim()) throw new Error('Name your goal');
          const m = parseInt(gMonths, 10); const d = new Date(); if (m > 0) d.setMonth(d.getMonth() + m);
          await api.addGoal({ name: gName.trim(), emoji: gEmoji, target_paise: t, target_date: m > 0 ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined });
          setGName(''); setGAmt(''); setGMonths('');
        })} />
      </Card>

      <Title emoji="🧊">Cooling-off list</Title>
      <Card>
        <Muted>Want something? Add it here and wait 24–48h. If you still want it after, go for it. Most wishes fade 🧘</Muted>
        {!!wish.data?.skipped_count && <T w="bold" color="#0A9E7B">🧘 You've kept {formatRupees(wish.data.skipped_paise)} by waiting ({wish.data.skipped_count} skipped)</T>}
        {wish.data?.items.map((w) => (
          <View key={w.id} style={{ gap: 8, backgroundColor: C.skySoft, borderRadius: 20, padding: 12 }}>
            <Row><T style={{ flex: 1 }} w="black">{w.name}</T><T w="black">{formatRupees(w.price_paise)}</T></Row>
            <T size={13} w="semi" color={w.hours_left > 0 ? C.sub : '#0A9E7B'}>{w.hours_left > 0 ? `🧊 Cooling off · ready in ${w.hours_left}h` : '🔥 Cooled off. Still want it?'}</T>
            <Row>
              <Btn kind="mint" label="Skip it 💪" onPress={() => run(() => api.decideWish(w.id, 'skipped'))} style={{ flex: 1, paddingVertical: 10 }} />
              <Btn kind="soft" label="Buy it" disabled={w.hours_left > 0} onPress={() => run(() => api.decideWish(w.id, 'bought'))} style={{ flex: 1, paddingVertical: 10 }} />
            </Row>
          </View>
        ))}
        <Row><View style={{ flex: 2 }}><Field label="I want…" value={wName} onChangeText={setWName} placeholder="Sneakers" /></View><View style={{ flex: 1 }}><Field label="Price ₹" value={wPrice} onChangeText={setWPrice} keyboardType="decimal-pad" /></View></Row>
        <Chips><Chip label="Wait 24h" active={wHours === 24} onPress={() => setWHours(24)} /><Chip label="Wait 48h" active={wHours === 48} onPress={() => setWHours(48)} /></Chips>
        <Btn kind="soft" label="Add to cooling-off list" onPress={() => run(async () => {
          const pr = need(parseRupees(wPrice), 'Enter the price'); if (!wName.trim()) throw new Error('What do you want?');
          await api.addWish(wName.trim(), pr, wHours); setWName(''); setWPrice('');
        })} />
      </Card>

      <Title emoji="💵">Add income</Title>
      <Card>
        <Field label="Amount (₹): stipend, pocket money, cash in hand" value={iAmt} onChangeText={setIAmt} keyboardType="decimal-pad" />
        <Field label="Source" value={iSrc} onChangeText={setISrc} placeholder="Stipend, pocket money…" />
        <Muted>Received into</Muted>
        <Chips>{data.accounts.map((a) => <Chip key={a.id} label={a.name} active={a.id === iAcc} onPress={() => setIAcc(a.id)} color={C.mint} />)}</Chips>
        <Chips><Chip label="🔁 Regular (monthly)" active={iReg} onPress={() => setIReg(true)} color={C.mint} /><Chip label="⚡ One-off" active={!iReg} onPress={() => setIReg(false)} color={C.mint} /></Chips>
        <Btn label="Add income" onPress={() => run(async () => {
          await api.addIncome({ amount_paise: need(parseRupees(iAmt), 'Enter the income amount, like 15000'), source: iSrc, is_regular: iReg, account_id: iAcc }); setIAmt(''); setISrc('');
        })} />
        {income.data?.map((i) => (
          <Row key={i.id}>
            <Bubble emoji="💵" bg={C.mintSoft} size={38} />
            <View style={{ flex: 1 }}><T w="bold">{i.source || 'Income'}</T><Muted size={12}>{dayLabel(i.received_at)}{i.is_regular ? ' · regular' : ''}</Muted></View>
            <Money paise={i.amount_paise} w="black" color="#0A9E7B" />
            <Pressable onPress={() => run(() => api.deleteIncome(i.id))}><T color={C.sub}>✕</T></Pressable>
          </Row>
        ))}
      </Card>

      <Title emoji="🎚️">Your targets</Title>
      <Card>
        <Field label="Savings target (% of take-home)" value={pct} onChangeText={setPct} keyboardType="decimal-pad" />
        <Field label="Fixed needs per month (₹): rent, EMI, insurance…" value={fixed} onChangeText={setFixed} keyboardType="decimal-pad" />
        <Field label="Emergency fund saved so far (₹)" value={saved} onChangeText={setSaved} keyboardType="decimal-pad" />
        <Chips><Chip label="🗓️ Regular income" active={!irr} onPress={() => setIrr(false)} /><Chip label="🎢 Irregular income" active={irr} onPress={() => setIrr(true)} /></Chips>
        <Btn label="Save targets" onPress={() => run(async () => {
          const f = parseRupees(fixed), s = parseRupees(saved), n = parseFloat(pct);
          if (f === null || s === null || !(n >= 0 && n <= 100)) throw new Error('Check the numbers: rupees for amounts, 0 to 100 for the target %');
          await api.updateSettings({ savings_target_pct: n, fixed_needs_paise: f, emergency_saved_paise: s, income_irregular: irr ? 1 : 0 });
        })} />
      </Card>

      <Title emoji="👛">Accounts & cash wallets</Title>
      <Card>
        {data.accounts.map((a) => (
          <Row key={a.id}><Bubble emoji={a.kind === 'cash' ? '💵' : a.kind === 'wallet' ? '👛' : a.kind === 'card' ? '💳' : '🏦'} size={38} /><T style={{ flex: 1 }} w="bold">{a.name}</T><Money paise={a.balance_paise} w="black" color={a.balance_paise < 0 ? '#E0245E' : C.ink} /></Row>
        ))}
        <Field label="New account / wallet" value={aName} onChangeText={setAName} placeholder="Paytm wallet, cash in drawer…" />
        <Chips>{(['bank', 'cash', 'wallet', 'card'] as AccountKind[]).map((k) => <Chip key={k} label={k} active={k === aKind} onPress={() => setAKind(k)} />)}</Chips>
        <Field label="Opening balance (₹)" value={aOpen} onChangeText={setAOpen} keyboardType="decimal-pad" placeholder="0" />
        <Btn kind="soft" label="Add account" onPress={() => run(async () => {
          const o = aOpen ? parseRupees(aOpen) : 0; if (!aName.trim() || o === null) throw new Error('Give it a name and a valid opening balance');
          await api.addAccount(aKind, aName.trim(), o); setAName(''); setAOpen('');
        })} />
      </Card>
      </>)}
    </Screen>
  );
}
