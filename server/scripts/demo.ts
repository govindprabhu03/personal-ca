// Fills a running server with a realistic week so every screen has something to show:  npm run demo
// Dates are relative to today, so it always looks current. (To start clean again: More -> Delete all my data.)
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.CA_URL ?? 'http://127.0.0.1:8787';
// works with `npm run phone` too: falls back to the token that script saved
const tokenFile = path.join(__dirname, '..', 'data', '.phone-token');
const token = process.env.CA_API_TOKEN ?? (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : undefined);
const H: Record<string, string> = { 'content-type': 'application/json', ...(token ? { 'x-api-key': token } : {}) };
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${BASE}/api${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: ${await r.text()}`);
  return r.json();
};
const p2 = (n: number) => String(n).padStart(2, '0');
const at = (daysAgo: number, hh = 14, mm = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(hh)}:${p2(mm)}:00`;
};
const month = (back: number) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - back); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`; };
const rs = (n: number) => Math.round(n * 100);

async function main() {
  await call('PUT', '/settings', { fixed_needs_paise: rs(6000), savings_target_pct: 20 });
  for (const back of [0, 1, 2]) await call('POST', '/income', { amount_paise: rs(15000), received_at: `${month(back)}-01T09:00:00`, source: 'Stipend', is_regular: true });
  const cats = Object.fromEntries((await call('GET', '/bootstrap')).categories.map((c: { name: string; id: number }) => [c.name, c.id]));

  // last month's baseline so the spike / month-on-month views have something to compare with
  for (let w = 2; w <= 9; w++) await call('POST', '/transactions', { amount_paise: rs(250), merchant_raw: 'Zomato', occurred_at: at(w * 7, 20, 30) });
  await call('POST', '/transactions', { amount_paise: rs(6000), merchant_raw: 'PG rent', category_id: cats.Rent, occurred_at: `${month(1)}-01T10:00:00` });
  await call('POST', '/transactions', { amount_paise: rs(1800), merchant_raw: 'BigBasket', occurred_at: `${month(1)}-12T18:00:00` });

  const tx = [
    [6000, 'PG rent', 'upi', at(5, 10), cats.Rent], [850, 'BigBasket', 'upi', at(4, 18)], [60, 'Auto to college', 'cash', at(4, 8, 30)],
    [220, 'Apollo Pharmacy', 'upi', at(3, 17)], [340, 'Zomato', 'upi', at(3, 23, 40)], [290, 'Zomato', 'upi', at(2, 22, 10)],
    [410, 'Swiggy', 'upi', at(1, 21, 30)], [260, 'Zomato', 'upi', at(1, 23, 15)], [380, 'Swiggy', 'upi', at(0, 0, 30)],
    [250, 'Uber', 'upi', at(2, 1, 10)], [1299, 'Myntra sale', 'card', at(3, 15)], [649, 'Netflix', 'upi', at(2, 10, 0)],
    [649, 'Netflix', 'upi', at(2, 10, 3)], [100, 'Credit card late fee', 'netbanking', at(1, 11)], [20, 'Chai', 'cash', at(0, 16)],
  ] as const;
  for (const [amt, who, method, when, cat] of tx)
    await call('POST', '/transactions', { amount_paise: rs(amt), merchant_raw: who, payment_method: method, occurred_at: when, category_id: cat });

  // a monthly subscription (finder needs 3+ charges ~30 days apart), a goal, and one wish that is still cooling off
  for (const ago of [95, 65, 35, 5]) await call('POST', '/transactions', { amount_paise: rs(119), merchant_raw: 'Spotify', occurred_at: at(ago, 10), category_id: cats.Subscriptions });
  await call('POST', '/goals', { name: 'New laptop', emoji: '💻', target_paise: rs(45000), target_date: at(-150).slice(0, 10) });
  await call('POST', '/goals/1/contribute', { add_paise: rs(6500) });
  await call('POST', '/goals', { name: 'Goa trip', emoji: '🏖️', target_paise: rs(12000) });
  await call('POST', '/goals/2/contribute', { add_paise: rs(3000) });
  await call('POST', '/wishlist', { name: 'Sneakers', price_paise: rs(4499), wait_hours: 24 });

  // bills & EMIs (due days relative to today so "Coming up" has something), and a split dinner + a small loan
  const dd = new Date().getDate();
  await call('POST', '/bills', { name: 'PG rent', emoji: '🏠', amount_paise: rs(6000), due_day: 1, remind_days: 3 });
  await call('POST', '/bills', { name: 'Wifi', emoji: '🌐', amount_paise: rs(599), due_day: Math.min(28, dd + 2), remind_days: 3 });
  await call('POST', '/bills', { name: 'Phone EMI', emoji: '📱', kind: 'emi', amount_paise: rs(1250), due_day: Math.min(28, dd + 5), remind_days: 3, installments_left: 8 });
  await call('POST', '/ious/split', { amount_paise: rs(1200), merchant_raw: 'Dinner at Fisherman\'s Wharf', friends: ['Ria', 'Sam'], paid_by: null });
  await call('POST', '/ious/entry', { person: 'Zoya', amount_paise: rs(200), kind: 'lent' });

  const open = await call('GET', '/review/weekly');
  const first = open.find((t: { merchant_raw: string }) => t.merchant_raw === 'Zomato');
  if (first) await call('POST', `/transactions/${first.id}/regret`, { regret: true });
  console.log('Demo data loaded. Open the app.');
}
main().catch((e) => { console.error(e.message); process.exit(1); });
