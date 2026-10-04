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

export type ScalePref = 'small' | 'default' | 'large' | 'larger';

/** Root font size per interface size. Text, spacing and icons are all in rem, so they scale together. */
export const SCALE_PX: Record<ScalePref, number> = { small: 14, default: 15, large: 16, larger: 17.5 };

const SCALE_KEY = 'supercharge.scale';
let scale: ScalePref = (() => {
  try {
    const v = localStorage.getItem(SCALE_KEY) as ScalePref | null;
    return v && v in SCALE_PX ? v : 'default';
  } catch {
    return 'default';
  }
})();

function applyScale() {
  document.documentElement.style.fontSize = `${SCALE_PX[scale]}px`;
  try {
    localStorage.setItem(SCALE_KEY, scale);
  } catch {
    // private mode: the server value still applies on every load
  }
  for (const l of listeners) l();
}
// Before the first render, from the last session, so the page does not jump when the snapshot arrives.
if (typeof document !== 'undefined') applyScale();

export function setScalePref(s: ScalePref) {
  if (s === scale) return;
  scale = s;
  applyScale();
}

export function useScalePref(): ScalePref {
  return useSyncExternalStore(subscribe, () => scale);
}

/** Follow ui.scale from config.toml as it arrives over SSE. */
export function useSyncScaleFrom(serverPref: ScalePref | undefined) {
  useEffect(() => {
    if (serverPref) setScalePref(serverPref);
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
