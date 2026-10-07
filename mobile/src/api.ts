// The app's data layer. There is no network in the READ path any more: every screen is computed by the on-device database,
// running the very same service code as the server (shared/core). WRITES apply to that database instantly and are queued for the
// server (see ../../shared/sync.ts). Only a few things (import, backup, restore, erase, Ask your CA) genuinely need the server.
import * as svc from '../../shared/core/service';
import type { DB } from '../../shared/core/schema';
import { isLocalId } from '../../shared/core/localdb';
import { nowLocal, todayLocal } from '../../shared/time';
import type { Bill, Bootstrap, Bucket, Flag, Goal, ImportResult, IncomeEntry, IouSummary, MonthlyReport, PaymentMethod, SafeToSpend, SavingsPlan, Settings, Subscription, Suggestion, Tx, Wishlist, Account } from '../../shared/types';
import { getSync } from './offline';

const read = <T>(f: (db: DB) => T): Promise<T> => Promise.resolve().then(() => f(getSync().db));
const run = <T>(cmd: Parameters<ReturnType<typeof getSync>['run']>[0], args: unknown) => getSync().run<T>(cmd, args);
const remote = <T>(cmd: Parameters<ReturnType<typeof getSync>['remote']>[0], args: unknown) => getSync().remote<T>(cmd, args);
/** A spend that exists only on this phone so far is shown, but flagged: it can't be edited until the server has it. */
const mark = (t: Tx): Tx => ({ ...t, pending: isLocalId(t.id) });
/** Actions on a row the server hasn't seen yet can't be sent (it has a different id there), so wait for the sync. */
const sid = (id: number) => { if (isLocalId(id)) throw new Error("That one is still syncing. Give it a moment, then try again."); return id; };

export interface NewTx {
  amount_paise: number; merchant_raw?: string; category_id?: number | null; payment_method?: PaymentMethod; account_id?: number;
}

export const api = {
  bootstrap: (): Promise<Bootstrap> => read((db) => svc.bootstrap(db, todayLocal())),
  suggest: (text: string, hour: number): Promise<Suggestion> => read((db) => svc.suggest(db, text, hour)),
  updateSettings: (p: Partial<Settings>) => run<Settings>('updateSettings', p),
  addAccount: (kind: string, name: string, opening_paise: number) => run<Account[]>('addAccount', { kind, name, opening_paise }),
  addIncome: (b: { amount_paise: number; source?: string; is_regular?: boolean; account_id?: number }) => run<IncomeEntry>('addIncome', { ...b, received_at: nowLocal() }),
  income: (month: string): Promise<IncomeEntry[]> => read((db) => svc.listIncome(db, month)),
  deleteIncome: (id: number) => run<void>('deleteIncome', { id: sid(id) }),

  /** Logging a spend never waits for anything: it is judged and saved on the phone at once, stamped with the moment you logged it. */
  addTx: async (b: NewTx) => mark(await run<Tx>('addTx', { ...b, occurred_at: nowLocal() })),
  addBulk: async (items: (NewTx & { occurred_at?: string })[]) =>
    (await run<Tx[]>('addBulk', { items: items.map((i) => ({ ...i, occurred_at: i.occurred_at ?? nowLocal() })) })).map(mark),
  transactions: (month: string): Promise<Tx[]> => read((db) => svc.listTxs(db, month, todayLocal()).map(mark)),
  patchTx: async (id: number, p: { category_id?: number; bucket?: Bucket }) => mark(await run<Tx>('patchTx', { id: sid(id), ...p })),
  deleteTx: (id: number) => run<void>('deleteTx', { id: sid(id) }),
  regret: async (id: number, regret: boolean) => mark(await run<Tx>('regret', { id: sid(id), regret })),

  ask: (question: string, history: { role: 'user' | 'assistant'; text: string }[]) => remote<{ answer: string; tools_used: string[] }>('ask', { question, history }),

  bills: (): Promise<Bill[]> => read((db) => svc.listBills(db, todayLocal())),
  addBill: (b: { name: string; emoji: string; kind: 'bill' | 'emi'; amount_paise: number; due_day: number; remind_days: number; installments_left?: number }) => run<Bill[]>('addBill', b),
  payBill: (id: number, log_spend: boolean, name = 'Bill') => run<Bill[]>('payBill', { id: sid(id), log_spend, occurred_at: nowLocal(), name }),
  deleteBill: (id: number) => run<void>('deleteBill', { id: sid(id) }),

  ious: (): Promise<IouSummary> => read((db) => svc.iouSummary(db)),
  split: (b: { amount_paise: number; merchant_raw?: string; friends: string[]; paid_by: string | null; my_share_paise?: number }) => run<IouSummary>('split', { ...b, occurred_at: nowLocal() }),
  addIou: (b: { person: string; amount_paise: number; kind: 'lent' | 'borrowed' }) => run<IouSummary>('addIou', { ...b, occurred_at: nowLocal() }),
  settle: (person: string, amount_paise?: number) => run<IouSummary>('settle', { person, amount_paise }),

  subscriptions: (): Promise<Subscription[]> => read((db) => svc.subscriptionsFor(db, todayLocal())),
  markSubscription: (merchant: string, unused: boolean) => run<Subscription[]>('markSubscription', { merchant, unused }),
  goals: (): Promise<Goal[]> => read((db) => svc.listGoals(db, todayLocal())),
  addGoal: (b: { name: string; emoji: string; target_paise: number; target_date?: string }) => run<Goal[]>('addGoal', b),
  contribute: (id: number, add_paise: number) => run<Goal[]>('contribute', { id: sid(id), add_paise }),
  deleteGoal: (id: number) => run<void>('deleteGoal', { id: sid(id) }),
  wishlist: (): Promise<Wishlist> => read((db) => svc.wishlist(db)),
  addWish: (name: string, price_paise: number, wait_hours: 24 | 48) => run<Wishlist>('addWish', { name, price_paise, wait_hours }),
  decideWish: (id: number, decision: 'bought' | 'skipped') => run<Wishlist>('decideWish', { id: sid(id), decision }),

  weeklyReview: (): Promise<Tx[]> => read((db) => svc.weeklyReview(db, todayLocal()).map(mark)),
  flags: (month: string): Promise<Flag[]> => read((db) => svc.flagsFor(db, month, todayLocal())),
  safeToSpend: (date: string): Promise<SafeToSpend> => read((db) => svc.safeToSpendFor(db, date)),
  savings: (): Promise<SavingsPlan> => read((db) => svc.savingsFor(db, todayLocal())),
  report: (month: string): Promise<MonthlyReport> => read((db) => svc.reportFor(db, month, todayLocal())),

  importStatement: (src: { csv: string } | { pdf_base64: string; password?: string }, commit: boolean, include_credits: boolean) =>
    remote<ImportResult>('importStatement', { ...src, commit, include_credits }),
  exportCsv: (): Promise<string> => read((db) => svc.exportCsv(db)),
  backup: (passphrase: string) => remote<{ backup: string }>('backup', { passphrase }),
  restore: (passphrase: string, backup: string) => remote<{ ok: true }>('restore', { passphrase, backup }),
  erase: () => remote<{ ok: true }>('erase', {}),
  pairing: () => remote<{ urls: string[]; token: string | null }>('pairing', {}),
};
