// The tax rules, pinned to worked examples calculated by hand from the FY 2025-26 slabs (not copied from the code under test).
import { describe, expect, it } from 'vitest';
import { compareRegimes, computeRegime, emptyInput, hraExemption, makeCtx, slabTax, TaxInput, whatIf } from '../../shared/core/tax/compute';
import { returnYearFor, rs, TAX_YEARS } from '../../shared/core/tax/rules';

const ctx = (o: { age?: 'under60' | 'senior' | 'super_senior'; resident?: boolean; today?: string } = {}) =>
  makeCtx('2025-26', { residency: o.resident === false ? 'nri' : 'resident', age_group: o.age ?? 'under60' }, o.today ?? '2026-07-01');
const input = (p: Partial<TaxInput>): TaxInput => ({ ...emptyInput(), ...p });
const tax = (i: TaxInput, regime: 'new' | 'old', c = ctx()) => computeRegime(i, c, regime);
const L = (n: number) => rs(n * 100000);

describe('new regime (the default)', () => {
  it('salary of 12 lakh pays nothing: the 87A rebate wipes out the tax on 11.25 lakh', () => {
    const r = tax(input({ salary_gross: L(12) }), 'new');
    expect(r.normal_income).toBe(rs(1125000));
    expect([r.tax.slab, r.tax.rebate_87a, r.tax.total]).toEqual([rs(52500), rs(52500), 0]);
  });
  it('salary of 15 lakh: 93,750 tax + 4% cess = 97,500', () => {
    const r = tax(input({ salary_gross: L(15) }), 'new');
    expect([r.tax.slab, r.tax.cess, r.tax.total]).toEqual([rs(93750), rs(3750), rs(97500)]);
  });
  it('just over the 12 lakh limit, marginal relief caps the tax at the excess: 13 lakh salary pays 25,000 + cess = 26,000', () => {
    const r = tax(input({ salary_gross: L(13) }), 'new');
    expect(r.normal_income).toBe(rs(1225000));
    expect([r.tax.slab, r.tax.marginal_relief_87a, r.tax.total]).toEqual([rs(63750), rs(38750), rs(26000)]);
  });
  it('the standard deduction is 75,000 and cannot exceed the salary', () => {
    expect(tax(input({ salary_gross: L(10) }), 'new').salary.standard_deduction).toBe(rs(75000));
    expect(tax(input({ salary_gross: rs(20000) }), 'new').salary.standard_deduction).toBe(rs(20000));
  });
  it('HRA, 80C and professional tax are ignored, with a note saying so', () => {
    const r = tax(input({ salary_gross: L(10), hra_received: L(2), basic_da: L(5), rent_paid: L(2), d80c: L(1.5), professional_tax: rs(2500) }), 'new');
    expect(r.salary.exemptions + r.salary.professional_tax).toBe(0);
    expect(r.deductions_total).toBe(0);
    expect(r.notes.join(' ')).toMatch(/HRA/);
  });
  it('employer NPS is allowed, capped at 14% of basic in the new regime', () => {
    const r = tax(input({ salary_gross: L(20), basic_da: L(10), employer_nps: L(2) }), 'new');
    expect(r.deductions_total).toBe(rs(140000));
  });
  it('a non-resident gets no rebate', () => {
    const r = tax(input({ salary_gross: L(8) }), 'new', ctx({ resident: false }));
    expect([r.tax.rebate_87a, r.tax.slab, r.tax.total]).toEqual([0, rs(16250), rs(16900)]);
  });
});

