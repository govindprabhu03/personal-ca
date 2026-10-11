// Tax details are stored per financial year as one validated document, and travel with the account like everything else.
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import * as svc from '../../shared/core/service';
import { emptyInput } from '../../shared/core/tax/compute';
import { getTaxInput, normaliseTaxInput, saveTaxInput, taxSummary } from '../../shared/core/tax/data';
import { createApp } from '../src/app';
import { openDb } from '../src/db';

const rs = (n: number) => n * 100;

describe('validation: nothing hostile or broken can be stored', () => {
  it('turns garbage into a complete, safe document', () => {
    const d = normaliseTaxInput({ salary_gross: 'lots', tds: -5, d80c: Infinity, evil: 'DROP TABLE', business: { mode: 'sorcery', receipts: 'many' }, let_out: 'nope', filing_date: 'tomorrow' });
    expect(d).toEqual(emptyInput());
    expect(normaliseTaxInput(null)).toEqual(emptyInput());
    expect(normaliseTaxInput('x')).toEqual(emptyInput());
  });
  it('rounds to whole paise, clamps huge numbers, allows capital LOSSES but no negative income, and caps the property list', () => {
    const d = normaliseTaxInput({ salary_gross: 12.6, tds: 1e30, ltcg_112a: -50000, stcg_other: -1, interest_other: -9, let_out: Array(30).fill({ rent: 1, municipal_tax: 2, interest: 3 }) });
    expect([d.salary_gross, d.tds, d.ltcg_112a, d.stcg_other, d.interest_other, d.let_out.length]).toEqual([13, 1e13, -50000, -1, 0, 10]);
  });
  it('keeps digital receipts no larger than total receipts, and valid dates only', () => {
    const d = normaliseTaxInput({ business: { mode: '44ad', receipts: 100, digital_receipts: 500, expenses: 0 }, filing_date: '2026-11-05' });
    expect([d.business.digital_receipts, d.filing_date]).toEqual([100, '2026-11-05']);
  });
});

describe('storage', () => {
  it('saves per year, reads back exactly, and replaces (not merges) on the next save', () => {
    const db = openDb(':memory:');
    expect(getTaxInput(db, '2025-26')).toEqual(emptyInput());
    saveTaxInput(db, '2025-26', { salary_gross: rs(1500000), tds: rs(90000) });
    saveTaxInput(db, '2024-25', { salary_gross: rs(900000) });
    expect(getTaxInput(db, '2025-26')).toMatchObject({ salary_gross: rs(1500000), tds: rs(90000) });
    saveTaxInput(db, '2025-26', { salary_gross: rs(1600000) });
    expect(getTaxInput(db, '2025-26')).toMatchObject({ salary_gross: rs(1600000), tds: 0 });
    expect(getTaxInput(db, '2024-25').salary_gross).toBe(rs(900000));
    expect(() => saveTaxInput(db, "2025-26'; DROP TABLE tax_data; --", {})).toThrow(/financial year/);
  });
  it('counts as data (an account with tax details is not "empty"), travels in the snapshot, and is erased with everything', () => {
    const a = openDb(':memory:'); expect(svc.isEmpty(a)).toBe(true);
    saveTaxInput(a, '2025-26', { salary_gross: rs(800000) });
    expect(svc.isEmpty(a)).toBe(false);
    const b = openDb(':memory:'); svc.importTables(b, svc.exportTables(a));
    expect(getTaxInput(b, '2025-26').salary_gross).toBe(rs(800000));
    svc.eraseAll(b);
    expect(getTaxInput(b, '2025-26').salary_gross).toBe(0);
  });
  it('a corrupted stored document falls back to an empty one instead of crashing the screens', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO tax_data (fy, json) VALUES (?, ?)').run('2025-26', '{not json');
    expect(getTaxInput(db, '2025-26')).toEqual(emptyInput());
  });
});

describe('the summary every screen shares', () => {
  it('follows the profile: age, residency and the regime choice', () => {
    const db = openDb(':memory:');
    saveTaxInput(db, '2025-26', { salary_gross: rs(1500000) });
    const auto = taxSummary(db, '2025-26', '2026-07-01');
    expect([auto.supported, auto.entered, auto.comparison!.chosen, auto.form!.form]).toEqual([true, true, 'new', 'ITR-1']);
    svc.updateProfile(db, { regime_pref: 'old' });
    expect(taxSummary(db, '2025-26', '2026-07-01').comparison!.chosen).toBe('old');
    svc.updateProfile(db, { residency: 'nri' });
    expect(taxSummary(db, '2025-26', '2026-07-01').form!.form).toBe('ITR-2');
  });
  it('says plainly that a year has no rules yet, rather than guessing', () => {
    const s = taxSummary(openDb(':memory:'), '2030-31', '2026-10-11');
    expect([s.supported, s.message]).toEqual([false, expect.stringContaining('not built in')]);
  });
  it('reports the deadlines relative to today', () => {
    const s = taxSummary(openDb(':memory:'), '2025-26', '2026-10-11');
    expect(s.deadlines).toMatchObject({ due: '2026-07-31', belated: '2026-12-31', dueIsPassed: true, belatedIsPassed: false, daysToBelated: 81 });
  });
});

describe('through the API', () => {
  it('saves and returns the summary, ignoring junk fields', async () => {
    const s = createApp(openDb(':memory:'), { today: () => '2026-07-01' }).listen(0); await new Promise((r) => s.once('listening', r));
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const put = await fetch(`${base}/api/tax/2025-26`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ salary_gross: rs(1200000), junk: 'x' }) });
    expect(put.status).toBe(200);
    const sum = (await (await fetch(`${base}/api/tax/2025-26`)).json()) as any;
    expect([sum.entered, sum.comparison.new.tax.total, 'junk' in sum.input]).toEqual([true, 0, false]); // 12 lakh salary: the rebate makes it nil
    expect((await fetch(`${base}/api/tax/not-a-year`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(500);
    s.close();
  });
});
