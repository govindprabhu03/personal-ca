// The tools "Ask your CA" may call. Design rules from the research doc:
//   1. The LLM never does the maths: every total, share and date is computed here, from the database.
//   2. Privacy: tool results contain merchant (cleaned name), amount, date and category ONLY.
//      Never raw bank narrations, UPI IDs, account names/numbers, or free-text notes.
import { z } from 'zod';
import { DETECTOR_LABEL } from '../../../shared/labels';
import type { DB } from '../db';
import { addDays, monthOf } from '../engine/dates';
import * as svc from '../service';

const inr = (paise: number) => Math.round(paise) / 100; // rupees with 2 decimals; the model quotes these, it never computes them
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must look like 2026-09');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must look like 2026-09-30');
const detectors = Object.keys(DETECTOR_LABEL) as [string, ...string[]];

const SCHEMAS = {
  spend_summary: z.object({ month: month.optional(), group_by: z.enum(['category', 'bucket', 'merchant']).default('category') }),
  list_flags: z.object({ month: month.optional(), detector: z.enum(detectors).optional() }),
  savings_status: z.object({}),
  safe_to_spend: z.object({ date: date.optional() }),
  find_transactions: z.object({ query: z.string().max(60).optional(), from: date.optional(), to: date.optional(), bucket: z.enum(['need', 'want', 'waste']).optional(), limit: z.number().int().min(1).max(25).default(10) }),
  monthly_report: z.object({ month: month.optional() }),
  subscriptions: z.object({}),
  bills: z.object({}),
  friends: z.object({}),
} as const;
export type ToolName = keyof typeof SCHEMAS;

const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, additionalProperties: false });
const M = { type: 'string', description: 'Month as YYYY-MM. Defaults to the current month.' };

