// Splitting a spend with friends. Pure maths, shared so the app previews exactly what the server will save.
// Only YOUR share is a spend (budget, reports, safe-to-spend); what friends owe you is a receivable, never an expense.

export function parseNames(text: string): string[] {
  const seen = new Set<string>();
  return text.split(/[,;]|\sand\s|&/i).map((n) => n.trim()).filter((n) => {
    const k = n.toLowerCase();
    if (!n || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface Shares { mine: number; shares: { person: string; paise: number }[] }

/**
 * total: what was paid, in paise. friends: everyone else sharing it. payer: a friend's name, or null if YOU paid.
 * myShare: optional exact share for you; otherwise equal. Rounding paise go to whoever paid, so nobody is short-changed.
 */
export function computeShares(i: { total: number; friends: string[]; payer: string | null; myShare?: number }): Shares {
  const { total, friends, payer } = i;
  if (!Number.isInteger(total) || total <= 0) throw new Error('Enter the total amount');
  if (friends.length < 1) throw new Error('Add at least one friend to split with');
  const payerIdx = payer === null ? -1 : friends.findIndex((f) => f.toLowerCase() === payer.toLowerCase());
  if (payer !== null && payerIdx < 0) throw new Error('The person who paid must be one of the friends');

  if (i.myShare !== undefined) {
    if (i.myShare < 0 || i.myShare > total) throw new Error('Your share must be between 0 and the total');
    const rest = total - i.myShare, base = Math.floor(rest / friends.length), rem = rest - base * friends.length;
    const rIdx = payerIdx >= 0 ? payerIdx : 0;
    return { mine: i.myShare, shares: friends.map((person, k) => ({ person, paise: base + (k === rIdx ? rem : 0) })) };
  }
  const n = friends.length + 1, base = Math.floor(total / n), rem = total - base * n;
  return {
    mine: base + (payer === null ? rem : 0),
    shares: friends.map((person, k) => ({ person, paise: base + (k === payerIdx ? rem : 0) })),
  };
}
