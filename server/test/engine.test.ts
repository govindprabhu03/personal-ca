import { describe, expect, it } from 'vitest';
import { formatRupees, parseRupees } from '../../shared/money';
import { categorise, normaliseMerchant } from '../../shared/categorise';
import { decrypt, encrypt } from '../src/engine/crypto';
import { DTx, runDetectors } from '../src/engine/detectors';
import { safeToSpend, savingsPlan } from '../src/engine/savings';
import { parseDate, parseStatement } from '../src/engine/statement';

describe('money', () => {
  it('parses and formats paise with Indian grouping', () => {
    expect(parseRupees('1,250.50')).toBe(125050);
    expect(parseRupees('₹90')).toBe(9000);
    expect(parseRupees('abc')).toBeNull();
    expect(formatRupees(9000000)).toBe('₹90,000');
    expect(formatRupees(12345678)).toBe('₹1,23,456.78');
  });
});

describe('categorise', () => {
  const ctx = (rules = new Map()) => ({ userRules: rules, bucketOf: (n: string) => (n === 'Food Delivery' ? 'want' : n === 'Transport' ? 'need' : 'want') as never });
  it('cleans noisy narrations', () => {
    expect(normaliseMerchant('UPI-SWIGGY-swiggy@icici-ICIC0001-4123-UPI')).toBe('Swiggy');
    expect(normaliseMerchant('UPI/DR/412345678901/ZOMATO/HDFC/zomato@hdfcbank')).toBe('Zomato');
    expect(normaliseMerchant('POS 400000XXXXXX1234 AMAZON PAY INDIA')).toBe('Amazon Pay India');
  });
  it('uses keyword rules, then your corrections win', () => {
    expect(categorise('Zomato', '', ctx()).category).toBe('Food Delivery');
    const rules = new Map([['zomato', { category: 'Groceries', bucket: 'need' as const }]]);
    const v = categorise('Zomato', '', ctx(rules));
    expect([v.category, v.source, v.confidence]).toEqual(['Groceries', 'user', 1]);
  });
  it('context overrides: a late ride is a want, unknown text is low confidence', () => {
    expect(categorise('Auto', '', { ...ctx(), hour: 8 }).bucket).toBe('need');
    expect(categorise('Auto', '', { ...ctx(), hour: 1 }).bucket).toBe('want');
    expect(categorise('xyzzy', '', ctx()).confidence).toBeLessThan(0.6);
  });
});

describe('statement import', () => {
  it('parses a bank layout, keeps identical rows, and hashes are stable', () => {
    const csv = [
      'Statement of account,,,,,,', 'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
      '01/03/26,UPI-SWIGGY-swiggy@icici-ICIC0001-4123-UPI,0000412,01/03/26,"1,250.50",,50000',
      '01/03/26,UPI-SWIGGY-swiggy@icici-ICIC0001-4123-UPI,0000412,01/03/26,"1,250.50",,48750',
      '02/03/26,UPI-RAMESH-ramesh@oksbi,0000999,02/03/26,,500.00,49250', 'Total,,,,2501.00,500.00,',
    ].join('\n');
    const a = parseStatement(csv), b = parseStatement(csv);
    expect(a.rows).toHaveLength(3);
    expect(a.rows[0].amount_paise).toBe(125050);
    expect(a.rows[2].direction).toBe('credit');
    expect(new Set(a.rows.map((r) => r.hash)).size).toBe(3);
    expect(a.rows.map((r) => r.hash)).toEqual(b.rows.map((r) => r.hash));
  });
  it('handles an Amount + Type layout and many date formats', () => {
    const r = parseStatement('Date,Transaction Details,Type,Amount\n"Oct 05, 2026 10:30 PM",Paid to Chai Point,DEBIT,₹40.00');
    expect(r.rows[0]).toMatchObject({ occurred_at: '2026-10-05T22:30:00', direction: 'debit', amount_paise: 4000 });
    expect(parseDate('5-Mar-26')).toBe('2026-03-05T12:00:00');
    expect(parseDate('garbage')).toBeNull();
  });
});

let n = 0;
const tx = (o: Partial<DTx>): DTx => ({ id: ++n, amount_paise: 10000, occurred_at: '2026-03-05T14:00:00', merchant_raw: 'X', merchant_norm: 'X',
  category_name: 'Food Delivery', bucket: 'want', payment_method: 'upi', note: '', regret: null, ...o });

