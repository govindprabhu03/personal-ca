// The service layer: reads the DB, hands plain arrays to the engine (pure functions), returns API-shaped results.
import type {
  Account, Bill, Bootstrap, Bucket, Category, Flag, Goal, IouEntry, IouPerson, IouSummary, ImportResult, ImportRow, IncomeEntry, MonthlyReport,
  PaymentMethod, SafeToSpend, SavingsPlan, Settings, Subscription, Suggestion, Tx, WishItem, Wishlist,
} from '../types';
import { DB, wipe } from './schema';
import { categorise, UserRule } from '../categorise';
import { addDays, addHoursStr, asOfFor, dayDiff, lastDayOf, monthOf, monthsBack, nextMonth, nowStr, hourOf, todayStr } from './dates';
import { detectSubscriptions } from './subscriptions';
import { billStatus, nextCycle } from './bills';
import { computeShares } from '../splits';
import { formatRupees } from '../money';
import { flagsByTx, runDetectors } from './detectors';
import { monthlyReport } from './report';
import { safeToSpend, savingsPlan } from './savings';

type P = (string | number | null)[];
export const all = <T>(db: DB, sql: string, ...p: P) => db.prepare(sql).all(...p) as unknown as T[];
export const get = <T>(db: DB, sql: string, ...p: P) => db.prepare(sql).get(...p) as unknown as T | undefined;
export const run = (db: DB, sql: string, ...p: P) => db.prepare(sql).run(...p);
const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

export class HttpError extends Error { constructor(public status: number, msg: string, public code?: string) { super(msg); } }

// ---------- settings / accounts / categories ----------
export const getSettings = (db: DB) => get<Settings>(db, 'SELECT * FROM settings WHERE id = 1')!;
export function updateSettings(db: DB, patch: Partial<Settings>) {
  const keys = Object.keys(patch) as (keyof Settings)[];
  if (keys.length) run(db, `UPDATE settings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = 1`, ...keys.map((k) => patch[k] as number));
  return getSettings(db);
}
export const listCategories = (db: DB) => all<Category>(db, 'SELECT * FROM categories ORDER BY id');
export const listAccounts = (db: DB) => all<Account>(db, `
  SELECT a.*, a.opening_paise
    + COALESCE((SELECT SUM(amount_paise) FROM income WHERE account_id = a.id), 0)
    - COALESCE((SELECT SUM(amount_paise) FROM transactions WHERE account_id = a.id), 0)
    + COALESCE((SELECT SUM(account_delta_paise) FROM iou_entries WHERE account_id = a.id), 0) AS balance_paise
  FROM accounts a ORDER BY a.id`);
export function addAccount(db: DB, kind: string, name: string, opening: number) {
  run(db, 'INSERT INTO accounts (kind, name, opening_paise) VALUES (?, ?, ?)', kind, name, opening);
  return listAccounts(db);
}
/** Consecutive days (ending today, or yesterday if you have not logged yet) with a manually logged spend. */
export function streakFor(db: DB, today: string): number {
  const days = new Set(all<{ d: string }>(db, "SELECT DISTINCT substr(occurred_at, 1, 10) AS d FROM transactions WHERE source = 'manual' AND occurred_at >= ?", addDays(today, -120)).map((r) => r.d));
  let day = days.has(today) ? today : addDays(today, -1), n = 0;
  while (days.has(day)) { n++; day = addDays(day, -1); }
  return n;
}
export function bootstrap(db: DB, today = todayStr()): Bootstrap {
  const last = get<{ category_id: number | null; account_id: number; payment_method: PaymentMethod }>(
    db, 'SELECT category_id, account_id, payment_method FROM transactions ORDER BY id DESC LIMIT 1');
  return {
    today, streak: streakFor(db, today), settings: getSettings(db), accounts: listAccounts(db), categories: listCategories(db),
    last: { category_id: last?.category_id ?? null, account_id: last?.account_id ?? null, payment_method: last?.payment_method ?? 'upi' },
  };
}

// ---------- categorisation context ----------
export function ctx(db: DB, hour?: number) {
  const userRules = new Map<string, UserRule>();
  for (const r of all<{ pattern: string; bucket: Bucket; name: string }>(db, 'SELECT r.pattern, r.bucket, c.name FROM merchant_rules r JOIN categories c ON c.id = r.category_id'))
    userRules.set(r.pattern, { category: r.name, bucket: r.bucket });
  const buckets = new Map(listCategories(db).map((c) => [c.name, c.default_bucket]));
  return { userRules, bucketOf: (n: string) => buckets.get(n) ?? 'want', hour };
}
const catId = (db: DB, name: string) => get<{ id: number }>(db, 'SELECT id FROM categories WHERE name = ?', name)?.id ?? null;

