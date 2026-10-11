// Wrong-credential throttle, per client address: `max` misses within `windowMs` lock that client out for `lockMs`
// (even a correct credential is refused meanwhile). Used by the home-PC server (access token) and the hosted one (sign-in tokens).
export function createLockout(opts: { max?: number; windowMs?: number; lockMs?: number } = {}) {
  const max = opts.max ?? 10, windowMs = opts.windowMs ?? 60_000, lockMs = opts.lockMs ?? 60_000;
  const misses = new Map<string, { n: number; since: number; until: number }>();
  return {
    /** Seconds this client must wait, or 0 if it may try. */
    retryAfter(who: string, now = Date.now()): number { const m = misses.get(who); return m && m.until > now ? Math.ceil((m.until - now) / 1000) : 0; },
    /** Record a wrong credential. Returns true when this miss is the one that locks the client out. */
    fail(who: string, now = Date.now()): boolean {
      const m = misses.get(who), e = m && now - m.since < windowMs ? m : { n: 0, since: now, until: 0 };
      const locked = ++e.n >= max;
      if (locked) e.until = now + lockMs;
      misses.set(who, e);
      if (misses.size > 500) for (const [k, v] of misses) if (v.until < now && now - v.since > windowMs) misses.delete(k);
      return locked;
    },
    ok(who: string) { misses.delete(who); },
  };
}
