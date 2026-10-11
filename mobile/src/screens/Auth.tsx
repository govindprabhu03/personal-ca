// Sign in / create account (email or Google), and the gate that keeps everything behind it. One phone, one person: if someone else signs in
// here, the previous person's local data is cleared first, so nobody's data can ever end up in someone else's account.
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { ACCOUNT_MODE } from '../config';
import { explain, resendConfirmation, sendPasswordReset, signIn, signInWithGoogle, signOut, signUp, useAuth } from '../auth';
import { getSync } from '../offline';
import { C, GRAD } from '../theme';
import { Btn, Card, Chip, Chips, ErrorText, Field, Muted, T } from '../ui';
import { encryptedKv } from '../vault';

const OWNER = 'owner'; // which account the data on this phone belongs to

/** Before the app opens for an account: if this phone held another person's data, clear it. (First sign-in ever: adopt what is already here.) */
async function bindAccount(userId: string) {
  const owner = await encryptedKv.get(OWNER);
  if (owner && owner !== userId) await getSync().clearAll();
  await encryptedKv.set(OWNER, userId);
}

/** Signing out takes this person's data off the phone (it stays safe in their account). */
export async function signOutAndWipe() {
  await signOut();
  await getSync().clearAll();
  await encryptedKv.del(OWNER);
}

const Splash = ({ text }: { text: string }) => (
  <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 12 }}>
    <T size={56}>💜</T>
    <T size={28} w="black">Personal CA</T>
    <Muted>{text}</Muted>
  </View>
);

export function AuthGate({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const [bound, setBound] = useState<string | null>(null);
  const userId = auth.status === 'in' ? auth.userId : null;
  useEffect(() => {
    if (!userId) { setBound(null); return; }
    let alive = true;
    bindAccount(userId).then(() => { if (!alive) return; setBound(userId); getSync().requestPull(); getSync().ping().catch(() => {}); });
    return () => { alive = false; };
  }, [userId]);

  if (!ACCOUNT_MODE) return <>{children}</>; // the PC-served web version: your own PC, no accounts
  if (auth.status === 'loading') return <Splash text="Just a sec…" />;
  if (auth.status === 'out') return <AuthScreen />;
  if (bound !== auth.userId) return <Splash text="Opening your account…" />;
  return <>{children}</>;
}

type Mode = 'signin' | 'signup' | 'reset';

export function AuthScreen() {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState(false); // a new account that must click the emailed link before signing in

  const go = async (f: () => Promise<void>) => { setBusy(true); setErr(''); setNote(''); try { await f(); } catch (e) { setErr(explain(e)); } finally { setBusy(false); } };
  const emailOk = /^\S+@\S+\.\S+$/.test(email.trim());
  const submit = () => go(async () => {
    if (!emailOk) throw new Error('Enter a valid email address.');
    if (mode === 'reset') { await sendPasswordReset(email); setNote('If that email has an account, a reset link is on its way. Open it, choose a new password, then sign in here.'); setMode('signin'); return; }
    if (password.length < 8) throw new Error('Choose a password with at least 8 characters.');
    if (mode === 'signup') { if (await signUp(email, password)) { setConfirm(true); setNote(''); } return; }
    await signIn(email, password);
  });

  return (
    <LinearGradient colors={GRAD.night} style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 20, gap: 14, maxWidth: 480, width: '100%', alignSelf: 'center' }}>
        <View style={{ alignItems: 'center', gap: 6 }}>
          <T size={56}>💜</T>
          <T size={30} w="black" color="#fff">Personal CA</T>
          <T size={14} color="#FFFFFFCC" center>Your money, your taxes, your own space.</T>
        </View>

        <Card style={{ gap: 12 }}>
          {confirm ? (
            <>
              <T size={22} w="black">📬 Check your email</T>
              <Muted>We sent a confirmation link to {email.trim()}. Open it, then come back and sign in. (Look in spam if it isn't there after a minute.)</Muted>
              <ErrorText error={err} />
              {!!note && <T size={13} w="semi" color={C.mint}>{note}</T>}
              <Btn label="I've confirmed. Sign in" onPress={() => { setConfirm(false); setMode('signin'); }} />
              <Btn kind="ghost" label="Resend the email" disabled={busy} onPress={() => go(async () => { await resendConfirmation(email); setNote('Sent again.'); })} />
            </>
          ) : (
            <>
              <Chips>
                <Chip label="Sign in" active={mode === 'signin'} onPress={() => { setMode('signin'); setErr(''); }} />
                <Chip label="Create account" active={mode === 'signup'} onPress={() => { setMode('signup'); setErr(''); }} />
              </Chips>
              <T size={20} w="black">{mode === 'signup' ? 'Create your account' : mode === 'reset' ? 'Reset your password' : 'Welcome back'}</T>
              <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="emailAddress" placeholder="you@example.com" />
              {mode !== 'reset' && <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" textContentType={mode === 'signup' ? 'newPassword' : 'password'} placeholder="at least 8 characters" onSubmitEditing={submit} />}
              <ErrorText error={err} />
              {!!note && <T size={13} w="semi" color={C.mint}>{note}</T>}
              <Btn label={busy ? 'One moment…' : mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Email me a reset link' : 'Sign in'} disabled={busy} onPress={submit} />
              {mode === 'signin' && <Btn kind="ghost" label="Forgot password?" onPress={() => { setMode('reset'); setErr(''); }} />}
              {mode === 'reset' && <Btn kind="ghost" label="Back to sign in" onPress={() => { setMode('signin'); setErr(''); }} />}
              {mode !== 'reset' && (
                <>
                  <Muted center>or</Muted>
                  <Btn kind="soft" label="Continue with Google" disabled={busy} onPress={() => go(async () => { await signInWithGoogle(); })} />
                </>
              )}
            </>
          )}
        </Card>
        <T size={12} color="#FFFFFFAA" center>Your data is stored encrypted, in a space that is yours alone. Signing in on a new phone brings it all back.</T>
      </ScrollView>
    </LinearGradient>
  );
}
