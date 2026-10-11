// "Tell us about you": asked once after sign-in (and editable from More). The answers decide which income heads and which ITR form the
// tax screens lead with, so they are kept in the account like everything else.
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import type { Profile, TaxpayerType } from '../../../shared/types';
import { api } from '../api';
import { C } from '../theme';
import { Btn, Card, Chip, Chips, ErrorText, Muted, T } from '../ui';

export const TYPE_INFO: Array<{ id: TaxpayerType; emoji: string; label: string; hint: string }> = [
  { id: 'salaried', emoji: '💼', label: 'Salaried', hint: 'Salary with a Form 16, maybe HRA and 80C/80D' },
  { id: 'professional', emoji: '🧑‍💻', label: 'Freelancer / professional', hint: 'Doctor, designer, developer, consultant…' },
  { id: 'business', emoji: '🏪', label: 'Business owner', hint: 'Shop, trading, services with turnover' },
  { id: 'investor', emoji: '📈', label: 'Investor', hint: 'Shares, mutual funds, property or gold gains' },
  { id: 'pensioner', emoji: '🌿', label: 'Pensioner', hint: 'Pension and interest income' },
  { id: 'other', emoji: '✨', label: 'Something else', hint: 'Student, homemaker, rental income only…' },
];
export const typeLabel = (t: TaxpayerType) => { const i = TYPE_INFO.find((x) => x.id === t)!; return `${i.emoji} ${i.label}`; };

export function Onboarding({ initial, onDone, onClose }: { initial: Profile; onDone: () => void; onClose?: () => void }) {
  const [types, setTypes] = useState<TaxpayerType[]>(initial.taxpayer_types);
  const [age, setAge] = useState(initial.age_group);
  const [res, setRes] = useState(initial.residency);
  const [regime, setRegime] = useState(initial.regime_pref);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const toggle = (t: TaxpayerType) => setTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  const save = async () => {
    if (!types.length) { setErr('Pick at least one that describes you. You can change it any time.'); return; }
    setBusy(true); setErr('');
    try { await api.saveProfile({ taxpayer_types: types, age_group: age, residency: res, regime_pref: regime, onboarded: true }); onDone(); }
    catch (e: any) { setErr(e?.message ?? 'Could not save. Try again.'); } finally { setBusy(false); }
  };
  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 18, gap: 14, maxWidth: 560, width: '100%', alignSelf: 'center' }}>
      <View style={{ gap: 4, paddingTop: 8 }}>
        <T size={30}>👋</T>
        <T size={26} w="black">Let's get to know you</T>
        <Muted>Your answers shape the tax tools: which income to ask about and which return (ITR) form fits you. You can change them later in More.</Muted>
      </View>

      <Card style={{ gap: 10 }}>
        <T w="black">What best describes you? <Muted size={12}>(pick all that apply)</Muted></T>
        {TYPE_INFO.map((i) => {
          const on = types.includes(i.id);
          return (
            <View key={i.id} style={{ borderRadius: 16, borderWidth: 2, borderColor: on ? C.violet : C.line, backgroundColor: on ? C.violetSoft : 'transparent', padding: 12 }}>
              <Chip label={`${i.emoji} ${i.label}${on ? '  ✓' : ''}`} active={on} onPress={() => toggle(i.id)} />
              <Muted size={12} style={{ marginTop: 6 }}>{i.hint}</Muted>
            </View>
          );
        })}
      </Card>

      <Card style={{ gap: 10 }}>
        <T w="black">Your age group</T>
        <Chips>
          <Chip label="Under 60" active={age === 'under60'} onPress={() => setAge('under60')} />
          <Chip label="60 to 79" active={age === 'senior'} onPress={() => setAge('senior')} />
          <Chip label="80 and above" active={age === 'super_senior'} onPress={() => setAge('super_senior')} />
        </Chips>
        <Muted size={12}>Senior citizens get higher tax-free limits under the old regime.</Muted>
      </Card>

      <Card style={{ gap: 10 }}>
        <T w="black">Residency for tax</T>
        <Chips>
          <Chip label="Resident in India" active={res === 'resident'} onPress={() => setRes('resident')} />
          <Chip label="NRI" active={res === 'nri'} onPress={() => setRes('nri')} />
        </Chips>
        {res === 'nri' && <Muted size={12}>NRIs have different rules (no new-regime rebate, different forms). We'll flag where our guidance doesn't fully apply and suggest a CA for those parts.</Muted>}
      </Card>

      <Card style={{ gap: 10 }}>
        <T w="black">Tax regime</T>
        <Chips>
          <Chip label="Compare both for me" active={regime === 'auto'} onPress={() => setRegime('auto')} />
          <Chip label="New regime" active={regime === 'new'} onPress={() => setRegime('new')} />
          <Chip label="Old regime" active={regime === 'old'} onPress={() => setRegime('old')} />
        </Chips>
        <Muted size={12}>Not sure? "Compare both" shows which one costs you less.</Muted>
      </Card>

      <ErrorText error={err} />
      <Btn label={busy ? 'Saving…' : 'Continue'} disabled={busy} onPress={save} />
      {onClose && <Btn kind="ghost" label="Cancel" onPress={onClose} />}
      <Muted size={11} center>This is guidance to help you prepare. It isn't a substitute for a practising Chartered Accountant for audits or certifications.</Muted>
    </ScrollView>
  );
}