export function suggest(db: DB, text: string, hour?: number): Suggestion {
  const v = categorise(text, '', ctx(db, hour));
  return { category: v.category, category_id: catId(db, v.category), bucket: v.bucket, confidence: v.confidence, merchant: v.merchant_norm };
}
function learnRule(db: DB, merchantNorm: string, categoryId: number, bucket: Bucket) {
  if (!merchantNorm) return;
  run(db, `INSERT INTO merchant_rules (pattern, category_id, bucket) VALUES (?, ?, ?)
           ON CONFLICT(pattern) DO UPDATE SET category_id = excluded.category_id, bucket = excluded.bucket`, merchantNorm.toLowerCase(), categoryId, bucket);
}

// ---------- transactions ----------
const TX_SQL = 'SELECT t.*, c.name AS category_name FROM transactions t LEFT JOIN categories c ON c.id = t.category_id';
const decorate = (t: Tx): Tx => ({ ...t, needs_review: t.confidence < 0.6 && t.bucket_source !== 'user' });
export const getTx = (db: DB, id: number) => {
  const t = get<Tx>(db, `${TX_SQL} WHERE t.id = ?`, id);
  if (!t) throw new HttpError(404, 'transaction not found');
  return decorate(t);
};
/** [from, toExclusive) by day string. */
export const txBetween = (db: DB, from: string, toExclusive: string) =>
  all<Tx>(db, `${TX_SQL} WHERE t.occurred_at >= ? AND t.occurred_at < ? ORDER BY t.occurred_at DESC, t.id DESC`, from, toExclusive).map(decorate);