describe('detectors', () => {
  const ids = (f: ReturnType<typeof runDetectors>, d: string) => f.find((x) => x.detector === d)?.tx_ids ?? [];
  it('flags late night, pay-later, sale and fees', () => {
    const late = tx({ occurred_at: '2026-03-05T23:40:00' }), card = tx({ payment_method: 'card' }), sale = tx({ note: 'Myntra SALE' });
    const fee = tx({ merchant_raw: 'Late payment fee', category_name: 'Fees & Penalties', bucket: 'waste' });
    const f = runDetectors([late, card, sale, fee, tx({})], [], '2026-03', '2026-03-10');
    expect(ids(f, 'late_night')).toEqual([late.id]);
    expect(ids(f, 'pay_later')).toEqual([card.id]);
    expect(ids(f, 'sale')).toEqual([sale.id]);
    expect(ids(f, 'fee')).toEqual([fee.id]);
  });
  it('flags 15+ small leaks but not 14', () => {
    const mk = (k: number) => Array.from({ length: k }, () => tx({ amount_paise: 2000 }));
    expect(ids(runDetectors(mk(15), [], '2026-03', '2026-03-10'), 'small_leaks')).toHaveLength(15);
    expect(ids(runDetectors(mk(14), [], '2026-03', '2026-03-10'), 'small_leaks')).toHaveLength(0);
  });
  it('flags a possible double charge only when the time is known', () => {
    const a = tx({ merchant_norm: 'Netflix', amount_paise: 64900, occurred_at: '2026-03-05T10:00:00' });
    const b = tx({ merchant_norm: 'Netflix', amount_paise: 64900, occurred_at: '2026-03-05T10:04:00' });
    expect(ids(runDetectors([a, b], [], '2026-03', '2026-03-10'), 'double_charge')).toHaveLength(2);
    const c = tx({ merchant_norm: 'Chai', occurred_at: '2026-03-05T12:00:00' }), d = tx({ merchant_norm: 'Chai', occurred_at: '2026-03-05T12:00:00' });
    expect(ids(runDetectors([c, d], [], '2026-03', '2026-03-10'), 'double_charge')).toHaveLength(0);
  });
  it('flags a category spike vs its 8-week average', () => {
    const hist = Array.from({ length: 8 }, (_, w) => tx({ amount_paise: 20000, occurred_at: `2026-0${w < 4 ? 2 : 1}-${10 + w}T14:00:00` })); // ~Rs200/week
    const week = [1, 2, 3].map((d) => tx({ amount_paise: 30000, occurred_at: `2026-03-0${d + 5}T14:00:00` })); // Rs900 this week
    expect(ids(runDetectors([...hist, ...week], [], '2026-03', '2026-03-11'), 'spike').length).toBeGreaterThan(0);
    const subs = week.map((t) => ({ ...t, category_name: 'Subscriptions' })); // monthly bills must not count as spikes
    expect(ids(runDetectors([...hist.map((t) => ({ ...t, category_name: 'Subscriptions' })), ...subs], [], '2026-03', '2026-03-11'), 'spike')).toHaveLength(0);
  });
});

describe('savings engine', () => {
  it('safe-to-spend matches the worked formula (whole rupees, today included)', () => {
    const r = safeToSpend({ date: '2026-10-11', incomePaise: 3000000, incomeIsEstimate: false, fixedNeedsPaise: 800000, savingsTargetPaise: 600000, spentSoFarPaise: 500000 });
    expect([r.days_left, r.remaining_paise, r.per_day_paise, r.status]).toEqual([21, 1100000, 52300, 'ok']);
    expect(safeToSpend({ date: '2026-10-11', incomePaise: 3000000, incomeIsEstimate: false, fixedNeedsPaise: 800000, savingsTargetPaise: 600000, spentSoFarPaise: 1700000 }).status).toBe('over');
  });
  it('sizes the emergency fund (x3-6, x6-12 if irregular) and steps down when unrealistic', () => {
    const base = { takeHomePaise: 3000000, essentialMonthlyPaise: 1500000, irregular: false, savedPaise: 0, targetPct: 20, fixedNeedsPaise: 800000, horizonMonths: 12 };
    const p = savingsPlan(base);
    expect([p.targets.min_paise, p.targets.max_paise, p.stage, p.pct_target_paise]).toEqual([4500000, 9000000, 'starter', 600000]);
    expect(savingsPlan({ ...base, irregular: true }).targets.max_paise).toBe(18000000);
    const tight = savingsPlan({ ...base, takeHomePaise: 2000000, fixedNeedsPaise: 1800000, essentialMonthlyPaise: 1800000 });
    expect([tight.start_at_paise, tight.stepped_down]).toEqual([100000, true]);
    expect(savingsPlan({ ...base, savedPaise: 1500000 }).stage).toBe('min');
  });
});

describe('encrypted backup', () => {
  it('round-trips and rejects a wrong passphrase', () => {
    const blob = encrypt('{"hello":"world"}', 'secret-1');
    expect(decrypt(blob, 'secret-1')).toBe('{"hello":"world"}');
    expect(() => decrypt(blob, 'wrong-pass')).toThrow();
  });
});

