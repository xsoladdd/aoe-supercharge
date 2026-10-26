import { useEffect, useState } from 'react';
import { ApiError, getJson } from '@/lib/api';

interface Output {
  content: string;
  rcUrl: string | null;
}

/** Polls a session's pane text while mounted and the tab is visible (AoE has no stream for it). */
export function useSessionOutput(sessionId: string, intervalMs = 2000) {
  const [output, setOutput] = useState<Output | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    let first = true;
    const load = async () => {
      if (first || document.visibilityState === 'visible') {
        first = false;
        try {
          const r = await getJson<Output>(`/api/sessions/${encodeURIComponent(sessionId)}/output?lines=400`);
          if (live) {
            setOutput(r);
            setError(null);
          }
        } catch (e) {
          if (live) setError(e instanceof ApiError ? e.message : 'Could not read the session.');
        }
      }
      if (live) timer = setTimeout(load, intervalMs);
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [sessionId, intervalMs, tick]);
  return { output, error, refresh: () => setTick((t) => t + 1) };
}