export interface NewTx {
  amount_paise: number; merchant_raw?: string; note?: string; category_id?: number | null; account_id?: number;
  payment_method?: PaymentMethod; occurred_at?: string; source?: 'manual' | 'statement'; import_hash?: string;
}
export function createTx(db: DB, i: NewTx): Tx {
  const method = i.payment_method ?? 'upi';
  const at = i.occurred_at ?? nowStr();
  const raw = (i.merchant_raw ?? '').trim(), note = i.note ?? '';
  const auto = categorise(raw, note, ctx(db, hourOf(at)));
  let category_id = catId(db, auto.category), bucket = auto.bucket, source = auto.source, confidence = auto.confidence;

  if (i.category_id) { // the user picked a category: that is the verdict, and a correction teaches the rules
    const c = get<Category>(db, 'SELECT * FROM categories WHERE id = ?', i.category_id);
    if (!c) throw new HttpError(400, 'unknown category');
    if (c.id !== category_id) learnRule(db, auto.merchant_norm, c.id, c.default_bucket);
    category_id = c.id; bucket = c.default_bucket; source = 'user'; confidence = 1;
  }
  const account = i.account_id ?? get<{ id: number }>(db, 'SELECT id FROM accounts WHERE kind = ? ORDER BY id LIMIT 1', method === 'cash' ? 'cash' : 'bank')?.id
    ?? get<{ id: number }>(db, 'SELECT id FROM accounts ORDER BY id LIMIT 1')!.id;
  const r = run(db, `INSERT INTO transactions (account_id, amount_paise, occurred_at, merchant_raw, merchant_norm, category_id, bucket,
      bucket_source, confidence, payment_method, source, note, import_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    account, i.amount_paise, at, raw, auto.merchant_norm, category_id, bucket, source, confidence, method, i.source ?? 'manual', note, i.import_hash ?? null);
  return getTx(db, Number(r.lastInsertRowid));
}

export function patchTx(db: DB, id: number, p: { category_id?: number; bucket?: Bucket; note?: string }): Tx {
  const t = getTx(db, id);
  let cat = p.category_id ?? t.category_id, bucket = p.bucket ?? t.bucket;
  if (p.category_id) {
    const c = get<Category>(db, 'SELECT * FROM categories WHERE id = ?', p.category_id);
    if (!c) throw new HttpError(400, 'unknown category');
    if (!p.bucket) bucket = c.default_bucket;
  }
  run(db, "UPDATE transactions SET category_id = ?, bucket = ?, bucket_source = 'user', confidence = 1, note = ? WHERE id = ?", cat, bucket, p.note ?? t.note, id);
  if (cat && (p.category_id || p.bucket)) learnRule(db, t.merchant_norm, cat, bucket); // every correction teaches the rules
  return getTx(db, id);
}
export const deleteTx = (db: DB, id: number) => { run(db, 'DELETE FROM transactions WHERE id = ?', id); };

/** The weekly "worth it / regret" tap: ground truth for what waste means for YOU. */
export function setRegret(db: DB, id: number, regret: boolean): Tx {
  const t = getTx(db, id);
  if (regret) run(db, "UPDATE transactions SET regret = 1, bucket = 'waste' WHERE id = ?", id);
  else {
    const def = t.category_id ? get<{ default_bucket: Bucket }>(db, 'SELECT default_bucket FROM categories WHERE id = ?', t.category_id)!.default_bucket : 'want';
    run(db, 'UPDATE transactions SET regret = 0, bucket = ? WHERE id = ?', t.bucket === 'waste' && t.regret === 1 ? (def === 'waste' ? 'want' : def) : t.bucket, id);
  }
  return getTx(db, id);
}

// ---------- income ----------
export function addIncome(db: DB, i: { amount_paise: number; received_at?: string; source?: string; is_regular?: boolean; account_id?: number }) {
  const acc = i.account_id ?? get<{ id: number }>(db, 'SELECT id FROM accounts ORDER BY id LIMIT 1')!.id;
  const r = run(db, 'INSERT INTO income (account_id, amount_paise, received_at, source, is_regular) VALUES (?,?,?,?,?)',
    acc, i.amount_paise, i.received_at ?? nowStr(), i.source ?? '', i.is_regular ? 1 : 0);
  return get<IncomeEntry>(db, 'SELECT * FROM income WHERE id = ?', Number(r.lastInsertRowid))!;
}
export const listIncome = (db: DB, month: string) =>
  all<IncomeEntry>(db, 'SELECT * FROM income WHERE received_at >= ? AND received_at < ? ORDER BY received_at DESC', month, nextMonth(month));
export const deleteIncome = (db: DB, id: number) => { run(db, 'DELETE FROM income WHERE id = ?', id); };

// ---------- detectors, review ----------
function flagData(db: DB, month: string, today: string) {
  const asOf = asOfFor(month, today);
  const from = [`${month}-01`, addDays(asOf, -62)].sort()[0];
  const txs = txBetween(db, from, addDays(lastDayOf(month), 1));
  const incomes = all<{ amount_paise: number; received_at: string; is_regular: 0 | 1 }>(db, 'SELECT * FROM income WHERE received_at >= ? AND received_at < ?', month, nextMonth(month));
  const flags = runDetectors(txs, incomes, month, asOf);
  return { txs, flags, byTx: flagsByTx(flags) };
}
export const flagsFor = (db: DB, month: string, today = todayStr()): Flag[] => flagData(db, month, today).flags;

export function listTxs(db: DB, month: string, today = todayStr()): Tx[] {
  const { txs, byTx } = flagData(db, month, today);
  return txs.filter((t) => t.occurred_at.startsWith(month)).map((t) => ({ ...t, flags: byTx.get(t.id) ?? [] }));
}

/** Last 7 days of wants you have not judged yet. Most signals first, then biggest. */
export function weeklyReview(db: DB, today = todayStr()): Tx[] {
  const start = addDays(today, -6);
  const month = monthOf(today);
  const { byTx } = flagData(db, month, today);
  const pool = txBetween(db, start, addDays(today, 1));
  return pool.filter((t) => t.bucket === 'want' && t.regret === null)
    .map((t) => ({ ...t, flags: byTx.get(t.id) ?? [] }))
    .sort((a, b) => (b.flags!.length - a.flags!.length) || b.amount_paise - a.amount_paise);
}

// ---------- money maths ----------
const sumRows = (db: DB, sql: string, ...p: P) => get<{ s: number | null }>(db, sql, ...p)?.s ?? 0;
const incomeIn = (db: DB, month: string) => sumRows(db, 'SELECT SUM(amount_paise) AS s FROM income WHERE received_at >= ? AND received_at < ?', month, nextMonth(month));
const spendIn = (db: DB, month: string, where = '') => sumRows(db, `SELECT SUM(t.amount_paise) AS s FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
  WHERE t.bucket != 'ignore' AND t.occurred_at >= ? AND t.occurred_at < ? ${where}`, month, nextMonth(month));

function baselines(db: DB, month: string) {
  const prev = monthsBack(month, 3);
  const incomes = prev.map((m) => incomeIn(db, m)).filter((x) => x > 0);
  const needs = prev.map((m) => spendIn(db, m, "AND t.bucket = 'need'")).filter((x) => x > 0);
  return {
    takeHome: incomes.length ? avg(incomes) : incomeIn(db, month),
    essential: needs.length ? avg(needs) : spendIn(db, month, "AND t.bucket = 'need'"),
  };
}

export function savingsFor(db: DB, today = todayStr()): SavingsPlan {
  const s = getSettings(db), b = baselines(db, monthOf(today));
  return savingsPlan({
    takeHomePaise: b.takeHome, essentialMonthlyPaise: Math.max(b.essential, s.fixed_needs_paise), irregular: !!s.income_irregular,
    savedPaise: s.emergency_saved_paise, targetPct: s.savings_target_pct, fixedNeedsPaise: s.fixed_needs_paise, horizonMonths: s.emergency_horizon_months,
  });
}

export function safeToSpendFor(db: DB, date = todayStr()): SafeToSpend {
  const month = monthOf(date), s = getSettings(db);
  const actual = incomeIn(db, month), est = actual <= 0 ? baselines(db, month).takeHome : 0;
  const fixedSpent = spendIn(db, month, 'AND COALESCE(c.is_fixed, 0) = 1');
  return safeToSpend({
    date, incomePaise: actual > 0 ? actual : est, incomeIsEstimate: actual <= 0 && est > 0,
    fixedNeedsPaise: Math.max(s.fixed_needs_paise, fixedSpent),            // a logged rent can never be under-counted
    savingsTargetPaise: savingsFor(db, date).start_at_paise,
    spentSoFarPaise: spendIn(db, month, 'AND COALESCE(c.is_fixed, 0) = 0'), // fixed categories are covered by fixedNeeds
  });
}

export function reportFor(db: DB, month: string, today = todayStr()): MonthlyReport {
  const s = getSettings(db), { txs, byTx } = flagData(db, month, today);
  const prev = monthsBack(month, 1)[0];
  return monthlyReport({
    month, txs: txs.filter((t) => t.occurred_at.startsWith(month)), prevTxs: txBetween(db, `${prev}-01`, `${month}-01`),
    incomePaise: incomeIn(db, month), flags: byTx,
    targets: { need: s.need_target_pct, want: s.want_target_pct, savings: s.savings_target_pct },
  });
}

// ---------- export / backup / restore / erase ----------
const csvCell = (v: string | number | null) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function exportCsv(db: DB): string {
  const rows = all<Tx & { account: string }>(db, `SELECT t.*, c.name AS category_name, a.name AS account FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id JOIN accounts a ON a.id = t.account_id ORDER BY t.occurred_at`);
  const head = 'date,account,merchant,category,bucket,amount_inr,payment_method,regret,note';
  return [head, ...rows.map((t) => [t.occurred_at, t.account, t.merchant_raw, t.category_name, t.bucket, (t.amount_paise / 100).toFixed(2), t.payment_method,
    t.regret === null ? '' : t.regret ? 'regret' : 'worth it', t.note].map(csvCell).join(','))].join('\n');
}

// ---------- snapshot: the whole database as plain data (backup, restore, and phone <-> server sync) ----------
const TABLES = ['accounts', 'categories', 'income', 'transactions', 'merchant_rules', 'goals', 'wishlist', 'bills', 'iou_entries'] as const;
export type Snapshot = Record<string, any> & { settings: Settings };
export function exportTables(db: DB): Snapshot {
  const data: Record<string, unknown> = { version: 1, exported_at: nowStr(), settings: getSettings(db) };
  for (const t of TABLES) data[t] = all(db, `SELECT * FROM ${t}`);
  return data as Snapshot;
}
/** Replace everything with a snapshot, all-or-nothing. Rows keep their ids. */
export function importTables(db: DB, d: Snapshot) {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM iou_entries; DELETE FROM bills; DELETE FROM merchant_rules; DELETE FROM transactions; DELETE FROM income; DELETE FROM goals; DELETE FROM wishlist; DELETE FROM accounts; DELETE FROM categories;');
    for (const t of TABLES) for (const row of d[t] ?? []) {
      const cols = Object.keys(row);
      run(db, `INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => row[c] as string | number | null));
    }
    updateSettings(db, d.settings);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export const eraseAll = (db: DB) => wipe(db);

