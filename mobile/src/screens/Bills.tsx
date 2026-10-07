// Bill & EMI reminders: never pay a late fee again (a late fee is the purest waste).
import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { formatRupees, parseRupees } from '../../../shared/money';
import type { Bill } from '../../../shared/types';
import { api } from '../api';
import { useLoad } from '../hooks';
import { remindersSupported, syncReminders, testReminder } from '../reminders';
import type { ScreenProps } from '../state';
import { C } from '../theme';
import { Btn, Bubble, Card, Chip, Chips, ErrorText, Field, Muted, Row, T, Title } from '../ui';
import { dayLabel } from '../util';

const EMOJI = ['🧾', '💡', '📱', '🌐', '🏠', '🎓', '🚗', '🏦'];

export const billWhen = (b: Bill) =>
  b.status === 'overdue' ? `⚠️ Overdue by ${-b.days_until} day${b.days_until === -1 ? '' : 's'}`
  : b.paid_this_month ? `✅ Paid · next ${dayLabel(b.next_due)}`
  : b.days_until === 0 ? '🔔 Due today'
  : b.status === 'due_soon' ? `🔔 Due in ${b.days_until} day${b.days_until === 1 ? '' : 's'}`
  : `Due ${dayLabel(b.next_due)}`;

export function BillsSection({ version, bump }: ScreenProps) {
  const q = useLoad(() => api.bills(), [version]);
  const bills = q.data ?? [];
  const [name, setName] = useState(''); const [emoji, setEmoji] = useState('🧾'); const [kind, setKind] = useState<'bill' | 'emi'>('bill');
  const [amt, setAmt] = useState(''); const [day, setDay] = useState(''); const [remind, setRemind] = useState(3); const [left, setLeft] = useState('');
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('');

  useEffect(() => { if (q.data) syncReminders(q.data).catch(() => {}); }, [q.data]); // keeps phone reminders in step, silently, once allowed
  const run = async (f: () => Promise<unknown>) => { try { setErr(''); await f(); bump(); } catch (e: any) { setErr(e.message); } };
  const total = bills.reduce((s, b) => s + b.amount_paise, 0);

  return (
    <>
      <ErrorText error={err || q.error} />
      <Card tint={C.violetSoft}>
        <Row><T size={34}>🧾</T><View style={{ flex: 1 }}><Muted size={12}>Your bills & EMIs, per month</Muted><T size={24} w="black">{formatRupees(total)}</T></View>
          <T size={13} w="bold" color={C.violet}>{bills.filter((b) => b.status !== 'upcoming').length} need attention</T></Row>
        {remindersSupported
          ? <Btn kind="soft" label="🔔 Remind me on my phone" onPress={async () => { const r = await syncReminders(bills, true); setMsg(r === 'ok' ? 'Reminders are on 🔔' : r === 'denied' ? 'Notifications are blocked. Allow them in phone settings.' : 'Reminders are not available here.'); }} />
          : <Muted size={12}>Phone reminders switch on in the mobile app. Here you still see everything under “Coming up”.</Muted>}
        {remindersSupported && (
          <Btn kind="ghost" label="🧪 Send a test reminder in 10 seconds" onPress={async () => {
            const r = await testReminder();
            setMsg(r === 'ok' ? 'Sent! Lock your phone or leave the app: a notification arrives in about 10 seconds.' : r === 'denied' ? 'Notifications are blocked. Allow them in phone settings.' : 'Notifications are not available here.');
          }} />
        )}
        {!!msg && <T size={13} w="semi" color="#0A9E7B">{msg}</T>}
      </Card>

      {bills.length === 0 && <Muted center>No bills yet. Add rent, wifi, phone, or an EMI below 👇</Muted>}
      {bills.map((b) => (
        <Card key={b.id} tint={b.status === 'overdue' ? C.pinkSoft : b.status === 'due_soon' ? C.sunSoft : undefined} style={{ gap: 10 }}>
          <Row>
            <Bubble emoji={b.emoji} bg="#fff" />
            <View style={{ flex: 1 }}>
              <T w="black">{b.name}{b.kind === 'emi' && b.installments_left ? ` · ${b.installments_left} left` : ''}</T>
              <T size={13} w="semi" color={b.status === 'overdue' ? '#C21B52' : C.sub}>{billWhen(b)}</T>
            </View>
            <T w="black">{formatRupees(b.amount_paise)}</T>
            <Pressable onPress={() => run(() => api.deleteBill(b.id))}><T color={C.sub}>✕</T></Pressable>
          </Row>
          {!(b.paid_this_month && b.status === 'upcoming') && (
            <Row>
              <Btn kind="mint" label="Paid ✅" onPress={() => run(() => api.payBill(b.id, true, b.name))} style={{ flex: 1, paddingVertical: 10 }} />
              <Btn kind="ghost" label="Paid, already logged" onPress={() => run(() => api.payBill(b.id, false, b.name))} style={{ flex: 1.3, paddingVertical: 10 }} />
            </Row>
          )}
        </Card>
      ))}

      <Title emoji="➕">Add a bill or EMI</Title>
      <Card>
        <Chips>{EMOJI.map((e) => <Chip key={e} label={e} active={e === emoji} onPress={() => setEmoji(e)} />)}</Chips>
        <Chips><Chip label="🧾 Bill" active={kind === 'bill'} onPress={() => setKind('bill')} /><Chip label="🏦 EMI" active={kind === 'emi'} onPress={() => setKind('emi')} /></Chips>
        <Field label="Name" value={name} onChangeText={setName} placeholder="Wifi, Phone EMI, Rent…" />
        <Row>
          <View style={{ flex: 1 }}><Field label="Amount (₹)" value={amt} onChangeText={setAmt} keyboardType="decimal-pad" /></View>
          <View style={{ flex: 1 }}><Field label="Due day (1–31)" value={day} onChangeText={setDay} keyboardType="number-pad" maxLength={2} /></View>
        </Row>
        <Muted>Remind me</Muted>
        <Chips>{[1, 3, 7].map((n) => <Chip key={n} label={`${n} day${n > 1 ? 's' : ''} before`} active={remind === n} onPress={() => setRemind(n)} color={C.mint} />)}</Chips>
        {kind === 'emi' && <Field label="Instalments left (optional)" value={left} onChangeText={setLeft} keyboardType="number-pad" placeholder="e.g. 8" />}
        <Muted size={12}>If this month's due day has already passed, I assume it's handled.</Muted>
        <Btn label="Add it" onPress={() => run(async () => {
          const a = parseRupees(amt), d = parseInt(day, 10);
          if (!name.trim()) throw new Error('Give it a name');
          if (!a) throw new Error('Enter the amount, like 599');
          if (!(d >= 1 && d <= 31)) throw new Error('Due day should be between 1 and 31');
          await api.addBill({ name: name.trim(), emoji, kind, amount_paise: a, due_day: d, remind_days: remind, installments_left: kind === 'emi' && parseInt(left, 10) > 0 ? parseInt(left, 10) : undefined });
          setName(''); setAmt(''); setDay(''); setLeft('');
        })} />
      </Card>
    </>
  );
}
