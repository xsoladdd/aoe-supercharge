/**
 * A control chat's NEEDS YOU item that is about one of its workers is *relayed* (SPEC §14.5): the
 * worker waits at your door for it, so the control chat does not queue for it too, and it clears by
 * itself once the worker has nothing waiting on you. Anything else on the list is the control chat's
 * own ask. Pure, so the dashboard and the daemon agree.
 */
import { workerLabel, workerName } from './names.ts';
import type { LiveStatus, NeedsYouItem, SessionView, TaskRecord } from './types.ts';

/** A worker a control chat's reply can name: one of its project's tasks, or a session it started. */
export interface RelayWorker {
  /** "Aldric (AS-0018)", or a crew session's name. */
  label: string;
  /** "Aldric": what the office calls it. */
  name: string;
  taskId: string | null;
  /** Its AoE session: a task's, or the crew session itself. Its Needs-you items carry it. */
  sessionId: string;
  /** What names it in a reply: its task id and its AoE session title (any case), its name (as written). */
  ids: string[];
  names: string[];
  titles: string[];
  /** Its session's status; null once its task is done or its session is gone. */
  status: LiveStatus | null;
  /** When something about it last changed: its status, its question answered, its stage. */
  changedAt: string | null;
}

/** A session title this short ("api", "docs") is too common a word to say who an item is about. */
const MIN_TITLE = 6;

const latest = (...at: (string | null | undefined)[]) =>
  at
    .filter((x): x is string => !!x)
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .at(-1) ?? null;

export function taskWorker(task: TaskRecord, session: SessionView | null): RelayWorker {
  const done = task.stage === 'done';
  const name = workerName(task);
  return {
    label: workerLabel(task),
    name,
    taskId: task.id,
    sessionId: task.aoeSessionId,
    ids: [task.id],
    names: name === task.id ? [] : [name],
    titles: session ? [session.title] : [],
    // Done: it has left, and only the time it left says whether that answered the item.
    status: done ? null : (session?.status ?? null),
    changedAt: latest(
      done ? null : session?.statusSince,
      task.openQuestion?.answeredAt,
      task.history.at(-1)?.at,
    ),
  };
}

/** A session the control chat started through AoE, with the name the daemon gave it (`crew`). */
export function crewWorker(session: SessionView, crew: string | null): RelayWorker {
  return {
    label: crew ?? session.title,
    name: crew ?? session.title,
    taskId: null,
    sessionId: session.id,
    ids: [],
    names: crew ? [crew] : [],
    titles: [session.title],
    status: session.status,
    changedAt: session.statusSince,
  };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Built once per word: every recompute matches each item against the whole team. */
const patterns = new Map<string, RegExp>();
/** `s` as a whole word or phrase: no letter or digit right before or after it. */
function whole(s: string, flags = ''): RegExp {
  const key = `${flags}:${s}`;
  let re = patterns.get(key);
  if (!re) {
    if (patterns.size > 5_000) patterns.clear();
    re = new RegExp(`(?<![\\p{L}\\p{N}_])${escape(s)}(?![\\p{L}\\p{N}_])`, `u${flags}`);
    patterns.set(key, re);
  }
  return re;
}

function names(w: RelayWorker, text: string): boolean {
  return (
    w.ids.some((id) => whole(id, 'i').test(text)) ||
    w.names.some((n) => whole(n).test(text)) ||
    w.titles.some((t) => t.trim().length >= MIN_TITLE && whole(t.trim(), 'i').test(text))
  );
}

/**
 * The one worker an item names, by task id, name or AoE session title; `ambiguous` when it names more
 * than one (it stays the control chat's own ask, so nothing is hidden), or null for none.
 */
export function relayTarget(text: string, workers: RelayWorker[]): RelayWorker | 'ambiguous' | null {
  const named = workers.filter((w) => names(w, text));
  if (named.length > 1) return 'ambiguous';
  return named[0] ?? null;
}

export type RelayState = 'open' | 'cleared' | 'own';

/**
 * What an item that names one worker is now, given that worker's open Needs-you items and when the
 * control chat first listed the item (`since`):
 * - `open` while the worker waits on you (an item, or its session waiting inside the debounce);
 * - `cleared` once it has moved on: its session works, or something about it changed since the
 *   item was listed (you answered it, its stage moved, it left);
 * - `own` when it is idle or stopped and nothing changed since: the control chat is telling you about
 *   the worker (a stall, say), not passing on something the worker asked.
 */
export function relayState(since: string, worker: RelayWorker, open: NeedsYouItem[]): RelayState {
  if (open.length || worker.status === 'waiting') return 'open';
  if (worker.status === 'working') return 'cleared';
  if (worker.changedAt && Date.parse(worker.changedAt) > Date.parse(since)) return 'cleared';
  return 'own';
}

/** "Calling for Aldric", "Calling for Aldric and Gareth", "Calling for 3 workers": who a lead is on the phone for. */
export function callingFor(items: Pick<NeedsYouItem, 'relay'>[]): string {
  const who = [...new Set(items.map((i) => i.relay?.name).filter((x): x is string => !!x))];
  if (who.length === 1) return `Calling for ${who[0]}`;
  if (who.length === 2) return `Calling for ${who[0]} and ${who[1]}`;
  return `Calling for ${who.length} workers`;
}

/** An item its worker's own item already shows you: listed, but left out of counts and sounds. */
export const isRelayed = (i: Pick<NeedsYouItem, 'kind'>) => i.kind === 'control_relayed';