// ---------- Phase 3: bill & EMI reminders ----------
type BillRow = Omit<Bill, 'next_due' | 'days_until' | 'status' | 'paid_this_month'> & { active: number };
const billOut = ({ active: _a, ...b }: BillRow, today: string): Bill => {
  const c = nextCycle(b.last_paid_month, today, b.due_day);
  return { ...b, next_due: c.due, days_until: c.days_until, status: billStatus(c.days_until, b.remind_days), paid_this_month: c.paid_this_month };
};
export const listBills = (db: DB, today = todayStr()): Bill[] =>
  all<BillRow>(db, 'SELECT * FROM bills WHERE active = 1').map((b) => billOut(b, today)).sort((a, b) => a.days_until - b.days_until);

export function addBill(db: DB, b: { name: string; emoji?: string; kind: 'bill' | 'emi'; amount_paise: number; due_day: number; remind_days: number; installments_left?: number }, today = todayStr()) {
  // A due day that has already passed this month is assumed handled, so adding a bill never starts life as "overdue".
  const assumePaid = Number(today.slice(8, 10)) > b.due_day ? monthOf(today) : null;
  run(db, 'INSERT INTO bills (name, emoji, kind, amount_paise, due_day, remind_days, installments_left, last_paid_month) VALUES (?,?,?,?,?,?,?,?)',
    b.name, b.emoji ?? '🧾', b.kind, b.amount_paise, b.due_day, b.remind_days, b.installments_left ?? null, assumePaid);
  return listBills(db, today);
}
/** Marks the next unpaid cycle paid; optionally logs the spend (bills are needs, EMIs go to EMI & Loans). EMIs count down and retire at zero. */
export function payBill(db: DB, id: number, logSpend: boolean, today = todayStr(), paidAt?: string) {
  const b = get<BillRow>(db, 'SELECT * FROM bills WHERE id = ? AND active = 1', id);
  if (!b) throw new HttpError(404, 'bill not found');
  const { cycle } = nextCycle(b.last_paid_month, today, b.due_day);
  db.exec('BEGIN');
  try {
    if (logSpend) {
      const category_id = b.kind === 'emi' ? catId(db, 'EMI & Loans') : suggest(db, b.name).category === 'Other' ? catId(db, 'Utilities & Recharge') : undefined;
      createTx(db, { amount_paise: b.amount_paise, merchant_raw: b.name, category_id, payment_method: 'upi', occurred_at: paidAt });
    }
    const left = b.installments_left === null ? null : b.installments_left - 1;
    run(db, 'UPDATE bills SET last_paid_month = ?, installments_left = ?, active = ? WHERE id = ?', cycle, left, left !== null && left <= 0 ? 0 : 1, id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return listBills(db, today);
}
export const deleteBill = (db: DB, id: number) => { run(db, 'UPDATE bills SET active = 0 WHERE id = ?', id); };

// ---------- Phase 3: splits & IOUs ----------
// Only YOUR share is a spend. What friends owe you is a receivable; the ledger also records the real cash that moved, so account balances stay true.
const pickAccount = (db: DB, method: PaymentMethod = 'upi') =>
  get<{ id: number }>(db, 'SELECT id FROM accounts WHERE kind = ? ORDER BY id LIMIT 1', method === 'cash' ? 'cash' : 'bank')?.id ?? get<{ id: number }>(db, 'SELECT id FROM accounts ORDER BY id LIMIT 1')!.id;
const addEntry = (db: DB, e: { person: string; delta: number; account: number; accountDelta: number; note: string; at: string; tx?: number | null }) =>
  run(db, 'INSERT INTO iou_entries (person, delta_paise, account_id, account_delta_paise, note, occurred_at, tx_id) VALUES (?,?,?,?,?,?,?)',
    e.person, e.delta, e.account, e.accountDelta, e.note, e.at, e.tx ?? null);

export function iouSummary(db: DB): IouSummary {
  const by = new Map<string, IouPerson>();
  for (const e of all<IouEntry>(db, 'SELECT * FROM iou_entries ORDER BY occurred_at DESC, id DESC')) {
    const k = e.person.toLowerCase(), p = by.get(k) ?? { person: e.person, balance_paise: 0, entries: [] };
    p.balance_paise += e.delta_paise; p.entries.push(e); by.set(k, p);
  }
  const people = [...by.values()].sort((a, b) => Math.abs(b.balance_paise) - Math.abs(a.balance_paise));
  return {
    people,
    owed_to_me_paise: people.reduce((s, p) => s + Math.max(0, p.balance_paise), 0),
    i_owe_paise: people.reduce((s, p) => s + Math.max(0, -p.balance_paise), 0),
  };
}

export function splitSpend(db: DB, i: { amount_paise: number; merchant_raw?: string; friends: string[]; paid_by: string | null; my_share_paise?: number; payment_method?: PaymentMethod; category_id?: number | null; occurred_at?: string }) {
  let sh;
  try { sh = computeShares({ total: i.amount_paise, friends: i.friends, payer: i.paid_by, myShare: i.my_share_paise }); } catch (e: any) { throw new HttpError(400, e.message); }
  const at = i.occurred_at ?? nowStr();
  const note = `${i.merchant_raw?.trim() || 'Split'} · total ${formatRupees(i.amount_paise)}`;
  db.exec('BEGIN');
  try {
    const tx = sh.mine > 0 ? createTx(db, { amount_paise: sh.mine, merchant_raw: i.merchant_raw, category_id: i.category_id, payment_method: i.payment_method, occurred_at: i.occurred_at }) : null;
    const account = tx?.account_id ?? pickAccount(db, i.payment_method);
    if (i.paid_by === null) { // you paid: each friend owes you their share, and that cash has really left your account
      for (const f of sh.shares) if (f.paise > 0) addEntry(db, { person: f.person, delta: f.paise, account, accountDelta: -f.paise, note, at, tx: tx?.id });
    } else if (sh.mine > 0) { // a friend paid: you owe them your share; you have not paid yet, so undo the tx's cash deduction until you do
      const payer = i.friends.find((f) => f.toLowerCase() === i.paid_by!.toLowerCase())!;
      addEntry(db, { person: payer, delta: -sh.mine, account, accountDelta: sh.mine, note, at, tx: tx?.id });
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return iouSummary(db);
}

/** Plain lending: "lent" = you handed money over (they owe you); "borrowed" = they handed you money (you owe them). */
export function addIou(db: DB, i: { person: string; amount_paise: number; kind: 'lent' | 'borrowed'; note?: string; account_id?: number; occurred_at?: string }) {
  const sign = i.kind === 'lent' ? 1 : -1;
  addEntry(db, { person: i.person.trim(), delta: sign * i.amount_paise, account: i.account_id ?? pickAccount(db), accountDelta: -sign * i.amount_paise,
    note: i.note?.trim() || (i.kind === 'lent' ? 'Lent' : 'Borrowed'), at: i.occurred_at ?? nowStr() });
  return iouSummary(db);
}

/** Settling up nets the balance toward zero. Friend pays you back = cash in; you pay them = cash out. Never income, never an expense. */
export function settleIou(db: DB, person: string, amount?: number, accountId?: number) {
  const p = iouSummary(db).people.find((x) => x.person.toLowerCase() === person.trim().toLowerCase());
  if (!p || p.balance_paise === 0) throw new HttpError(409, 'nothing to settle with them');
  const amt = Math.min(Math.abs(p.balance_paise), amount ?? Math.abs(p.balance_paise)), sign = p.balance_paise > 0 ? -1 : 1;
  addEntry(db, { person: p.person, delta: sign * amt, account: accountId ?? pickAccount(db), accountDelta: -sign * amt, note: sign < 0 ? 'Paid you back' : 'You paid them back', at: nowStr() });
  return iouSummary(db);
}

// ---------- Phase 2: chat entry, subscriptions, goals, cooling-off wishlist ----------
export const bulkCreate = (db: DB, items: NewTx[]): Tx[] => {
  db.exec('BEGIN');
  try { const out = items.map((i) => createTx(db, i)); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
};

export function subscriptionsFor(db: DB, today = todayStr()): Subscription[] {
  const rules = ctx(db).userRules;
  return detectSubscriptions(txBetween(db, addDays(today, -200), addDays(today, 1)), today)
    .map((s) => ({ ...s, unused: rules.get(s.merchant.toLowerCase())?.bucket === 'waste' }));
}
/** "I don't use this": every charge from the merchant becomes waste (this month and from now on). Undo restores the category default. */
export function markSubscription(db: DB, merchant: string, unused: boolean, today = todayStr()) {
  const last = get<{ category_id: number | null }>(db, 'SELECT category_id FROM transactions WHERE merchant_norm = ? ORDER BY occurred_at DESC LIMIT 1', merchant);
  if (!last?.category_id) throw new HttpError(404, 'unknown subscription');
  const def = get<{ default_bucket: Bucket }>(db, 'SELECT default_bucket FROM categories WHERE id = ?', last.category_id)!.default_bucket;
  const from = `${monthOf(today)}-01`;
  if (unused) run(db, "UPDATE transactions SET bucket = 'waste', bucket_source = 'user' WHERE merchant_norm = ? AND occurred_at >= ? AND bucket != 'ignore'", merchant, from);
  else run(db, "UPDATE transactions SET bucket = ? WHERE merchant_norm = ? AND occurred_at >= ? AND bucket = 'waste' AND regret IS NOT 1", def, merchant, from);
  learnRule(db, merchant, last.category_id, unused ? 'waste' : def);
  return subscriptionsFor(db, today);
}

type GoalRow = Omit<Goal, 'monthly_needed_paise'>;
const goalOut = (g: GoalRow, today: string): Goal => ({
  ...g,
  monthly_needed_paise: g.target_date ? Math.ceil(Math.max(0, g.target_paise - g.saved_paise) / Math.max(1, Math.ceil(dayDiff(g.target_date, today) / 30))) : null,
});
export const listGoals = (db: DB, today = todayStr()) => all<GoalRow>(db, 'SELECT * FROM goals ORDER BY id').map((g) => goalOut(g, today));
export function addGoal(db: DB, g: { name: string; emoji?: string; target_paise: number; target_date?: string }, today = todayStr()) {
  run(db, 'INSERT INTO goals (name, emoji, target_paise, target_date) VALUES (?, ?, ?, ?)', g.name, g.emoji ?? '🎯', g.target_paise, g.target_date ?? null);
  return listGoals(db, today);
}
export function contributeGoal(db: DB, id: number, add: number, today = todayStr()) {
  if (!run(db, 'UPDATE goals SET saved_paise = MAX(0, saved_paise + ?) WHERE id = ?', add, id).changes) throw new HttpError(404, 'goal not found');
  return listGoals(db, today);
}
export const deleteGoal = (db: DB, id: number) => { run(db, 'DELETE FROM goals WHERE id = ?', id); };

const hoursLeft = (ready: string) => Math.max(0, Math.ceil((new Date(ready).getTime() - new Date(nowStr()).getTime()) / 3600000));
type WishRow = Omit<WishItem, 'hours_left'>;
export function wishlist(db: DB): Wishlist {
  const items = all<WishRow>(db, "SELECT * FROM wishlist WHERE status = 'waiting' ORDER BY ready_at").map((w) => ({ ...w, hours_left: hoursLeft(w.ready_at) }));
  const sk = get<{ s: number | null; n: number }>(db, "SELECT SUM(price_paise) AS s, COUNT(*) AS n FROM wishlist WHERE status = 'skipped'")!;
  return { items, skipped_paise: sk.s ?? 0, skipped_count: sk.n };
}
export function addWish(db: DB, name: string, price: number, waitHours: number) {
  const created = nowStr();
  run(db, 'INSERT INTO wishlist (name, price_paise, created_at, ready_at) VALUES (?, ?, ?, ?)', name, price, created, addHoursStr(created, waitHours));
  return wishlist(db);
}
/** Friction on purpose: you can only buy after the cooling-off wait; skipping is always allowed (and counted as money kept). */
export function decideWish(db: DB, id: number, decision: 'bought' | 'skipped') {
  const w = get<WishRow>(db, "SELECT * FROM wishlist WHERE id = ? AND status = 'waiting'", id);
  if (!w) throw new HttpError(404, 'wish not found');
  if (decision === 'bought') {
    if (hoursLeft(w.ready_at) > 0) throw new HttpError(409, 'still cooling off, give it a little longer');
    createTx(db, { amount_paise: w.price_paise, merchant_raw: w.name, category_id: catId(db, 'Shopping'), payment_method: 'upi' });
  }
  run(db, 'UPDATE wishlist SET status = ? WHERE id = ?', decision, id);
  return wishlist(db);
}

