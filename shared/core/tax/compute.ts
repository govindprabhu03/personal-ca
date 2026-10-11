// The tax computation: pure functions, integer paise, no I/O. The LLM never does this arithmetic; these rules do, and the tests pin them to
// worked examples. Scope: resident and non-resident individuals (salary, pension, house property, business/profession incl. presumptive, capital
// gains, other sources) under both regimes. What is NOT modelled is listed in `notes` on every result, so nothing is silently skipped.
import { AgeGroup, Regime, Slabs, TAX_YEARS, TaxYear } from './rules';

export interface LetOutProperty { rent: number; municipal_tax: number; interest: number }
export type BusinessMode = 'none' | '44ada' | '44ad' | 'books';

export interface TaxInput {
  // salary & pension
  salary_gross: number; hra_received: number; basic_da: number; rent_paid: number; metro: boolean;
  other_exempt_allowances: number; professional_tax: number; pension: number; employer_nps: number;
  // house property
  self_occupied_interest: number; let_out: LetOutProperty[];
  // other sources
  interest_savings: number; interest_deposits: number; interest_other: number; dividends: number; other_income: number;
  // business or profession
  business: { mode: BusinessMode; receipts: number; digital_receipts: number; expenses: number };
  // capital gains: the NET gain per bucket (a loss is negative)
  stcg_111a: number; stcg_other: number; ltcg_112a: number; ltcg_other: number;
  bf: { stcl: number; ltcl: number; business_loss: number; hp_loss: number }; // losses brought forward from earlier years (positive numbers)
  // deductions (Chapter VI-A: old regime; only employer NPS counts in the new regime)
  d80c: number; d80ccd1b: number; d80d_self: number; d80d_parents: number; parents_senior: boolean; d80e: number; d80g: number; d_other: number;
  // tax already paid
  tds: number; tcs: number; advance_tax: number; self_assessment: number;
  agricultural_income: number;
  flags: { director: boolean; unlisted_shares: boolean; foreign_assets: boolean };
  filing_date: string | null; // when the return is/will be filed (YYYY-MM-DD): drives the late-fee and interest estimates
}

export const emptyBusiness = (): TaxInput['business'] => ({ mode: 'none', receipts: 0, digital_receipts: 0, expenses: 0 });
export const emptyInput = (): TaxInput => ({
  salary_gross: 0, hra_received: 0, basic_da: 0, rent_paid: 0, metro: false, other_exempt_allowances: 0, professional_tax: 0, pension: 0, employer_nps: 0,
  self_occupied_interest: 0, let_out: [], interest_savings: 0, interest_deposits: 0, interest_other: 0, dividends: 0, other_income: 0,
  business: emptyBusiness(), stcg_111a: 0, stcg_other: 0, ltcg_112a: 0, ltcg_other: 0, bf: { stcl: 0, ltcl: 0, business_loss: 0, hp_loss: 0 },
  d80c: 0, d80ccd1b: 0, d80d_self: 0, d80d_parents: 0, parents_senior: false, d80e: 0, d80g: 0, d_other: 0,
  tds: 0, tcs: 0, advance_tax: 0, self_assessment: 0, agricultural_income: 0,
  flags: { director: false, unlisted_shares: false, foreign_assets: false }, filing_date: null,
});

export interface Ctx { year: TaxYear; age: AgeGroup; resident: boolean; today: string }
export interface Line { label: string; amount: number; note?: string }

export interface RegimeResult {
  regime: Regime;
  salary: { gross: number; exemptions: number; standard_deduction: number; professional_tax: number; income: number };
  house_property: { self_occupied: number; let_out: number; net: number; set_off: number; carried_forward: number };
  business: { income: number; set_off_b_f: number; loss_carried_forward: number };
  other_sources: number;
  capital_gains: { stcg_111a: number; stcg_other: number; ltcg_112a: number; ltcg_other: number; stcl_carried_forward: number; ltcl_carried_forward: number };
  gross_total_income: number;            // normal-rate income before deductions
  deductions: Line[]; deductions_total: number;
  normal_income: number;                 // taxable at slab rates, after deductions
  total_income: number;                  // everything, rounded to the nearest 10 rupees
  tax: { slab: number; special_111a: number; special_112a: number; special_112: number; rebate_87a: number; marginal_relief_87a: number; surcharge: number; cess: number; total: number };
  late_fee_234f: number; interest_234a: number; interest_234b: number;
  taxes_paid: number; net_payable: number; // positive = pay, negative = refund
  notes: string[];
}

