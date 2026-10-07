// Ask your CA: chat with your own numbers. The server runs the AI and the maths; this screen only shows the conversation.
import React, { useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { api } from '../api';
import { C, F } from '../theme';
import { Chip, Chips, Muted, Row, T } from '../ui';

interface Msg { id: number; role: 'user' | 'assistant' | 'error'; text: string; tools?: string[] }

const LOOKED_AT: Record<string, string> = {
  spend_summary: 'spending summary', list_flags: 'waste flags', savings_status: 'savings status', safe_to_spend: 'safe-to-spend',
  find_transactions: 'your spends', monthly_report: 'monthly report', subscriptions: 'subscriptions', bills: 'bills', friends: 'friends ledger',
};
const IDEAS = ['How much did I spend on food delivery this month?', 'Am I on track with my savings?', 'What are my biggest leaks?', 'Any bills due soon?', 'Who owes me money?'];

export function AskSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const next = useRef(1);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    const history = msgs.filter((m) => m.role !== 'error').slice(-10).map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text }));
    setMsgs((m) => [...m, { id: next.current++, role: 'user', text: q }]);
    setInput(''); setBusy(true);
    try {
      const r = await api.ask(q, history);
      setMsgs((m) => [...m, { id: next.current++, role: 'assistant', text: r.answer, tools: r.tools_used }]);
    } catch (e: any) {
      setMsgs((m) => [...m, { id: next.current++, role: 'error', text: String(e?.message ?? e) }]);
    } finally { setBusy(false); }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#1E1B3A99' }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View style={{ backgroundColor: C.card, borderTopLeftRadius: 32, borderTopRightRadius: 32, height: '86%', width: '100%', maxWidth: 560, alignSelf: 'center', overflow: 'hidden' }}>
          <Row style={{ padding: 18, paddingBottom: 8, justifyContent: 'space-between' }}>
            <View><T size={22} w="black">Ask your CA 💬</T><Muted size={12}>Answers come from your own numbers</Muted></View>
            <Row>
              {msgs.length > 0 && <Chip label="Clear" onPress={() => setMsgs([])} />}
              <Pressable onPress={onClose} style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center' }}><T>✕</T></Pressable>
            </Row>
          </Row>

          <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled"
            onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
            {msgs.length === 0 && (
              <View style={{ gap: 12, paddingTop: 8 }}>
                <T size={44} center>🧠</T>
                <T w="black" size={18} center>Hey! What do you want to know?</T>
                <Muted center>Ask about spending, savings, bills, subscriptions or friends. Try one:</Muted>
                <Chips>{IDEAS.map((i) => <Chip key={i} label={i} onPress={() => send(i)} />)}</Chips>
              </View>
            )}
            {msgs.map((m) => (
              <View key={m.id} style={{ alignItems: m.role === 'user' ? 'flex-end' : 'flex-start', gap: 4 }}>
                <View style={{ maxWidth: '88%', borderRadius: 22, paddingHorizontal: 14, paddingVertical: 10,
                  backgroundColor: m.role === 'user' ? C.violet : m.role === 'error' ? C.pinkSoft : C.bg,
                  borderBottomRightRadius: m.role === 'user' ? 6 : 22, borderBottomLeftRadius: m.role === 'user' ? 22 : 6 }}>
                  <T size={15} color={m.role === 'user' ? '#fff' : m.role === 'error' ? '#C21B52' : C.ink} w={m.role === 'user' ? 'semi' : 'reg'}>{m.role === 'error' ? `😕 ${m.text}` : m.text}</T>
                </View>
                {!!m.tools?.length && <Muted size={11}>🔎 Looked at: {m.tools.map((t) => LOOKED_AT[t] ?? t).join(', ')}</Muted>}
              </View>
            ))}
            {busy && <Row style={{ alignSelf: 'flex-start', backgroundColor: C.bg, borderRadius: 22, paddingHorizontal: 14, paddingVertical: 10 }}><ActivityIndicator color={C.violet} /><Muted>Checking your numbers…</Muted></Row>}
          </ScrollView>

          <Row style={{ padding: 12, borderTopWidth: 1, borderTopColor: C.line }}>
            <TextInput value={input} onChangeText={setInput} onSubmitEditing={() => send(input)} placeholder="Ask anything about your money…" placeholderTextColor="#A9A4C4" returnKeyType="send"
              style={{ flex: 1, backgroundColor: C.bg, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 11, fontSize: 15, fontFamily: F.semi, color: C.ink }} />
            <Pressable onPress={() => send(input)} disabled={busy || !input.trim()} style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: C.violet, alignItems: 'center', justifyContent: 'center', opacity: busy || !input.trim() ? 0.4 : 1 }}>
              <T size={20} color="#fff" w="black">↑</T>
            </Pressable>
          </Row>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