export const TOOL_DEFS = [
  { name: 'spend_summary', description: 'Total spent in a month, grouped by category, bucket (need/want/waste) or merchant, with each group\'s total, count and share of spending. Use for "how much did I spend on X".',
    input_schema: obj({ month: M, group_by: { type: 'string', enum: ['category', 'bucket', 'merchant'], description: 'Default: category.' } }) },
  { name: 'list_flags', description: 'Waste-detector hits for a month (late-night spends, spikes, pay-later, sale-driven, small leaks, fees, double charges...), each with a plain-language reason.',
    input_schema: obj({ month: M, detector: { type: 'string', enum: detectors, description: 'Only this detector.' } }) },
  { name: 'savings_status', description: 'Savings target, emergency-fund progress, how much to save per month, and goal progress.', input_schema: obj({}) },
  { name: 'safe_to_spend', description: 'How much the user can spend per day and still hit their savings goal, and how that was worked out.',
    input_schema: obj({ date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' } }) },
  { name: 'find_transactions', description: 'Search individual spends by merchant/category text, date range and bucket. Returns the match count, the TOTAL of all matches, and up to `limit` rows (newest first). Defaults to this month so far.',
    input_schema: obj({ query: { type: 'string', description: 'Merchant or category text, e.g. "zomato" or "food".' }, from: { type: 'string', description: 'YYYY-MM-DD inclusive.' }, to: { type: 'string', description: 'YYYY-MM-DD inclusive.' },
      bucket: { type: 'string', enum: ['need', 'want', 'waste'] }, limit: { type: 'integer', minimum: 1, maximum: 25 } }) },
  { name: 'monthly_report', description: 'The month at a glance: income, spent, saved, needs/wants/waste split vs the user\'s targets, top leaks, and change vs last month.', input_schema: obj({ month: M }) },
  { name: 'subscriptions', description: 'Recurring charges found in the user\'s spending, with next renewal date and yearly cost.', input_schema: obj({}) },
  { name: 'bills', description: 'The user\'s bills and EMIs with due dates and overdue/due-soon status.', input_schema: obj({}) },
  { name: 'friends', description: 'Money friends owe the user, and money the user owes friends (split spends and IOUs).', input_schema: obj({}) },
];

/** Runs one tool. Throws on bad input (the agent loop turns that into an error result so the model can retry). */
export function runTool(db: DB, name: string, input: unknown, today: string): unknown {
  const schema = SCHEMAS[name as ToolName];
  if (!schema) throw new Error(`unknown tool: ${name}`);
  const a = schema.parse(input ?? {}) as any;
  const m: string = a.month ?? monthOf(today);

  switch (name as ToolName) {
    case 'spend_summary': {
      const r = svc.reportFor(db, m, today);
      const groups = new Map<string, { paise: number; count: number }>();
      for (const t of svc.listTxs(db, m, today)) {
        if (t.bucket === 'ignore') continue;
        const k = a.group_by === 'bucket' ? t.bucket : a.group_by === 'merchant' ? t.merchant_norm || '(unnamed)' : (t.category_name ?? 'Other');
        const g = groups.get(k) ?? { paise: 0, count: 0 };
        g.paise += t.amount_paise; g.count++; groups.set(k, g);
      }
      return {
        month: m, income_inr: inr(r.income_paise), spent_inr: inr(r.spent_paise), saved_inr: inr(r.saved_paise),
        group_by: a.group_by,
        groups: [...groups].sort((x, y) => y[1].paise - x[1].paise).slice(0, 15).map(([key, g]) => ({
          key, total_inr: inr(g.paise), count: g.count, share_of_spending_pct: r.spent_paise ? Math.round((g.paise / r.spent_paise) * 1000) / 10 : 0 })),
      };
    }
    case 'list_flags':
      return { month: m, flags: svc.flagsFor(db, m, today).filter((f) => !a.detector || f.detector === a.detector)
        .map((f) => ({ detector: f.detector, reason: f.reason, total_inr: inr(f.amount_paise), spends: f.tx_ids.length })) };
    case 'savings_status': {
      const p = svc.savingsFor(db, today), s = svc.getSettings(db);
      return {
        monthly_take_home_inr: inr(p.take_home_paise), essential_monthly_expenses_inr: inr(p.essential_monthly_paise), savings_target_pct: s.savings_target_pct,
        monthly_savings_target_inr: inr(p.monthly_target_paise), suggested_start_per_month_inr: inr(p.start_at_paise), target_was_stepped_down: p.stepped_down,
        emergency_fund: { stage: p.stage, saved_inr: inr(p.saved_paise), next_target_inr: inr(p.next_target_paise), remaining_inr: inr(p.remaining_paise), months_to_next_stage: p.months_to_next,
          irregular_income: p.irregular, needs_more_data: p.needs_data },
        goals: svc.listGoals(db, today).map((g) => ({ name: g.name, saved_inr: inr(g.saved_paise), target_inr: inr(g.target_paise), per_month_needed_inr: g.monthly_needed_paise === null ? null : inr(g.monthly_needed_paise) })),
      };
    }
    case 'safe_to_spend': {
      const s = svc.safeToSpendFor(db, a.date ?? today);
      return { date: s.date, per_day_inr: inr(s.per_day_paise), remaining_this_month_inr: inr(s.remaining_paise), days_left: s.days_left, status: s.status,
        income_inr: inr(s.income_paise), income_is_estimate: s.income_is_estimate, fixed_needs_inr: inr(s.fixed_needs_paise), savings_target_inr: inr(s.savings_target_paise), spent_so_far_inr: inr(s.spent_so_far_paise) };
    }
    case 'find_transactions': {
      const from = a.from ?? `${monthOf(today)}-01`, to = a.to ?? today, q = a.query?.toLowerCase().trim();
      const hits = svc.txBetween(db, from, addDays(to, 1)).filter((t) => t.bucket !== 'ignore' && (!a.bucket || t.bucket === a.bucket)
        && (!q || `${t.merchant_norm} ${t.category_name ?? ''}`.toLowerCase().includes(q)));
      return {
        from, to, matches: hits.length, total_inr: inr(hits.reduce((s, t) => s + t.amount_paise, 0)), showing: Math.min(hits.length, a.limit),
        transactions: hits.slice(0, a.limit).map((t) => ({ date: t.occurred_at.slice(0, 10), merchant: t.merchant_norm || t.category_name, category: t.category_name, bucket: t.bucket, amount_inr: inr(t.amount_paise),
          ...(t.regret === 1 ? { regretted: true } : {}) })),
      };
    }
    case 'monthly_report': {
      const r = svc.reportFor(db, m, today);
      return { month: r.month, income_inr: inr(r.income_paise), spent_inr: inr(r.spent_paise), saved_inr: inr(r.saved_paise),
        totals_inr: { need: inr(r.totals.need), want: inr(r.totals.want), waste: inr(r.totals.waste) }, pct_of_income: r.pct, user_targets_pct: r.targets,
        top_leaks: r.top_leaks.map((l) => ({ category: l.label, total_inr: inr(l.amount_paise), spends: l.count, reasons: l.reasons })),
        change_vs_last_month_inr: { month: r.prev_month, need: inr(r.vs_prev.need), want: inr(r.vs_prev.want), waste: inr(r.vs_prev.waste), total_spent: inr(r.vs_prev.spent) } };
    }
    case 'subscriptions': {
      const subs = svc.subscriptionsFor(db, today);
      return { monthly_total_inr: inr(subs.filter((s) => !s.unused).reduce((t, s) => t + s.amount_paise, 0)),
        subscriptions: subs.map((s) => ({ merchant: s.merchant, amount_inr: inr(s.amount_paise), next_renewal: s.next_due, days_until_renewal: s.days_until, per_year_inr: inr(s.yearly_paise), user_marked_unused: s.unused })) };
    }
    case 'bills': {
      const bills = svc.listBills(db, today);
      return { monthly_total_inr: inr(bills.reduce((t, b) => t + b.amount_paise, 0)),
        bills: bills.map((b) => ({ name: b.name, kind: b.kind, amount_inr: inr(b.amount_paise), next_due: b.next_due, days_until_due: b.days_until, status: b.status, instalments_left: b.installments_left })) };
    }
    case 'friends': {
      const s = svc.iouSummary(db);
      return { owed_to_user_inr: inr(s.owed_to_me_paise), user_owes_inr: inr(s.i_owe_paise),
        people: s.people.filter((p) => p.balance_paise !== 0).map((p) => ({ person: p.person, balance_inr: inr(p.balance_paise), meaning: p.balance_paise > 0 ? 'owes the user' : 'the user owes them' })) };
    }
  }
}
