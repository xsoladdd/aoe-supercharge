import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, getJson } from '@/lib/api';
import { cn } from '@/lib/utils';

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

/** The session's terminal, as text. Sticks to the bottom unless you scrolled up to read. */
export function Conversation({
  content,
  error,
  className,
}: {
  content: string | null;
  error: string | null;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [content]);
  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      role="log"
      // Focusable so keyboard users can scroll the conversation.
      tabIndex={0}
      aria-live="polite"
      aria-label="Session conversation"
      className={cn(
        'overflow-auto overscroll-contain rounded-lg border border-border bg-background',
        className,
      )}
    >
      {error ? (
        <p role="alert" className="p-4 text-[0.9375rem] text-st-red">
          {error} It retries by itself.
        </p>
      ) : content === null ? (
        <p className="p-4 text-[0.9375rem] text-muted-foreground">Loading the conversation…</p>
      ) : (
        <pre
          translate="no"
          className="min-w-max p-4 font-mono text-[0.8125rem] leading-[1.45] text-foreground"
        >
          {content || '(no output yet)'}
        </pre>
      )}
    </div>
  );
}
