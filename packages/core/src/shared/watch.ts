/**
 * Worker watch: a line typed into a project's control chat when one of its workers needs attention
 * (a question, done, a permission prompt, an error, or idle too long). The daemon writes these, and so
 * did `control-watch.sh` before it, in the same shape:
 *
 *   [WATCH] worker="fix-1989-ci" status=error kind=error log=/path/to/capture.txt
 *
 * `worker` is the AoE title (what `aoe` commands take); the daemon adds name, project, task, stage,
 * session, at and detail after the first four. The dashboard shows each line as a notice, not as
 * something you typed.
 */
import { spawnedSessions, type OfficeInput } from './office-model.ts';
import { workerName } from './names.ts';
import type { Stage } from './stages.ts';
import type { NeedsYouItem, ProjectRecord, SessionView, TaskRecord } from './types.ts';

export const WATCH_KINDS = ['question', 'done', 'permission', 'error', 'stalled'] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];

export interface WatchNotice {
  /** The worker's AoE session title. */
  worker: string;
  /** One of WATCH_KINDS from Supercharge; whatever another watcher wrote otherwise. */
  kind: string;
  /** The session's status in AoE's words: running, waiting, idle, error, stopped. */
  status: string | null;
  /** A capture of the worker's pane when it fired, for the control chat to read. */
  log: string | null;
  /** The worker's office name (a task's or the crew's). */
  name: string | null;
  project: string | null;
  task: string | null;
  stage: string | null;
  session: string | null;
  at: string | null;
  detail: string | null;
}

const PREFIX = /^\s*\[WATCH\]\s*/;
const KEYS = [
  'worker',
  'status',
  'kind',
  'log',
  'name',
  'project',
  'task',
  'stage',
  'session',
  'at',
  'detail',
] as const;
type Key = (typeof KEYS)[number];
const MAX_DETAIL = 200;

/** One `[WATCH] key=value …` line as a notice; null for anything else (it needs at least a worker). */
export function parseWatchLine(line: string): WatchNotice | null {
  const head = PREFIX.exec(line);
  if (!head) return null;
  const fields: Partial<Record<string, string>> = {};
  const rest = line.slice(head[0].length);
  const pair = /([A-Za-z_][\w-]*)=(?:"((?:[^"\\]|\\.)*)"|(\S*))\s*/y;
  let i = 0;
  while (i < rest.length) {
    pair.lastIndex = i;
    const m = pair.exec(rest);
    if (!m) {
      // Not key=value: skip the word, so one odd token doesn't lose the rest.
      const next = rest.slice(i).search(/\s+\S/);
      if (next < 0) break;
      i += next + rest.slice(i + next).search(/\S/);
      continue;
    }
    fields[m[1]!] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3]!;
    i = pair.lastIndex;
  }
  if (!fields.worker) return null;
  const get = (k: Key) => (fields[k] ? fields[k] : null);
  return {
    worker: fields.worker,
    kind: fields.kind || 'notice',
    status: get('status'),
    log: get('log'),
    name: get('name'),
    project: get('project'),
    task: get('task'),
    stage: get('stage'),
    session: get('session'),
    at: get('at'),
    detail: get('detail'),
  };
}

