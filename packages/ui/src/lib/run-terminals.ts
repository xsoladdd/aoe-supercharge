import type { RunTerminal } from '@aoe-supercharge/core/shared';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { ApiError, getJson, sendJson } from '@/lib/api';

/**
 * The terminals Run in a new terminal opened, for the chats on screen. Each shows under the command it
 * ran, found by its anchor (`<turn id>:<segment key>:<offset>`). One the chat no longer shows (after Start
 * fresh, or further back than the chat loads) is listed at its end instead, so it can still be closed.
 */
let all: RunTerminal[] = [];
/** How many places on the page show each anchor's terminals. */
const placed = new Map<string, number>();
let placedVersion = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const path = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/terminals`;

async function load(sessionId: string) {
  const { terminals } = await getJson<{ terminals: RunTerminal[] }>(path(sessionId));
  all = [...all.filter((t) => t.sessionId !== sessionId), ...terminals];
  emit();
}

/** Open a terminal of its own for a command; it shows under the command, which runs there once it does. */
export async function openRunTerminal(
  sessionId: string,
  command: string,
  anchor: string,
): Promise<RunTerminal> {
  const { terminal } = await sendJson<{ terminal: RunTerminal }>('POST', path(sessionId), {
    command,
    anchor,
  });
  all = [...all, terminal];
  emit();
  return terminal;
}

/** Close a terminal: its shell, and whatever still runs there, stops. */
export async function closeRunTerminal(t: RunTerminal): Promise<void> {
  try {
    await sendJson('DELETE', `${path(t.sessionId)}/${encodeURIComponent(t.id)}`);
  } catch (e) {
    // Already closed (in another tab): let it go here too.
    if (!(e instanceof ApiError && e.status === 404)) throw e;
  }
  all = all.filter((x) => x.id !== t.id);
  emit();
}

/** A session's terminals, loaded when its chat opens. */
export function useRunTerminals(sessionId: string): RunTerminal[] {
  useEffect(() => {
    void load(sessionId).catch(() => {});
  }, [sessionId]);
  const snap = useSyncExternalStore(subscribe, () => all);
  return useMemo(() => snap.filter((t) => t.sessionId === sessionId), [snap, sessionId]);
}

/** The terminals to show at one place in the chat; they count as shown there while it is on the page. */
export function useTerminalsAt(anchor: string | null): RunTerminal[] {
  const snap = useSyncExternalStore(subscribe, () => all);
  const here = useMemo(() => (anchor ? snap.filter((t) => t.anchor === anchor) : []), [snap, anchor]);
  const shown = here.length > 0;
  useEffect(() => {
    if (!anchor || !shown) return;
    placed.set(anchor, (placed.get(anchor) ?? 0) + 1);
    placedVersion++;
    emit();
    return () => {
      const n = (placed.get(anchor) ?? 1) - 1;
      if (n) placed.set(anchor, n);
      else placed.delete(anchor);
      placedVersion++;
      emit();
    };
  }, [anchor, shown]);
  return here;
}

/** A session's terminals that no command in the chat shows. */
export function useUnplacedTerminals(sessionId: string): RunTerminal[] {
  const snap = useSyncExternalStore(subscribe, () => all);
  const version = useSyncExternalStore(subscribe, () => placedVersion);
  return useMemo(
    () => snap.filter((t) => t.sessionId === sessionId && !placed.has(t.anchor)),
    // `version` stands for `placed`, which changes in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snap, sessionId, version],
  );
}