const pct = (x: number, p: number) => Math.round((x * p) / 100);
const tens = (x: number) => Math.round(x / 1000) * 1000; // sections 288A/288B: round to the nearest 10 rupees (1000 paise)
const pos = (x: number) => Math.max(0, x);

export function slabTax(income: number, slabs: Slabs): number {
  let tax = 0, lower = 0;
  for (const [upper, rate] of slabs) {
    if (income > lower) tax += pct(Math.min(income, upper) - lower, rate);
    if (income <= upper) break;
    lower = upper;
  }
  return tax;
}

export function hraExemption(i: Pick<TaxInput, 'hra_received' | 'basic_da' | 'rent_paid' | 'metro'>): number {
  if (i.hra_received <= 0) return 0;
  return pos(Math.min(i.hra_received, i.rent_paid - pct(i.basic_da, 10), pct(i.basic_da, i.metro ? 50 : 40)));
}

/** Tax on a given split of income, with rebate and surcharge (and the marginal relief at each threshold). Pure; the surcharge relief calls it again at the threshold. */
function taxOn(ctx: Ctx, regime: Regime, normal: number, sp: { a111: number; a112: number; a112a: number }, totalIncome: number, depth = 0) {
  const y = ctx.year, slabs = regime === 'new' ? y.slabs.new : y.slabs.old[ctx.resident ? ctx.age : 'under60'];
  const slab = slabTax(normal, slabs);
  const special111a = pct(sp.a111, y.capitalGains.stcg111a), special112a = pct(sp.a112a, y.capitalGains.ltcg112a), special112 = pct(sp.a112, y.capitalGains.ltcg112);
  const special = special111a + special112a + special112;
  const rb = y.rebate[regime];
  let rebate = 0, relief87 = 0;
  if (ctx.resident) {
    if (totalIncome <= rb.incomeLimit) rebate = Math.min(slab, rb.max);
    else if (regime === 'new' && special === 0) relief87 = pos(slab - (totalIncome - rb.incomeLimit)); // just over the limit: the tax can't exceed the excess
  }
  const afterRebate = slab - rebate - relief87, before = afterRebate + special;
  const bracket = y.surcharge.thresholds.find(([t]) => totalIncome > t);
  let surcharge = 0;
  if (bracket) {
    const [threshold, rates] = bracket, rate = rates[regime];
    surcharge = pct(afterRebate, rate) + pct(special, Math.min(rate, y.surcharge.specialCap));
    if (depth < 4) { // marginal relief: never pay more extra tax than the income above the threshold
      const cut = totalIncome - threshold;
      const atThreshold = taxOn(ctx, regime, pos(normal - cut), sp, threshold, depth + 1);
      surcharge = Math.min(surcharge, pos(atThreshold.before + atThreshold.surcharge - before + cut));
    }
  }
  const cess = pct(before + surcharge, y.cessPct);
  return { slab, special111a, special112a, special112, rebate, relief87, surcharge, cess, before, total: before + surcharge + cess };
}

function monthsLate(due: string, filed: string): number {
  if (filed <= due) return 0;
  const [dy, dm, dd] = due.split('-').map(Number), [fy, fm, fd] = filed.split('-').map(Number);
  return (fy - dy) * 12 + (fm - dm) + (fd > dd ? 1 : 0);
}

