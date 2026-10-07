// The schema and seed data. Plain SQL, and driver-independent: the SAME code builds the database on the server (node:sqlite) and on
// the phone (expo-sqlite, or sql.js in the web preview). Anything that fits this tiny interface can host the app's data.
import { SEED_CATEGORIES } from '../categorise';

export interface Stmt {
  all(...params: any[]): any[];
  get(...params: any[]): any;
  run(...params: any[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
export interface DB { prepare(sql: string): Stmt; exec(sql: string): void }

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  savings_target_pct REAL NOT NULL DEFAULT 20, need_target_pct REAL NOT NULL DEFAULT 50, want_target_pct REAL NOT NULL DEFAULT 30,
  fixed_needs_paise INTEGER NOT NULL DEFAULT 0, income_irregular INTEGER NOT NULL DEFAULT 0,
  emergency_saved_paise INTEGER NOT NULL DEFAULT 0, emergency_horizon_months INTEGER NOT NULL DEFAULT 12);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('bank','cash','card','wallet')),
  name TEXT NOT NULL, opening_paise INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  default_bucket TEXT NOT NULL CHECK (default_bucket IN ('need','want','waste','ignore')), is_fixed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS income (
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0), received_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '', is_regular INTEGER NOT NULL DEFAULT 0, import_hash TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0), occurred_at TEXT NOT NULL,
  merchant_raw TEXT NOT NULL DEFAULT '', merchant_norm TEXT NOT NULL DEFAULT '',
  category_id INTEGER REFERENCES categories(id),
  bucket TEXT NOT NULL CHECK (bucket IN ('need','want','waste','ignore')),
  bucket_source TEXT NOT NULL DEFAULT 'rule', confidence REAL NOT NULL DEFAULT 1,
  payment_method TEXT NOT NULL DEFAULT 'upi', source TEXT NOT NULL DEFAULT 'manual',
  regret INTEGER, note TEXT NOT NULL DEFAULT '', import_hash TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_tx_time ON transactions(occurred_at);
CREATE TABLE IF NOT EXISTS merchant_rules (
  id INTEGER PRIMARY KEY, pattern TEXT NOT NULL UNIQUE, category_id INTEGER NOT NULL REFERENCES categories(id), bucket TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '🎯',
  target_paise INTEGER NOT NULL CHECK (target_paise > 0), saved_paise INTEGER NOT NULL DEFAULT 0, target_date TEXT);
CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '🧾',
  kind TEXT NOT NULL DEFAULT 'bill' CHECK (kind IN ('bill','emi')), amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31), remind_days INTEGER NOT NULL DEFAULT 3,
  installments_left INTEGER, last_paid_month TEXT, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS iou_entries (
  id INTEGER PRIMARY KEY, person TEXT NOT NULL, delta_paise INTEGER NOT NULL,
  account_id INTEGER REFERENCES accounts(id), account_delta_paise INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '', occurred_at TEXT NOT NULL, tx_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS wishlist (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, price_paise INTEGER NOT NULL CHECK (price_paise > 0),
  created_at TEXT NOT NULL, ready_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','bought','skipped')));
-- Offline sync: every queued write carries a unique key; we remember the answer so a replay is answered, never re-applied.
CREATE TABLE IF NOT EXISTS sync_ops (
  op_id TEXT PRIMARY KEY, status INTEGER NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`;

export function seed(db: DB) {
  db.exec('INSERT OR IGNORE INTO settings (id) VALUES (1)');
  const cat = db.prepare('INSERT OR IGNORE INTO categories (name, default_bucket, is_fixed) VALUES (?, ?, ?)');
  for (const c of SEED_CATEGORIES) cat.run(c.name, c.bucket, c.fixed);
  const n = db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as unknown as { n: number };
  if (!n.n) {
    db.exec("INSERT INTO accounts (kind, name) VALUES ('bank', 'Bank'), ('cash', 'Cash')");
  }
}

/** Create tables and seed defaults on any freshly opened database. Safe to call on an existing one. */
export function initSchema(db: DB) {
  db.exec(SCHEMA);
  seed(db);
}

/** "Delete all my data": one tap, everything gone, defaults re-seeded. */
export function wipe(db: DB) {
  db.exec('DELETE FROM iou_entries; DELETE FROM bills; DELETE FROM transactions; DELETE FROM income; DELETE FROM merchant_rules; DELETE FROM goals; DELETE FROM wishlist; DELETE FROM accounts; DELETE FROM settings;');
  seed(db);
}