describe('old regime', () => {
  it('10 lakh salary with 1.5 lakh in 80C: taxable 8 lakh, tax 72,500 + cess = 75,400', () => {
    const r = tax(input({ salary_gross: L(10), d80c: L(1.5) }), 'old');
    expect(r.normal_income).toBe(L(8));
    expect([r.tax.slab, r.tax.total]).toEqual([rs(72500), rs(75400)]);
  });
  it('caps deductions at their limits: 80C 1.5 lakh, 80D self 25,000', () => {
    const r = tax(input({ salary_gross: L(20), d80c: L(3), d80d_self: rs(40000) }), 'old');
    expect(r.deductions.find((d) => d.label.startsWith('80C'))!.amount).toBe(L(1.5));
    expect(r.deductions.find((d) => d.label.includes('self'))!.amount).toBe(rs(25000));
  });
  it('seniors get the higher 3 lakh exemption and a higher 80D limit', () => {
    expect(tax(input({ salary_gross: L(4) }), 'old', ctx({ age: 'senior' })).tax.total).toBe(0); // 3.5 lakh taxable: 2,500 tax, rebated
    expect(slabTax(L(5), TAX_YEARS['2025-26'].slabs.old.senior)).toBe(rs(10000));      // 5% of the 2 lakh between 3 and 5 lakh
    expect(slabTax(L(5), TAX_YEARS['2025-26'].slabs.old.under60)).toBe(rs(12500));     // 5% of the 2.5 lakh between 2.5 and 5 lakh
  });
  it('HRA exemption is the least of: HRA received, rent minus 10% of basic, 50%/40% of basic', () => {
    expect(hraExemption({ hra_received: L(3), basic_da: L(6), rent_paid: L(2.4), metro: true })).toBe(L(1.8));   // 2.4L - 0.6L
    expect(hraExemption({ hra_received: L(1), basic_da: L(6), rent_paid: L(4), metro: true })).toBe(L(1));       // HRA received is lowest
    expect(hraExemption({ hra_received: L(3), basic_da: L(6), rent_paid: L(4), metro: false })).toBe(L(2.4));    // 40% of basic
    expect(hraExemption({ hra_received: L(3), basic_da: L(6), rent_paid: L(0.5), metro: true })).toBe(0);        // rent below 10% of basic
  });
  it('interest on a self-occupied home is deductible up to 2 lakh and shows as a house-property loss', () => {
    const r = tax(input({ salary_gross: L(12), self_occupied_interest: L(3) }), 'old');
    expect([r.house_property.self_occupied, r.house_property.set_off]).toEqual([-L(2), -L(2)]);
  });
  it('a let-out property: 30% standard deduction on net rent, then interest', () => {
    const r = tax(input({ let_out: [{ rent: L(6), municipal_tax: rs(0), interest: L(1) }] }), 'old');
    expect(r.house_property.let_out).toBe(L(6) - rs(180000) - L(1)); // 6L - 30% - 1L = 3.2L
  });
});

describe('business income', () => {
  it('44ADA: 50% of receipts is the income (20 lakh receipts -> 10 lakh) and 12-lakh-and-under still gets the rebate', () => {
    const r = tax(input({ business: { mode: '44ada', receipts: L(20), digital_receipts: 0, expenses: 0 } }), 'new');
    expect([r.business.income, r.tax.total]).toEqual([L(10), 0]);
  });
  it('44AD: 6% of digital receipts and 8% of the rest', () => {
    const r = tax(input({ business: { mode: '44ad', receipts: L(50), digital_receipts: L(30), expenses: 0 } }), 'new');
    expect(r.business.income).toBe(L(30) * 6 / 100 + L(20) * 8 / 100);
  });
  it('a business loss is set off against other income but never against salary, and the rest is carried forward', () => {
    const r = tax(input({ salary_gross: L(10), interest_other: L(1), business: { mode: 'books', receipts: L(1), digital_receipts: 0, expenses: L(4) } }), 'new');
    expect(r.other_sources).toBe(0);                       // the 1 lakh of interest absorbed 1 lakh of the 3 lakh loss
    expect(r.salary.income).toBe(L(10) - rs(75000));       // salary untouched
    expect(r.business.loss_carried_forward).toBe(L(2));
  });
});

describe('capital gains', () => {
  it('LTCG on listed shares: 12.5% above the 1.25 lakh exemption, and the 87A rebate does not apply to it', () => {
    const r = tax(input({ salary_gross: L(8), ltcg_112a: L(3) }), 'new');
    expect([r.tax.slab, r.tax.rebate_87a, r.tax.special_112a, r.tax.total]).toEqual([rs(16250), rs(16250), rs(21875), rs(22750)]);
  });
  it('a short-term loss can absorb a long-term gain', () => {
    const r = tax(input({ salary_gross: L(8), ltcg_112a: L(3), stcg_other: -L(1) }), 'new');
    expect(r.capital_gains.ltcg_112a).toBe(L(2));
    expect(r.capital_gains.stcl_carried_forward).toBe(0);
  });
  it('a long-term loss can NOT absorb a short-term gain: it is carried forward', () => {
    const r = tax(input({ stcg_111a: L(2), ltcg_112a: -L(1) }), 'new');
    expect([r.capital_gains.stcg_111a, r.capital_gains.ltcl_carried_forward]).toEqual([L(2), L(1)]);
  });
  it('a resident can use the unused basic exemption against short-term gains: 2 lakh income + 3 lakh STCG -> 1 lakh taxed at 20%', () => {
    const r = tax(input({ interest_other: L(2), stcg_111a: L(3) }), 'new');
    expect([r.tax.special_111a, r.tax.total]).toEqual([rs(20000), rs(20800)]);
  });
  it('losses brought forward are used first, and any excess stays carried forward', () => {
    const r = tax(input({ stcg_other: L(2), bf: { stcl: L(5), ltcl: 0, business_loss: 0, hp_loss: 0 } }), 'new');
    expect([r.capital_gains.stcg_other, r.capital_gains.stcl_carried_forward]).toEqual([0, L(3)]);
  });
});

