// The savings engine: "safe to spend today" and the savings target. All maths, no LLM.
import type { SafeToSpend, SavingsPlan } from '../types';
import { daysInMonth } from './dates';

/** safe today = (income - fixed needs - savings target - spent so far) / days left (today included). */
export function safeToSpend(i: {
  date: string; incomePaise: number; incomeIsEstimate: boolean;
  fixedNeedsPaise: number; savingsTargetPaise: number; spentSoFarPaise: number;
}): SafeToSpend {
  const dim = daysInMonth(i.date.slice(0, 7));
  const daysLeft = dim - Number(i.date.slice(8, 10)) + 1;
  const pool = i.incomePaise - i.fixedNeedsPaise - i.savingsTargetPaise;
  const remaining = pool - i.spentSoFarPaise;
  const perDay = remaining > 0 ? Math.floor(remaining / daysLeft / 100) * 100 : 0; // whole rupees
  const planned = pool > 0 ? pool / dim : 0;
  return {
    date: i.date, income_paise: i.incomePaise, income_is_estimate: i.incomeIsEstimate, needs_income: i.incomePaise <= 0,
    fixed_needs_paise: i.fixedNeedsPaise, savings_target_paise: i.savingsTargetPaise, spent_so_far_paise: i.spentSoFarPaise,
    remaining_paise: remaining, days_left: daysLeft, per_day_paise: perDay,
    status: remaining < 0 ? 'over' : perDay < 0.5 * planned ? 'tight' : 'ok',
  };
}

/** Emergency fund = essential monthly expenses x m (3-6 months, 6-12 if income is irregular).
 *  Monthly target = larger of "x% of take-home" and "what the next stage needs to land on time".
 *  If that is unrealistic today, start lower (cap: half of what is left after fixed needs) and step up. */
export function savingsPlan(i: {
  takeHomePaise: number; essentialMonthlyPaise: number; irregular: boolean;
  savedPaise: number; targetPct: number; fixedNeedsPaise: number; horizonMonths: number;
}): SavingsPlan {
  const [lo, hi] = i.irregular ? [6, 12] : [3, 6];
  const ess = i.essentialMonthlyPaise;
  const targets = { starter_paise: ess, min_paise: ess * lo, max_paise: ess * hi };
  const needsData = ess <= 0;
  const stage: SavingsPlan['stage'] = needsData || i.savedPaise < targets.starter_paise ? 'starter'
    : i.savedPaise < targets.min_paise ? 'min' : i.savedPaise < targets.max_paise ? 'max' : 'done';
  const next = { starter: targets.starter_paise, min: targets.min_paise, max: targets.max_paise, done: targets.max_paise }[stage];
  const remaining = needsData ? 0 : Math.max(0, next - i.savedPaise);
  const pctTarget = Math.round((i.takeHomePaise * i.targetPct) / 100);
  const goalNeed = Math.ceil(remaining / Math.max(1, i.horizonMonths));
  const monthly = Math.max(pctTarget, goalNeed);
  const cap = Math.round(Math.max(0, i.takeHomePaise - i.fixedNeedsPaise) * 0.5);
  const startAt = Math.min(monthly, cap);
  return {
    take_home_paise: i.takeHomePaise, essential_monthly_paise: ess, irregular: i.irregular, needs_data: needsData,
    multiples: { min: lo, max: hi }, targets, saved_paise: i.savedPaise, stage,
    next_target_paise: next, remaining_paise: remaining, pct_target_paise: pctTarget, goal_need_paise: goalNeed,
    monthly_target_paise: monthly, start_at_paise: startAt, stepped_down: startAt < monthly,
    months_to_next: remaining === 0 ? 0 : startAt > 0 ? Math.ceil(remaining / startAt) : null,
  };
}
