// Phone key-value stores can't take big values (Android's AsyncStorage struggles above ~2 MB per item). The on-device database snapshot
// can grow, so this wrapper stores one logical value as several small pieces. Pieces are written first and the count last.
export interface KV { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void>; del(k: string): Promise<void> }

export function chunkedKv(inner: KV, size = 200_000): KV {
  const count = async (k: string) => Number((await inner.get(`${k}#n`)) ?? 0);
  return {
    async get(k) {
      const n = await count(k);
      if (!n) return null;
      const parts: string[] = [];
      for (let i = 0; i < n; i++) {
        const p = await inner.get(`${k}#${i}`);
        if (p === null) return null; // a piece is missing or unreadable: treat the whole value as missing
        parts.push(p);
      }
      return parts.join('');
    },
    async set(k, v) {
      const old = await count(k), n = Math.max(1, Math.ceil(v.length / size));
      for (let i = 0; i < n; i++) await inner.set(`${k}#${i}`, v.slice(i * size, (i + 1) * size));
      await inner.set(`${k}#n`, String(n));
      for (let i = n; i < old; i++) await inner.del(`${k}#${i}`);
    },
    async del(k) {
      const n = await count(k);
      for (let i = 0; i < n; i++) await inner.del(`${k}#${i}`);
      await inner.del(`${k}#n`);
    },
  };
}
