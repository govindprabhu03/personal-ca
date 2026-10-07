// Splits & IOUs. Paying for friends would inflate your spending, so only YOUR share counts as a spend;
// what they owe you is tracked here, and paying you back is never income.
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { computeShares, parseNames } from '../../../shared/splits';
import { formatRupees, parseRupees } from '../../../shared/money';
import { api } from '../api';
import { useLoad } from '../hooks';
import type { ScreenProps } from '../state';
import { C } from '../theme';
import { Btn, Bubble, Card, Chip, Chips, ErrorText, Field, Muted, Row, T, Title } from '../ui';
import { dayLabel } from '../util';

export function FriendsSection({ version, bump }: ScreenProps) {
  const q = useLoad(() => api.ious(), [version]);
  const s = q.data;
  const [total, setTotal] = useState(''); const [what, setWhat] = useState(''); const [names, setNames] = useState('');
  const [payer, setPayer] = useState<string | null>(null); const [mine, setMine] = useState('');
  const [iPerson, setIPerson] = useState(''); const [iAmt, setIAmt] = useState(''); const [iKind, setIKind] = useState<'lent' | 'borrowed'>('lent');
  const [part, setPart] = useState<string | null>(null); const [partAmt, setPartAmt] = useState('');
  const [err, setErr] = useState('');

  const friends = parseNames(names);
  const effPayer = payer && friends.some((f) => f.toLowerCase() === payer.toLowerCase()) ? friends.find((f) => f.toLowerCase() === payer.toLowerCase())! : null;
  const preview = useMemo(() => {
    const t = parseRupees(total);
    if (!t || !friends.length) return null;
    try { return computeShares({ total: t, friends, payer: effPayer, myShare: mine ? parseRupees(mine) ?? undefined : undefined }); } catch { return null; }
  }, [total, names, effPayer, mine]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (f: () => Promise<unknown>) => { try { setErr(''); await f(); bump(); } catch (e: any) { setErr(e.message); } };
  const open = (s?.people ?? []).filter((p) => p.balance_paise !== 0);
  const settled = (s?.people.length ?? 0) - open.length;

  return (
    <>
      <ErrorText error={err || q.error} />
      <Row>
        <View style={{ flex: 1, backgroundColor: C.mintSoft, borderRadius: 22, padding: 14, gap: 2 }}><T size={20}>💚</T><T size={20} w="black">{formatRupees(s?.owed_to_me_paise ?? 0)}</T><Muted size={12}>friends owe you</Muted></View>
        <View style={{ flex: 1, backgroundColor: C.pinkSoft, borderRadius: 22, padding: 14, gap: 2 }}><T size={20}>💔</T><T size={20} w="black">{formatRupees(s?.i_owe_paise ?? 0)}</T><Muted size={12}>you owe</Muted></View>
      </Row>

      {open.map((p) => {
        const owes = p.balance_paise > 0;
        return (
          <Card key={p.person} style={{ gap: 10 }}>
            <Row>
              <Bubble emoji={owes ? '😊' : '🙏'} bg={owes ? C.mintSoft : C.pinkSoft} />
              <View style={{ flex: 1 }}><T w="black">{p.person}</T><T size={13} w="bold" color={owes ? '#0A9E7B' : '#E0245E'}>{owes ? 'owes you' : 'you owe'} {formatRupees(Math.abs(p.balance_paise))}</T></View>
            </Row>
            {p.entries.slice(0, 3).map((e) => (
              <Row key={e.id} style={{ justifyContent: 'space-between' }}>
                <Muted size={12}>{dayLabel(e.occurred_at)} · {e.note}</Muted>
                <T size={12} w="bold" color={e.delta_paise > 0 ? '#0A9E7B' : '#E0245E'}>{e.delta_paise > 0 ? '+' : '−'}{formatRupees(Math.abs(e.delta_paise))}</T>
              </Row>
            ))}
            {part === p.person ? (
              <Row>
                <View style={{ flex: 1 }}><Field label="How much? (₹)" value={partAmt} onChangeText={setPartAmt} keyboardType="decimal-pad" /></View>
                <Btn label="Settle" style={{ marginTop: 20 }} onPress={() => run(async () => { const a = parseRupees(partAmt); if (!a) throw new Error('Enter an amount'); await api.settle(p.person, a); setPart(null); setPartAmt(''); })} />
              </Row>
            ) : (
              <Row>
                <Btn kind="mint" label={owes ? 'Paid me back ✅' : 'I paid them ✅'} onPress={() => run(() => api.settle(p.person))} style={{ flex: 1.4, paddingVertical: 10 }} />
                <Btn kind="ghost" label="Part" onPress={() => setPart(p.person)} style={{ flex: 1, paddingVertical: 10 }} />
              </Row>
            )}
          </Card>
        );
      })}
      {open.length === 0 && <Card style={{ alignItems: 'center', paddingVertical: 24 }}><T size={40}>🤝</T><T w="black">All square!</T><Muted center>No one owes anyone. Split a spend or add an IOU below.</Muted></Card>}
      {settled > 0 && open.length > 0 && <Muted center>Settled up with {settled} {settled === 1 ? 'friend' : 'friends'} 🎉</Muted>}

      <Title emoji="🍕">Split a spend</Title>
      <Card>
        <Row><View style={{ flex: 1 }}><Field label="Total paid (₹)" value={total} onChangeText={setTotal} keyboardType="decimal-pad" /></View><View style={{ flex: 1.4 }}><Field label="What for?" value={what} onChangeText={setWhat} placeholder="Dinner, cab…" /></View></Row>
        <Field label="Split with (names, comma separated)" value={names} onChangeText={setNames} placeholder="Ria, Sam" />
        {friends.length > 0 && (
          <>
            <Muted>Who paid?</Muted>
            <Chips>
              <Chip label="🙋 Me" active={effPayer === null} onPress={() => setPayer(null)} />
              {friends.map((f) => <Chip key={f} label={f} active={effPayer === f} onPress={() => setPayer(f)} color={C.pink} />)}
            </Chips>
          </>
        )}
        <Field label="Your share (₹), blank = equal split" value={mine} onChangeText={setMine} keyboardType="decimal-pad" placeholder="equal" />
        {preview && (
          <View style={{ backgroundColor: C.mintSoft, borderRadius: 16, padding: 12, gap: 3 }}>
            <T size={13} w="bold">You {formatRupees(preview.mine)} · {preview.shares.map((x) => `${x.person} ${formatRupees(x.paise)}`).join(' · ')}</T>
            <T size={12} color={C.sub}>{preview.mine > 0 ? `Only ${formatRupees(preview.mine)} counts as your spend. ` : 'None of this counts as your spend. '}{effPayer ? `You'll owe ${effPayer} ${formatRupees(preview.mine)}.` : `Friends owe you ${formatRupees(preview.shares.reduce((a, x) => a + x.paise, 0))}.`}</T>
          </View>
        )}
        <Btn label="Split it 🤝" onPress={() => run(async () => {
          const t = parseRupees(total);
          if (!t) throw new Error('Enter the total amount');
          const m = mine ? parseRupees(mine) : undefined;
          if (m === null) throw new Error('Your share is not a valid amount');
          await api.split({ amount_paise: t, merchant_raw: what.trim(), friends, paid_by: effPayer, my_share_paise: m });
          setTotal(''); setWhat(''); setNames(''); setMine(''); setPayer(null);
        })} />
      </Card>

      <Title emoji="💸">Quick IOU</Title>
      <Card>
        <Chips><Chip label="I lent them" active={iKind === 'lent'} onPress={() => setIKind('lent')} color={C.mint} /><Chip label="They lent me" active={iKind === 'borrowed'} onPress={() => setIKind('borrowed')} color={C.pink} /></Chips>
        <Row><View style={{ flex: 1.2 }}><Field label="Who?" value={iPerson} onChangeText={setIPerson} placeholder="Zoya" /></View><View style={{ flex: 1 }}><Field label="Amount (₹)" value={iAmt} onChangeText={setIAmt} keyboardType="decimal-pad" /></View></Row>
        <Btn kind="soft" label="Add IOU" onPress={() => run(async () => {
          const a = parseRupees(iAmt);
          if (!iPerson.trim() || !a) throw new Error('Add a name and an amount');
          await api.addIou({ person: iPerson.trim(), amount_paise: a, kind: iKind }); setIPerson(''); setIAmt('');
        })} />
      </Card>
    </>
  );
}
