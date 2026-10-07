// The contract between server and mobile. Both import this file, so the API can never drift.
// All money fields are integer paise. Dates are local "YYYY-MM-DD" / "YYYY-MM-DDTHH:mm:ss" (IST, no timezone).

export type Bucket = 'need' | 'want' | 'waste' | 'ignore';
export type PaymentMethod = 'upi' | 'card' | 'cash' | 'bnpl' | 'netbanking';
export type AccountKind = 'bank' | 'cash' | 'card' | 'wallet';
export type BucketSource = 'rule' | 'user' | 'default';
export type DetectorId =
  | 'late_night' | 'sale' | 'spike' | 'pay_later' | 'small_leaks'
  | 'payday' | 'fee' | 'double_charge' | 'repeat_regret';

export interface Settings {
  savings_target_pct: number;
  need_target_pct: number;
  want_target_pct: number;
  fixed_needs_paise: number;        // monthly commitments: rent, EMI, insurance...
  income_irregular: 0 | 1;          // doubles the emergency-fund months (6-12 instead of 3-6)
  emergency_saved_paise: number;
  emergency_horizon_months: number; // how fast you want the next emergency-fund stage done
}

export interface Account { id: number; kind: AccountKind; name: string; opening_paise: number; balance_paise: number }
export interface Category { id: number; name: string; default_bucket: Bucket; is_fixed: 0 | 1 }

export interface Tx {
  id: number;
  account_id: number;
  amount_paise: number;
  occurred_at: string;
  merchant_raw: string;
  merchant_norm: string;
  category_id: number | null;
  category_name: string | null;
  bucket: Bucket;
  bucket_source: BucketSource;
  confidence: number;
  payment_method: PaymentMethod;
  source: 'manual' | 'statement';
  regret: 0 | 1 | null;
  note: string;
  flags?: DetectorId[];
  needs_review?: boolean;           // low-confidence guess: ask the user instead of being silently wrong
  pending?: boolean;                // saved on the phone, not yet synced (offline). Shown, but not editable until it syncs.
}

export interface IncomeEntry { id: number; account_id: number; amount_paise: number; received_at: string; source: string; is_regular: 0 | 1 }
export interface Flag { detector: DetectorId; reason: string; tx_ids: number[]; amount_paise: number }

export interface Suggestion { category: string; category_id: number | null; bucket: Bucket; confidence: number; merchant: string }

export interface Bill {
  id: number; name: string; emoji: string; kind: 'bill' | 'emi'; amount_paise: number; due_day: number;
  remind_days: number; installments_left: number | null; last_paid_month: string | null;
  next_due: string; days_until: number;           // negative = overdue
  status: 'overdue' | 'due_soon' | 'upcoming'; paid_this_month: boolean;
}
/** One row of the friends ledger. delta = what they owe you (+) / you owe them (-); account_delta = real money moving in an account. */
export interface IouEntry {
  id: number; person: string; delta_paise: number; account_id: number | null; account_delta_paise: number;
  note: string; occurred_at: string; tx_id: number | null;
}
export interface IouPerson { person: string; balance_paise: number; entries: IouEntry[] }   // balance > 0: they owe you
export interface IouSummary { people: IouPerson[]; owed_to_me_paise: number; i_owe_paise: number }

export interface Goal {
  id: number; name: string; emoji: string; target_paise: number; saved_paise: number;
  target_date: string | null; monthly_needed_paise: number | null;
}
export interface WishItem {
  id: number; name: string; price_paise: number; created_at: string; ready_at: string;
  status: 'waiting' | 'bought' | 'skipped'; hours_left: number;
}
export interface Wishlist { items: WishItem[]; skipped_paise: number; skipped_count: number }
export interface Subscription {
  merchant: string; category: string | null; bucket: Bucket; amount_paise: number; charges: number;
  last_charge: string; next_due: string; days_until: number; yearly_paise: number; unused: boolean;
}

export interface Bootstrap {
  today: string;
  streak: number;                   // consecutive days with a manually logged spend

  settings: Settings;
  accounts: Account[];
  categories: Category[];
  last: { category_id: number | null; account_id: number | null; payment_method: PaymentMethod }; // "remembers your last choices"
}

export interface SafeToSpend {
  date: string;
  income_paise: number;
  income_is_estimate: boolean;
  needs_income: boolean;
  fixed_needs_paise: number;
  savings_target_paise: number;
  spent_so_far_paise: number;
  remaining_paise: number;
  days_left: number;
  per_day_paise: number;
  status: 'ok' | 'tight' | 'over';
}

export interface SavingsPlan {
  take_home_paise: number;
  essential_monthly_paise: number;
  irregular: boolean;
  needs_data: boolean;
  multiples: { min: number; max: number };
  targets: { starter_paise: number; min_paise: number; max_paise: number };
  saved_paise: number;
  stage: 'starter' | 'min' | 'max' | 'done';
  next_target_paise: number;
  remaining_paise: number;
  pct_target_paise: number;
  goal_need_paise: number;
  monthly_target_paise: number;
  start_at_paise: number;           // what the app asks for TODAY (steps down if the full target is unrealistic)
  stepped_down: boolean;
  months_to_next: number | null;
}

export interface MonthlyReport {
  month: string;
  prev_month: string;
  income_paise: number;
  spent_paise: number;
  saved_paise: number;
  totals: { need: number; want: number; waste: number };
  pct: { need: number; want: number; waste: number; savings: number };   // % of income
  targets: { need: number; want: number; savings: number };
  top_leaks: { label: string; amount_paise: number; count: number; reasons: string[] }[];
  vs_prev: { need: number; want: number; waste: number; spent: number }; // paise change vs last month
}

export interface ImportRow {
  occurred_at: string; narration: string; merchant: string; amount_paise: number;
  category_name: string; bucket: Bucket; confidence: number; payment_method: PaymentMethod; duplicate: boolean;
}
export interface ImportResult {
  committed: boolean; rows: ImportRow[]; imported: number; duplicates: number; credits_skipped: number; header_found: boolean;
  format: 'csv' | 'pdf'; warnings: string[];   // warnings = things worth a human look (guessed directions, balances that don't add up)
}