export function computeRegime(i: TaxInput, ctx: Ctx, regime: Regime): RegimeResult {
  const y = ctx.year, isNew = regime === 'new', notes: string[] = [];

  // ---- salary & pension ----
  const base = i.salary_gross + i.pension;
  const exemptions = isNew ? 0 : hraExemption(i) + i.other_exempt_allowances;
  const std = Math.min(y.standardDeduction[regime], base);
  const profTax = isNew ? 0 : i.professional_tax;
  const salary = pos(base - exemptions - std - profTax);
  if (isNew && (i.hra_received || i.other_exempt_allowances || i.professional_tax)) notes.push('New regime: HRA, other exempt allowances and professional tax are not allowed.');

  // ---- house property ----
  const selfOcc = isNew ? 0 : -Math.min(i.self_occupied_interest, y.limits.homeLoanSelfOccupied);
  const letOut = i.let_out.reduce((s, p) => { const nav = pos(p.rent - p.municipal_tax); return s + nav - pct(nav, 30) - p.interest; }, 0);
  let hpNet = selfOcc + letOut, hpBfUsed = 0;
  if (hpNet > 0) { hpBfUsed = Math.min(hpNet, i.bf.hp_loss); hpNet -= hpBfUsed; }
  const hpSetOff = hpNet < 0 ? (isNew ? 0 : -Math.min(-hpNet, y.limits.hpLossSetOff)) : hpNet;
  const hpCarry = hpNet < 0 ? -hpNet + hpSetOff : 0;
  if (isNew && i.self_occupied_interest) notes.push('New regime: interest on a self-occupied home is not deductible.');
  if (isNew && hpNet < 0) notes.push('New regime: a house-property loss cannot be set off against other income; it is carried forward.');

  // ---- business or profession ----
  const b = i.business;
  let biz = b.mode === 'none' ? 0 : b.mode === '44ada' ? pct(b.receipts, 50) : b.mode === '44ad' ? pct(b.digital_receipts, 6) + pct(b.receipts - b.digital_receipts, 8) : b.receipts - b.expenses;
  let bizBfUsed = 0;
  if (biz > 0) { bizBfUsed = Math.min(biz, i.bf.business_loss); biz -= bizBfUsed; }
  if (b.mode === '44ada' && b.receipts > 7500000 * 100) notes.push('44ADA applies only up to ₹75 lakh of receipts (and only if cash receipts are at most 5%): check you qualify.');
  if (b.mode === '44ad' && b.receipts > 30000000 * 100) notes.push('44AD applies only up to ₹3 crore of turnover (and only with at most 5% cash): check you qualify.');

  // ---- other sources ----
  let other = i.interest_savings + i.interest_deposits + i.interest_other + i.dividends + i.other_income;

  // ---- capital gains: set losses off, cheapest-to-keep first ----
  const cg = { stcg_111a: i.stcg_111a, stcg_other: i.stcg_other, ltcg_112a: i.ltcg_112a, ltcg_other: i.ltcg_other };
  let stcl = i.bf.stcl - Math.min(0, cg.stcg_111a) - Math.min(0, cg.stcg_other), ltcl = i.bf.ltcl - Math.min(0, cg.ltcg_112a) - Math.min(0, cg.ltcg_other);
  for (const k of ['stcg_111a', 'stcg_other', 'ltcg_112a', 'ltcg_other'] as const) cg[k] = pos(cg[k]);
  const eat = (k: keyof typeof cg, loss: number) => { const used = Math.min(cg[k], loss); cg[k] -= used; return loss - used; };
  for (const k of ['stcg_other', 'stcg_111a', 'ltcg_other', 'ltcg_112a'] as const) stcl = eat(k, stcl); // a short-term loss can absorb any gain
  for (const k of ['ltcg_other', 'ltcg_112a'] as const) ltcl = eat(k, ltcl);                            // a long-term loss only long-term gains

  // ---- a business loss this year can be set off against house-property income and other sources, never against salary ----
  let bizLoss = biz < 0 ? -biz : 0, hpUse = hpSetOff;
  biz = Math.max(0, biz);
  if (bizLoss > 0 && hpUse > 0) { const u = Math.min(bizLoss, hpUse); hpUse -= u; bizLoss -= u; }
  if (bizLoss > 0) { const u = Math.min(bizLoss, other); other -= u; bizLoss -= u; }
  const bizLossCarry = bizLoss;
  const normalGross = salary + hpUse + biz + other + cg.stcg_other;

  // ---- deductions ----
  const ded: Line[] = [];
  const add = (label: string, amount: number, note?: string) => { if (amount > 0) ded.push({ label, amount, note }); };
  const npsCap = i.basic_da > 0 ? pct(i.basic_da, y.limits.employerNps[regime]) : Infinity;
  add('80CCD(2) employer NPS', Math.min(i.employer_nps, npsCap), i.basic_da > 0 ? undefined : 'basic pay not given, so the cap was not checked');
  if (!isNew) {
    const senior = ctx.age !== 'under60';
    add('80C / 80CCC / 80CCD(1)', Math.min(i.d80c, y.limits.d80c), `limit ${y.limits.d80c / 100}`);
    add('80CCD(1B) extra NPS', Math.min(i.d80ccd1b, y.limits.d80ccd1b));
    add('80D health insurance (self & family)', Math.min(i.d80d_self, senior ? y.limits.d80dSelfSenior : y.limits.d80dSelf));
    add('80D health insurance (parents)', Math.min(i.d80d_parents, i.parents_senior ? y.limits.d80dParentsSenior : y.limits.d80dParents));
    add('80E education-loan interest', i.d80e);
    add('80G donations (deductible part)', i.d80g);
    add(senior ? '80TTB deposit interest (senior)' : '80TTA savings interest', senior ? Math.min(i.interest_savings + i.interest_deposits, y.limits.d80ttb) : Math.min(i.interest_savings, y.limits.d80tta));
    add('Other Chapter VI-A', i.d_other, 'as entered: check its own limit');
  } else if (i.d80c || i.d80ccd1b || i.d80d_self || i.d80d_parents || i.d80e || i.d80g || i.d_other) notes.push('New regime: 80C, 80D, 80E, 80G and the other Chapter VI-A deductions are not allowed (only employer NPS).');
  const dedTotal = Math.min(ded.reduce((s, d) => s + d.amount, 0), pos(normalGross));
  const normal = pos(normalGross - dedTotal);

  // ---- special-rate incomes, and the unused basic exemption (residents) ----
  const a112aFull = cg.ltcg_112a, a112a0 = pos(a112aFull - y.capitalGains.ltcg112aExempt);
  const sp = { a111: cg.stcg_111a, a112: cg.ltcg_other, a112a: a112a0 };
  if (ctx.resident) {
    const slabs = isNew ? y.slabs.new : y.slabs.old[ctx.age];
    let shortfall = pos(slabs[0][0] - normal);
    for (const k of ['a111', 'a112', 'a112a'] as const) { const used = Math.min(shortfall, sp[k]); sp[k] -= used; shortfall -= used; }
  }
  const totalIncomeRaw = normal + cg.stcg_111a + cg.ltcg_other + a112aFull;
  const totalIncome = tens(totalIncomeRaw);
  const t = taxOn(ctx, regime, tens(normal), sp, totalIncome);
  const totalTax = tens(t.total);

  // ---- late fee & interest (estimates) ----
  const filed = i.filing_date ?? ctx.today;
  const due = b.mode === 'none' ? y.deadlines.individual : y.deadlines.business;
  const exemptLimit = (isNew ? y.slabs.new : y.slabs.old[ctx.resident ? ctx.age : 'under60'])[0][0];
  const late = filed > due;
  const fee = late && totalIncome > exemptLimit ? (totalIncome <= y.lateFee234F.ifIncomeUpTo ? y.lateFee234F.reduced : y.lateFee234F.amount) : 0;
  const netOfTds = pos(totalTax - i.tds - i.tcs);
  const int234a = late ? pct(pos(netOfTds - i.advance_tax) , 1) * monthsLate(due, filed) : 0;
  const m234b = (() => { const [fy, fm] = filed.split('-').map(Number), ay = Number(y.ay.slice(0, 4)); return Math.max(0, (fy - ay) * 12 + (fm - 4) + 1); })();
  const int234b = netOfTds >= 1000000 && i.advance_tax < pct(netOfTds, 90) ? pct(netOfTds - i.advance_tax, 1) * m234b : 0;
  if (late) notes.push(`Filing after ${due} adds a late fee and interest (shown as estimates). The last date for a belated return is ${y.deadlines.belated}.`);
  if (int234b) notes.push('Interest under 234B/234A is an estimate: 234C (late instalments) is not modelled. Check the portal’s own computation.');
  if (i.agricultural_income > 0) notes.push('Agricultural income is not included in this computation (partial integration is not modelled).');
  if (!ctx.resident) notes.push('Non-resident: no 87A rebate, no age-based exemption and other special rules apply. Treat this as a rough guide and use a CA.');
  if (hpCarry || bizLossCarry || stcl || ltcl) notes.push('Losses that could not be set off this year are shown as carried forward (valid for 8 years if the return is filed on time).');

  const paid = i.tds + i.tcs + i.advance_tax + i.self_assessment;
  return {
    regime,
    salary: { gross: base, exemptions, standard_deduction: std, professional_tax: profTax, income: salary },
    house_property: { self_occupied: selfOcc, let_out: letOut, net: hpNet, set_off: hpUse, carried_forward: hpCarry },
    business: { income: biz, set_off_b_f: bizBfUsed, loss_carried_forward: bizLossCarry + pos(i.bf.business_loss - bizBfUsed) },
    other_sources: other,
    capital_gains: { ...cg, stcl_carried_forward: stcl, ltcl_carried_forward: ltcl },
    gross_total_income: normalGross, deductions: ded, deductions_total: dedTotal, normal_income: normal, total_income: totalIncome,
    tax: { slab: t.slab, special_111a: t.special111a, special_112a: t.special112a, special_112: t.special112, rebate_87a: t.rebate, marginal_relief_87a: t.relief87, surcharge: t.surcharge, cess: t.cess, total: totalTax },
    late_fee_234f: fee, interest_234a: int234a, interest_234b: int234b,
    taxes_paid: paid, net_payable: totalTax + fee + int234a + int234b - paid, notes,
  };
}

