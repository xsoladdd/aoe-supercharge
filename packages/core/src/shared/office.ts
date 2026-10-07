import { STAGE_LABEL, type Stage } from './stages.ts';
import type { NeedsYouItem, NeedsYouKind, SessionView, TaskRecord } from './types.ts';

/**
 * The office view (SPEC §14.5): where a worker stands *is* its status. Everyone who needs you queues
 * at your door, working workers sit at their desk, those with an MR wait in the review lounge, idle
 * ones go to the pantry. Pure, so the dashboard and the CLI agree.
 */

export type Zone = 'door' | 'desk' | 'pantry' | 'review' | 'away' | 'archived' | 'gone';

export const ZONE_LABEL: Record<Zone, string> = {
  door: 'At your door',
  desk: 'At their desk',
  pantry: 'In the pantry',
  review: 'In the review lounge',
  away: 'Away',
  archived: 'Archived',
  gone: 'Gone home',
};

export type Pose =
  'typing' | 'sketching' | 'inspecting' | 'waiting' | 'coffee' | 'reading' | 'away' | 'waving';

/** What a worker holds or shows above its head, so the reason reads at a glance. */
export type Prop =
  | 'speech'
  | 'scroll'
  | 'shield'
  | 'hand'
  /** An MR ready to review (green). */
  | 'folder'
  | 'folder_closed'
  /** An MR waiting: the pipeline running, or review threads open (amber). */
  | 'folder_amber'
  /** An MR whose pipeline failed, or that was closed (red). */
  | 'folder_red'
  | 'warning'
  | 'lost'
  | 'clipboard'
  | 'envelope'
  | 'pipeline'
  | 'pipeline_failed'
  | 'letter'
  | 'mug'
  | null;

export interface OfficeSpot {
  zone: Zone;
  pose: Pose;
  prop: Prop;
  /** One short line on why it is there ("Plan to approve", "Waiting on the pipeline"). */
  reason: string;
  /**
   * Short-lived state: stay where it was last seen, if it was seen. `zone` is where it goes when
   * there is nothing to stay at (first sight). Keeps characters from pacing back and forth.
   */
  hold: boolean;
  /** For a timed hold: when to look again (epoch ms). */
  holdUntil: number | null;
  /** At the door: the most urgent reason it is there, and when it started queueing. */
  kind: NeedsYouKind | null;
  queuedSince: string | null;
}

/** An idle worker finishes up at its desk this long before it heads to the pantry. */
export const PANTRY_DWELL_MS = 15_000;

/** Most urgent first: a worker with several items carries the prop of the first. */
const URGENCY: NeedsYouKind[] = [
  'question',
  'permission',
  'plan_approval',
  'approval',
  'control_waiting',
  'control_blocker',
  'session_error',
  'session_missing',
  'mr_closed',
  'control_needs',
  'mr_ready',
  'control_replied',
];

/** Work is stopped until you act: these stand at the front of the line. */
const BLOCKING = new Set<NeedsYouKind>([
  'question',
  'permission',
  'plan_approval',
  'approval',
  'control_waiting',
  'control_blocker',
  'session_error',
]);

const DOOR: Record<NeedsYouKind, { prop: Exclude<Prop, null>; reason: string }> = {
  question: { prop: 'speech', reason: 'Has a question' },
  permission: { prop: 'shield', reason: 'Needs permission' },
  plan_approval: { prop: 'scroll', reason: 'Plan to approve' },
  approval: { prop: 'hand', reason: 'Waiting in AoE' },
  control_waiting: { prop: 'clipboard', reason: 'Control chat waiting' },
  session_error: { prop: 'warning', reason: 'Session error' },
  session_missing: { prop: 'lost', reason: 'Session missing' },
  mr_closed: { prop: 'folder_closed', reason: 'MR was closed' },
  mr_ready: { prop: 'folder', reason: 'MR ready for review' },
  control_replied: { prop: 'envelope', reason: 'Control chat replied' },
  control_blocker: { prop: 'hand', reason: 'Blocked on you' },
  control_needs: { prop: 'clipboard', reason: 'Needs you' },
};

export const DESK_POSE: Record<Stage, Pose> = {
  planning: 'sketching',
  implementing: 'typing',
  verifying: 'inspecting',
  mr_raised: 'typing',
  watching_mr: 'typing',
  ready_for_review: 'typing',
  blocked: 'typing',
  done: 'typing',
};

/**
 * A reply you have not read yet is a notification, not something waiting on you: it stays out of the
 * line. What the reply lists under NEEDS YOU does bring the lead to the door. An MR ready or closed
 * waits in the review lounge with its folder instead (it still shows in Needs you, and notifies).
 */
