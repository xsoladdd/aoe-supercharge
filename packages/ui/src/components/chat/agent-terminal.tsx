import { ArrowClockwiseIcon, CircleNotchIcon, HandGrabbingIcon } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { LiveTerminal, type LiveState, type LiveTerminalHandle } from './live-terminal';

/**
 * The chat's Terminal view: the agent's own pane, live. Every key goes straight in, as in a terminal
 * attached to the session (arrows, Enter, Escape, Tab, Ctrl-C, paste). While you are attached to it in a
 * terminal, it shows the pane at that terminal's size and leaves its size alone.
 */
export default function AgentTerminal({ sessionId }: { sessionId: string }) {
  const term = useRef<LiveTerminalHandle>(null);
  const [state, setState] = useState<LiveState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [attached, setAttached] = useState(false);
  const [attempt, setAttempt] = useState(0);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border">
      <div className="flex min-h-11 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-sm text-muted-foreground">
        <p role={error ? 'alert' : 'status'} className="mr-auto inline-flex min-w-0 items-center gap-2">
          {error ? (
            <span className="text-st-red">{error}</span>
          ) : state === 'connecting' ? (
            <>
              <CircleNotchIcon className="size-4 animate-spin" />
              Opening the terminal…
            </>
          ) : state === 'elsewhere' ? (
            'This session is open in AoE, which has the keyboard.'
          ) : state === 'closed' ? (
            'The terminal connection closed.'
          ) : attached ? (
            'You are attached in a terminal, so this shows its size.'
          ) : (
            'Keys go straight to the session.'
          )}
        </p>
        {state === 'elsewhere' && (
          <Button size="sm" variant="outline" onClick={() => term.current?.send({ type: 'claim' })}>
            <HandGrabbingIcon />
            Take over
          </Button>
        )}
        {state === 'closed' && (
          <Button size="sm" variant="outline" onClick={() => setAttempt((a) => a + 1)}>
            <ArrowClockwiseIcon />
            Reconnect
          </Button>
        )}
      </div>
      <LiveTerminal
        ref={term}
        path={`/api/sessions/${encodeURIComponent(sessionId)}/agent/ws`}
        attempt={attempt}
        label="Session terminal"
        className="flex-1"
        onState={(s) => {
          if (s === 'connecting') setError(null);
          setState(s);
        }}
        onMessage={(m) => {
          if (m.type === 'sc_window') setAttached(!!m.attached);
          else if (m.type === 'sc_error') setError(m.message ?? 'Something went wrong.');
        }}
      />
    </div>
  );
}