export interface Comparison { year: TaxYear; new: RegimeResult; old: RegimeResult; recommended: Regime; chosen: Regime; saving: number; reason: string }

/** Both regimes side by side, the cheaper one recommended, and the one that applies given the person's own preference. */
export function compareRegimes(i: TaxInput, ctx: Ctx, pref: 'auto' | Regime = 'auto'): Comparison {
  const nw = computeRegime(i, ctx, 'new'), od = computeRegime(i, ctx, 'old');
  const cost = (r: RegimeResult) => r.tax.total + r.late_fee_234f + r.interest_234a + r.interest_234b;
  const recommended: Regime = cost(od) < cost(nw) ? 'old' : 'new';
  const chosen: Regime = pref === 'auto' ? recommended : pref;
  const saving = Math.abs(cost(nw) - cost(od));
  const reason = saving === 0 ? 'Both regimes cost the same for you.' : `${recommended === 'new' ? 'New' : 'Old'} regime costs you less (by ${Math.round(saving / 100).toLocaleString('en-IN')} rupees).`;
  if (i.business.mode !== 'none') (recommended === 'old' ? od : nw).notes.push('You have business/professional income: switching back to the old regime from the new one is allowed only once (Form 10-IEA) and must be filed by the due date.');
  return { year: ctx.year, new: nw, old: od, recommended, chosen, saving, reason };
}

export function makeCtx(fy: string, profile: { residency: 'resident' | 'nri'; age_group: AgeGroup }, today: string): Ctx {
  const year = TAX_YEARS[fy];
  if (!year) throw new Error(`Tax rules for FY ${fy} are not available yet.`);
  return { year, age: profile.age_group, resident: profile.residency === 'resident', today };
}

/** What a further deduction would save: the difference in total tax, recomputed (so slabs, rebate and cess are all respected). */
export function whatIf(i: TaxInput, ctx: Ctx, regime: Regime, patch: Partial<TaxInput>): number {
  const a = computeRegime(i, ctx, regime), b = computeRegime({ ...i, ...patch }, ctx, regime);
  return a.tax.total - b.tax.total;
}
