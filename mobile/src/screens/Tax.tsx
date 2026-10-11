// Money > Tax: enter your income, deductions and taxes paid for the year; see the tax under both regimes, the ITR form that fits, and a
// worksheet to fill the return from. Numbers update live as you type; "Save" stores them in your account. We prepare; you file and e-verify
// on the income-tax portal.
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import type { TaxInput } from '../../../shared/core/tax/compute';
import { emptyInput } from '../../../shared/core/tax/compute';
import { summarise } from '../../../shared/core/tax/data';
import { returnYearFor, SUPPORTED_FYS } from '../../../shared/core/tax/rules';
import { worksheetCsv, worksheetText } from '../../../shared/core/tax/itr';
import { formatRupees } from '../../../shared/money';
import { todayLocal } from '../../../shared/time';
import { api } from '../api';
import { useLoad } from '../hooks';
import { saveText } from '../platform';
import type { ScreenProps } from '../state';
import { C, GRAD } from '../theme';
import { Btn, Card, Chip, Chips, ErrorText, Field, Hero, Muted, Row, T, Tag } from '../ui';

const rupeeText = (p: number) => (p ? String(p / 100) : '');
const parseMoney = (t: string): number => { const n = Number(t.replace(/[,₹\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
const getAt = (o: unknown, path: string) => path.split('.').reduce<any>((x, k) => x?.[k], o);
const setAt = (o: TaxInput, path: string, v: unknown): TaxInput => {
  const c = JSON.parse(JSON.stringify(o)); const keys = path.split('.'); let t = c;
  for (const k of keys.slice(0, -1)) t = t[k];
  t[keys[keys.length - 1]] = v; return c;
};
const dateLabel = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** A rupee amount typed as text; the stored value is paise. Keeps what you are typing (like "12.") instead of reformatting under your fingers. */
function MoneyField({ label, value, onChange, hint, signed }: { label: string; value: number; onChange: (paise: number) => void; hint?: string; signed?: boolean }) {
  const [text, setText] = useState(rupeeText(value));
  useEffect(() => { if (parseMoney(text) !== value) setText(rupeeText(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <View style={{ gap: 2 }}>
      <Field label={label} value={text} placeholder="0" keyboardType={signed ? 'default' : 'numeric'} onChangeText={(t) => { setText(t); onChange(signed ? parseMoney(t) : Math.max(0, parseMoney(t))); }} />
      {!!hint && <Muted size={11}>{hint}</Muted>}
    </View>
  );
}

function Fold({ emoji, title, open, onToggle, filled, children }: { emoji: string; title: string; open: boolean; onToggle: () => void; filled: boolean; children: React.ReactNode }) {
  return (
    <Card style={{ gap: 10 }}>
      <Pressable onPress={onToggle}>
        <Row>
          <T size={22}>{emoji}</T>
          <View style={{ flex: 1 }}><T w="black" size={16}>{title}</T></View>
          {filled && <Tag text="✓ filled" fg="#0A9E7B" bg={C.mintSoft} />}
          <T size={18} color={C.sub}>{open ? '▾' : '▸'}</T>
        </Row>
      </Pressable>
      {open && children}
    </Card>
  );
}

export function TaxSection({ data, version, bump }: ScreenProps) {
  const today = todayLocal();
  const [fy, setFy] = useState(SUPPORTED_FYS.includes(returnYearFor(today)) ? returnYearFor(today) : SUPPORTED_FYS[SUPPORTED_FYS.length - 1]);
  const load = useLoad(() => api.tax(fy), [fy, version]);
  const [draft, setDraft] = useState<TaxInput>(emptyInput());
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('');
  const types = data.profile.taxpayer_types;
  const rel = (...t: string[]) => t.some((x) => (types as string[]).includes(x));
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (id: string, byDefault: boolean) => open[id] ?? byDefault;
  const toggle = (id: string, byDefault: boolean) => setOpen((o) => ({ ...o, [id]: !(o[id] ?? byDefault) }));

  useEffect(() => { if (load.data && !dirty) setDraft(load.data.input); }, [load.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = useMemo(() => summarise(draft, data.profile, fy, today, load.data?.entered ?? false), [draft, data.profile, fy, today, load.data?.entered]);

  const edit = (path: string, v: unknown) => { setDraft((d) => setAt(d, path, v)); setDirty(true); setMsg(''); };
  const M = (path: string, label: string, hint?: string, signed?: boolean) => <MoneyField key={path} label={label} value={getAt(draft, path)} onChange={(p) => edit(path, p)} hint={hint} signed={signed} />;
  const Bool = (path: string, label: string) => <Chip key={path} label={label} active={!!getAt(draft, path)} onPress={() => edit(path, !getAt(draft, path))} />;
  const filled = (...paths: string[]) => paths.some((p) => { const v = getAt(draft, p); return Array.isArray(v) ? v.length > 0 : !!v && v !== 'none'; });

  const save = async () => { setBusy(true); setErr(''); try { await api.saveTax(fy, draft); setDirty(false); setMsg('Saved to your account ✅'); bump(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const share = async (kind: 'txt' | 'csv') => {
    if (!s.worksheet) return;
    try { await saveText(`ITR-worksheet-FY${fy}.${kind}`, kind === 'txt' ? worksheetText(s.worksheet) : worksheetCsv(s.worksheet), kind === 'txt' ? 'text/plain' : 'text/csv'); } catch (e: any) { setErr(e.message); }
  };

  const c = s.comparison, pick = c ? c[c.chosen] : undefined, dl = s.deadlines;
  const Row2 = ({ a, b }: { a: string; b: string }) => <Row style={{ justifyContent: 'space-between' }}><Muted size={13}>{a}</Muted><T size={13} w="bold">{b}</T></Row>;

  return (
    <View style={{ gap: 14 }}>
      <ErrorText error={err || load.error} />
      {SUPPORTED_FYS.length > 1 && <Chips>{SUPPORTED_FYS.map((y) => <Chip key={y} label={`FY ${y}`} active={y === fy} onPress={() => { setFy(y); setDirty(false); }} />)}</Chips>}
      {!s.supported ? <Card><T>{s.message}</T></Card> : (<>
        {dl && (dl.dueIsPassed || dl.daysToDue < 30) && (
          <Card tint={dl.belatedIsPassed ? C.pinkSoft : C.sunSoft} style={{ gap: 4 }}>
            <T w="black">{dl.belatedIsPassed ? '⏰ The last date to file this year has passed' : dl.dueIsPassed ? `⏰ The due date (${dateLabel(dl.due)}) has passed` : `⏰ Due ${dateLabel(dl.due)} (${dl.daysToDue} days)`}</T>
            <Muted size={12}>{dl.belatedIsPassed ? `A belated return was allowed until ${dateLabel(dl.belated)}. Talk to a CA about options.` : dl.dueIsPassed ? `You can still file a belated return until ${dateLabel(dl.belated)} (${dl.daysToBelated} days left). A late fee and interest apply, so the sooner the cheaper.` : 'File before then to avoid the late fee and interest.'}</Muted>
          </Card>
        )}

        {pick && c && (
          <Hero colors={pick.net_payable > 0 ? GRAD.warn : GRAD.win}>
            <T size={13} w="semi" color="#FFFFFFD9">{s.label} · {c.chosen === 'new' ? 'New' : 'Old'} regime{data.profile.regime_pref === 'auto' ? ' (cheaper for you)' : ''}</T>
            <T size={44} w="black" color="#fff" style={{ lineHeight: 52 }}>{formatRupees(Math.abs(pick.net_payable))}</T>
            <T size={15} w="bold" color="#fff">{!s.entered && !dirty ? 'Enter your details below 👇' : pick.net_payable > 0 ? 'to pay' : pick.net_payable < 0 ? 'refund expected 🎉' : 'nothing to pay or get back'}</T>
            <T size={12} color="#FFFFFFD9">Tax {formatRupees(pick.tax.total)} · already paid {formatRupees(pick.taxes_paid)}{pick.late_fee_234f + pick.interest_234a + pick.interest_234b > 0 ? ` · late fee & interest (est.) ${formatRupees(pick.late_fee_234f + pick.interest_234a + pick.interest_234b)}` : ''}</T>
          </Hero>
        )}

        {dirty && (
          <Card tint={C.violetSoft} style={{ gap: 8 }}>
            <T w="bold">You have unsaved changes</T>
            <Row><Btn label={busy ? 'Saving…' : 'Save'} disabled={busy} onPress={save} style={{ flex: 1 }} /><Btn kind="ghost" label="Discard" onPress={() => { setDraft(load.data?.input ?? emptyInput()); setDirty(false); }} style={{ flex: 1 }} /></Row>
          </Card>
        )}
        {!!msg && <T size={13} w="semi" color="#0A9E7B">{msg}</T>}

        <Fold emoji="💼" title="Salary & pension" open={isOpen('salary', rel('salaried', 'pensioner'))} onToggle={() => toggle('salary', rel('salaried', 'pensioner'))} filled={filled('salary_gross', 'pension')}>
          <Muted size={12}>From your Form 16 (Part B) and payslips, for the whole financial year.</Muted>
          {M('salary_gross', 'Gross salary', 'Total salary including allowances and perquisites')}
          {M('pension', 'Pension from a former employer')}
          {M('employer_nps', "Employer's NPS contribution", 'Section 80CCD(2): allowed in both regimes')}
          {M('basic_da', 'Basic pay + DA for the year', 'Needed for the HRA and NPS limits')}
          {M('hra_received', 'HRA received', 'Old regime only')}
          {M('rent_paid', 'Rent you paid in the year', 'Old regime only')}
          <Chips>{Bool('metro', 'Metro city (Delhi, Mumbai, Kolkata, Chennai)')}</Chips>
          {M('other_exempt_allowances', 'Other exempt allowances (LTA etc.)', 'Old regime only')}
          {M('professional_tax', 'Professional tax paid', 'Old regime only')}
        </Fold>

        <Fold emoji="🏠" title="House property" open={isOpen('hp', false)} onToggle={() => toggle('hp', false)} filled={filled('self_occupied_interest', 'let_out')}>
          {M('self_occupied_interest', 'Home-loan interest (self-occupied home)', 'Old regime: up to ₹2 lakh')}
          {draft.let_out.map((p, n) => (
            <Card key={n} tint={C.violetSoft} style={{ gap: 8 }}>
              <T w="bold">Let-out property {n + 1}</T>
              {M(`let_out.${n}.rent`, 'Rent received in the year')}
              {M(`let_out.${n}.municipal_tax`, 'Municipal tax paid')}
              {M(`let_out.${n}.interest`, 'Home-loan interest')}
              <Btn kind="ghost" label="Remove" onPress={() => { setDraft((d) => ({ ...d, let_out: d.let_out.filter((_, i) => i !== n) })); setDirty(true); }} style={{ paddingVertical: 6 }} />
            </Card>
          ))}
          {draft.let_out.length < 10 && <Btn kind="soft" label="+ Add a let-out property" onPress={() => { setDraft((d) => ({ ...d, let_out: [...d.let_out, { rent: 0, municipal_tax: 0, interest: 0 }] })); setDirty(true); }} />}
        </Fold>

        <Fold emoji="🧑‍💻" title="Business or profession" open={isOpen('biz', rel('professional', 'business'))} onToggle={() => toggle('biz', rel('professional', 'business'))} filled={filled('business.mode')}>
          <Chips>
            {([['none', 'None'], ['44ada', 'Professional (44ADA)'], ['44ad', 'Small business (44AD)'], ['books', 'Books of account']] as const).map(([m, label]) => <Chip key={m} label={label} active={draft.business.mode === m} onPress={() => edit('business.mode', m)} />)}
          </Chips>
          {draft.business.mode !== 'none' && M('business.receipts', draft.business.mode === '44ada' ? 'Gross receipts for the year' : 'Turnover / gross receipts', draft.business.mode === '44ada' ? '50% of this is treated as your income' : undefined)}
          {draft.business.mode === '44ad' && M('business.digital_receipts', 'Of which received digitally (UPI, bank)', 'Taxed at 6% instead of 8%')}
          {draft.business.mode === 'books' && M('business.expenses', 'Total business expenses')}
          {draft.business.mode !== 'none' && <Muted size={12}>Presumptive taxation (44ADA/44AD) has turnover and cash-receipt limits; the worksheet warns if you cross them. Business income is also the one case where a CA is usually worth it.</Muted>}
        </Fold>

        <Fold emoji="📈" title="Capital gains" open={isOpen('cg', rel('investor'))} onToggle={() => toggle('cg', rel('investor'))} filled={filled('stcg_111a', 'stcg_other', 'ltcg_112a', 'ltcg_other')}>
          <Muted size={12}>Net gain or loss for the year, from your broker / fund statements (use a minus sign for a loss).</Muted>
          {M('stcg_111a', 'Short-term: listed shares & equity funds', 'Sold within 12 months: taxed at 20%', true)}
          {M('ltcg_112a', 'Long-term: listed shares & equity funds', 'First ₹1.25 lakh a year is tax-free, the rest 12.5%', true)}
          {M('stcg_other', 'Short-term: other assets (debt funds, gold, property…)', 'Taxed at your slab rate', true)}
          {M('ltcg_other', 'Long-term: other assets (property, gold…)', '12.5% (older property may have a better indexed option: ask a CA)', true)}
          {M('bf.stcl', 'Short-term losses brought forward')}
          {M('bf.ltcl', 'Long-term losses brought forward')}
        </Fold>

        <Fold emoji="🏦" title="Other income" open={isOpen('os', true)} onToggle={() => toggle('os', true)} filled={filled('interest_savings', 'interest_deposits', 'interest_other', 'dividends', 'other_income')}>
          <Muted size={12}>Your bank's interest certificate and AIS show these.</Muted>
          {M('interest_savings', 'Savings-account interest')}
          {M('interest_deposits', 'FD / RD interest')}
          {M('interest_other', 'Other interest')}
          {M('dividends', 'Dividends')}
          {M('other_income', 'Anything else (gifts above ₹50,000, winnings…)')}
          {M('agricultural_income', 'Agricultural income', 'Not included in the calculation: a CA should check it')}
        </Fold>

        <Fold emoji="🧾" title="Deductions (old regime)" open={isOpen('ded', rel('salaried'))} onToggle={() => toggle('ded', rel('salaried'))} filled={filled('d80c', 'd80ccd1b', 'd80d_self', 'd80d_parents', 'd80e', 'd80g', 'd_other')}>
          <Muted size={12}>These only help in the old regime; the comparison above uses them for that regime.</Muted>
          {M('d80c', '80C: PF, PPF, ELSS, life insurance, tuition…', 'Limit ₹1.5 lakh')}
          {M('d80ccd1b', '80CCD(1B): extra NPS', 'Limit ₹50,000')}
          {M('d80d_self', '80D: health insurance (you & family)', 'Limit ₹25,000 (₹50,000 for seniors)')}
          {M('d80d_parents', '80D: health insurance (parents)', 'Limit ₹25,000 (₹50,000 if they are seniors)')}
          <Chips>{Bool('parents_senior', 'My parents are senior citizens')}</Chips>
          {M('d80e', '80E: education-loan interest')}
          {M('d80g', '80G: donations (the deductible part)')}
          {M('d_other', 'Other Chapter VI-A deductions', 'Check the limit yourself')}
        </Fold>

        <Fold emoji="💸" title="Tax already paid" open={isOpen('paid', true)} onToggle={() => toggle('paid', true)} filled={filled('tds', 'tcs', 'advance_tax', 'self_assessment')}>
          <Muted size={12}>Your Form 26AS / AIS lists TDS and TCS; your challans show advance tax.</Muted>
          {M('tds', 'TDS deducted (salary, bank, others)')}
          {M('tcs', 'TCS collected')}
          {M('advance_tax', 'Advance tax paid')}
          {M('self_assessment', 'Self-assessment tax paid')}
        </Fold>

        <Fold emoji="🔎" title="Does any of this apply to you?" open={isOpen('flags', false)} onToggle={() => toggle('flags', false)} filled={filled('flags.director', 'flags.unlisted_shares', 'flags.foreign_assets')}>
          <Muted size={12}>These decide whether the simple ITR-1 / ITR-4 forms are allowed.</Muted>
          <Chips>{Bool('flags.director', 'I am a director in a company')}{Bool('flags.unlisted_shares', 'I hold unlisted shares')}{Bool('flags.foreign_assets', 'I have foreign assets or income')}</Chips>
        </Fold>

        {dirty && <Btn label={busy ? 'Saving…' : 'Save my tax details'} disabled={busy} onPress={save} />}

        {c && pick && (
          <>
            <Card style={{ gap: 8 }}>
              <T w="black" size={16}>⚖️ Old vs new regime</T>
              <Row style={{ alignItems: 'flex-start', gap: 10 }}>
                {(['new', 'old'] as const).map((k) => (
                  <View key={k} style={{ flex: 1, borderRadius: 16, borderWidth: 2, borderColor: c.recommended === k ? C.mint : C.line, padding: 10, gap: 4 }}>
                    <T w="black">{k === 'new' ? 'New regime' : 'Old regime'}</T>
                    {c.recommended === k && <Tag text="cheaper ✓" fg="#0A9E7B" bg={C.mintSoft} />}
                    <Muted size={12}>Taxable income</Muted><T w="bold">{formatRupees(c[k].total_income)}</T>
                    <Muted size={12}>Tax</Muted><T w="black" size={18}>{formatRupees(c[k].tax.total)}</T>
                  </View>
                ))}
              </Row>
              <T size={13} w="semi">{c.reason}</T>
              <Muted size={12}>Your tax profile says: {data.profile.regime_pref === 'auto' ? 'compare both' : `use the ${data.profile.regime_pref} regime`}. Change it in More.</Muted>
            </Card>

            <Card style={{ gap: 8 }}>
              <T w="black" size={16}>📋 Your return: {s.form!.form}</T>
              {s.form!.reasons.map((r, n) => <Muted key={n}>{r}</Muted>)}
              {s.form!.ruledOut.map((r) => <Muted key={r.form} size={12}>Not {r.form}: {r.because.join('; ')}.</Muted>)}
            </Card>

            <Card style={{ gap: 8 }}>
              <T w="black" size={16}>🧮 How the tax was worked out</T>
              <Row2 a="Income taxable at slab rates" b={formatRupees(pick.normal_income)} />
              <Row2 a="Tax at slab rates" b={formatRupees(pick.tax.slab)} />
              {pick.tax.rebate_87a > 0 && <Row2 a="Rebate (87A)" b={`− ${formatRupees(pick.tax.rebate_87a)}`} />}
              {pick.tax.marginal_relief_87a > 0 && <Row2 a="Marginal relief just above the rebate limit" b={`− ${formatRupees(pick.tax.marginal_relief_87a)}`} />}
              {pick.tax.special_111a + pick.tax.special_112a + pick.tax.special_112 > 0 && <Row2 a="Tax on capital gains (special rates)" b={formatRupees(pick.tax.special_111a + pick.tax.special_112a + pick.tax.special_112)} />}
              {pick.tax.surcharge > 0 && <Row2 a="Surcharge" b={formatRupees(pick.tax.surcharge)} />}
              <Row2 a="Health & education cess (4%)" b={formatRupees(pick.tax.cess)} />
              <Row2 a="Total tax" b={formatRupees(pick.tax.total)} />
              {pick.notes.map((n, i) => <Muted key={i} size={12}>ℹ️ {n}</Muted>)}
            </Card>

            <Card style={{ gap: 8 }}>
              <T w="black" size={16}>🗂️ Filing worksheet</T>
              <Muted size={12}>Schedule by schedule, the figures to enter in the income-tax portal's pre-filled return. Share it to your email or notes, or open it on your PC.</Muted>
              <Row><Btn kind="soft" label="Share as text" onPress={() => share('txt')} style={{ flex: 1 }} /><Btn kind="soft" label="Share as CSV" onPress={() => share('csv')} style={{ flex: 1 }} /></Row>
              {s.worksheet!.sections.map((sec) => (
                <View key={sec.schedule} style={{ gap: 4, paddingTop: 6 }}>
                  <T size={13} w="black" color={C.violet}>{sec.schedule}: {sec.title}</T>
                  {sec.rows.map((r, n) => <Row key={n} style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}><View style={{ flex: 1 }}><Muted size={12}>{r.label}{r.text ? `: ${r.text}` : ''}</Muted></View>{r.amount !== undefined && <T size={12} w="bold">{formatRupees(r.amount)}</T>}</Row>)}
                </View>
              ))}
            </Card>

            <Card style={{ gap: 6 }}>
              <T w="black" size={16}>✅ Before you file</T>
              {s.form!.checks.map((t, n) => <Muted key={n} size={12}>{n + 1}. {t}</Muted>)}
            </Card>
          </>
        )}
        <Muted size={11} center>{s.worksheet?.disclaimer ?? 'Estimates to help you prepare. Not professional advice.'}</Muted>
      </>)}
    </View>
  );
}
