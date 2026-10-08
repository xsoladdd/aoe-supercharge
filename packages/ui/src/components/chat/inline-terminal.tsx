import {
  ArrowClockwiseIcon,
  CircleNotchIcon,
  HandGrabbingIcon,
  TerminalWindowIcon,
  XIcon,
} from '@phosphor-icons/react';
import type { RunTerminal } from '@aoe-supercharge/core/shared';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { closeRunTerminal } from '@/lib/run-terminals';
import { cn } from '@/lib/utils';
import { LiveTerminal, type LiveState, type LiveTerminalHandle } from './live-terminal';

/**
 * A terminal of its own that Run in a new terminal opened, under the command: the command runs in it as
 * you, in the session's folder. You see the output, scroll back through it and answer its prompts, and it
 * stays, across reloads too, until you close it. It connects once it scrolls into view.
 */
export default function InlineTerminal({ terminal }: { terminal: RunTerminal }) {
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<LiveTerminalHandle>(null);
  const [seen, setSeen] = useState(false);
  const [state, setState] = useState<LiveState>('connecting');
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el || seen) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  const close = async () => {
    setClosing(true);
    try {
      await closeRunTerminal(terminal);
    } catch (e) {
      setClosing(false);
      toast.error('Could not close the terminal', {
        description: e instanceof ApiError ? e.message : undefined,
      });
    }
  };

  const status =
    state === 'live'
      ? null
      : state === 'elsewhere'
        ? 'Open in AoE, which has the keyboard'
        : state === 'closed'
          ? 'Disconnected'
          : 'Connecting…';
  return (
    <section
      ref={box}
      aria-label={`Terminal: ${terminal.command}`}
      className="my-3 overflow-hidden rounded-lg border border-border bg-background"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[0.8125rem]">
        <TerminalWindowIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span translate="no" className="min-w-0 flex-1 truncate font-mono" title={terminal.command}>
          <span className="text-st-green select-none">$ </span>
          {terminal.command.split('\n')[0]}
          {terminal.command.includes('\n') && <span className="text-muted-foreground"> …</span>}
        </span>
        {status && (
          <span role="status" className="inline-flex shrink-0 items-center gap-1.5 text-muted-foreground">
            {state === 'connecting' && seen && <CircleNotchIcon className="size-3.5 animate-spin" />}
            {status}
          </span>
        )}
        {state === 'elsewhere' && (
          <Button size="xs" variant="outline" onClick={() => term.current?.send({ type: 'claim' })}>
            <HandGrabbingIcon />
            Take over
          </Button>
        )}
        {state === 'closed' && (
          <Button size="xs" variant="outline" onClick={() => setAttempt((a) => a + 1)}>
            <ArrowClockwiseIcon />
            Reconnect
          </Button>
        )}
        <Button
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground"
          aria-label="Close this terminal"
          title="Close this terminal: anything still running in it stops"
          disabled={closing}
          onClick={() => void close()}
        >
          {closing ? <CircleNotchIcon className="animate-spin" /> : <XIcon />}
        </Button>
      </div>
      {note && (
        <p
          role={note.error ? 'alert' : 'status'}
          className={cn(
            'border-b border-border px-3 py-1.5 text-[0.8125rem]',
            note.error ? 'text-st-red' : 'text-muted-foreground',
          )}
        >
          {note.text}
        </p>
      )}
      {seen ? (
        <LiveTerminal
          ref={term}
          path={`/api/sessions/${encodeURIComponent(terminal.sessionId)}/terminals/${encodeURIComponent(terminal.id)}/ws`}
          attempt={attempt}
          label={`Output of ${terminal.command}`}
          className="h-80"
          onState={setState}
          onMessage={(m) => {
            if (m.type === 'sc_error') setNote({ text: m.message ?? 'Something went wrong.', error: true });
            else if (m.type === 'sc_note') setNote({ text: m.message ?? '', error: false });
          }}
        />
      ) : (
        <div className="h-80" />
      )}
    </section>
  );
}
