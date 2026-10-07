// Bill & EMI reminders. Late fees are the purest waste, so the whole job is "which month's bill is next, and how close is it?".
import { daysInMonth, dayDiff, monthOf, nextMonth, pad } from './dates';

/** The unpaid cycle: this month's, unless it is already paid (then the month after the last paid one). */
export function nextCycle(lastPaidMonth: string | null, today: string, dueDay: number) {
  const thisMonth = monthOf(today);
  const paid = !!lastPaidMonth && lastPaidMonth >= thisMonth;
  const cycle = paid ? nextMonth(lastPaidMonth!) : thisMonth;
  const due = `${cycle}-${pad(Math.min(dueDay, daysInMonth(cycle)))}`; // due day 31 in a 30-day month -> the 30th
  return { cycle, due, days_until: dayDiff(due, today), paid_this_month: paid };
}

export const billStatus = (daysUntil: number, remindDays: number): 'overdue' | 'due_soon' | 'upcoming' =>
  daysUntil < 0 ? 'overdue' : daysUntil <= remindDays ? 'due_soon' : 'upcoming';
