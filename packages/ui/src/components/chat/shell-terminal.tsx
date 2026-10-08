import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  CircleNotchIcon,
  EraserIcon,
  HandGrabbingIcon,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { ApiError, sendJson } from '@/lib/api';
import { takeShellRuns, useShellRunVersion } from '@/lib/shell-runs';
import { LiveTerminal, type LiveState, type LiveTerminalHandle } from './live-terminal';

/**
 * The control chat's own shell, in its folder: a paired terminal AoE keeps for the session, through the
 * daemon. Type in it as in any terminal. Commands from Run in control shell arrive through
 * `requestShellRun` and are sent once the shell is connected. Clear clears the screen; Restart closes the
 * shell and starts a fresh one.
 */
export default function ShellTerminal({ sessionId }: { sessionId: string }) {
  const term = useRef<LiveTerminalHandle>(null);
  const ready = useRef(false);
  const [state, setState] = useState<LiveState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [restarting, setRestarting] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const restartButton = useRef<HTMLButtonElement>(null);
  const runs = useShellRunVersion();

  const flush = () => {
    if (!ready.current) return;
    for (const command of takeShellRuns(sessionId)) term.current?.send({ type: 'run', command });
  };
  // A Run button queued a command while the shell was open.
  useEffect(flush, [runs]);

  const restart = async () => {
    setConfirmRestart(false);
    setRestarting(true);
    setError(null);
    try {
      await sendJson('POST', `/api/sessions/${encodeURIComponent(sessionId)}/shell/restart`);
      setAttempt((a) => a + 1);
    } catch (e) {
      setRestarting(false);
      toast.error('Could not restart the shell', {
        description: e instanceof ApiError ? e.message : undefined,
      });
    }
  };

  const banner = restarting ? 'restarting' : state;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-sm text-muted-foreground">
        <p role={error ? 'alert' : 'status'} className="mr-auto inline-flex min-w-0 items-center gap-2">
          {error ? (
            <span className="text-st-red">{error}</span>
          ) : banner === 'connecting' || banner === 'restarting' ? (
            <>
              <CircleNotchIcon className="size-4 animate-spin" />
              {banner === 'restarting' ? 'Starting a fresh shell…' : 'Opening the terminal…'}
            </>
          ) : banner === 'elsewhere' ? (
            'This terminal is open in AoE, which has the keyboard.'
          ) : banner === 'closed' ? (
            'The terminal connection closed.'
          ) : null}
        </p>
        {banner === 'elsewhere' && (
          <Button size="sm" variant="outline" onClick={() => term.current?.send({ type: 'claim' })}>
            <HandGrabbingIcon />
            Take over
          </Button>
        )}
        {banner === 'closed' && (
          <Button size="sm" variant="outline" onClick={() => setAttempt((a) => a + 1)}>
            <ArrowClockwiseIcon />
            Reconnect
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={state !== 'live' || restarting}
          title="Clear the screen (Ctrl-L). Earlier output stays in the scrollback."
          onClick={() => {
            term.current?.type('\x0c');
            term.current?.focus();
          }}
        >
          <EraserIcon />
          Clear
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={restarting}
          title="Close this shell and start a fresh one"
          onClick={() => setConfirmRestart(true)}
        >
          <ArrowCounterClockwiseIcon />
          Restart
        </Button>
      </div>
      <LiveTerminal
        ref={term}
        path={`/api/sessions/${encodeURIComponent(sessionId)}/shell/ws`}
        attempt={attempt}
        label="Terminal"
        className="flex-1"
        onState={(s) => {
          if (s !== 'live' && s !== 'elsewhere') ready.current = false;
          if (s === 'connecting') setError(null);
          // The old shell closing is the restart itself, not a lost connection.
          if (s === 'live' || s === 'elsewhere') setRestarting(false);
          setState(s);
        }}
        onMessage={(m) => {
          if (m.type === 'size_owner') {
            ready.current = true;
            flush();
          } else if (m.type === 'sc_error') setError(m.message ?? 'Something went wrong.');
        }}
      />
      <AlertDialog open={confirmRestart} onOpenChange={setConfirmRestart}>
        <AlertDialogContent
          size="sm"
          // Enter restarts, Escape cancels.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            restartButton.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Restart the shell?</AlertDialogTitle>
            <AlertDialogDescription>
              Anything running in it stops, and a fresh shell starts in the same folder.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction ref={restartButton} onClick={() => void restart()}>
              <ArrowCounterClockwiseIcon />
              Restart
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
