import type { ChatResponse } from '@aoe-supercharge/core/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, getJson } from '@/lib/api';

type Poll = ChatResponse | { unchanged: true; version: string };

/**
 * The session's conversation from Claude Code's transcript. Polls about once a second while the tab is
 * visible; the daemon answers `unchanged` when nothing was appended, so idle polls are tiny.
 */
export function useChat(sessionId: string, intervalMs = 1200) {
  const [chat, setChat] = useState<ChatResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = useRef<string | null>(null);
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    version.current = null;
    setChat(null);
    setError(null);
    // One poll at a time: a kick during a poll queues exactly one more, so loops never double up.
    let busy = false;
    let again = false;
    const load = async () => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      clearTimeout(timer);
      // The first read always happens; after that, hidden tabs stop polling until they are shown.
      if (!version.current || document.visibilityState === 'visible') {
        try {
          const q = version.current ? `?version=${encodeURIComponent(version.current)}` : '';
          const r = await getJson<Poll>(`/api/sessions/${encodeURIComponent(sessionId)}/chat${q}`);
          if (live && !('unchanged' in r)) {
            version.current = r.version;
            setChat(r);
          }
          if (live) setError(null);
        } catch (e) {
          if (live) setError(e instanceof ApiError ? e.message : 'Could not read the conversation.');
        }
      }
      busy = false;
      if (!live) return;
      if (again) {
        again = false;
        void load();
      } else {
        timer = setTimeout(load, intervalMs);
      }
    };
    kick.current = () => void load();
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [sessionId, intervalMs]);

  const refresh = useCallback(() => kick.current(), []);
  return { chat, error, refresh };
}
