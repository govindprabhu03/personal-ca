import { useCallback, useEffect, useState } from 'react';

/** Tiny data hook: runs `fn` on mount and whenever `deps` change (screens pass the global `version`, bumped after every write). */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, set] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(() => {
    fn().then((data) => set({ data, loading: false }), (e) => set((s) => ({ ...s, error: String(e?.message ?? e), loading: false })));
  }, deps);
  useEffect(reload, [reload]);
  return { ...state, reload };
}
