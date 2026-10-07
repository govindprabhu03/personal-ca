import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeShares, parseNames } from '../../shared/splits';
import { createApp } from '../src/app';
import { openDb } from '../src/db';
import { billStatus, nextCycle } from '../src/engine/bills';

describe('split maths', () => {
  it('splits equally and gives rounding paise to whoever paid', () => {
    expect(computeShares({ total: 10000, friends: ['A', 'B'], payer: null })).toEqual({ mine: 3334, shares: [{ person: 'A', paise: 3333 }, { person: 'B', paise: 3333 }] });
    const r = computeShares({ total: 10000, friends: ['A', 'B'], payer: 'b' });
    expect([r.mine, r.shares.map((s) => s.paise)]).toEqual([3333, [3333, 3334]]);
    expect(r.mine + r.shares.reduce((s, x) => s + x.paise, 0)).toBe(10000);
  });
  it('supports an exact share for you, and rejects nonsense', () => {
    const r = computeShares({ total: 1000, friends: ['A', 'B'], payer: null, myShare: 400 });
    expect([r.mine, r.shares.map((s) => s.paise)]).toEqual([400, [300, 300]]);
    expect(computeShares({ total: 1000, friends: ['A'], payer: null, myShare: 0 }).mine).toBe(0);
    expect(() => computeShares({ total: 1000, friends: [], payer: null })).toThrow();
    expect(() => computeShares({ total: 1000, friends: ['A'], payer: 'Zed' })).toThrow();
    expect(() => computeShares({ total: 1000, friends: ['A'], payer: null, myShare: 2000 })).toThrow();
  });
  it('parses names from "Ria, Sam and Joe"', () => {
    expect(parseNames('Ria, Sam and Joe, ria')).toEqual(['Ria', 'Sam', 'Joe']);
  });
});

describe('bill cycles', () => {
  it('is due this month until paid, then next month', () => {
    expect(nextCycle(null, '2026-03-10', 12)).toMatchObject({ due: '2026-03-12', days_until: 2, paid_this_month: false });
    expect(nextCycle('2026-02', '2026-03-10', 5)).toMatchObject({ due: '2026-03-05', days_until: -5 }); // missed: overdue
    expect(nextCycle('2026-03', '2026-03-10', 5)).toMatchObject({ due: '2026-04-05', days_until: 26, paid_this_month: true });
    expect(nextCycle('2026-04', '2026-03-10', 5).cycle).toBe('2026-05'); // paid ahead
  });
  it('clamps day 31 into short months and labels status', () => {
    expect(nextCycle(null, '2026-02-10', 31).due).toBe('2026-02-28');
    expect([billStatus(-1, 3), billStatus(3, 3), billStatus(4, 3)]).toEqual(['overdue', 'due_soon', 'upcoming']);
  });
});

