// Step 3: the waste detectors. Pure functions over plain arrays (no DB) so they are easy to unit test.
// Impulse signals only FLAG a want; the weekly regret tap is the ground truth that turns it into waste.
import type { DetectorId, Flag, Tx } from '../types';
import { formatRupees } from '../money';
import { addDays, hourOf, isLateHour, minutesBetween } from './dates';

export type DTx = Pick<Tx, 'id' | 'amount_paise' | 'occurred_at' | 'merchant_raw' | 'merchant_norm' | 'category_name' | 'bucket' | 'payment_method' | 'note' | 'regret'>;
export interface DInc { amount_paise: number; received_at: string; is_regular: 0 | 1 }

// Starting values from the research doc: tune them on your own data.
export const CFG = {
  spikeMultiple: 1.5, spikeMinPaise: 30000,
  leakCount: 15, leakMaxPaise: 15000,
  doubleMinutes: 10,
  paydayDays: 2, paydayMinPaise: 50000,
  repeatRegretMin: 2,
};
const SALE = /\b(sale|offer|discount|deal|coupon|cashback|flash)\b/i;
const FEE = /late (payment )?fee|penalty|convenience fee|processing fee|overdue|dishonou?r|bounce charge|\bfine\b/i;
const sum = (ts: DTx[]) => ts.reduce((s, t) => s + t.amount_paise, 0);

export { DETECTOR_LABEL } from '../labels';

/** `all` must cover the month plus ~9 weeks of history (for spike / payday baselines). */
export function runDetectors(all: DTx[], incomes: DInc[], month: string, asOf: string): Flag[] {
  const flags: Flag[] = [];
  const add = (detector: DetectorId, reason: string, ts: DTx[]) => {
    if (ts.length) flags.push({ detector, reason, tx_ids: ts.map((t) => t.id), amount_paise: sum(ts) });
  };
  const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? 's' : ''}`;

  const spend = all.filter((t) => t.bucket !== 'ignore');
  const monthTx = spend.filter((t) => t.occurred_at.startsWith(month));
  const isWant = (t: DTx) => t.bucket !== 'need';
  const wants = monthTx.filter(isWant);
  const wantsAll = spend.filter(isWant);

  const late = wants.filter((t) => isLateHour(hourOf(t.occurred_at))); // statement rows are stamped 12:00, so never "late"
  add('late_night', `${plural(late.length, 'late-night spend')} (11 pm-4 am) · ${formatRupees(sum(late))}`, late);

  const sale = wants.filter((t) => SALE.test(`${t.merchant_raw} ${t.note}`));
  add('sale', `${plural(sale.length, 'sale/offer-driven buy')} · ${formatRupees(sum(sale))}`, sale);

  const later = wants.filter((t) => t.payment_method === 'card' || t.payment_method === 'bnpl');
  add('pay_later', `${plural(later.length, 'want')} on card / pay-later (delayed pain) · ${formatRupees(sum(later))}`, later);

  const small = wants.filter((t) => t.amount_paise < CFG.leakMaxPaise);
  if (small.length >= CFG.leakCount)
    add('small_leaks', `${small.length} small spends under ${formatRupees(CFG.leakMaxPaise)} add up to ${formatRupees(sum(small))}`, small);

  const fees = monthTx.filter((t) => t.category_name === 'Fees & Penalties' || FEE.test(`${t.merchant_raw} ${t.note}`));
  add('fee', `${plural(fees.length, 'fee/penalty')} · always waste · ${formatRupees(sum(fees))}`, fees);

  // Same merchant + same amount within 10 minutes. Skip noon-stamped rows: their real time is unknown.
  const sorted = [...monthTx].sort((a, b) => a.merchant_norm.localeCompare(b.merchant_norm) || a.amount_paise - b.amount_paise || a.occurred_at.localeCompare(b.occurred_at));
  const dup = new Set<DTx>();
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (a.occurred_at.endsWith('T12:00:00') || b.occurred_at.endsWith('T12:00:00')) continue;
    if (a.merchant_norm === b.merchant_norm && a.amount_paise === b.amount_paise && minutesBetween(a.occurred_at, b.occurred_at) <= CFG.doubleMinutes) { dup.add(a); dup.add(b); }
  }
  add('double_charge', `Check this: ${dup.size} charges look duplicated`, [...dup]);

  const regrets = new Map<string, number>();
  for (const t of all) if (t.regret === 1) regrets.set(t.merchant_norm, (regrets.get(t.merchant_norm) ?? 0) + 1);
  const repeat = wants.filter((t) => t.regret !== 1 && (regrets.get(t.merchant_norm) ?? 0) >= CFG.repeatRegretMin);
  add('repeat_regret', `${plural(repeat.length, 'spend')} at merchants you regretted ${CFG.repeatRegretMin}+ times before`, repeat);

  // Spike: a want category this week vs its own 8-week average.
  const weekStart = addDays(asOf, -6);
  const priorStart = addDays(weekStart, -56);
  const cats = new Map<string, { week: DTx[]; priorAmt: number; priorCnt: number }>();
  for (const t of wantsAll) {
    const d = t.occurred_at.slice(0, 10);
    const k = t.category_name ?? 'Other';
    const c = cats.get(k) ?? { week: [], priorAmt: 0, priorCnt: 0 };
    if (d >= weekStart && d <= asOf) c.week.push(t);
    else if (d >= priorStart && d < weekStart) { c.priorAmt += t.amount_paise; c.priorCnt++; }
    cats.set(k, c);
  }
  for (const [name, c] of cats) {
    if (name === 'Subscriptions') continue; // a monthly bill always looks like a "spike" against a weekly average
    const avgAmt = c.priorAmt / 8, avgCnt = c.priorCnt / 8, amt = sum(c.week);
    const amtSpike = avgAmt > 0 && amt > CFG.spikeMultiple * avgAmt && amt >= CFG.spikeMinPaise;
    const cntSpike = c.week.length >= 4 && c.week.length > CFG.spikeMultiple * avgCnt;
    if (amtSpike || cntSpike)
      add('spike', `${name}: ${c.week.length}× / ${formatRupees(amt)} this week vs ~${formatRupees(Math.round(avgAmt))} weekly average`, c.week);
  }

  // Payday splurge: want spend in the 2 days after a regular income, well above your normal pace.
  for (const inc of incomes.filter((i) => i.is_regular && i.received_at.startsWith(month))) {
    const start = inc.received_at.slice(0, 10), end = addDays(start, CFG.paydayDays), histStart = addDays(start, -56);
    const win = wants.filter((t) => { const d = t.occurred_at.slice(0, 10); return d >= start && d <= end; });
    const hist = wantsAll.filter((t) => { const d = t.occurred_at.slice(0, 10); return d >= histStart && d < start; });
    const baseline = (sum(hist) / 56) * (CFG.paydayDays + 1);
    if (baseline > 0 && sum(win) > CFG.spikeMultiple * baseline && sum(win) >= CFG.paydayMinPaise)
      add('payday', `${formatRupees(sum(win))} on wants within ${CFG.paydayDays} days of payday`, win);
  }
  return flags;
}

export function flagsByTx(flags: Flag[]): Map<number, DetectorId[]> {
  const m = new Map<number, DetectorId[]>();
  for (const f of flags) for (const id of f.tx_ids) m.set(id, [...(m.get(id) ?? []), f.detector]);
  return m;
}
