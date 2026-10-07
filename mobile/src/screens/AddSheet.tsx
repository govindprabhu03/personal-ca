// Quick add (amount + what for) or Chat add ("chai 20, auto 60"). The app suggests the verdict as you type; one tap fixes it.
import React, { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { parseChat, stampFor } from '../../../shared/chat';
import { BUCKET_EMOJI, CATEGORY_EMOJI } from '../../../shared/labels';
import { formatRupees, parseRupees } from '../../../shared/money';
import type { Bootstrap, PaymentMethod, Suggestion, Tx } from '../../../shared/types';
import { api } from '../api';
import { useSyncState } from '../offline';
import { bucketOf, C, F } from '../theme';
import { Btn, Bubble, BucketTag, Burst, Chip, Chips, ErrorText, Field, Muted, Pop, Row, T } from '../ui';

const METHODS: [PaymentMethod, string][] = [['upi', '📲 UPI'], ['cash', '💵 Cash'], ['card', '💳 Card'], ['bnpl', '⏳ Pay-later']];
const CHEER = { need: 'Smart move, that is a need 🌱', want: "Treat yourself, you've got a plan ✨", waste: 'Noted. No judgement, we learn 🫠', ignore: 'Logged, not counted as spend 🔕' };

export function AddSheet({ data, visible, onClose, bump }: { data: Bootstrap; visible: boolean; onClose: () => void; bump: () => void }) {
  const sy = useSyncState();
  const [mode, setMode] = useState<'quick' | 'chat'>('quick');
  const [amount, setAmount] = useState('');
  const [text, setText] = useState('');
  const [chat, setChat] = useState('');
  const [method, setMethod] = useState<PaymentMethod>(data.last.payment_method);
  const [picked, setPicked] = useState<number | null>(null);
  const [sug, setSug] = useState<Suggestion | null>(null);
  const [saved, setSaved] = useState<Tx[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!text.trim()) return setSug(null);
    const h = setTimeout(() => api.suggest(text, new Date().getHours()).then(setSug).catch(() => {}), 250);
    return () => clearTimeout(h);
  }, [text]);

  const lastCat = data.last.category_id;
  // offline, the phone's own rules answer and give a name but no database id, so find the id by name
  const sugId = sug ? (sug.category_id ?? data.categories.find((c) => c.name === sug.category)?.id ?? null) : null;
  const shown = picked ?? (sug && sug.confidence >= 0.6 ? sugId : text.trim() ? null : lastCat);
  const items = useMemo(() => parseChat(chat), [chat]);
  const reset = () => { setAmount(''); setText(''); setChat(''); setPicked(null); setSug(null); setSaved(null); setErr(''); };
  const close = () => { reset(); onClose(); };

  const save = async () => {
    try {
      if (mode === 'quick') {
        const paise = parseRupees(amount);
        if (!paise) return setErr('Enter a valid amount, like 120 or 45.50');
        setSaved([await api.addTx({ amount_paise: paise, merchant_raw: text.trim(), payment_method: method, category_id: picked ?? (text.trim() ? undefined : lastCat) })]);
      } else {
        if (!items.length) return setErr('Try something like: chai 20, auto 60');
        setSaved(await api.addBulk(items.map((i) => ({ amount_paise: i.amount_paise, merchant_raw: i.merchant, payment_method: i.payment_method ?? method, occurred_at: stampFor(i.day_offset) }))));
      }
      setErr(''); bump();
    } catch (e: any) { setErr(e.message); }
  };
  const fixSaved = async (id: number, category_id: number) => {
    const t = await api.patchTx(id, { category_id }); // undefined if it was queued offline: the sync will apply it
    if (t) setSaved((cur) => cur && cur.map((x) => (x.id === id ? t : x)));
    bump();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#1E1B3A99' }}>
        <Pressable style={{ flex: 1 }} onPress={close} />
        <View style={{ backgroundColor: C.card, borderTopLeftRadius: 32, borderTopRightRadius: 32, padding: 18, paddingTop: 10, maxHeight: '90%', width: '100%', maxWidth: 560, alignSelf: 'center' }}>
          <View style={{ alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: C.line, marginBottom: 12 }} />
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 14, paddingBottom: 8 }}>
            {saved ? (
              <View style={{ gap: 14 }}>
                <Burst />
                <Pop style={{ alignItems: 'center', gap: 4 }}>
                  <T size={46}>{saved.length > 1 ? '🎉' : (CATEGORY_EMOJI[saved[0].category_name ?? 'Other'] ?? '🎉')}</T>
                  <T size={24} w="black">{saved.length > 1 ? `${saved.length} spends logged!` : 'Logged!'}</T>
                  {saved.length === 1 && <Muted center>{CHEER[saved[0].bucket]}</Muted>}
                </Pop>
                {!sy.online && saved.some((t) => t.pending) && (
                  <View style={{ backgroundColor: C.skySoft, borderRadius: 16, padding: 12 }}>
                    <T size={13} w="semi" color="#1B6FA8">📴 Saved on your phone and already counted in your numbers. It will sync automatically when you're back online.</T>
                  </View>
                )}
                {saved.map((t) => (
                  <View key={t.id} style={{ gap: 8 }}>
                    <Row>
                      <Bubble emoji={CATEGORY_EMOJI[t.category_name ?? 'Other'] ?? '✨'} bg={bucketOf(t.bucket).bg} size={40} />
                      <View style={{ flex: 1 }}><T w="bold">{t.merchant_raw || t.category_name}</T><Muted size={12}>{t.category_name}</Muted></View>
                      <T w="black">{formatRupees(t.amount_paise)}</T><BucketTag bucket={t.bucket} />
                    </Row>
                    {t.needs_review && !t.pending && (
                      <>
                        <T size={13} color="#C77F00" w="semi">🤔 Not sure about this one. Tap the right category:</T>
                        <Chips>{data.categories.map((c) => <Chip key={c.id} label={`${CATEGORY_EMOJI[c.name] ?? ''} ${c.name}`} active={c.id === t.category_id} onPress={() => fixSaved(t.id, c.id)} />)}</Chips>
                      </>
                    )}
                  </View>
                ))}
                <Row><Btn kind="soft" label="Add another" onPress={reset} style={{ flex: 1 }} /><Btn label="Done" onPress={close} style={{ flex: 1 }} /></Row>
              </View>
            ) : (
              <>
                <Row>
                  <Chip label="⚡ Quick add" active={mode === 'quick'} onPress={() => setMode('quick')} />
                  <Chip label="💬 Chat add" active={mode === 'chat'} onPress={() => setMode('chat')} />
                </Row>
                {mode === 'quick' ? (
                  <>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <T size={40} w="black" color={C.violet}>₹</T>
                      <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0" placeholderTextColor="#CFC8EE" autoFocus
                        style={{ flex: 1, fontSize: 48, fontFamily: F.black, color: C.ink, paddingVertical: 0 }} />
                    </View>
                    <Field label="What for? (chai, Zomato, auto…)" value={text} onChangeText={setText} placeholder="optional" onSubmitEditing={save} />
                    {sug && sug.confidence >= 0.6 && picked === null && (
                      <T size={13} w="semi" color={bucketOf(sug.bucket).fg}>{BUCKET_EMOJI[sug.bucket]} Looks like {sug.category}, a {sug.bucket}. Tap below if I'm wrong.</T>
                    )}
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      {data.categories.map((c) => {
                        const on = c.id === shown;
                        return (
                          <Pressable key={c.id} onPress={() => setPicked(c.id)} style={{ width: '23.4%', alignItems: 'center', gap: 3, paddingVertical: 9, borderRadius: 18, borderWidth: 2, borderColor: on ? C.violet : C.line, backgroundColor: on ? C.violetSoft : '#fff' }}>
                            <T size={22}>{CATEGORY_EMOJI[c.name] ?? '✨'}</T>
                            <T size={10} w="semi" color={on ? C.violet : C.sub} center style={{ paddingHorizontal: 2 }}>{c.name.split(' & ')[0]}</T>
                          </Pressable>
                        );
                      })}
                    </View>
                    <Chips>{METHODS.map(([m, l]) => <Chip key={m} label={l} active={m === method} onPress={() => setMethod(m)} color={C.mint} />)}</Chips>
                  </>
                ) : (
                  <>
                    <Muted>Type it like you'd text a friend. Commas split entries. Try “yesterday swiggy 340 cash”.</Muted>
                    <TextInput value={chat} onChangeText={setChat} multiline autoFocus placeholder="chai 20, auto 60, lunch 120" placeholderTextColor="#CFC8EE"
                      style={{ minHeight: 96, backgroundColor: C.bg, borderRadius: 20, borderWidth: 2, borderColor: C.line, padding: 14, fontSize: 18, fontFamily: F.semi, color: C.ink, textAlignVertical: 'top' }} />
                    {items.length > 0 && (
                      <View style={{ gap: 6 }}>
                        <T size={13} w="bold" color={C.mint}>I understood {items.length} {items.length > 1 ? 'entries' : 'entry'} 👇</T>
                        {items.map((i, k) => (
                          <Row key={k} style={{ backgroundColor: C.mintSoft, borderRadius: 16, padding: 10 }}>
                            <T style={{ flex: 1 }} w="semi">{i.merchant || 'Something'}{i.day_offset ? ' · yesterday' : ''}{i.payment_method ? ` · ${i.payment_method}` : ''}</T>
                            <T w="black">{formatRupees(i.amount_paise)}</T>
                          </Row>
                        ))}
                      </View>
                    )}
                    <Chips>{METHODS.map(([m, l]) => <Chip key={m} label={l} active={m === method} onPress={() => setMethod(m)} color={C.mint} />)}</Chips>
                    <Muted size={12}>Default payment method for entries that don't say one.</Muted>
                  </>
                )}
                <ErrorText error={err} />
                <Btn label={mode === 'chat' && items.length > 1 ? `Log all ${items.length} 🎉` : 'Log it 🎉'} onPress={save} />
              </>
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