let base = '', server: ReturnType<ReturnType<typeof createApp>['listen']>;
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
};
const bank = async () => (await call('GET', '/api/bootstrap')).json.accounts[0].balance_paise as number;
const realMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`; // local, like the server; spends are stamped with the real clock, only "today" is injected
beforeAll(async () => {
  server = createApp(openDb(':memory:'), { today: () => '2026-03-10' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });

describe('bills API', () => {
  it('lists bills by urgency; a due day already past this month is assumed handled', async () => {
    await call('POST', '/api/bills', { name: 'Electricity', amount_paise: 180000, due_day: 5 });
    const list = (await call('POST', '/api/bills', { name: 'Wifi', amount_paise: 59900, due_day: 12, remind_days: 3 })).json;
    expect(list.map((b: { name: string; status: string; days_until: number }) => [b.name, b.status, b.days_until])).toEqual([['Wifi', 'due_soon', 2], ['Electricity', 'upcoming', 26]]);
  });
  it('paying logs the spend (bills are needs), then moves the due date a month on', async () => {
    const after = (await call('POST', '/api/bills/2/pay', {})).json;
    expect(after.find((b: { name: string }) => b.name === 'Wifi')).toMatchObject({ next_due: '2026-04-12', paid_this_month: true });
    const tx = (await call('GET', `/api/transactions?month=${realMonth}`)).json.find((t: { merchant_raw: string }) => t.merchant_raw === 'Wifi');
    expect([tx.category_name, tx.bucket, tx.amount_paise]).toEqual(['Utilities & Recharge', 'need', 59900]);
    expect((await call('POST', '/api/bills/1/pay', { log_spend: false })).status).toBe(200); // "already logged it"
    expect((await call('GET', `/api/transactions?month=${realMonth}`)).json.filter((t: { merchant_raw: string }) => t.merchant_raw === 'Electricity')).toHaveLength(0);
  });
  it('EMIs count down and retire after the last instalment', async () => {
    await call('POST', '/api/bills', { name: 'Phone EMI', kind: 'emi', amount_paise: 250000, due_day: 15, installments_left: 2 });
    const one = (await call('POST', '/api/bills/3/pay', {})).json;
    expect(one.find((b: { name: string }) => b.name === 'Phone EMI').installments_left).toBe(1);
    const two = (await call('POST', '/api/bills/3/pay', {})).json;
    expect(two.some((b: { name: string }) => b.name === 'Phone EMI')).toBe(false);
    const tx = (await call('GET', `/api/transactions?month=${realMonth}`)).json.find((t: { merchant_raw: string }) => t.merchant_raw === 'Phone EMI');
    expect(tx.category_name).toBe('EMI & Loans');
    expect((await call('POST', '/api/bills/99/pay', {})).status).toBe(404);
  });
});

describe('splits & IOUs API', () => {
  it('you pay for the group: only your share is a spend, but the full amount left your account', async () => {
    const before = await bank();
    const s = (await call('POST', '/api/ious/split', { amount_paise: 120000, merchant_raw: 'Dinner', friends: ['Ria', 'Sam'], paid_by: null })).json;
    expect([s.owed_to_me_paise, s.i_owe_paise]).toEqual([80000, 0]);
    const tx = (await call('GET', `/api/transactions?month=${realMonth}`)).json.find((t: { merchant_raw: string }) => t.merchant_raw === 'Dinner');
    expect(tx.amount_paise).toBe(40000); // budget sees ₹400, not ₹1,200
    expect(before - (await bank())).toBe(120000); // the account really paid ₹1,200
  });
  it('a friend paying you back nets out: no income, no expense, balance restored', async () => {
    const before = await bank();
    const s = (await call('POST', '/api/ious/settle', { person: 'ria' })).json; // case-insensitive
    expect(s.owed_to_me_paise).toBe(40000);
    expect((await bank()) - before).toBe(40000);
    expect((await call('GET', '/api/income?month=2026-03')).json).toHaveLength(0);
  });
  it('a friend pays for you: you owe your share, and cash only leaves when you settle', async () => {
    const before = await bank();
    const s = (await call('POST', '/api/ious/split', { amount_paise: 90000, merchant_raw: 'Cab', friends: ['Sam'], paid_by: 'Sam' })).json;
    expect(await bank()).toBe(before); // you have not paid Sam yet
    expect([s.owed_to_me_paise, s.i_owe_paise]).toEqual([0, 5000]); // Sam owed you 400, you owe Sam 450
    const settled = (await call('POST', '/api/ious/settle', { person: 'Sam' })).json;
    expect([settled.owed_to_me_paise, settled.i_owe_paise]).toEqual([0, 0]);
    expect(before - (await bank())).toBe(5000);
  });
  it('plain lending, partial settling, and input checks', async () => {
    await call('POST', '/api/ious/entry', { person: 'Zoya', amount_paise: 20000, kind: 'lent' });
    const part = (await call('POST', '/api/ious/settle', { person: 'Zoya', amount_paise: 5000 })).json;
    expect(part.people.find((p: { person: string }) => p.person === 'Zoya').balance_paise).toBe(15000);
    expect((await call('POST', '/api/ious/settle', { person: 'Nobody' })).status).toBe(409);
    expect((await call('POST', '/api/ious/split', { amount_paise: 1000, friends: [], paid_by: null })).status).toBe(400);
    expect((await call('POST', '/api/ious/split', { amount_paise: 1000, friends: ['A'], paid_by: 'Zed' })).status).toBe(400);
  });
  it('survives an encrypted backup round-trip', async () => {
    const { backup } = (await call('POST', '/api/backup', { passphrase: 'correct-horse' })).json;
    await call('POST', '/api/erase', { confirm: true });
    expect((await call('GET', '/api/ious')).json.people).toHaveLength(0);
    expect((await call('POST', '/api/restore', { passphrase: 'correct-horse', backup })).status).toBe(200);
    expect((await call('GET', '/api/ious')).json.owed_to_me_paise).toBe(15000);
    expect((await call('GET', '/api/bills')).json.some((b: { name: string }) => b.name === 'Wifi')).toBe(true);
  });
});
