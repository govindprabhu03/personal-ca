// End-to-end through real HTTP + a real (in-memory) SQLite DB: quick-add -> verdict -> regret -> numbers -> import -> backup.
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { openDb } from '../src/db';

let base = '', server: ReturnType<ReturnType<typeof createApp>['listen']>;
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, json: (() => { try { return JSON.parse(text); } catch { return text; } })() };
};

beforeAll(async () => {
  server = createApp(openDb(':memory:'), { today: () => '2026-03-10' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });

describe('Personal CA API', () => {
  let zomatoId = 0;
  it('quick-add suggests a verdict and the detectors flag it', async () => {
    await call('POST', '/api/income', { amount_paise: 3000000, received_at: '2026-03-01T09:00:00', is_regular: true, source: 'Stipend' });
    await call('PUT', '/api/settings', { fixed_needs_paise: 800000 });
    const t = await call('POST', '/api/transactions', { amount_paise: 25000, merchant_raw: 'Zomato', occurred_at: '2026-03-05T23:30:00' });
    expect(t.status).toBe(201);
    expect([t.json.category_name, t.json.bucket]).toEqual(['Food Delivery', 'want']);
    zomatoId = t.json.id;
    const list = await call('GET', '/api/transactions?month=2026-03');
    expect(list.json[0].flags).toContain('late_night');
  });

  it('weekly regret tap turns a want into waste and drives the report', async () => {
    const review = await call('GET', '/api/review/weekly');
    expect(review.json.map((x: { id: number }) => x.id)).toContain(zomatoId);
    expect((await call('POST', `/api/transactions/${zomatoId}/regret`, { regret: true })).json.bucket).toBe('waste');
    const rep = await call('GET', '/api/report/monthly?month=2026-03');
    expect(rep.json.totals.waste).toBe(25000);
    expect(rep.json.top_leaks[0]).toMatchObject({ label: 'Food Delivery', amount_paise: 25000 });
  });

  it('safe-to-spend uses income, fixed needs, savings target and spend', async () => {
    const s = (await call('GET', '/api/safe-to-spend?date=2026-03-10')).json;
    expect([s.income_paise, s.fixed_needs_paise, s.spent_so_far_paise, s.days_left]).toEqual([3000000, 800000, 25000, 22]);
    expect(s.savings_target_paise).toBe(600000);
    expect(s.per_day_paise).toBe(Math.floor((3000000 - 800000 - 600000 - 25000) / 22 / 100) * 100);
  });

  it('imports a statement once; a re-import adds nothing', async () => {
    const csv = 'Date,Narration,Withdrawal Amt.,Deposit Amt.\n02/03/26,UPI-SWIGGY-swiggy@icici-ICIC0001,"1,250.50",\n03/03/26,UPI-RAMESH-r@oksbi,,500.00\n04/03/26,ATM WDL 99,2000.00,';
    const preview = (await call('POST', '/api/import', { csv })).json;
    expect([preview.committed, preview.rows.length, preview.credits_skipped]).toEqual([false, 2, 1]);
    expect((await call('POST', '/api/import', { csv, commit: true })).json.imported).toBe(2);
    const again = (await call('POST', '/api/import', { csv, commit: true })).json;
    expect([again.imported, again.duplicates]).toEqual([0, 2]);
    const rep = (await call('GET', '/api/report/monthly?month=2026-03')).json;
    expect(rep.totals.want).toBe(125050); // swiggy; the ATM withdrawal is ignored, not "spend"
  });

  it('exports CSV, and an encrypted backup restores everything', async () => {
    expect((await call('GET', '/api/export/transactions.csv')).json).toContain('Zomato');
    const { backup } = (await call('POST', '/api/backup', { passphrase: 'correct-horse' })).json;
    expect((await call('POST', '/api/restore', { passphrase: 'wrong-pass', backup })).status).toBe(400);
    await call('POST', '/api/erase', { confirm: true });
    expect((await call('GET', '/api/transactions?month=2026-03')).json).toHaveLength(0);
    expect((await call('POST', '/api/restore', { passphrase: 'correct-horse', backup })).status).toBe(200);
    expect((await call('GET', '/api/transactions?month=2026-03')).json).toHaveLength(3);
  });

  it('rejects bad input and enforces the API token when set', async () => {
    expect((await call('POST', '/api/transactions', { amount_paise: -5 })).status).toBe(400);
    const guarded = createApp(openDb(':memory:'), { token: 's3cret' }).listen(0);
    await new Promise((r) => guarded.once('listening', r));
    const url = `http://127.0.0.1:${(guarded.address() as AddressInfo).port}/api/bootstrap`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { 'x-api-key': 's3cret' } })).status).toBe(200);
    guarded.close();
  });
});
