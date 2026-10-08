import { useEffect, useState } from 'react';
import { sendJson } from '@/lib/api';

const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

/**
 * A chat that is open and visible is read: AoE keeps `unread` until its own UI shows the chat, so
 * without this a reply seen here stays "Control chat replied" in Needs you. Runs again whenever a new
 * reply sets `unread` while the page is open, and when the tab comes back into view.
 */
export function useMarkRead(sessionId: string, unread: boolean) {
  const [visible, setVisible] = useState(isVisible);
  useEffect(() => {
    const update = () => setVisible(isVisible());
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
    };
  }, []);

  useEffect(() => {
    if (!unread || !visible) return;
    // A moment's grace, so a chat that is only passed through on a click is not marked.
    const timer = setTimeout(() => {
      sendJson('POST', `/api/sessions/${encodeURIComponent(sessionId)}/read`, {}).catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [sessionId, unread, visible]);
}
