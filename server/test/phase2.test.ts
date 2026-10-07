import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseChat, stampFor } from '../../shared/chat';
import { createApp } from '../src/app';
import { openDb } from '../src/db';
import { detectSubscriptions } from '../src/engine/subscriptions';

describe('chat entry parser', () => {
  it('splits entries and reads amounts either side of the name', () => {
    expect(parseChat('chai 20, auto 60').map((i) => [i.merchant, i.amount_paise])).toEqual([['chai', 2000], ['auto', 6000]]);
    expect(parseChat('20 chai and 30 samosa').map((i) => [i.merchant, i.amount_paise])).toEqual([['chai', 2000], ['samosa', 3000]]);
  });
  it('understands k, thousands commas, payment words and yesterday', () => {
    expect(parseChat('1,200 rent')[0].amount_paise).toBe(120000);
    expect(parseChat('laptop stand 2k')[0].amount_paise).toBe(200000);
    expect(parseChat('yesterday swiggy 340 cash')[0]).toMatchObject({ merchant: 'swiggy', amount_paise: 34000, payment_method: 'cash', day_offset: 1 });
    expect(parseChat('hello world')).toEqual([]);
  });
  it('stamps yesterday at noon and leaves today to the server', () => {
    expect(stampFor(1, new Date(2026, 2, 10))).toBe('2026-03-09T12:00:00');
    expect(stampFor(0)).toBeUndefined();
  });
});

describe('subscription finder', () => {
  const t = (d: string, amt = 11900) => ({ merchant_norm: 'Spotify', category_name: 'Subscriptions', bucket: 'want' as const, amount_paise: amt, occurred_at: `${d}T10:00:00` });
  it('needs 3+ monthly charges with a stable amount', () => {
    const s = detectSubscriptions([t('2026-01-05'), t('2026-02-05'), t('2026-03-05')], '2026-03-10');
    expect(s[0]).toMatchObject({ merchant: 'Spotify', charges: 3, next_due: '2026-04-04', days_until: 25 });
    expect(detectSubscriptions([t('2026-01-05'), t('2026-03-05')], '2026-03-10')).toHaveLength(0);
    expect(detectSubscriptions([t('2026-01-05'), t('2026-02-05'), t('2026-03-05', 50000)], '2026-03-10')).toHaveLength(0);
    expect(detectSubscriptions([t('2026-01-05'), t('2026-01-20'), t('2026-03-05')], '2026-03-10')).toHaveLength(0);
  });
});

let base = '', server: ReturnType<ReturnType<typeof createApp>['listen']>;
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
};
beforeAll(async () => {
  server = createApp(openDb(':memory:'), { today: () => '2026-03-10' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });

describe('Phase 2 API', () => {
  it('bulk-logs chat entries, categorises them, and counts the streak', async () => {
    const r = await call('POST', '/api/transactions/bulk', { items: [
      { amount_paise: 2000, merchant_raw: 'chai', occurred_at: '2026-03-10T09:00:00' },
      { amount_paise: 6000, merchant_raw: 'auto', occurred_at: '2026-03-09T09:00:00' },
    ] });
    expect(r.status).toBe(201);
    expect(r.json.map((t: { category_name: string }) => t.category_name)).toEqual(['Chai & Snacks', 'Transport']);
    expect((await call('GET', '/api/bootstrap')).json.streak).toBe(2);
  });

  it('finds a subscription, and "I do not use this" turns it into waste', async () => {
    for (const d of ['2026-01-05', '2026-02-05', '2026-03-05'])
      await call('POST', '/api/transactions', { amount_paise: 11900, merchant_raw: 'Spotify', occurred_at: `${d}T10:00:00` });
    const subs = (await call('GET', '/api/subscriptions')).json;
    expect(subs[0]).toMatchObject({ merchant: 'Spotify', days_until: 25, unused: false, yearly_paise: 144783 });
    const after = (await call('POST', '/api/subscriptions/mark', { merchant: 'Spotify', unused: true })).json;
    expect(after[0].unused).toBe(true);
    expect((await call('GET', '/api/report/monthly?month=2026-03')).json.totals.waste).toBe(11900);
    await call('POST', '/api/subscriptions/mark', { merchant: 'Spotify', unused: false });
    expect((await call('GET', '/api/report/monthly?month=2026-03')).json.totals.waste).toBe(0);
  });

  it('goals track progress and the monthly amount needed', async () => {
    await call('POST', '/api/goals', { name: 'Laptop', emoji: '💻', target_paise: 1000000, target_date: '2026-06-10' });
    const g = (await call('POST', '/api/goals/1/contribute', { add_paise: 25000 })).json[0];
    expect([g.saved_paise, g.monthly_needed_paise]).toEqual([25000, 243750]);
    expect((await call('POST', '/api/goals/99/contribute', { add_paise: 1 })).status).toBe(404);
  });

  it('wishlist makes you wait, and skipped wishes count as money kept', async () => {
    const w = (await call('POST', '/api/wishlist', { name: 'Sneakers', price_paise: 450000, wait_hours: 24 })).json;
    expect(w.items[0].hours_left).toBeGreaterThan(22);
    expect((await call('POST', `/api/wishlist/${w.items[0].id}/decide`, { decision: 'bought' })).status).toBe(409);
    const done = (await call('POST', `/api/wishlist/${w.items[0].id}/decide`, { decision: 'skipped' })).json;
    expect([done.items.length, done.skipped_paise, done.skipped_count]).toEqual([0, 450000, 1]);
  });
});
