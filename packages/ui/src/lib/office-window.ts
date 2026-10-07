import { useEffect } from 'react';

/**
 * The office in a window of its own, to keep on another screen: the floor and nothing else. Whatever
 * you open from it (a worker's page, a chat) opens in the dashboard window, so the office stays put.
 */
export const OFFICE_WINDOW = '/office/window';
const OFFICE_NAME = 'supercharge-office';
const MAIN_NAME = 'supercharge-main';
const NAVIGATE = 'supercharge:navigate';

/** Opens the office window, or brings it back if it is already open. */
export function openOfficeWindow() {
  const w = Math.min(1600, Math.round(screen.availWidth * 0.8));
  const h = Math.min(1000, Math.round(screen.availHeight * 0.8));
  window.open(OFFICE_WINDOW, OFFICE_NAME, `popup,width=${w},height=${h}`)?.focus();
}

/** From the office window: show a page in the dashboard window that opened it, or in a new one. */
export function openInMain(href: string) {
  const main = window.opener as Window | null;
  if (main && !main.closed) {
    main.postMessage({ type: NAVIGATE, href }, location.origin);
    main.focus();
    return;
  }
  window.open(href, MAIN_NAME)?.focus();
}

/** wouter's location in the office window: it stays on the office, and every link goes to the dashboard. */
export function useOfficeWindowLocation(): [string, (to: string) => void] {
  return [OFFICE_WINDOW, openInMain];
}

/** In the dashboard window: go where the office window asks. Only pages of this dashboard, from itself. */
export function useOfficeWindowLinks(navigate: (to: string) => void) {
  useEffect(() => {
    // So an office window opened on its own (no opener) finds this window again.
    if (!window.name) window.name = MAIN_NAME;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin) return;
      const d = e.data as { type?: unknown; href?: unknown } | null;
      if (d?.type !== NAVIGATE || typeof d.href !== 'string') return;
      // A path on this dashboard, not `//host` or `/\host`.
      if (!/^\/(?![/\\])/.test(d.href)) return;
      navigate(d.href);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [navigate]);
}
