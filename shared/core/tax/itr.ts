// Which ITR form fits, and the schedule-by-schedule worksheet to copy into the income-tax portal's pre-filled return.
// The app prepares; the taxpayer files and e-verifies on the portal (we never hold or use portal credentials).
import { formatRupees } from '../../money';
import type { Regime } from './rules';
import { rs } from './rules';
import type { RegimeResult, TaxInput } from './compute';

export type ItrForm = 'ITR-1' | 'ITR-2' | 'ITR-3' | 'ITR-4';
export interface FormAdvice { form: ItrForm; reasons: string[]; ruledOut: Array<{ form: ItrForm; because: string[] }>; checks: string[] }

const LIMIT_50L = rs(5000000), CG_112A_LIMIT = rs(125000), AGRI_LIMIT = rs(5000);

export function suggestForm(i: TaxInput, profile: { residency: 'resident' | 'nri' }, r: RegimeResult): FormAdvice {
  const resident = profile.residency === 'resident';
  const mode = i.business.mode, presumptive = mode === '44ada' || mode === '44ad', hasBusiness = mode !== 'none';
  const houses = i.let_out.length + (i.self_occupied_interest > 0 ? 1 : 0);
  const cgAny = [i.stcg_111a, i.stcg_other, i.ltcg_112a, i.ltcg_other].some((x) => x !== 0);
  const cgOnly112aSmall = i.stcg_111a === 0 && i.stcg_other === 0 && i.ltcg_other === 0 && i.ltcg_112a >= 0 && i.ltcg_112a <= CG_112A_LIMIT;
  const bf = Object.values(i.bf).some((x) => x > 0);

  // reasons a simple form can't be used (shared by ITR-1 and ITR-4)
  const common: string[] = [];
  if (!resident) common.push('you are a non-resident');
  if (r.total_income > LIMIT_50L) common.push('total income is above ₹50 lakh');
  if (houses > 2) common.push('you have more than two house properties');
  if (cgAny && !cgOnly112aSmall) common.push('you have capital gains beyond listed-share long-term gains of ₹1.25 lakh');
  if (bf) common.push('you are carrying forward losses from earlier years');
  if (i.flags.director) common.push('you are a director of a company');
  if (i.flags.unlisted_shares) common.push('you hold unlisted equity shares');
  if (i.flags.foreign_assets) common.push('you have foreign assets or foreign income');
  if (i.agricultural_income > AGRI_LIMIT) common.push('agricultural income is above ₹5,000');

  const why1 = [...common]; if (hasBusiness) why1.push('you have business or professional income');
  const why4 = [...common]; if (hasBusiness && !presumptive) why4.push('your business income is computed from books (not presumptive 44AD/44ADA)'); if (!hasBusiness) why4.push('you have no presumptive business income');

  let form: ItrForm, reasons: string[];
  if (hasBusiness) {
    if (presumptive && !why4.length) { form = 'ITR-4'; reasons = ['Resident, total income up to ₹50 lakh, with presumptive income under 44AD/44ADA (plus any salary, up to two houses and other income).']; }
    else { form = 'ITR-3'; reasons = ['You have business or professional income that ITR-4 cannot take' + (why4.length ? `: ${why4.filter((x) => x !== 'you have no presumptive business income').join('; ')}.` : '.')]; }
  } else if (!why1.length) { form = 'ITR-1'; reasons = ['Resident, total income up to ₹50 lakh, from salary or pension, up to two house properties and other sources (interest etc.).']; }
  else { form = 'ITR-2'; reasons = [`ITR-1 is not available because ${why1.join('; ')}.`, 'ITR-2 is for individuals with no business or professional income.']; }

  const ruledOut: FormAdvice['ruledOut'] = [];
  if (form !== 'ITR-1') ruledOut.push({ form: 'ITR-1', because: why1 });
  if (form === 'ITR-3' || form === 'ITR-2') if (hasBusiness) ruledOut.push({ form: 'ITR-4', because: why4 });
  if (form === 'ITR-3' || form === 'ITR-4') ruledOut.push({ form: 'ITR-2', because: ['you have business or professional income'] });

  const checks = [
    'Open your AIS and Form 26AS on the portal and make sure every interest, dividend, sale and TDS entry there matches what you entered. Mismatches are the commonest cause of notices.',
    'Compare your salary and TDS with your Form 16 (Part A and Part B) and with the TDS shown in 26AS.',
    'Make sure the bank account where you want any refund is pre-validated on the portal.',
    'After submitting, e-verify within 30 days (Aadhaar OTP or net banking); an unverified return is treated as not filed.',
    'Choose the same regime on the portal that you compared here. Business/professional income: opting out of the new regime needs Form 10-IEA.',
  ];
  if (form === 'ITR-2' || form === 'ITR-3') checks.push('Fill Schedule CG from your broker/fund statements (Schedule 112A needs scrip-wise details) and Schedule AL if your income is above ₹1 crore.');
  if (form === 'ITR-3' || form === 'ITR-4') checks.push('Presumptive income needs your GST turnover/receipts and bank-account details; check you meet the 44AD/44ADA turnover and cash-receipt limits.');
  return { form, reasons, ruledOut, checks };
}

