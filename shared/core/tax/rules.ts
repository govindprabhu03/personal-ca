// Indian income-tax rules, one table per financial year. All money is integer PAISE (like the rest of the app).
// FY 2025-26 (assessment year 2026-27) is still governed by the Income-tax Act, 1961, even though the new Act of 2025 started on 1 April 2026.
// These figures were checked against secondary sources (ClearTax, Tax2Win, etc.), not the Finance Act text: confirm on incometax.gov.in before filing.
export const rs = (rupees: number) => Math.round(rupees * 100);
export type Regime = 'new' | 'old';
export type AgeGroup = 'under60' | 'senior' | 'super_senior';

/** [upper limit (paise, Infinity for the last), rate %] pairs, in order. */
export type Slabs = Array<[number, number]>;

export interface TaxYear {
  fy: string; ay: string; label: string; law: '1961' | '2025';
  slabs: { new: Slabs; old: Record<AgeGroup, Slabs> };
  standardDeduction: { new: number; old: number };
  rebate: { new: { incomeLimit: number; max: number }; old: { incomeLimit: number; max: number } };
  cessPct: number;
  surcharge: { thresholds: Array<[number, { new: number; old: number }]>; specialCap: number }; // by total income; special-rate income is capped
  capitalGains: { stcg111a: number; ltcg112a: number; ltcg112aExempt: number; ltcg112: number };
  limits: {
    d80c: number; d80ccd1b: number; d80dSelf: number; d80dSelfSenior: number; d80dParents: number; d80dParentsSenior: number;
    d80tta: number; d80ttb: number; homeLoanSelfOccupied: number; hpLossSetOff: number; employerNps: { new: number; old: number };
    smallGift: number;
  };
  deadlines: { individual: string; business: string; audit: string; belated: string; revised: string };
  lateFee234F: { amount: number; ifIncomeUpTo: number; reduced: number };
}

const L = (n: number) => rs(n * 100000);   // lakh -> paise
const CR = (n: number) => rs(n * 10000000); // crore -> paise
const INF = Infinity;

export const TAX_YEARS: Record<string, TaxYear> = {
  '2025-26': {
    fy: '2025-26', ay: '2026-27', label: 'FY 2025-26 (AY 2026-27)', law: '1961',
    slabs: {
      new: [[L(4), 0], [L(8), 5], [L(12), 10], [L(16), 15], [L(20), 20], [L(24), 25], [INF, 30]],
      old: {
        under60: [[L(2.5), 0], [L(5), 5], [L(10), 20], [INF, 30]],
        senior: [[L(3), 0], [L(5), 5], [L(10), 20], [INF, 30]],
        super_senior: [[L(5), 0], [L(10), 20], [INF, 30]],
      },
    },
    standardDeduction: { new: rs(75000), old: rs(50000) },
    rebate: { new: { incomeLimit: L(12), max: rs(60000) }, old: { incomeLimit: L(5), max: rs(12500) } },
    cessPct: 4,
    surcharge: { thresholds: [[CR(5), { new: 25, old: 37 }], [CR(2), { new: 25, old: 25 }], [CR(1), { new: 15, old: 15 }], [rs(5000000), { new: 10, old: 10 }]], specialCap: 15 },
    capitalGains: { stcg111a: 20, ltcg112a: 12.5, ltcg112aExempt: rs(125000), ltcg112: 12.5 },
    limits: {
      d80c: rs(150000), d80ccd1b: rs(50000), d80dSelf: rs(25000), d80dSelfSenior: rs(50000), d80dParents: rs(25000), d80dParentsSenior: rs(50000),
      d80tta: rs(10000), d80ttb: rs(50000), homeLoanSelfOccupied: rs(200000), hpLossSetOff: rs(200000), employerNps: { new: 14, old: 10 },
      smallGift: rs(50000),
    },
    deadlines: { individual: '2026-07-31', business: '2026-08-31', audit: '2026-10-31', belated: '2026-12-31', revised: '2027-03-31' },
    lateFee234F: { amount: rs(5000), ifIncomeUpTo: L(5), reduced: rs(1000) },
  },
};

export const SUPPORTED_FYS = Object.keys(TAX_YEARS);

/** The financial year whose return is being prepared today: the one that ended on the most recent 31 March. */
export function returnYearFor(today: string): string {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const endYear = m >= 4 ? y : y - 1; // FY 2025-26 ends 31 Mar 2026
  return `${endYear - 1}-${String(endYear).slice(2)}`;
}
