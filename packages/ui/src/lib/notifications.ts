import { useEffect, useRef, useSyncExternalStore } from 'react';
import { claimNotices, onNotice } from './live';

/** A notice this old came again on a replay after a reconnect: shown already, or old news. */
const STALE_MS = 60_000;
const ASKED_KEY = 'supercharge:notifications-asked';

export type NoticePermission = NotificationPermission | 'unsupported';

export function noticePermission(): NoticePermission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

const listeners = new Set<() => void>();
function permissionChanged() {
  claimNotices(noticePermission() === 'granted');
  for (const l of listeners) l();
}

function askedBefore(): boolean {
  try {
    return localStorage.getItem(ASKED_KEY) === '1';
  } catch {
    // no storage: don't ask on every visit
    return true;
  }
}

/** Asks the browser to allow this dashboard's notifications (it answers by itself once blocked). */
export async function askNoticePermission(): Promise<NoticePermission> {
  if (noticePermission() !== 'default') return noticePermission();
  try {
    localStorage.setItem(ASKED_KEY, '1');
  } catch {
    // asked anyway
  }
  try {
    await Notification.requestPermission();
  } catch {
    // an old browser without the promise form
  }
  permissionChanged();
  return noticePermission();
}

export function useNoticePermission(): NoticePermission {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    noticePermission,
    () => 'unsupported',
  );
}

/**
 * This tab shows the daemon's desktop notifications, so a click focuses it and opens the item (the
 * daemon sends none of its own while one does). Asks for the browser's permission once, on your first
 * click; Settings asks too. Off in the office window: the dashboard tab beside it does it.
 */
export function useBrowserNotices(on: boolean, navigate: (to: string) => void) {
  const go = useRef(navigate);
  go.current = navigate;
  useEffect(() => {
    if (!on || noticePermission() === 'unsupported') return;
    claimNotices(noticePermission() === 'granted');
    // The browser's own site setting can change behind the page.
    let status: PermissionStatus | null = null;
    navigator.permissions
      ?.query({ name: 'notifications' })
      .then((s) => {
        status = s;
        s.onchange = permissionChanged;
      })
      .catch(() => {});
    const firstClick = () => {
      if (!askedBefore()) void askNoticePermission();
    };
    window.addEventListener('pointerdown', firstClick, { once: true });
    const shown = new Set<string>();
    const off = onNotice((n) => {
      const key = `${n.id}@${n.at}`;
      if (shown.has(key) || Date.now() - Date.parse(n.at) > STALE_MS) return;
      shown.add(key);
      // On its own page, in front of you: you see it already.
      if (!n.test && document.hasFocus() && window.location.pathname === n.href) return;
      try {
        // One per item: a newer notice for it replaces the one on screen.
        const note = new Notification(n.title, { body: n.body, tag: n.id });
        note.onclick = () => {
          window.focus();
          go.current(n.href);
          note.close();
        };
      } catch {
        // permission withdrawn in between
      }
    });
    return () => {
      off();
      window.removeEventListener('pointerdown', firstClick);
      if (status) status.onchange = null;
      claimNotices(false);
    };
  }, [on]);
}
