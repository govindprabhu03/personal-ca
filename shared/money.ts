// Money is ALWAYS whole paise (integer). Floats never touch a balance, so totals never drift.

/** "1,250.50" or "₹90" -> 125050 / 9000. Returns null if it is not a valid amount. */
export function parseRupees(input: string): number | null {
  const s = input.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [r, p = ''] = s.split('.');
  return parseInt(r, 10) * 100 + parseInt(p.padEnd(2, '0'), 10);
}

/** 125050 -> "₹1,250.50", 9000000 -> "₹90,000" (Indian digit grouping). */
export function formatRupees(paise: number): string {
  const abs = Math.abs(Math.round(paise));
  const r = Math.floor(abs / 100);
  const p = abs % 100;
  const s = String(r);
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${paise < 0 ? '-' : ''}₹${grouped}${p ? '.' + String(p).padStart(2, '0') : ''}`;
}
