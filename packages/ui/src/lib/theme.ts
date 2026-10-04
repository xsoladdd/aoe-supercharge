import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

export type ThemePref = 'dark' | 'light' | 'system';

const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
let pref: ThemePref = 'dark';
const listeners = new Set<() => void>();

function resolve(p: ThemePref): 'dark' | 'light' {
  return p === 'system' ? (media?.matches ? 'dark' : 'light') : p;
}

function apply() {
  const r = resolve(pref);
  document.documentElement.classList.toggle('dark', r === 'dark');
  document.documentElement.style.colorScheme = r;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', r === 'dark' ? '#17191a' : '#eef0f2');
  for (const l of listeners) l();
}

media?.addEventListener('change', () => pref === 'system' && apply());

export function setThemePref(p: ThemePref) {
  if (p === pref) return;
  pref = p;
  apply();
}

export function getThemePref(): ThemePref {
  return pref;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, () => pref);
}

export function useResolvedTheme(): 'dark' | 'light' {
  return useSyncExternalStore(subscribe, () => resolve(pref));
}

/** Follow the persisted preference from config.toml (ui.theme) as it arrives over SSE. */
export function useSyncThemeFrom(serverPref: ThemePref | undefined) {
  useEffect(() => {
    if (serverPref) setThemePref(serverPref);
  }, [serverPref]);
}

/** Current time, refreshed every `intervalMs` so relative times stay fresh. */
export function useNow(intervalMs = 30_000): Date {
  const subscribeTick = useCallback(
    (l: () => void) => {
      const t = setInterval(l, intervalMs);
      return () => clearInterval(t);
    },
    [intervalMs],
  );
  const tick = useSyncExternalStore(subscribeTick, () => Math.floor(Date.now() / intervalMs));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => new Date(), [tick]);
}