describe('surcharge and its marginal relief', () => {
  it('a business income of exactly 50 lakh has no surcharge: 10,80,000 + 4% cess = 11,23,200', () => {
    const r = tax(input({ business: { mode: 'books', receipts: L(50), digital_receipts: 0, expenses: 0 } }), 'new');
    expect([r.tax.slab, r.tax.surcharge, r.tax.total]).toEqual([rs(1080000), 0, rs(1123200)]);
  });
  it('crossing 50 lakh never costs more extra tax than the extra income (plus its cess)', () => {
    const at = (extra: number) => tax(input({ business: { mode: 'books', receipts: L(50) + extra, digital_receipts: 0, expenses: 0 } }), 'new').tax.total;
    for (const extra of [rs(1000), rs(10000), rs(100000), rs(300000)]) expect(at(extra) - at(0)).toBeLessThanOrEqual(Math.ceil(extra * 1.04) + 1000);
  });
  it('far above the thresholds the full surcharge applies (1.5 crore -> 15%), and the new regime caps at 25%', () => {
    const big = (cr: number, regime: 'new' | 'old') => tax(input({ business: { mode: 'books', receipts: rs(cr * 10000000), digital_receipts: 0, expenses: 0 } }), regime);
    expect(big(1.5, 'new').tax.surcharge / big(1.5, 'new').tax.slab).toBeCloseTo(0.15, 2);
    expect(big(6, 'new').tax.surcharge / big(6, 'new').tax.slab).toBeCloseTo(0.25, 2);
    expect(big(6, 'old').tax.surcharge / big(6, 'old').tax.slab).toBeCloseTo(0.37, 2);
  });
  it('surcharge on special-rate gains is capped at 15% even at a crore-plus income', () => {
    const r = tax(input({ business: { mode: 'books', receipts: rs(60000000), digital_receipts: 0, expenses: 0 }, ltcg_112a: L(100) }), 'new');
    expect(r.tax.surcharge).toBeLessThan(r.tax.slab * 0.25 + r.tax.special_112a * 0.15 + 100);
  });
});

describe('comparing the regimes, late filing, and what-if', () => {
  it('recommends the cheaper regime and says how much it saves', () => {
    const i = input({ salary_gross: L(20), basic_da: L(8), hra_received: L(3), rent_paid: L(3), metro: true, d80c: L(1.5), d80d_self: rs(25000), d80ccd1b: rs(50000), self_occupied_interest: L(2) });
    const c = compareRegimes(i, ctx());
    const cost = (r: typeof c.new) => r.tax.total + r.late_fee_234f + r.interest_234a + r.interest_234b; // the comparison counts fee and interest estimates too
    const costNew = cost(c.new), costOld = cost(c.old);
    expect(c.recommended).toBe(costOld < costNew ? 'old' : 'new');
    expect(c.saving).toBe(Math.abs(costNew - costOld));
    expect(compareRegimes(i, ctx(), 'new').chosen).toBe('new'); // a stated preference is respected
  });
  it('a return filed after the due date shows the 5,000 late fee and interest estimates', () => {
    const r = tax(input({ salary_gross: L(20), tds: rs(100000) }), 'new', ctx({ today: '2026-10-11' }));
    expect(r.late_fee_234f).toBe(rs(5000));
    expect(r.interest_234a).toBeGreaterThan(0);
    expect(r.notes.join(' ')).toMatch(/belated/);
  });
  it('the late fee is only 1,000 when total income is up to 5 lakh, and nil below the exemption', () => {
    expect(tax(input({ salary_gross: L(5.5) }), 'new', ctx({ today: '2026-10-11' })).late_fee_234f).toBe(rs(1000));
    expect(tax(input({ salary_gross: L(3) }), 'new', ctx({ today: '2026-10-11' })).late_fee_234f).toBe(0);
  });
  it('on-time filing has no fee or interest, and TDS turns into a refund when it exceeds the tax', () => {
    const r = tax(input({ salary_gross: L(12), tds: rs(40000) }), 'new');
    expect([r.late_fee_234f, r.interest_234a, r.net_payable]).toEqual([0, 0, -rs(40000)]);
  });
  it('whatIf shows what an extra 50,000 of 80C would save under the old regime (at the 30% slab: 15,600 with cess)', () => {
    expect(whatIf(input({ salary_gross: L(20), d80c: L(1) }), ctx(), 'old', { d80c: L(1.5) })).toBe(rs(15600));
  });
  it('knows which return year is being prepared today', () => {
    expect(returnYearFor('2026-10-11')).toBe('2025-26');
    expect(returnYearFor('2026-03-31')).toBe('2024-25');
    expect(returnYearFor('2026-04-01')).toBe('2025-26');
  });
  it('refuses a year it has no rules for, instead of guessing', () => {
    expect(() => makeCtx('2026-27', { residency: 'resident', age_group: 'under60' }, '2026-10-11')).toThrow(/not available/);
  });
});

