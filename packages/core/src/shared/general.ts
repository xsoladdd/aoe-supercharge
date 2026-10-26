import type { GeneralRecord, SessionView } from './types.ts';

/** The key General work uses where a project's name would go (watch log, worker names); no project slug starts with `_`. */
export const GENERAL_KEY = '_general';

export const EMPTY_GENERAL: GeneralRecord = { schema: 1, controlSessionId: null, sessions: {} };

/**
 * General chats and workers (the control chat left out): the ones Supercharge recorded, and any session
 * the General control chat started, straight through AoE included.
 */
export function generalSessionIds(
  general: GeneralRecord,
  sessions: readonly Pick<SessionView, 'id' | 'parentId'>[],
): Set<string> {
  const ids = new Set(Object.keys(general.sessions));
  if (general.controlSessionId)
    for (const s of sessions) if (s.parentId === general.controlSessionId) ids.add(s.id);
  ids.delete(general.controlSessionId ?? '');
  return ids;
}

/**
 * General chats and workers that count against `maxWorkers`: only while busy (working or waiting on
 * you) or while their first message is still held, since they have no stage to say they are done. An
 * idle one, say a chat kept for a nightly job, leaves its place free.
 */
export function countBusyGeneral(
  ids: Iterable<string>,
  sessionStatus: (sessionId: string) => string | null,
  firstMessageHeld: (sessionId: string) => boolean = () => false,
): number {
  let n = 0;
  for (const id of ids) {
    const s = sessionStatus(id);
    if (s === 'working' || s === 'waiting' || (s !== null && s !== 'stopped' && firstMessageHeld(id))) n++;
  }
  return n;
}
