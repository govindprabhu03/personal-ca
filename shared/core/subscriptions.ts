// Subscription finder: same merchant, 3+ charges, ~30 +/- 5 days apart, amount within +/-15%.
// (Thresholds follow the open-source recurring-charge detectors cited in the research doc.)
import type { Subscription, Tx } from '../types';
import { addDays, dayDiff } from './dates';

type STx = Pick<Tx, 'merchant_norm' | 'category_name' | 'bucket' | 'amount_paise' | 'occurred_at'>;

export function detectSubscriptions(txs: STx[], today: string): Omit<Subscription, 'unused'>[] {
  const groups = new Map<string, Map<string, STx>>(); // merchant -> one charge per day
  for (const t of txs) {
    if (t.bucket === 'ignore' || !t.merchant_norm) continue;
    const days = groups.get(t.merchant_norm) ?? new Map<string, STx>();
    days.set(t.occurred_at.slice(0, 10), t);
    groups.set(t.merchant_norm, days);
  }
  const out: Omit<Subscription, 'unused'>[] = [];
  for (const [merchant, byDay] of groups) {
    const days = [...byDay.keys()].sort();
    if (days.length < 3) continue;
    const gaps = days.slice(1).map((d, i) => dayDiff(d, days[i]));
    if (gaps.some((g) => g < 25 || g > 35)) continue;
    const amts = days.map((d) => byDay.get(d)!.amount_paise).sort((a, b) => a - b);
    const med = amts[Math.floor(amts.length / 2)];
    if (amts.some((a) => Math.abs(a - med) > med * 0.15)) continue;
    const avgGap = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
    const last = days[days.length - 1], lastTx = byDay.get(last)!, next = addDays(last, avgGap);
    out.push({
      merchant, category: lastTx.category_name, bucket: lastTx.bucket, amount_paise: med, charges: days.length,
      last_charge: last, next_due: next, days_until: dayDiff(next, today), yearly_paise: Math.round((med * 365) / avgGap),
    });
  }
  return out.sort((a, b) => a.days_until - b.days_until);
}
