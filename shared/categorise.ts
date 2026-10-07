// Step 1 + 2 of the CA brain: categorise a spend, then give the verdict (need / want / waste).
// Order of trust: (1) rules YOU taught by correcting, (2) built-in keyword rules, (3) low-confidence "Other" -> ask the user.
import type { Bucket, BucketSource } from './types';
import { isLateHour } from './time';

export interface SeedCategory { name: string; bucket: Bucket; fixed: 0 | 1 }
const C = (name: string, bucket: Bucket, fixed: 0 | 1 = 0): SeedCategory => ({ name, bucket, fixed });

// `fixed` = a monthly commitment (rent, EMI...) that is covered by the "fixed needs" setting, not by daily spending.
export const SEED_CATEGORIES: SeedCategory[] = [
  C('Groceries', 'need'), C('Rent', 'need', 1), C('Utilities & Recharge', 'need', 1), C('Transport', 'need'),
  C('Education', 'need'), C('Health', 'need'), C('Insurance', 'need', 1), C('EMI & Loans', 'need', 1),
  C('Food Delivery', 'want'), C('Eating Out', 'want'), C('Chai & Snacks', 'want'), C('Cabs & Rides', 'want'),
  C('Shopping', 'want'), C('Entertainment', 'want'), C('Subscriptions', 'want'), C('Travel', 'want'),
  C('Fees & Penalties', 'waste'), C('Cash Withdrawal', 'ignore'), C('Transfers', 'ignore'), C('Other', 'want'),
];

// First match wins, so specific rules (fees, subscriptions) sit above broad ones (shopping).
const RULES: [RegExp, string][] = [
  [/late (payment )?fee|penalty|convenience fee|processing fee|overdue|dishonou?r|bounce charge|min(imum)? bal\w* (charge|penalty)|\bfine\b/i, 'Fees & Penalties'],
  [/\batm\b|cash (wdl|withdrawal)|\bnfs\b/i, 'Cash Withdrawal'],
  [/self transfer|own account|to self/i, 'Transfers'],
  [/zomato|swiggy|eatsure|domino|pizza|kfc|mcdonald|burger king|subway/i, 'Food Delivery'],
  [/restaurant|cafe|café|starbucks|barbeque|bistro|dhaba/i, 'Eating Out'],
  [/\bchai\b|tea stall|tapri|snack|bakery|juice|vada pav|canteen/i, 'Chai & Snacks'],
  [/bigbasket|blinkit|zepto|instamart|dmart|grofers|reliance fresh|kirana|grocer|vegetable|\bmilk\b|supermarket/i, 'Groceries'],
  [/uber|\bola\b|rapido|blusmart|indrive/i, 'Cabs & Rides'],
  [/irctc|redbus|\bmetro\b|\bbus\b|\bauto\b|petrol|diesel|fuel|hpcl|bpcl|indian oil|fastag|ksrtc|kadamba/i, 'Transport'],
  [/netflix|spotify|prime video|hotstar|jiocinema|youtube premium|sonyliv|zee5|subscription|membership/i, 'Subscriptions'],
  [/bookmyshow|\bpvr\b|\binox\b|steam|playstation|movie/i, 'Entertainment'],
  [/makemytrip|goibibo|cleartrip|airbnb|\boyo\b|indigo|air india|flight|hotel/i, 'Travel'],
  [/electricity|kseb|msedcl|bescom|\btneb\b|water bill|\bgas\b|\bjio\b|airtel|vodafone|bsnl|recharge|broadband|fibernet|wifi/i, 'Utilities & Recharge'],
  [/\brent\b|hostel|\bpg\b|landlord/i, 'Rent'],
  [/tuition|college|udemy|coursera|unacademy|byju|exam fee|stationery|\bbooks?\b/i, 'Education'],
  [/pharmacy|apollo|medplus|1mg|pharmeasy|hospital|clinic|doctor|medical/i, 'Health'],
  [/\blic\b|insurance|policybazaar|premium/i, 'Insurance'],
  [/\bemi\b|\bloan\b|bajaj fin/i, 'EMI & Loans'],
  [/amazon|flipkart|myntra|ajio|meesho|nykaa|decathlon|croma|\bmall\b/i, 'Shopping'],
];

const STOP = new Set(['UPI', 'DR', 'CR', 'IMPS', 'NEFT', 'RTGS', 'POS', 'ATM', 'ECOM', 'PAYMENT', 'PAYMENTS', 'TO', 'FROM', 'PAID', 'VIA',
  'BANK', 'TRANSFER', 'TXN', 'PURCHASE', 'DEBIT', 'CREDIT', 'CARD', 'REF', 'NO', 'UPIOUT', 'UPIIN']);
const BANKS = new Set(['HDFC', 'ICICI', 'SBI', 'AXIS', 'KOTAK', 'YESB', 'PNB', 'PUNB', 'IDFB', 'PAYTM', 'OKAXIS', 'OKHDFCBANK', 'OKICICI', 'OKSBI', 'YBL', 'IBL', 'AXL']);
const title = (w: string) => w[0].toUpperCase() + w.slice(1).toLowerCase();

/** "UPI-SWIGGY-swiggy@icici-ICIC0001-4123-UPI" -> "Swiggy". Statement narrations are noisy; rules key off this clean name. */
export function normaliseMerchant(raw: string): string {
  const structured = /^(UPI|IMPS|NEFT)[-/]/i.test(raw.trim());
  for (const seg of raw.split(structured ? /[-/]/ : /[/|*]/)) {
    if (!seg.trim() || seg.includes('@')) continue; // skip empty bits and UPI handles
    const words = seg.replace(/[^A-Za-z&' .]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 1 && !/^[Xx]+$/.test(w) && !STOP.has(w.toUpperCase()) && !BANKS.has(w.toUpperCase())); // XXXX = masked card no.
    if (words.length) return words.slice(0, 3).map(title).join(' ');
  }
  return raw.trim().slice(0, 30);
}

export interface UserRule { category: string; bucket: Bucket }
export interface Verdict { merchant_norm: string; category: string; bucket: Bucket; confidence: number; source: BucketSource }

export function categorise(
  raw: string,
  note: string,
  ctx: { userRules: Map<string, UserRule>; bucketOf: (category: string) => Bucket; hour?: number },
): Verdict {
  const merchant_norm = normaliseMerchant(raw);
  const learned = ctx.userRules.get(merchant_norm.toLowerCase());
  if (learned) return { merchant_norm, category: learned.category, bucket: learned.bucket, confidence: 1, source: 'user' };

  const hit = RULES.find(([re]) => re.test(`${raw} ${note}`));
  const category = hit ? hit[1] : 'Other';
  let bucket = ctx.bucketOf(category);
  let confidence = hit ? 0.9 : 0.3;
  // Context beats category: an auto to college is a Need, a ride at 1 am is a Want.
  if (category === 'Transport' && ctx.hour !== undefined && isLateHour(ctx.hour)) { bucket = 'want'; confidence = 0.6; }
  return { merchant_norm, category, bucket, confidence, source: hit ? 'rule' : 'default' };
}

/** The built-in rules only (no learned corrections): what the phone can say offline. The server re-judges authoritatively on sync. */
export function localVerdict(raw: string, hour?: number): Verdict {
  const defaults = new Map(SEED_CATEGORIES.map((c) => [c.name, c.bucket]));
  return categorise(raw, '', { userRules: new Map(), bucketOf: (n) => defaults.get(n) ?? 'want', hour });
}

