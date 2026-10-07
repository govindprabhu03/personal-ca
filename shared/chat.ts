// Chat entry: "chai 20, auto 60, yesterday swiggy 340 cash" -> three entries. Pure rules (no LLM needed),
// and shared so the app can preview instantly while the server stays the one place that saves.
import type { PaymentMethod } from './types';

export interface ChatItem { merchant: string; amount_paise: number; payment_method?: PaymentMethod; day_offset: number }

const METHODS: [RegExp, PaymentMethod][] = [
  [/\bcash\b/gi, 'cash'], [/\b(credit card|card|cc)\b/gi, 'card'], [/\b(upi|gpay|phonepe|paytm)\b/gi, 'upi'], [/\b(pay ?later|bnpl|simpl|lazypay)\b/gi, 'bnpl'],
];

export function parseChat(text: string): ChatItem[] {
  const out: ChatItem[] = [];
  const clean = text.replace(/(\d),(\d{3})/g, '$1$2'); // "1,200" must survive the comma split
  for (let seg of clean.split(/[,;\n+]|\s&\s|\sand\s/i)) {
    let day_offset = 0;
    if (/\byesterday\b/i.test(seg)) day_offset = 1;
    seg = seg.replace(/\b(yesterday|today)\b/gi, ' ');
    let payment_method: PaymentMethod | undefined;
    for (const [re, m] of METHODS) if (re.test(seg)) { payment_method = m; seg = seg.replace(re, ' '); }
    seg = seg.replace(/[₹$@#*()]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!seg) continue;
    let merchant = '', num = '', k: string | undefined;
    let m = seg.match(/^(?:rs\.?|inr)?\s*(\d+(?:\.\d{1,2})?)\s*(k)?\s+([^\d].*)$/i); // "20 chai"
    if (m) { num = m[1]; k = m[2]; merchant = m[3]; }
    else if ((m = seg.match(/^(.*?)[\s:-]*(?:rs\.?|inr)?\s*(\d+(?:\.\d{1,2})?)\s*(k)?$/i))) { merchant = m[1]; num = m[2]; k = m[3]; } // "chai 20"
    else continue;
    const paise = Math.round(parseFloat(num) * (k ? 1000 : 1) * 100);
    if (paise > 0) out.push({ merchant: merchant.replace(/\b(rs\.?|inr)\s*$/i, '').trim(), amount_paise: paise, payment_method, day_offset });
  }
  return out;
}

/** "Yesterday" has no clock time, so it is stamped noon (never "late night"). Today -> undefined: the server stamps now. */
export function stampFor(dayOffset: number, now = new Date()): string | undefined {
  if (!dayOffset) return undefined;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOffset);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T12:00:00`;
}
