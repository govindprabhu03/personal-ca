// A person's tax details for one financial year: stored as ONE validated document per year (table tax_data), edited as a whole.
// Everything the screens, the worksheet and the "Ask your CA" assistant show comes from taxSummary(): one place, one set of rules.
import type { DB } from '../schema';
import { getProfile } from '../service';
import type { Profile } from '../../types';
import { Comparison, compareRegimes, emptyBusiness, emptyInput, makeCtx, TaxInput } from './compute';
import { buildWorksheet, FormAdvice, suggestForm, Worksheet } from './itr';
import { SUPPORTED_FYS, TAX_YEARS } from './rules';

const MAX = 1e13; // paise: ₹1000 crore, far beyond any real figure, so a typo or a hostile value can't overflow anything
const SIGNED = new Set(['stcg_111a', 'stcg_other', 'ltcg_112a', 'ltcg_other']); // capital gains may be negative (a loss)
const NUMERIC = ['salary_gross', 'hra_received', 'basic_da', 'rent_paid', 'other_exempt_allowances', 'professional_tax', 'pension', 'employer_nps', 'self_occupied_interest',
  'interest_savings', 'interest_deposits', 'interest_other', 'dividends', 'other_income', 'stcg_111a', 'stcg_other', 'ltcg_112a', 'ltcg_other',
  'd80c', 'd80ccd1b', 'd80d_self', 'd80d_parents', 'd80e', 'd80g', 'd_other', 'tds', 'tcs', 'advance_tax', 'self_assessment', 'agricultural_income'] as const;

/** Turns whatever was stored or sent into a complete, safe TaxInput: unknown keys dropped, numbers clamped, nothing missing. */
export function normaliseTaxInput(raw: unknown): TaxInput {
  const out = emptyInput();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, any>;
  const num = (v: unknown, signed = false) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(signed ? -MAX : 0, Math.min(MAX, Math.round(v))) : 0);
  for (const k of NUMERIC) (out as unknown as Record<string, number>)[k] = num(r[k], SIGNED.has(k));
  out.metro = r.metro === true; out.parents_senior = r.parents_senior === true;
  const b = r.business ?? {};
  out.business = { ...emptyBusiness(), mode: ['none', '44ada', '44ad', 'books'].includes(b.mode) ? b.mode : 'none', receipts: num(b.receipts), digital_receipts: Math.min(num(b.digital_receipts), num(b.receipts)), expenses: num(b.expenses) };
  out.bf = { stcl: num(r.bf?.stcl), ltcl: num(r.bf?.ltcl), business_loss: num(r.bf?.business_loss), hp_loss: num(r.bf?.hp_loss) };
  out.flags = { director: r.flags?.director === true, unlisted_shares: r.flags?.unlisted_shares === true, foreign_assets: r.flags?.foreign_assets === true };
  out.let_out = Array.isArray(r.let_out) ? r.let_out.slice(0, 10).map((p: any) => ({ rent: num(p?.rent), municipal_tax: num(p?.municipal_tax), interest: num(p?.interest) })) : [];
  out.filing_date = typeof r.filing_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.filing_date) ? r.filing_date : null;
  return out;
}

export function getTaxInput(db: DB, fy: string): TaxInput {
  const row = db.prepare('SELECT json FROM tax_data WHERE fy = ?').get(fy) as unknown as { json: string } | undefined;
  try { return normaliseTaxInput(row ? JSON.parse(row.json) : null); } catch { return emptyInput(); }
}
export function saveTaxInput(db: DB, fy: string, input: unknown): TaxInput {
  if (!/^\d{4}-\d{2}$/.test(fy)) throw new Error('Bad financial year.');
  const clean = normaliseTaxInput(input);
  db.prepare('INSERT INTO tax_data (fy, json) VALUES (?, ?) ON CONFLICT(fy) DO UPDATE SET json = excluded.json').run(fy, JSON.stringify(clean));
  return clean;
}

const daysBetween = (a: string, b: string) => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);

export interface TaxSummary {
  fy: string; years: string[]; supported: boolean; message?: string;
  label?: string; ay?: string; input: TaxInput;
  comparison?: Comparison; form?: FormAdvice; worksheet?: Worksheet;
  deadlines?: { due: string; belated: string; daysToDue: number; daysToBelated: number; dueIsPassed: boolean; belatedIsPassed: boolean };
  entered: boolean; // has the person entered anything for this year yet?
}

/** The whole picture for given inputs: pure, so a screen can show live numbers while someone is still typing (before anything is saved). */
export function summarise(input: TaxInput, profile: Profile, fy: string, today: string, entered: boolean): TaxSummary {
  const base = { fy, years: SUPPORTED_FYS, input, entered };
  const year = TAX_YEARS[fy];
  if (!year) return { ...base, supported: false, message: `Tax rules for FY ${fy} are not built in yet. This app handles ${SUPPORTED_FYS.map((y) => `FY ${y}`).join(', ')}.` };
  const ctx = makeCtx(fy, profile, today);
  const comparison = compareRegimes(input, ctx, profile.regime_pref);
  const form = suggestForm(input, profile, comparison[comparison.chosen]);
  const due = input.business.mode === 'none' ? year.deadlines.individual : year.deadlines.business;
  return {
    ...base, supported: true, label: year.label, ay: year.ay, comparison, form,
    worksheet: buildWorksheet(input, comparison[comparison.chosen], form, fy, year.ay),
    deadlines: { due, belated: year.deadlines.belated, daysToDue: daysBetween(today, due), daysToBelated: daysBetween(today, year.deadlines.belated), dueIsPassed: today > due, belatedIsPassed: today > year.deadlines.belated },
  };
}

export function taxSummary(db: DB, fy: string, today: string): TaxSummary {
  const row = db.prepare('SELECT 1 AS x FROM tax_data WHERE fy = ?').get(fy);
  return summarise(getTaxInput(db, fy), getProfile(db), fy, today, !!row);
}
