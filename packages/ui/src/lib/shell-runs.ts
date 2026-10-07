import { useSyncExternalStore } from 'react';

/**
 * Commands waiting to run in a session's shell (the control panel's Shell tab). A Run button queues one
 * here; the chat opens the panel, the panel shows the Shell tab, and the shell sends it once it is
 * connected.
 */
const queues = new Map<string, string[]>();
const listeners = new Set<() => void>();
let version = 0;

export function requestShellRun(sessionId: string, command: string) {
  queues.set(sessionId, [...(queues.get(sessionId) ?? []), command]);
  version++;
  for (const l of listeners) l();
}

export function hasShellRuns(sessionId: string): boolean {
  return (queues.get(sessionId)?.length ?? 0) > 0;
}

/** The waiting commands, which are now the caller's to send. */
export function takeShellRuns(sessionId: string): string[] {
  const q = queues.get(sessionId) ?? [];
  queues.delete(sessionId);
  return q;
}

/** Changes whenever a command is queued, so components can look again. */
export function useShellRunVersion(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}