// ---------------- the worksheet ----------------
export interface WsRow { label: string; amount?: number; text?: string; note?: string }
export interface WsSection { schedule: string; title: string; rows: WsRow[] }
export interface Worksheet { fy: string; ay: string; form: ItrForm; regime: Regime; sections: WsSection[]; checks: string[]; disclaimer: string }

export function buildWorksheet(i: TaxInput, r: RegimeResult, form: FormAdvice, fy: string, ay: string): Worksheet {
  const S: WsSection[] = [];
  const sec = (schedule: string, title: string, rows: WsRow[]) => { const kept = rows.filter((x) => x.amount !== 0 || x.text); if (kept.length) S.push({ schedule, title, rows: kept }); };

  sec('Schedule S', 'Salary / pension', [
    { label: 'Gross salary and pension', amount: r.salary.gross },
    { label: 'Less: allowances exempt under section 10 (HRA etc.)', amount: -r.salary.exemptions, note: r.regime === 'new' ? 'not allowed in the new regime' : undefined },
    { label: 'Less: standard deduction, section 16(ia)', amount: -r.salary.standard_deduction },
    { label: 'Less: professional tax, section 16(iii)', amount: -r.salary.professional_tax },
    { label: 'Income chargeable under Salaries', amount: r.salary.income },
  ]);
  sec('Schedule HP', 'House property', [
    { label: 'Interest on self-occupied home (limited to ₹2 lakh)', amount: r.house_property.self_occupied },
    { label: 'Income / (loss) from let-out property: rent less municipal tax, 30% standard deduction, interest', amount: r.house_property.let_out },
    { label: 'Income from house property set off in this year', amount: r.house_property.set_off },
    { label: 'House-property loss to carry forward', amount: r.house_property.carried_forward },
  ]);
  const b = i.business;
  sec('Schedule BP', 'Business or profession', [
    b.mode !== 'none' ? { label: b.mode === '44ada' ? 'Presumptive income, section 44ADA (50% of gross receipts)' : b.mode === '44ad' ? 'Presumptive income, section 44AD (6% digital / 8% other)' : 'Net profit from books', amount: r.business.income } : { label: '', amount: 0 },
    { label: 'Gross receipts / turnover', amount: b.receipts },
    { label: 'Brought-forward business loss used', amount: -r.business.set_off_b_f },
    { label: 'Business loss to carry forward', amount: r.business.loss_carried_forward },
  ].filter((x) => x.label));
  sec('Schedule CG', 'Capital gains (after setting off losses)', [
    { label: 'Short-term gain on listed shares/equity funds (section 111A, taxed at 20%)', amount: r.capital_gains.stcg_111a },
    { label: 'Short-term gain, other assets (taxed at slab rates)', amount: r.capital_gains.stcg_other },
    { label: 'Long-term gain on listed shares/equity funds (section 112A, 12.5% above ₹1.25 lakh)', amount: r.capital_gains.ltcg_112a },
    { label: 'Long-term gain, other assets (section 112, 12.5%)', amount: r.capital_gains.ltcg_other },
    { label: 'Short-term loss to carry forward', amount: r.capital_gains.stcl_carried_forward },
    { label: 'Long-term loss to carry forward', amount: r.capital_gains.ltcl_carried_forward },
  ]);
  sec('Schedule OS', 'Income from other sources', [
    { label: 'Interest from savings account', amount: i.interest_savings },
    { label: 'Interest from deposits (FD/RD)', amount: i.interest_deposits },
    { label: 'Other interest', amount: i.interest_other },
    { label: 'Dividends', amount: i.dividends },
    { label: 'Other income', amount: i.other_income },
    { label: 'Total other sources (after any business-loss set-off)', amount: r.other_sources },
  ]);
  sec('Schedule VI-A', 'Deductions', [...r.deductions.map((d) => ({ label: d.label, amount: d.amount, note: d.note })), { label: 'Total deductions allowed', amount: r.deductions_total }]);
  sec('Part B-TI', 'Total income', [
    { label: 'Gross total income at normal rates', amount: r.gross_total_income },
    { label: 'Less: deductions (Chapter VI-A)', amount: -r.deductions_total },
    { label: 'Income taxable at normal rates', amount: r.normal_income },
    { label: 'Special-rate gains: 111A + 112A + 112', amount: r.capital_gains.stcg_111a + r.capital_gains.ltcg_112a + r.capital_gains.ltcg_other },
    { label: 'TOTAL INCOME (rounded to ₹10)', amount: r.total_income },
  ]);
  sec('Part B-TTI', 'Tax computation', [
    { label: `Tax at slab rates (${r.regime} regime)`, amount: r.tax.slab },
    { label: 'Tax on 111A gains (20%)', amount: r.tax.special_111a },
    { label: 'Tax on 112A gains (12.5%)', amount: r.tax.special_112a },
    { label: 'Tax on 112 gains (12.5%)', amount: r.tax.special_112 },
    { label: 'Less: rebate under section 87A', amount: -r.tax.rebate_87a },
    { label: 'Less: marginal relief on the 87A limit', amount: -r.tax.marginal_relief_87a },
    { label: 'Surcharge (after marginal relief)', amount: r.tax.surcharge },
    { label: 'Health and education cess (4%)', amount: r.tax.cess },
    { label: 'TOTAL TAX LIABILITY', amount: r.tax.total },
    { label: 'Fee under section 234F (estimate)', amount: r.late_fee_234f },
    { label: 'Interest under 234A (estimate)', amount: r.interest_234a },
    { label: 'Interest under 234B (estimate)', amount: r.interest_234b },
  ]);
  sec('Schedules TDS / TCS / IT', 'Tax already paid', [
    { label: 'TDS deducted (Schedule TDS1/TDS2: match your 26AS)', amount: i.tds },
    { label: 'TCS collected', amount: i.tcs },
    { label: 'Advance tax paid (Schedule IT)', amount: i.advance_tax },
    { label: 'Self-assessment tax paid (Schedule IT)', amount: i.self_assessment },
    { label: 'Total taxes paid', amount: r.taxes_paid },
  ]);
  sec('Result', r.net_payable > 0 ? 'Tax payable' : 'Refund due', [{ label: r.net_payable > 0 ? 'Net tax payable (pay before filing)' : 'Refund expected (before any interest the department adds)', amount: Math.abs(r.net_payable) }, ...r.notes.map((n) => ({ label: 'Note', text: n }))]);

  return {
    fy, ay, form: form.form, regime: r.regime, sections: S, checks: form.checks,
    disclaimer: 'Prepared by Personal CA as a worksheet to help you fill the return. It is not professional advice and has not been audited. Check every figure against Form 16, AIS/26AS and the portal’s own computation before you file; use a practising Chartered Accountant for audits, certifications, notices or anything unusual.',
  };
}