import { buildWorksheet, suggestForm, worksheetCsv, worksheetText } from '../../shared/core/tax/itr';
describe('which ITR form, and the worksheet', () => {
  const advice = (p: Partial<TaxInput>, resident = true) => { const i = input(p); return suggestForm(i, { residency: resident ? 'resident' : 'nri' }, tax(i, 'new', ctx({ resident }))); };
  it('a plain salaried person files ITR-1', () => { expect(advice({ salary_gross: L(12), interest_savings: rs(5000) }).form).toBe('ITR-1'); });
  it('capital gains beyond listed LTCG of 1.25 lakh move a salaried person to ITR-2, and it says why ITR-1 is out', () => {
    const a = advice({ salary_gross: L(12), stcg_111a: L(1) });
    expect(a.form).toBe('ITR-2');
    expect(a.ruledOut[0]).toMatchObject({ form: 'ITR-1' });
    expect(a.ruledOut[0].because.join(' ')).toMatch(/capital gains/);
  });
  it('small listed LTCG (up to 1.25 lakh, no carried losses) can stay on ITR-1', () => { expect(advice({ salary_gross: L(12), ltcg_112a: rs(100000) }).form).toBe('ITR-1'); });
  it('a carried-forward loss, a directorship, foreign assets, or more than two houses force ITR-2', () => {
    expect(advice({ salary_gross: L(12), bf: { stcl: L(1), ltcl: 0, business_loss: 0, hp_loss: 0 } }).form).toBe('ITR-2');
    expect(advice({ salary_gross: L(12), flags: { director: true, unlisted_shares: false, foreign_assets: false } }).form).toBe('ITR-2');
    expect(advice({ salary_gross: L(12), flags: { director: false, unlisted_shares: false, foreign_assets: true } }).form).toBe('ITR-2');
    const house = { rent: L(1), municipal_tax: 0, interest: 0 };
    expect(advice({ salary_gross: L(12), let_out: [house, house, house] }).form).toBe('ITR-2');
  });
  it('a freelancer on presumptive income files ITR-4; books-based business files ITR-3', () => {
    expect(advice({ business: { mode: '44ada', receipts: L(20), digital_receipts: 0, expenses: 0 } }).form).toBe('ITR-4');
    expect(advice({ business: { mode: 'books', receipts: L(20), digital_receipts: 0, expenses: L(5) } }).form).toBe('ITR-3');
  });
  it('presumptive income plus real capital gains cannot use ITR-4: ITR-3', () => {
    expect(advice({ business: { mode: '44ada', receipts: L(20), digital_receipts: 0, expenses: 0 }, stcg_111a: L(2) }).form).toBe('ITR-3');
  });
  it('a non-resident never gets ITR-1 or ITR-4', () => {
    expect(advice({ salary_gross: L(12) }, false).form).toBe('ITR-2');
    expect(advice({ business: { mode: '44ada', receipts: L(20), digital_receipts: 0, expenses: 0 } }, false).form).toBe('ITR-3');
  });
  it('income above 50 lakh rules out ITR-1', () => { expect(advice({ salary_gross: L(60) }).form).toBe('ITR-2'); });

  it('the worksheet lists each schedule with the right figures, and exports to text and CSV', () => {
    const i = input({ salary_gross: L(15), interest_savings: rs(8000), tds: rs(90000) });
    const r = tax(i, 'new'), w = buildWorksheet(i, r, suggestForm(i, { residency: 'resident' }, r), '2025-26', '2026-27');
    const titles = w.sections.map((s) => s.schedule);
    expect(titles).toEqual(expect.arrayContaining(['Schedule S', 'Schedule OS', 'Part B-TI', 'Part B-TTI', 'Schedules TDS / TCS / IT', 'Result']));
    expect(titles).not.toContain('Schedule CG');   // nothing to report there
    expect(w.sections.find((s) => s.schedule === 'Schedule S')!.rows.at(-1)!.amount).toBe(r.salary.income);
    expect(w.sections.find((s) => s.schedule === 'Part B-TTI')!.rows.find((x) => x.label === 'TOTAL TAX LIABILITY')!.amount).toBe(r.tax.total);
    expect(worksheetText(w)).toContain('ITR-1');
    expect(worksheetText(w)).toContain('BEFORE YOU FILE');
    const csv = worksheetCsv(w).split('\n');
    expect(csv[0]).toBe('Schedule,Item,Amount (INR),Note');
    expect(csv.some((l) => l.startsWith('Result,'))).toBe(true);
  });
});