const NOT_AT_THE_DOOR = new Set<NeedsYouKind>(['control_replied', 'mr_ready', 'mr_closed']);

/** Stages with an MR out: a worker idle in one of them waits in the review lounge. */
export const REVIEW_STAGES = new Set<Stage>(['mr_raised', 'watching_mr', 'ready_for_review']);

export type Folder = 'green' | 'amber' | 'red';

export const FOLDER_PROP: Record<Folder, Exclude<Prop, null>> = {
  green: 'folder',
  amber: 'folder_amber',
  red: 'folder_red',
};

/**
 * The folder a worker in the review lounge carries: red when the pipeline failed or the MR was
 * closed, green when it is ready for review (or merged), amber while it waits on the pipeline or on
 * open review threads.
 */
export function folderFor(task: Pick<TaskRecord, 'stage' | 'mr'>): { folder: Folder; reason: string } {
  const mr = task.mr;
  if (mr?.state === 'closed') return { folder: 'red', reason: 'MR was closed' };
  if (mr?.pipeline === 'failed' || mr?.pipeline === 'canceled')
    return { folder: 'red', reason: 'Pipeline failed' };
  if (task.stage === 'ready_for_review' || mr?.state === 'merged')
    return { folder: 'green', reason: mr?.state === 'merged' ? 'MR merged' : 'MR ready for review' };
  if (mr?.unresolvedThreads)
    return {
      folder: 'amber',
      reason: `${mr.unresolvedThreads} review ${mr.unresolvedThreads === 1 ? 'thread' : 'threads'} open`,
    };
  if (mr?.pipeline === 'success') return { folder: 'amber', reason: 'Waiting on review' };
  return { folder: 'amber', reason: 'Waiting on the pipeline' };
}

function reviewSpot(task: Pick<TaskRecord, 'stage' | 'mr'>): OfficeSpot {
  const { folder, reason } = folderFor(task);
  return spot('review', 'waiting', FOLDER_PROP[folder], reason);
}

function atDoor(all: NeedsYouItem[]): OfficeSpot | null {
  const items = all.filter((i) => !NOT_AT_THE_DOOR.has(i.kind));
  if (!items.length) return null;
  const kind = URGENCY.find((k) => items.some((i) => i.kind === k)) ?? items[0]!.kind;
  const since = items.map((i) => i.since).sort()[0]!;
  // A control chat's NEEDS YOU list: how much is on it.
  const asks = items.filter((i) => i.kind === 'control_blocker' || i.kind === 'control_needs').length;
  const reason =
    (kind === 'control_blocker' || kind === 'control_needs') && asks > 1
      ? `${DOOR[kind].reason} (${asks} things)`
      : DOOR[kind].reason;
  return {
    zone: 'door',
    pose: 'waiting',
    prop: DOOR[kind].prop,
    reason,
    hold: false,
    holdUntil: null,
    kind,
    queuedSince: since,
  };
}

const spot = (zone: Zone, pose: Pose, prop: Prop, reason: string, hold = false): OfficeSpot => ({
  zone,
  pose,
  prop,
  reason,
  hold,
  holdUntil: null,
  kind: null,
  queuedSince: null,
});

/**
 * Where a worker stands. `items` are this task's Needs-you items; `session` is its AoE session (null
 * when AoE no longer has it). The first rule that matches wins (SPEC §14.5).
 */
export function officeSpot(
  task: Pick<TaskRecord, 'stage' | 'openQuestion' | 'mr'>,
  session: Pick<SessionView, 'status' | 'statusSince' | 'archived'> | null,
  items: NeedsYouItem[],
  now: Date = new Date(),
): OfficeSpot {
  if (task.stage === 'done') return spot('gone', 'waving', null, 'Done');
  const door = atDoor(items);
  if (door) return door;
  if (session?.archived) return spot('away', 'away', null, 'Archived');
  const status = session?.status ?? null;
  if (status === 'working') return spot('desk', DESK_POSE[task.stage], null, STAGE_LABEL[task.stage]);
  // An MR out is a deliverable: it waits in the review lounge, even with its session stopped.
  const review = REVIEW_STAGES.has(task.stage);
  if (status === 'stopped') return review ? reviewSpot(task) : spot('away', 'away', null, 'Stopped');
  if (status === 'idle') {
    const idleFor = session?.statusSince ? now.getTime() - Date.parse(session.statusSince) : Infinity;
    const s = review ? reviewSpot(task) : pantry(task);
    if (idleFor < PANTRY_DWELL_MS)
      return { ...s, hold: true, holdUntil: now.getTime() + PANTRY_DWELL_MS - idleFor };
    return s;
  }
  // Waiting inside the debounce, unknown, missing, or an error with no item yet: stay put.
  return spot('desk', 'waiting', null, status === 'waiting' ? 'Waiting' : 'Checking in', true);
}

