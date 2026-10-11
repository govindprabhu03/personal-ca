// Accounts: sign in with email + password, or with Google (Supabase Auth). Each person's data is their own: the server checks this sign-in
// token on every request and keeps one encrypted file per user. The session itself is stored encrypted (vault.ts), never in plain storage.
import 'react-native-url-polyfill/auto';
import { createClient, type Session } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { CLOUD_URL, SUPABASE_KEY, SUPABASE_URL } from './config';
import { encryptedKv } from './vault';

WebBrowser.maybeCompleteAuthSession();

const STORE_KEY = `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`; // where supabase-js keeps the session
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    storage: { getItem: (k) => encryptedKv.get('sb:' + k), setItem: (k, v) => encryptedKv.set('sb:' + k, v), removeItem: (k) => encryptedKv.del('sb:' + k) },
    autoRefreshToken: true, persistSession: true, detectSessionInUrl: false, flowType: 'pkce',
  },
});
// supabase-js only refreshes while told the app is in the foreground
if (Platform.OS !== 'web') AppState.addEventListener('change', (st) => { if (st === 'active') supabase.auth.startAutoRefresh(); else supabase.auth.stopAutoRefresh(); });

/** The token the server checks. `refresh` forces a new one (the sync core asks once if the server answers 401). */
export async function getAccessToken(refresh = false): Promise<string | null> {
  if (refresh) { const { data, error } = await supabase.auth.refreshSession(); return error ? null : data.session?.access_token ?? null; }
  const { data } = await supabase.auth.getSession(); // refreshes by itself if it has expired and we're online
  return data.session?.access_token ?? null;
}

export type AuthState = { status: 'loading' } | { status: 'out' } | { status: 'in'; userId: string; email: string };
const fromSession = (s: Session | null): AuthState => (s?.user ? { status: 'in', userId: s.user.id, email: s.user.email ?? '' } : { status: 'out' });

/** What the stored session says, without asking the network: so a signed-in person stays signed in with no signal (an expired token can't refresh offline). */
async function storedState(): Promise<AuthState> {
  try { const raw = await encryptedKv.get('sb:' + STORE_KEY); return fromSession(raw ? (JSON.parse(raw) as Session) : null); } catch { return { status: 'out' }; }
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    storedState().then((s) => { if (alive) setState(s); });
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (!alive) return;
      if (event === 'SIGNED_OUT') setState({ status: 'out' }); // a refresh token that was revoked lands here too
      else if (session) setState(fromSession(session));        // (a null session on INITIAL_SESSION while offline must not sign anyone out)
    });
    return () => { alive = false; data.subscription.unsubscribe(); };
  }, []);
  return state;
}

/** Supabase's messages are for developers; these are for people. */
export function explain(e: unknown): string {
  const m = String((e as { message?: string })?.message ?? e), code = (e as { code?: string })?.code ?? '';
  if (/invalid login credentials/i.test(m)) return "That email and password don't match. Check them, or use “Forgot password”.";
  if (/email not confirmed/i.test(m)) return 'Please confirm your email first: we sent you a link. Tap “Resend” if you can’t find it.';
  if (/already registered|already exists/i.test(m)) return 'That email already has an account. Try signing in instead.';
  if (/rate limit|too many/i.test(m) || code === 'over_email_send_rate_limit') return 'Too many emails sent just now. Wait a few minutes and try again.';
  if (/password.*(short|least|weak)|weak_password/i.test(m + code)) return 'Choose a longer password (at least 8 characters).';
  if (/network|fetch|failed to/i.test(m)) return "Can't reach the sign-in service. Check your connection and try again.";
  if (/provider.*not enabled|unsupported provider/i.test(m)) return 'Google sign-in is not switched on for this app yet. Use email for now.';
  return m || 'Something went wrong. Please try again.';
}

const SITE = CLOUD_URL.replace(/\/+$/, '') + '/'; // where the emailed links land (a small page that explains what to do next)

/** Returns true when the person must confirm their email before they can sign in (the usual case for a new account). */
export async function signUp(email: string, password: string): Promise<boolean> {
  const { data, error } = await supabase.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: SITE } });
  if (error) throw error;
  return !data.session;
}
export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw error;
}
export async function resendConfirmation(email: string): Promise<void> {
  const { error } = await supabase.auth.resend({ type: 'signup', email: email.trim(), options: { emailRedirectTo: SITE } });
  if (error) throw error;
}
// Reset links are completed on a web page (the one at SITE), which cannot finish the app's secure code exchange, so this one request uses the plain flow.
const resetClient = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { flowType: 'implicit', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
export async function sendPasswordReset(email: string): Promise<void> {
  const { error } = await resetClient.auth.resetPasswordForEmail(email.trim(), { redirectTo: SITE });
  if (error) throw error;
}

/** Opens Google in the system browser and comes back to the app with a one-time code that is exchanged for a session. Resolves false if the person backed out. */
export async function signInWithGoogle(): Promise<boolean> {
  // Ask first: if Google isn't switched on for this project, say so plainly instead of opening a browser onto an error page.
  const st = await fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: SUPABASE_KEY } }).then((r) => r.json()).catch(() => null);
  if (st && st.external && st.external.google === false) throw new Error('Unsupported provider: provider is not enabled');
  const redirectTo = Platform.OS === 'web' ? (globalThis as any).location.origin + '/' : Linking.createURL('auth-callback');
  const { data, error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo, skipBrowserRedirect: Platform.OS !== 'web' } });
  if (error) throw error;
  if (Platform.OS === 'web' || !data.url) return true; // the web preview navigates away by itself
  const res = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (res.type !== 'success') return false;
  const code = new URL(res.url).searchParams.get('code');
  if (!code) throw new Error('Google sign-in did not complete. Please try again.');
  const { error: e2 } = await supabase.auth.exchangeCodeForSession(code);
  if (e2) throw e2;
  return true;
}

export const signOut = () => supabase.auth.signOut();