const money = (paise: number) => formatRupees(paise).replace(/ /g, ' ');
export function worksheetText(w: Worksheet): string {
  const out = [`PERSONAL CA: ITR WORKSHEET`, `Return: ${w.form}   Financial year ${w.fy}   Assessment year ${w.ay}   Regime: ${w.regime} regime`, ''];
  for (const s of w.sections) {
    out.push(`${s.schedule}: ${s.title}`);
    for (const r of s.rows) out.push(`  ${r.label.padEnd(86)} ${r.amount !== undefined ? money(r.amount).padStart(16) : ''}${r.text ? r.text : ''}${r.note ? `   (${r.note})` : ''}`);
    out.push('');
  }
  out.push('BEFORE YOU FILE'); w.checks.forEach((c, n) => out.push(`  ${n + 1}. ${c}`)); out.push('', w.disclaimer);
  return out.join('\n');
}
const csvCell = (v: string | number) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function worksheetCsv(w: Worksheet): string {
  const rows: Array<Array<string | number>> = [['Schedule', 'Item', 'Amount (INR)', 'Note']];
  for (const s of w.sections) for (const r of s.rows) rows.push([s.schedule, r.label + (r.text ? `: ${r.text}` : ''), r.amount !== undefined ? (r.amount / 100).toFixed(2) : '', r.note ?? '']);
  rows.push([], ['Form', w.form], ['Regime', w.regime], ['Financial year', w.fy], ['Assessment year', w.ay], ['Disclaimer', w.disclaimer]);
  return rows.map((r) => r.map(csvCell).join(',')).join('\n');
}