/**
 * A worker its control chat started straight through AoE (`aoe add -P`), with no task: placed by its
 * session alone, since it has no stage or merge request.
 */
export function sessionSpot(
  session: Pick<SessionView, 'status' | 'statusSince' | 'archived'>,
  items: NeedsYouItem[],
  now: Date = new Date(),
): OfficeSpot {
  const door = atDoor(items);
  if (door) return door;
  if (session.archived) return spot('away', 'away', null, 'Archived');
  if (session.status === 'working') return spot('desk', 'typing', null, 'Working');
  if (session.status === 'stopped') return spot('away', 'away', null, 'Stopped');
  if (session.status === 'idle') {
    const idleFor = session.statusSince ? now.getTime() - Date.parse(session.statusSince) : Infinity;
    const s = spot('pantry', 'coffee', 'mug', 'Idle');
    if (idleFor < PANTRY_DWELL_MS)
      return { ...s, hold: true, holdUntil: now.getTime() + PANTRY_DWELL_MS - idleFor };
    return s;
  }
  return spot('desk', 'waiting', null, session.status === 'waiting' ? 'Waiting' : 'Checking in', true);
}

function pantry(task: Pick<TaskRecord, 'stage' | 'openQuestion' | 'mr'>): OfficeSpot {
  if (task.stage === 'blocked' && task.openQuestion?.answeredAt)
    return spot('pantry', 'reading', 'letter', 'Reading your reply');
  return spot('pantry', 'coffee', 'mug', 'Idle');
}

/** A project's control chat is the team lead: at the door when it needs you, else at the lead desk. */
export function leadSpot(
  session: Pick<SessionView, 'status' | 'archived'> | null,
  items: NeedsYouItem[],
): OfficeSpot {
  const door = atDoor(items);
  if (door) return door;
  if (!session) return spot('desk', 'waiting', null, 'Checking in', true);
  if (session.archived) return spot('away', 'away', null, 'Archived');
  if (session.status === 'stopped') return spot('away', 'away', null, 'Stopped');
  if (session.status === 'working') return spot('desk', 'typing', null, 'Working');
  return spot('desk', 'reading', null, 'At the lead desk', session.status !== 'idle');
}

/** Whether a spot at the door is there because work is stopped until you act. */
export function blocksWork(spot: OfficeSpot): boolean {
  return !!spot.kind && BLOCKING.has(spot.kind);
}

/**
 * Door queue order: whoever blocks work stands at the front; then who started waiting first; ties go
 * by id.
 */
export function byQueue<T extends { id: string; spot: OfficeSpot }>(a: T, b: T): number {
  return (
    Number(blocksWork(b.spot)) - Number(blocksWork(a.spot)) ||
    (a.spot.queuedSince ?? '').localeCompare(b.spot.queuedSince ?? '') ||
    a.id.localeCompare(b.id)
  );
}

/** "Ericson’s office" on the door, or "Your office" until you set `ui.displayName`. */
export function doorLabel(displayName: string | null | undefined): string {
  const name = displayName?.trim();
  return name ? `${name}’s office` : 'Your office';
}

/** The lowest desk number (from 1) nobody in the project sits at. */
export function pickDesk(taken: Iterable<number>): number {
  const used = new Set(taken);
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/**
 * Desk moves that give every open task in each project its own desk. Older tasks keep theirs; a task
 * with no desk, or one that clashes (a restored worker, two `task new` at once), gets the lowest free
 * one. Done tasks have left, so their desks count as free.
 */
export function deskChanges(
  tasks: Pick<TaskRecord, 'id' | 'project' | 'stage' | 'desk' | 'createdAt'>[],
): { project: string; id: string; desk: number }[] {
  const open = tasks
    .filter((t) => t.stage !== 'done')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const used = new Map<string, Set<number>>();
  const keep = new Set<string>();
  for (const t of open) {
    const u = used.get(t.project) ?? new Set<number>();
    used.set(t.project, u);
    if (t.desk && t.desk > 0 && !u.has(t.desk)) {
      u.add(t.desk);
      keep.add(`${t.project}/${t.id}`);
    }
  }
  const out: { project: string; id: string; desk: number }[] = [];
  for (const t of open) {
    if (keep.has(`${t.project}/${t.id}`)) continue;
    const u = used.get(t.project)!;
    const desk = pickDesk(u);
    u.add(desk);
    out.push({ project: t.project, id: t.id, desk });
  }
  return out;
}
