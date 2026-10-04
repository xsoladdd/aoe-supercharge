import { ArrowSquareOutIcon, PaperPlaneRightIcon } from '@phosphor-icons/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, getJson, sendJson } from '@/lib/api';
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
    const load = async () => {
      if (document.visibilityState === 'visible') {
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
        <p role="alert" className="p-4 text-[15px] text-st-red">
          {error} It retries by itself.
        </p>
      ) : content === null ? (
        <p className="p-4 text-[15px] text-muted-foreground">Loading the conversation…</p>
      ) : (
        <pre translate="no" className="min-w-max p-4 font-mono text-[13px] leading-[1.45] text-foreground">
          {content || '(no output yet)'}
        </pre>
      )}
    </div>
  );
}

/** Type into the session, like typing in AoE. Enter sends, Shift+Enter adds a line. Audited. */
export function Composer({
  sessionId,
  label,
  onSent,
  autoFocus,
}: {
  sessionId: string;
  label: string;
  onSent?: () => void;
  autoFocus?: boolean;
}) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    if (!message.trim()) {
      setError('Write a message first.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      await sendJson('POST', `/api/sessions/${encodeURIComponent(sessionId)}/send`, { message });
      setMessage('');
      onSent?.();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Could not send.';
      setError(`${msg} Try again, or type in AoE directly.`);
      toast.error('Message not sent');
    } finally {
      setSending(false);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      className="space-y-1.5"
    >
      <label htmlFor={`composer-${sessionId}`} className="sr-only">
        {label}
      </label>
      <div className="flex items-end gap-2">
        <Textarea
          id={`composer-${sessionId}`}
          name="message"
          autoComplete="off"
          autoFocus={autoFocus}
          value={message}
          rows={2}
          placeholder="Message this session…"
          aria-invalid={!!error || undefined}
          aria-describedby={`composer-help-${sessionId}`}
          onChange={(e) => {
            setMessage(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          className="max-h-48 min-h-11 text-[15px]"
        />
        <Button type="submit" variant="gradient" disabled={sending} aria-label="Send message">
          <PaperPlaneRightIcon weight="fill" />
          {sending ? 'Sending…' : 'Send'}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-st-red">
          {error}
        </p>
      ) : (
        <p id={`composer-help-${sessionId}`} className="text-sm text-muted-foreground">
          Enter sends, Shift+Enter adds a line. Every message is recorded in the audit log.
        </p>
      )}
    </form>
  );
}

export function RemoteControlLink({ url }: { url: string | null }) {
  if (!url) return null;
  return (
    <Button variant="outline" size="sm" asChild>
      <a href={url} target="_blank" rel="noreferrer">
        <ArrowSquareOutIcon />
        Open on claude.ai
      </a>
    </Button>
  );
}
