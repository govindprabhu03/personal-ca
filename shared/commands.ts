// Every action the app can take, described ONCE:
//   http   how the server is told about it (the same REST call as ever, so replays, other clients and the Idempotency-Key keep working)
//   local  how the phone applies it to its own database RIGHT NOW, by calling the very same service function the server calls
// Actions with no `local` need the server (import, backup, restore, erase, Ask your CA): they run there first, then the phone refreshes.
import type { DB } from './core/schema';
import * as svc from './core/service';
import { formatRupees } from './money';
import type { Bucket, PaymentMethod, Settings } from './types';

export interface Command<A = any> {
  label(a: A): string;
  http(a: A): { method: string; path: string; body?: unknown };
  local?(db: DB, a: A): unknown;
  /** After the server accepted it, the phone's own copy is stale in a way only a fresh snapshot fixes. */
  pull?: boolean;
  /** Replaces or wipes server data: anything still queued on the phone must not be replayed on top. */
  destructive?: boolean;
}
const c = <A>(x: Command<A>) => x;
type NewBill = { name: string; emoji?: string; kind: 'bill' | 'emi'; amount_paise: number; due_day: number; remind_days: number; installments_left?: number };

export const COMMANDS = {
  addTx: c<svc.NewTx & { occurred_at: string }>({
    label: (a) => `${a.merchant_raw || 'Spend'} · ${formatRupees(a.amount_paise)}`,
    http: (a) => ({ method: 'POST', path: '/transactions', body: a }), local: (db, a) => svc.createTx(db, a),
  }),
  addBulk: c<{ items: (svc.NewTx & { occurred_at: string })[] }>({
    label: (a) => `${a.items.length} spends`, http: (a) => ({ method: 'POST', path: '/transactions/bulk', body: a }), local: (db, a) => svc.bulkCreate(db, a.items),
  }),
  patchTx: c<{ id: number; category_id?: number; bucket?: Bucket }>({
    label: () => 'Category change', http: ({ id, ...b }) => ({ method: 'PATCH', path: `/transactions/${id}`, body: b }), local: (db, { id, ...b }) => svc.patchTx(db, id, b),
  }),
  deleteTx: c<{ id: number }>({ label: () => 'Delete entry', http: (a) => ({ method: 'DELETE', path: `/transactions/${a.id}` }), local: (db, a) => svc.deleteTx(db, a.id) }),
  regret: c<{ id: number; regret: boolean }>({
    label: (a) => (a.regret ? 'Regret tap' : 'Worth-it tap'), http: ({ id, regret }) => ({ method: 'POST', path: `/transactions/${id}/regret`, body: { regret } }), local: (db, a) => svc.setRegret(db, a.id, a.regret),
  }),
  addIncome: c<{ amount_paise: number; received_at: string; source?: string; is_regular?: boolean; account_id?: number }>({
    label: (a) => `Income · ${formatRupees(a.amount_paise)}`, http: (a) => ({ method: 'POST', path: '/income', body: a }), local: (db, a) => svc.addIncome(db, a),
  }),
  deleteIncome: c<{ id: number }>({ label: () => 'Delete income', http: (a) => ({ method: 'DELETE', path: `/income/${a.id}` }), local: (db, a) => svc.deleteIncome(db, a.id) }),
  updateSettings: c<Partial<Settings>>({ label: () => 'Targets', http: (a) => ({ method: 'PUT', path: '/settings', body: a }), local: (db, a) => svc.updateSettings(db, a) }),
  addAccount: c<{ kind: string; name: string; opening_paise: number }>({
    label: (a) => `Account · ${a.name}`, http: (a) => ({ method: 'POST', path: '/accounts', body: a }), local: (db, a) => svc.addAccount(db, a.kind, a.name, a.opening_paise),
  }),
  addBill: c<NewBill>({ label: (a) => `Bill · ${a.name}`, http: (a) => ({ method: 'POST', path: '/bills', body: a }), local: (db, a) => svc.addBill(db, a) }),
  payBill: c<{ id: number; log_spend: boolean; occurred_at: string; name?: string }>({
    label: (a) => `${a.name ?? 'Bill'} paid`, http: ({ id, log_spend, occurred_at }) => ({ method: 'POST', path: `/bills/${id}/pay`, body: { log_spend, occurred_at } }),
    local: (db, a) => svc.payBill(db, a.id, a.log_spend, undefined, a.occurred_at),
  }),
  deleteBill: c<{ id: number }>({ label: () => 'Delete bill', http: (a) => ({ method: 'DELETE', path: `/bills/${a.id}` }), local: (db, a) => svc.deleteBill(db, a.id) }),
  split: c<{ amount_paise: number; merchant_raw?: string; friends: string[]; paid_by: string | null; my_share_paise?: number; payment_method?: PaymentMethod; occurred_at: string }>({
    label: (a) => `Split · ${formatRupees(a.amount_paise)}`, http: (a) => ({ method: 'POST', path: '/ious/split', body: a }), local: (db, a) => svc.splitSpend(db, a),
  }),
  addIou: c<{ person: string; amount_paise: number; kind: 'lent' | 'borrowed'; occurred_at: string }>({
    label: (a) => `IOU · ${a.person}`, http: (a) => ({ method: 'POST', path: '/ious/entry', body: a }), local: (db, a) => svc.addIou(db, a),
  }),
  settle: c<{ person: string; amount_paise?: number; account_id?: number }>({
    label: (a) => `Settle · ${a.person}`, http: (a) => ({ method: 'POST', path: '/ious/settle', body: a }), local: (db, a) => svc.settleIou(db, a.person, a.amount_paise, a.account_id),
  }),
  markSubscription: c<{ merchant: string; unused: boolean }>({
    label: (a) => (a.unused ? `Unused · ${a.merchant}` : `Used · ${a.merchant}`), http: (a) => ({ method: 'POST', path: '/subscriptions/mark', body: a }), local: (db, a) => svc.markSubscription(db, a.merchant, a.unused),
  }),
  addGoal: c<{ name: string; emoji?: string; target_paise: number; target_date?: string }>({
    label: (a) => `Goal · ${a.name}`, http: (a) => ({ method: 'POST', path: '/goals', body: a }), local: (db, a) => svc.addGoal(db, a),
  }),
  contribute: c<{ id: number; add_paise: number }>({
    label: () => 'Goal top-up', http: ({ id, add_paise }) => ({ method: 'POST', path: `/goals/${id}/contribute`, body: { add_paise } }), local: (db, a) => svc.contributeGoal(db, a.id, a.add_paise),
  }),
  deleteGoal: c<{ id: number }>({ label: () => 'Delete goal', http: (a) => ({ method: 'DELETE', path: `/goals/${a.id}` }), local: (db, a) => svc.deleteGoal(db, a.id) }),
  addWish: c<{ name: string; price_paise: number; wait_hours: 24 | 48 }>({
    label: (a) => `Wish · ${a.name}`, http: (a) => ({ method: 'POST', path: '/wishlist', body: a }), local: (db, a) => svc.addWish(db, a.name, a.price_paise, a.wait_hours),
  }),
  decideWish: c<{ id: number; decision: 'bought' | 'skipped' }>({
    label: (a) => (a.decision === 'bought' ? 'Bought a wish' : 'Skipped a wish'), http: ({ id, decision }) => ({ method: 'POST', path: `/wishlist/${id}/decide`, body: { decision } }),
    local: (db, a) => svc.decideWish(db, a.id, a.decision),
  }),

  // ---- server-first: need Node, the AI, or replace everything ----
  importStatement: c<{ csv?: string; pdf_base64?: string; password?: string; commit: boolean; include_credits: boolean }>({
    label: () => 'Import', http: (a) => ({ method: 'POST', path: '/import', body: a }), pull: true,
  }),
  backup: c<{ passphrase: string }>({ label: () => 'Backup', http: (a) => ({ method: 'POST', path: '/backup', body: a }) }),
  restore: c<{ passphrase: string; backup: string }>({ label: () => 'Restore', http: (a) => ({ method: 'POST', path: '/restore', body: a }), pull: true, destructive: true }),
  erase: c<Record<string, never>>({ label: () => 'Erase', http: () => ({ method: 'POST', path: '/erase', body: { confirm: true } }), pull: true, destructive: true }),
  /** What a phone needs to connect to this server: its network addresses and the access token (only reachable with the token already). */
  pairing: c<Record<string, never>>({ label: () => 'Pairing', http: () => ({ method: 'GET', path: '/pairing' }) }),
  ask: c<{ question: string; history: { role: 'user' | 'assistant'; text: string }[] }>({ label: () => 'Ask', http: (a) => ({ method: 'POST', path: '/ask', body: a }) }),
};
export type CommandName = keyof typeof COMMANDS;
