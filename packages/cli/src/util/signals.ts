import { constants } from 'node:os';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** 128 + the signal's number, as a shell reports a process a signal stopped (130 for Ctrl-C). */
export const signalExitCode = (sig: NodeJS.Signals) => 128 + (constants.signals[sig] ?? 0);

/**
 * Turns Ctrl-C, a kill or a closed terminal into an abort while some work runs, so it can roll back
 * instead of stopping half-way. A second signal exits at once, after `onSecond` says what may be left.
 * `dispose` puts Node's own handling back.
 */
export function trapSignals(onSecond?: (sig: NodeJS.Signals) => void): {
  signal: AbortSignal;
  caught: () => NodeJS.Signals | null;
  dispose: () => void;
} {
  const ac = new AbortController();
  let caught: NodeJS.Signals | null = null;
  const handler = (sig: NodeJS.Signals) => {
    if (caught) {
      onSecond?.(sig);
      process.exit(signalExitCode(sig));
    }
    caught = sig;
    ac.abort(new Error(sig));
  };
  for (const s of SIGNALS) process.on(s, handler);
  return {
    signal: ac.signal,
    caught: () => caught,
    dispose: () => {
      for (const s of SIGNALS) process.off(s, handler);
    },
  };
}
