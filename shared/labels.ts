import type { DetectorId } from './types';

// Plain-language names for the waste detectors; used in reports (server) and badges (mobile).
export const DETECTOR_LABEL: Record<DetectorId, string> = {
  late_night: 'late-night', sale: 'sale-driven', spike: 'spike', pay_later: 'pay-later', small_leaks: 'small leak',
  payday: 'payday splurge', fee: 'fee/penalty', double_charge: 'possible double charge', repeat_regret: 'repeat regret',
};
export const DETECTOR_EMOJI: Record<DetectorId, string> = {
  late_night: '🌙', sale: '🏷️', spike: '📈', pay_later: '💳', small_leaks: '🪣', payday: '🛍️', fee: '🚨', double_charge: '👯', repeat_regret: '🔁',
};
export const CATEGORY_EMOJI: Record<string, string> = {
  Groceries: '🥦', Rent: '🏠', 'Utilities & Recharge': '📱', Transport: '🚌', Education: '📚', Health: '💊', Insurance: '🛡️', 'EMI & Loans': '🏦',
  'Food Delivery': '🍔', 'Eating Out': '🍽️', 'Chai & Snacks': '☕', 'Cabs & Rides': '🚕', Shopping: '🛍️', Entertainment: '🎬', Subscriptions: '📺',
  Travel: '✈️', 'Fees & Penalties': '🚨', 'Cash Withdrawal': '🏧', Transfers: '🔄', Other: '✨',
};
export const BUCKET_EMOJI = { need: '🌱', want: '✨', waste: '🫠', ignore: '🔕' } as const;