function quote(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The line for a notice: worker, status, kind and log first, as control-watch.sh wrote them. */
export function formatWatchNotice(n: WatchNotice): string {
  const parts = ['[WATCH]'];
  for (const k of KEYS) {
    let v = n[k];
    if (v === null || v === undefined || v === '') continue;
    if (k === 'detail') {
      v = v.replace(/\s+/g, ' ').trim();
      if (v.length > MAX_DETAIL) v = `${v.slice(0, MAX_DETAIL - 1)}…`;
    }
    const bare = k !== 'worker' && k !== 'name' && k !== 'detail' && /^[^\s"\\]+$/.test(v);
    parts.push(`${k}=${bare ? v : quote(v)}`);
  }
  return parts.join(' ');
}

/** A typed turn split into its notice lines and whatever else was typed with them. */
export function splitWatchNotices(text: string): { notices: WatchNotice[]; rest: string } {
  if (!text.includes('[WATCH]')) return { notices: [], rest: text };
  const notices: WatchNotice[] = [];
  const rest: string[] = [];
  for (const line of text.split('\n')) {
    const n = parseWatchLine(line);
    if (n) notices.push(n);
    else rest.push(line);
  }
  return { notices, rest: rest.join('\n').trim() };
}

/** A worker a project's control chat is told about: one of its tasks, or its crew. */
export interface WatchWorker {
  sessionId: string;
  /** The AoE title. */
  title: string;
  /** The office name. */
  name: string;
  task: TaskRecord | null;
  session: SessionView | null;
}

/**
 * The workers to watch for a project: its tasks that are not done, and the sessions its control chat
 * started straight through AoE. The control chat itself and archived sessions are left out.
 */
export function watchWorkers(input: OfficeInput, project: ProjectRecord): WatchWorker[] {
  if (!project.controlSessionId) return [];
  const sessions = new Map(input.sessions.map((s) => [s.id, s]));
  const out: WatchWorker[] = [];
  for (const t of input.tasks) {
    if (t.project !== project.name || t.stage === 'done' || t.aoeSessionId === project.controlSessionId)
      continue;
    const session = sessions.get(t.aoeSessionId) ?? null;
    if (session?.archived) continue;
    out.push({
      sessionId: t.aoeSessionId,
      title: session?.title ?? t.title,
      name: workerName(t),
      task: t,
      session,
    });
  }
  for (const s of spawnedSessions(input, project.controlSessionId))
    out.push({
      sessionId: s.id,
      title: s.title,
      name: project.crew?.[s.id] ?? s.title,
      task: null,
      session: s,
    });
  return out;
}

/** `QUESTION:` or `DONE:` in a plain worker's latest reply, the convention control-watch.sh read. */
export interface WatchMarker {
  kind: 'question' | 'done';
  /** The reply's message id: one notice per reply. */
  id: string;
  text: string;
}

const MARKER = /^\s*(?:[>*_-]\s*)*(?:\*\*|__)?(QUESTION|DONE)(?:\*\*|__)?:(?:\*\*|__)?\s*(.*)$/;

/** The last QUESTION: or DONE: line of a reply, with what it says (up to three lines). */
export function markerOf(text: string): Omit<WatchMarker, 'id'> | null {
  const lines = text.replace(/\r/g, '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = MARKER.exec(lines[i]!);
    if (!m) continue;
    const said = [m[2]!, ...lines.slice(i + 1, i + 4)]
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ');
    return { kind: m[1] === 'QUESTION' ? 'question' : 'done', text: said.slice(0, MAX_DETAIL) };
  }
  return null;
}

export interface WatchEvent {
  /** One per occurrence: a notice is sent once per key. */
  key: string;
  /**
   * The condition that keeps the key remembered: when it no longer holds, the key is forgotten, so the
   * next occurrence is told again. null keeps it until it ages out.
   */
  hold: string | null;
  kind: WatchKind;
  project: string;
  sessionId: string;
  taskId: string | null;
  worker: string;
  name: string;
  status: string | null;
  stage: Stage | null;
  detail: string | null;
}

/** Stages where an idle worker is expected to be working, so idling there long is a stall. */
const WORKING_STAGES: readonly Stage[] = ['planning', 'implementing', 'verifying'];

/**
 * How many background shells or tasks a Claude Code pane's footer says are running ("auto mode on · 2
 * shells · ← for agents"), 0 when none. Only the footer under the last prompt line counts: the turn
 * summary above it ("2 shells still running") goes stale.
 */
export function backgroundShells(pane: string): number {
  const lines = pane.replace(/\r/g, '').split('\n');
  let from = 0;
  for (let i = lines.length - 1; i >= 0; i--)
    if (/^\s*❯/.test(lines[i]!)) {
      from = i + 1;
      break;
    }
  for (const line of lines.slice(from)) {
    const m = /\b(\d+) (?:shells?|background tasks?)\b(?! still)/i.exec(line);
    if (m) return Number(m[1]);
  }
  return 0;
}

/** Whether a worker has been idle long enough, by AoE's clock, to be called stalled (given no marker). */
function stallIdleMs(w: WatchWorker, now: Date, stallMinutes: number, busyAt?: string): number | null {
  const s = w.session;
  if (s?.status !== 'idle' || (w.task && !WORKING_STAGES.includes(w.task.stage))) return null;
  const since = s.statusSince ? Date.parse(s.statusSince) : NaN;
  // Background shells running count as work: the idle clock starts when they were last seen.
  const from = Math.max(since, busyAt ? Date.parse(busyAt) : NaN);
  const idleMs = now.getTime() - (Number.isFinite(from) ? from : since);
  return Number.isFinite(idleMs) && idleMs >= stallMinutes * 60_000 ? idleMs : null;
}

/**
 * Workers idle long enough to be stalled and not yet told so (`told` says whether a key was): the ones
 * whose pane is worth reading for background shells before calling it a stall.
 */
export function stallCandidates(
  workers: WatchWorker[],
  now: Date,
  stallMinutes: number,
  told: (key: string) => boolean,
): WatchWorker[] {
  return workers.filter((w) => !told(`stalled:${w.sessionId}`) && stallIdleMs(w, now, stallMinutes) !== null);
}

/** AoE's word for a session status, as control-watch.sh reported it. */
function aoeStatus(s: SessionView | null): string | null {
  if (!s) return null;
  return s.status === 'working' ? 'running' : s.status;
}

/**
 * What each worker's status holds right now, for forgetting keys: `idle:<sid>`, `waiting:<sid>`,
 * `error:<sid>`, `blocked:<task>`, `ready:<task>`. A session whose status AoE doesn't know holds
 * everything it held, so a hiccup doesn't make it tell you again.
 */
export function watchHolds(workers: WatchWorker[]): { holds: Set<string>; unsure: Set<string> } {
  const holds = new Set<string>();
  const unsure = new Set<string>();
  for (const w of workers) {
    const st = w.session?.status;
    if (st === 'idle' || st === 'waiting' || st === 'error') holds.add(`${st}:${w.sessionId}`);
    if (st === 'unknown') unsure.add(w.sessionId);
    if (w.task?.stage === 'blocked') holds.add(`blocked:${w.task.id}`);
    if (w.task?.stage === 'ready_for_review') holds.add(`ready:${w.task.id}`);
  }
  return { holds, unsure };
}

export interface WatchEventsInput {
  project: string;
  workers: WatchWorker[];
  needsYou: NeedsYouItem[];
  /** Plain workers' latest replies with a marker, by session id (read while idle or waiting). */
  markers: Record<string, WatchMarker | null | undefined>;
  now: Date;
  stallMinutes: number;
  /** When each session was last seen with background shells running; the stall clock starts then. */
  busy?: Record<string, string>;
}

/**
 * Everything about a project's workers its control chat should hear about right now. It reuses what
 * Needs you already worked out (questions, ready for review, prompts after their debounce, errors) and
 * adds the plain workers' markers and stalls.
 */
export function watchEvents(input: WatchEventsInput): WatchEvent[] {
  const events: WatchEvent[] = [];
  for (const w of input.workers) {
    const base = {
      project: input.project,
      sessionId: w.sessionId,
      taskId: w.task?.id ?? null,
      worker: w.title,
      name: w.name,
      status: aoeStatus(w.session),
      stage: w.task?.stage ?? null,
    };
    const items = input.needsYou.filter(
      (i) => i.sessionId === w.sessionId || (w.task !== null && i.taskId === w.task.id),
    );
    for (const i of items) {
      const sid = w.sessionId;
      switch (i.kind) {
        case 'question':
          events.push(
            i.taskId && i.id.startsWith('question:')
              ? {
                  ...base,
                  key: `question:${i.taskId}:${i.since}`,
                  hold: `blocked:${i.taskId}`,
                  kind: 'question',
                  detail: i.detail,
                }
              : { ...base, key: `ask:${sid}`, hold: `waiting:${sid}`, kind: 'question', detail: i.detail },
          );
          break;
        case 'permission':
        case 'plan_approval':
        case 'approval':
          events.push({
            ...base,
            key: `${i.kind}:${sid}`,
            hold: `waiting:${sid}`,
            kind: 'permission',
            detail: i.detail,
          });
          break;
        case 'session_error':
          events.push({
            ...base,
            key: `error:${sid}`,
            hold: `error:${sid}`,
            kind: 'error',
            detail: i.detail,
          });
          break;
        case 'mr_ready':
          if (i.taskId)
            events.push({
              ...base,
              key: `done:${i.taskId}`,
              hold: `ready:${i.taskId}`,
              kind: 'done',
              detail: i.detail,
            });
          break;
      }
    }
    const marker = w.task ? null : input.markers[w.sessionId];
    if (marker)
      events.push({
        ...base,
        key: `marker:${w.sessionId}:${marker.id}`,
        hold: null,
        kind: marker.kind,
        detail: marker.text,
      });
    const idleMs = marker ? null : stallIdleMs(w, input.now, input.stallMinutes, input.busy?.[w.sessionId]);
    if (idleMs !== null)
      events.push({
        ...base,
        key: `stalled:${w.sessionId}`,
        hold: `idle:${w.sessionId}`,
        kind: 'stalled',
        detail: `Idle for ${Math.floor(idleMs / 60_000)} min`,
      });
  }
  return events;
}

/** What the watch remembers between polls (and restarts): the keys it told, and what keeps each. */
export interface WatchBook {
  seen: Record<string, { at: string; hold: string | null; sessionId: string }>;
  /** When each project's watch started; a project without one has its current state taken as told. */
  started: Record<string, string>;
}

/** How long a key with nothing holding it is remembered. */
export const WATCH_KEEP_DAYS = 30;

/**
 * One poll for a project: the events to tell (those not told before), and the book after it. Keys whose
 * condition no longer holds are forgotten. On a project's first poll everything is taken as told, so
 * starting the watch doesn't repeat what is already waiting.
 */
export function watchStep(
  book: WatchBook,
  project: string,
  workers: WatchWorker[],
  events: WatchEvent[],
  now: Date,
): { fresh: WatchEvent[]; book: WatchBook } {
  const at = now.toISOString();
  const mine = new Set(workers.map((w) => w.sessionId));
  const { holds, unsure } = watchHolds(workers);
  const seen = { ...book.seen };
  const cutoff = now.getTime() - WATCH_KEEP_DAYS * 86_400_000;
  for (const [key, s] of Object.entries(seen)) {
    if (!mine.has(s.sessionId)) {
      // Another project's, or a worker that is gone: kept until it ages out.
      if (Date.parse(s.at) < cutoff) delete seen[key];
      continue;
    }
    if (unsure.has(s.sessionId)) continue;
    if (s.hold ? !holds.has(s.hold) : Date.parse(s.at) < cutoff) delete seen[key];
  }
  const arming = !book.started[project];
  const fresh: WatchEvent[] = [];
  for (const e of events) {
    if (seen[e.key]) continue;
    seen[e.key] = { at, hold: e.hold, sessionId: e.sessionId };
    if (!arming) fresh.push(e);
  }
  return { fresh, book: { seen, started: arming ? { ...book.started, [project]: at } : book.started } };
}

/** One thing the watch told (or is about to tell) a project's control chat, for its Watch log. */
export interface WatchLogEntry {
  /** The event's key and when it fired. */
  id: string;
  at: string;
  kind: WatchKind;
  project: string;
  sessionId: string;
  taskId: string | null;
  worker: string;
  name: string;
  status: string | null;
  stage: string | null;
  detail: string | null;
  /** The pane capture's file name in the watch's logs folder; null when it couldn't be read. */
  capture: string | null;
  /** The line typed into the control chat. */
  line: string;
  /** pending: waiting for the control chat to be free · sent · dropped: the watch was turned off first. */
  state: 'pending' | 'sent' | 'dropped';
  sentAt: string | null;
}

/** A project's watch at a glance: the dashboard's Watch tab and status line. */
export interface WatchSummary {
  enabled: boolean;
  stallMinutes: number;
  /** Workers watched right now. */
  watching: number;
  /** Notices waiting for the control chat to be free. */
  pending: number;
  /** When the last notice fired. */
  lastAt: string | null;
  /** Why notices can't reach the control chat now (it is archived, or gone); null when they can. */
  held: string | null;
}

export interface WatchResponse extends WatchSummary {
  project: string;
  /** Newest first. */
  entries: WatchLogEntry[];
}
