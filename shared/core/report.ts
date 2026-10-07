// Monthly report: your split vs YOUR target, top 5 leaks, month-on-month change.
import type { DetectorId, MonthlyReport, Tx } from '../types';
import { DETECTOR_LABEL } from './detectors';
import { monthsBack } from './dates';

type RTx = Pick<Tx, 'id' | 'amount_paise' | 'bucket' | 'category_name' | 'regret'>;

export function totalsOf(txs: RTx[]) {
  const t = { need: 0, want: 0, waste: 0 };
  for (const x of txs) if (x.bucket !== 'ignore') t[x.bucket] += x.amount_paise;
  return t;
}

export function monthlyReport(i: {
  month: string; txs: RTx[]; prevTxs: RTx[]; incomePaise: number;
  targets: { need: number; want: number; savings: number }; flags: Map<number, DetectorId[]>;
}): MonthlyReport {
  const totals = totalsOf(i.txs), prev = totalsOf(i.prevTxs);
  const spent = totals.need + totals.want + totals.waste;
  const prevSpent = prev.need + prev.want + prev.waste;
  const pct = (n: number) => (i.incomePaise > 0 ? Math.round((n / i.incomePaise) * 1000) / 10 : 0);

  // A "leak" = waste, or a want that tripped an impulse signal. Grouped by category.
  const leaks = new Map<string, { amount: number; count: number; reasons: Set<string> }>();
  for (const t of i.txs) {
    const f = i.flags.get(t.id) ?? [];
    if (t.bucket === 'ignore' || t.bucket === 'need' || (t.bucket === 'want' && f.length === 0)) continue;
    const k = t.category_name ?? 'Other';
    const l = leaks.get(k) ?? { amount: 0, count: 0, reasons: new Set<string>() };
    l.amount += t.amount_paise; l.count++;
    if (t.regret === 1) l.reasons.add('regret');
    f.forEach((d) => l.reasons.add(DETECTOR_LABEL[d]));
    leaks.set(k, l);
  }
  return {
    month: i.month, prev_month: monthsBack(i.month, 1)[0], income_paise: i.incomePaise, spent_paise: spent,
    saved_paise: i.incomePaise - spent, totals,
    pct: { need: pct(totals.need), want: pct(totals.want + totals.waste), waste: pct(totals.waste), savings: pct(i.incomePaise - spent) },
    targets: i.targets,
    top_leaks: [...leaks].map(([label, l]) => ({ label, amount_paise: l.amount, count: l.count, reasons: [...l.reasons] }))
      .sort((a, b) => b.amount_paise - a.amount_paise).slice(0, 5),
    vs_prev: { need: totals.need - prev.need, want: totals.want - prev.want, waste: totals.waste - prev.waste, spent: spent - prevSpent },
  };
}
