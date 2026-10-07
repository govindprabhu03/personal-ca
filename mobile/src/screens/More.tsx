// Your data, your control: statement import (CSV or PDF), CSV export, encrypted backup/restore, app lock, delete-everything.
import React, { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { CATEGORY_EMOJI } from '../../../shared/labels';
import { formatRupees } from '../../../shared/money';
import type { ImportResult } from '../../../shared/types';
import { api } from '../api';
import { useLock } from '../lock';
import { getSync, useSyncState } from '../offline';
import { normaliseUrl, saveServer } from '../server';
import { confirmAsk, pickStatement, pickText, saveText, StatementSource } from '../platform';
import type { ScreenProps } from '../state';
import { bucketOf, C } from '../theme';
import { Btn, Bubble, BucketTag, Card, Chip, Chips, ErrorText, Field, Muted, Row, Screen, T, Title } from '../ui';

const payload = (s: StatementSource, password: string) => (s.kind === 'csv' ? { csv: s.text } : { pdf_base64: s.base64, password: password || undefined });

export function More({ bump }: ScreenProps) {
  const lock = useLock();
  const sy = useSyncState();
  const [srvUrl, setSrvUrl] = useState(''); const [srvToken, setSrvToken] = useState(''); const [srvMsg, setSrvMsg] = useState('');
  const [pair, setPair] = useState<{ urls: string[]; token: string | null } | null>(null);
  useEffect(() => {
    const s = getSync().getServer(); setSrvUrl(s.base); setSrvToken(s.token ?? '');
    if (Platform.OS === 'web') api.pairing().then(setPair, () => {}); // the web page (e.g. served by the PC program) can show what a phone needs
  }, []);
  const connect = async () => {
    try {
      setErr('');
      const url = normaliseUrl(srvUrl);
      if (!url) throw new Error("Enter your PC's address, like 192.168.0.150");
      await saveServer({ url, token: srvToken.trim() });
      getSync().setServer({ base: url, token: srvToken.trim() });
      setSrvUrl(url);
      const reached = await getSync().ping();
      setSrvMsg(getSync().getSnapshot().authFailed ? "🔑 Reached your PC, but it didn't accept that token." : reached ? '✅ Connected. Your data is syncing.' : "❌ Couldn't reach your PC. Same Wi-Fi? Is the Personal CA program running on it?");
      bump();
    } catch (e: any) { setErr(e.message); }
  };
  const [src, setSrc] = useState<StatementSource | null>(null);
  const [prev, setPrev] = useState<ImportResult | null>(null);
  const [credits, setCredits] = useState(false);
  const [pdfPw, setPdfPw] = useState('');
  const [needPw, setNeedPw] = useState<'pdf_password_required' | 'pdf_password_wrong' | null>(null);
  const [pass, setPass] = useState('');
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const run = async (f: () => Promise<unknown>) => { try { setErr(''); await f(); } catch (e: any) { setErr(e.message); } };
  /** Preview a statement. A password-protected PDF is not an error here: it just asks for the password. */
  const preview = async (s: StatementSource, inc: boolean, pw = '') => {
    try {
      setErr(''); setNeedPw(null);
      setPrev(await api.importStatement(payload(s, pw), false, inc));
    } catch (e: any) {
      setPrev(null);
      if (e.code === 'pdf_password_required' || e.code === 'pdf_password_wrong') { setNeedPw(e.code); if (e.code === 'pdf_password_wrong') setErr(e.message); }
      else setErr(e.message);
    }
  };
  const reset = () => { setPrev(null); setSrc(null); setNeedPw(null); setPdfPw(''); };

  return (
    <Screen>
      <ErrorText error={err} />
      {!!msg && <View style={{ backgroundColor: C.mintSoft, borderRadius: 16, padding: 12 }}><T w="bold" color="#0A9E7B">✅ {msg}</T></View>}

      <Title emoji="🔌">Connect to your PC</Title>
      <Card>
        <Muted>Your data lives on this device and syncs with the Personal CA program on your PC. Enter its address and access token once (the PC shows both).</Muted>
        <Field label="PC address" value={srvUrl} onChangeText={setSrvUrl} placeholder="192.168.0.150" autoCapitalize="none" keyboardType="url" />
        <Field label="Access token" value={srvToken} onChangeText={setSrvToken} autoCapitalize="none" secureTextEntry />
        <Btn label="Save & connect" onPress={connect} />
        {!!srvMsg && <T size={13} w="semi">{srvMsg}</T>}
        {pair && (
          <View style={{ backgroundColor: C.violetSoft, borderRadius: 14, padding: 12, gap: 4 }}>
            <T size={13} w="black" color={C.violet}>📱 To connect the phone app, enter these in it:</T>
            {pair.token ? (
              <>
                {pair.urls.map((u) => <T key={u} size={14} w="bold">{u}</T>)}
                <T size={12} color={C.sub}>Access token:</T>
                <T size={14} w="bold">{pair.token}</T>
              </>
            ) : <T size={12} color={C.sub}>Phone access is off. Start the server with "npm run phone" (or use the Personal CA program) to enable it.</T>}
          </View>
        )}
      </Card>

      <Title emoji="📴">Offline & sync</Title>
      <Card>
        <Row>
          <Bubble emoji={!sy.online ? '📴' : sy.syncing ? '🔄' : sy.pending.length ? '⏳' : '✅'} bg={!sy.online ? C.skySoft : sy.pending.length ? C.sunSoft : C.mintSoft} size={42} />
          <View style={{ flex: 1 }}>
            <T w="black">{!sy.online ? 'Offline' : sy.syncing ? 'Syncing…' : sy.pending.length ? `${sy.pending.length} waiting to sync` : 'All synced'}</T>
            <Muted size={12}>{sy.lastSync ? `Last synced ${sy.lastSync.slice(0, 10)} ${sy.lastSync.slice(11, 16)}` : 'Nothing has needed syncing yet'}</Muted>
          </View>
          <Btn kind="soft" label="Sync now" onPress={() => run(async () => { getSync().requestPull(); await getSync().ping(); bump(); })} style={{ paddingVertical: 8, paddingHorizontal: 14 }} />
        </Row>
        <Muted size={12}>Your whole app runs on a database on this phone (encrypted), so everything works with no signal: every screen and every number. Changes are sent to the server when you're online, and your phone refreshes from it afterwards. Only imports, backups, restore, erase and Ask your CA need a connection.</Muted>
        {sy.authFailed && (
          <View style={{ backgroundColor: C.pinkSoft, borderRadius: 14, padding: 10, gap: 4 }}>
            <T size={13} w="black" color="#C21B52">🔑 The server doesn't accept this app's access token</T>
            <T size={12} color="#C21B52">Nothing is lost: your changes are safe on this phone and will send once it's fixed. Fix it in "Connect to your PC" above: the token must match the one shown by the Personal CA program on your PC.</T>
          </View>
        )}
        {sy.pending.map((o) => <Muted key={o.id} size={12}>⏳ {o.label}</Muted>)}
        {sy.rejected.map((r) => (
          <View key={r.op.id} style={{ backgroundColor: C.pinkSoft, borderRadius: 14, padding: 10, gap: 6 }}>
            <T size={13} w="semi" color="#C21B52">⚠️ Couldn't save “{r.op.label}”: {r.error}</T>
            <Btn kind="ghost" label="Dismiss" onPress={() => getSync().dismissRejected(r.op.id)} style={{ paddingVertical: 6 }} />
          </View>
        ))}
      </Card>

      <Title emoji="📥">Import a statement</Title>
      <Card>
        <Muted>Pick the CSV or PDF statement from your bank or UPI app. PDFs need a text layer (the ones banks email you), not a photo or scan. Importing the same file twice is safe: duplicates get skipped.</Muted>
        <Btn label="Choose CSV or PDF" onPress={() => run(async () => { const s = await pickStatement(); if (s) { setSrc(s); setMsg(''); setPdfPw(''); await preview(s, credits); } })} />

        {needPw && src?.kind === 'pdf' && (
          <>
            <T w="black">🔐 This PDF is password protected</T>
            <Muted size={12}>Banks often use your date of birth (like 15031999) or part of your PAN or phone number. The password is only used to open the file once. It isn't stored.</Muted>
            <Field label="PDF password" value={pdfPw} onChangeText={setPdfPw} secureTextEntry autoCapitalize="none" onSubmitEditing={() => preview(src, credits, pdfPw)} />
            <Btn label="Unlock" disabled={!pdfPw} onPress={() => preview(src, credits, pdfPw)} />
          </>
        )}

        {prev && !prev.header_found && <ErrorText error="I couldn't find the header row. It needs a Date column, a Narration/Description column, and Debit/Credit or Amount columns." />}
        {prev?.header_found && src && (
          <>
            <T w="black">{prev.format === 'pdf' ? '📄 PDF' : '📊 CSV'} · {prev.rows.length - prev.duplicates} new · {prev.duplicates} duplicates · {prev.credits_skipped} credits skipped</T>
            {prev.warnings.map((w) => (
              <View key={w} style={{ backgroundColor: C.sunSoft, borderRadius: 14, padding: 10 }}><T size={13} w="semi" color="#8A5A00">⚠️ {w}</T></View>
            ))}
            <Chips>
              <Chip label="Skip money received" active={!credits} onPress={() => { setCredits(false); preview(src, false, pdfPw); }} />
              <Chip label="Import it as income" active={credits} onPress={() => { setCredits(true); preview(src, true, pdfPw); }} />
            </Chips>
            {prev.rows.slice(0, 6).map((r, i) => (
              <Row key={i} style={{ opacity: r.duplicate ? 0.4 : 1 }}>
                <Bubble emoji={CATEGORY_EMOJI[r.category_name] ?? '✨'} bg={bucketOf(r.bucket).bg} size={38} />
                <View style={{ flex: 1 }}><T w="bold">{r.merchant}</T><Muted size={12}>{r.category_name} · {r.occurred_at.slice(0, 10)}</Muted></View>
                <View style={{ alignItems: 'flex-end', gap: 3 }}><T w="black">{formatRupees(r.amount_paise)}</T><BucketTag bucket={r.bucket} /></View>
              </Row>
            ))}
            {prev.rows.length > 6 && <Muted>…and {prev.rows.length - 6} more</Muted>}
            <Btn label={`Import ${prev.rows.length - prev.duplicates} spends`} disabled={prev.rows.length === prev.duplicates && !credits}
              onPress={() => run(async () => { const r = await api.importStatement(payload(src, pdfPw), true, credits); setMsg(`Imported ${r.imported}, skipped ${r.duplicates} duplicates.`); reset(); bump(); })} />
          </>
        )}
      </Card>

      <Title emoji="📤">Export & encrypted backup</Title>
      <Card>
        <Btn kind="soft" label="Export all spends (CSV)" onPress={() => run(async () => saveText('personal-ca-spends.csv', await api.exportCsv(), 'text/csv'))} />
        <Field label="Backup passphrase (min 6 characters, don't lose it!)" value={pass} onChangeText={setPass} secureTextEntry />
        <Row>
          <Btn kind="ghost" label="Create backup" style={{ flex: 1 }} disabled={pass.length < 6}
            onPress={() => run(async () => { await saveText('personal-ca-backup.json', (await api.backup(pass)).backup, 'application/json'); setMsg('Encrypted backup created.'); })} />
          <Btn kind="ghost" label="Restore" style={{ flex: 1 }} disabled={pass.length < 6}
            onPress={() => run(async () => {
              const t = await pickText();
              if (!t || !(await confirmAsk('Restore backup?', 'This replaces everything currently in the app.'))) return;
              await api.restore(pass, t); setMsg('Backup restored.'); bump();
            })} />
        </Row>
      </Card>

      <Title emoji="🔒">App lock</Title>
      <Card>
        {lock.hasPin ? (
          <>
            <T w="bold" color="#0A9E7B">PIN lock is on. It locks whenever you leave the app 🔐</T>
            <Btn kind="ghost" label="Turn off PIN lock" onPress={() => run(lock.clearPin)} />
          </>
        ) : (
          <>
            <Field label="Choose a 4–6 digit PIN" value={pin} onChangeText={(v) => setPin(v.replace(/\D/g, ''))} secureTextEntry keyboardType="number-pad" maxLength={6} />
            <Btn label="Turn on PIN lock" disabled={pin.length < 4} onPress={() => run(async () => { await lock.setPin(pin); setPin(''); setMsg('PIN lock is on.'); })} />
          </>
        )}
      </Card>

      <Title emoji="⚠️">Danger zone</Title>
      <Card tint={C.pinkSoft}>
        <Muted>Wipes every spend, income, goal, wish and learned rule. Export a backup first if unsure.</Muted>
        <Btn kind="danger" label="Delete all my data" onPress={() => run(async () => {
          if (await confirmAsk('Delete everything?', 'All your data will be erased. This cannot be undone.')) { await api.erase(); setMsg('Everything deleted. Fresh start 🌱'); bump(); }
        })} />
      </Card>
    </Screen>
  );
}
