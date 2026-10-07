import { workerName } from './names.ts';
import {
  byQueue,
  leadSpot,
  officeSpot,
  pickDesk,
  sessionSpot,
  type OfficeSpot,
  type Zone,
} from './office.ts';
import { outfitFor, type Outfit } from './outfit.ts';
import type { SessionCost } from './office-cost.ts';
import { comesBack, idleCheck, nextIdleDeadline, type IdleCheck, type IdleLimits } from './office-idle.ts';
import type {
  MrState,
  NeedsYouItem,
  OfficeMark,
  OfficeState,
  SessionView,
  Snapshot,
  TaskRecord,
} from './types.ts';

/**
 * The whole floor from a snapshot (SPEC §14.5). Pure: the dashboard draws it, and the daemon logs it
 * to the office history with the same rules.
 */

/** One character in the office: a worker, or a project's control chat as its team lead. */
export interface OfficeWorker {
  /**
   * Unique across projects: `<project>/<task id>`, `<project>/lead`, or `<project>/s/<session id>` for a
   * worker the control chat started without a task.
   */
  key: string;
  role: 'worker' | 'lead';
  project: string;
  /** The task id ("NW-0007"); null for a lead, and for a worker with no task. */
  id: string | null;
  name: string;
  title: string;
  task: TaskRecord | null;
  session: SessionView | null;
  /** Its MR: the task's, or for a worker with no task the one found for its branch (SPEC §11.4). */
  mr: MrState | null;
  desk: number | null;
  outfit: Outfit;
  spot: OfficeSpot;
  /** Where it stands after holds are applied (see `OfficeSpot.hold`). */
  zone: Zone;
  /** When it got to where it is, for "12m" labels. */
  since: string | null;
  href: string;
  /** The Needs-you items that put it at your door. */
  items: NeedsYouItem[];
  /** Tokens and estimated cost of its live conversation, when known (SPEC §14.5). */
  cost: SessionCost | null;
  /** Its office mark (archived, kept, snoozed), if it has one. */
  mark: OfficeMark | null;
  /** The idle timeout: whether to ask it to go home. */
  idle: IdleCheck;
}

export interface OfficeTeam {
  project: string;
  lead: OfficeWorker | null;
  /** Workers at their desks, by desk number. */
  seated: OfficeWorker[];
  /** Every open worker's desk, seated or not: the size of the team's desk cluster. */
  desks: number;
}

export interface OfficeModel {
  door: OfficeWorker[];
  teams: OfficeTeam[];
  pantry: OfficeWorker[];
  /** Workers with an MR out, idle in the review lounge, by project then desk. */
  review: OfficeWorker[];
  away: OfficeWorker[];
  /** Sent home from the office (office-only): off the floor, listed apart with Restore. */
  archived: OfficeWorker[];
  everyone: OfficeWorker[];
}

export type OfficeInput = Pick<Snapshot, 'sessions' | 'projects' | 'tasks' | 'needsYou'> & {
  costs?: Snapshot['costs'];
  sessionMrs?: Snapshot['sessionMrs'];
  office?: Pick<OfficeState, 'marks' | 'idle'>;
};

/** `office.idle`'s defaults, for a build without the config. */
export const DEFAULT_IDLE: IdleLimits = { promptMinutes: 30, autoArchiveMinutes: 0 };

/**
 * Where each character was last seen. A hold (see `OfficeSpot.hold`) keeps it there; the caller owns
 * the map so it survives between builds (the dashboard across visits, the daemon across changes).
 */
export type HoldMemory = Map<string, Zone>;

export const chatPath = (sessionId: string) => `/chat/${encodeURIComponent(sessionId)}`;
export const taskPath = (project: string, id: string) =>
  `/p/${encodeURIComponent(project)}/t/${encodeURIComponent(id)}`;

function itemsByOwner(items: NeedsYouItem[]) {
  const byTask = new Map<string, NeedsYouItem[]>();
  const bySession = new Map<string, NeedsYouItem[]>();
  for (const i of items) {
    if (i.project && i.taskId) {
      const k = `${i.project}/${i.taskId}`;
      byTask.set(k, [...(byTask.get(k) ?? []), i]);
    } else if (i.sessionId) bySession.set(i.sessionId, [...(bySession.get(i.sessionId) ?? []), i]);
  }
  return { byTask, bySession };
}

/** Sessions a control chat started straight through AoE: not a task's, not archived. */
export function spawnedSessions(input: OfficeInput, controlSessionId: string | null): SessionView[] {
  if (!controlSessionId) return [];
  const managed = new Set<string>([
    ...input.projects.map((p) => p.controlSessionId).filter((x): x is string => !!x),
    ...input.tasks.map((t) => t.aoeSessionId),
  ]);
  return input.sessions.filter((s) => s.parentId === controlSessionId && !managed.has(s.id) && !s.archived);
}

export function buildOffice(input: OfficeInput, now: Date, holds: HoldMemory = new Map()): OfficeModel {
  const marks = input.office?.marks ?? {};
  const limits = input.office?.idle ?? DEFAULT_IDLE;
  const resolve = (key: string, spot: OfficeSpot, session: SessionView | null): Zone => {
    // Archived stays off the floor until its session works again or it needs you.
    const archived = !!marks[key]?.archivedAt && spot.zone !== 'gone' && !comesBack({ spot, session });
    const zone = archived ? 'archived' : spot.hold ? (holds.get(key) ?? spot.zone) : spot.zone;
    holds.set(key, zone);
    return zone;
  };
  const sessions = new Map(input.sessions.map((s) => [s.id, s]));
  const { byTask, bySession } = itemsByOwner(input.needsYou);
  const costOf = (id: string | null | undefined) => (id && input.costs?.[id]) || null;
  const everyone: OfficeWorker[] = [];
  const teams: OfficeTeam[] = [];

  for (const project of input.projects) {
    const name = project.name;
    let lead: OfficeWorker | null = null;
    if (project.controlSessionId) {
      const session = sessions.get(project.controlSessionId) ?? null;
      const items = bySession.get(project.controlSessionId) ?? [];
      const spot = leadSpot(session, items);
      const key = `${name}/lead`;
      lead = {
        key,
        role: 'lead',
        project: name,
        id: null,
        name: 'Control chat',
        title: 'Team lead',
        task: null,
        session,
        mr: null,
        desk: null,
        outfit: outfitFor('lead', name),
        spot,
        zone: resolve(key, spot, session),
        since: spot.queuedSince ?? session?.statusSince ?? null,
        href: chatPath(project.controlSessionId),
        items,
        cost: costOf(project.controlSessionId),
        mark: marks[key] ?? null,
        idle: idleCheck({ role: 'lead', spot, session }, marks[key], limits, now),
      };
      everyone.push(lead);
    }
    const tasks = input.tasks.filter((t) => t.project === name && t.stage !== 'done');
    for (const task of tasks) {
      const session = sessions.get(task.aoeSessionId) ?? null;
      const key = `${name}/${task.id}`;
      const items = byTask.get(key) ?? [];
      const spot = officeSpot(task, session, items, now);
      everyone.push({
        key,
        role: 'worker',
        project: name,
        id: task.id,
        name: workerName(task),
        title: task.title,
        task,
        session,
        mr: task.mr,
        desk: task.desk ?? null,
        outfit: outfitFor(task.id, name),
        spot,
        zone: resolve(key, spot, session),
        since: spot.queuedSince ?? session?.statusSince ?? null,
        href: taskPath(name, task.id),
        items,
        cost: costOf(task.aoeSessionId),
        mark: marks[key] ?? null,
        idle: idleCheck({ role: 'worker', spot, session }, marks[key], limits, now),
      });
    }
    // Workers the control chat started straight through AoE: no task, so they take the free desks after
    // the tasks', oldest first, and go where their session says.
    const taken = new Set(tasks.map((t) => t.desk).filter((d): d is number => typeof d === 'number'));
    const spawned = spawnedSessions(input, project.controlSessionId).sort(
      (a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id),
    );
    for (const session of spawned) {
      const key = `${name}/s/${session.id}`;
      const crew = project.crew?.[session.id];
      const items = bySession.get(session.id) ?? [];
      const mr = input.sessionMrs?.[session.id] ?? null;
      const spot = sessionSpot(session, items, now, mr);
      const desk = pickDesk(taken);
      taken.add(desk);
      everyone.push({
        key,
        role: 'worker',
        project: name,
        id: null,
        // Named like a task's worker; until the daemon has named it, its AoE title.
        name: crew ?? session.title,
        title: crew ? session.title : (session.branch ?? 'Started by the control chat'),
        task: null,
        session,
        mr,
        desk,
        outfit: outfitFor(session.id, name),
        spot,
        zone: resolve(key, spot, session),
        since: spot.queuedSince ?? session.statusSince ?? null,
        href: chatPath(session.id),
        items,
        cost: costOf(session.id),
        mark: marks[key] ?? null,
        idle: idleCheck({ role: 'worker', spot, session }, marks[key], limits, now),
      });
    }
    const mine = everyone.filter((w) => w.project === name && w.role === 'worker');
    teams.push({
      project: name,
      lead,
      seated: mine.filter((w) => w.zone === 'desk').sort((a, b) => (a.desk ?? 0) - (b.desk ?? 0)),
      desks: Math.max(0, ...mine.map((w) => w.desk ?? 0)),
    });
  }

  return {
    door: everyone
      .filter((w) => w.zone === 'door')
      .sort((a, b) => byQueue({ ...a, id: a.key }, { ...b, id: b.key })),
    teams,
    pantry: everyone.filter((w) => w.zone === 'pantry'),
    review: everyone.filter((w) => w.zone === 'review'),
    away: everyone.filter((w) => w.zone === 'away'),
    archived: everyone.filter((w) => w.zone === 'archived'),
    everyone,
  };
}

/** Everyone flagged as a runaway (SPEC §14.5): they need your attention. */
export function runaways(model: OfficeModel): OfficeWorker[] {
  return model.everyone.filter((w) => w.cost?.runaway.length);
}

/** Who to ask to go home: idle in the pantry past `office.idle.promptMinutes`, not kept or snoozed. */
export function goingHome(model: OfficeModel): OfficeWorker[] {
  return model.everyone.filter((w) => w.zone === 'pantry' && w.idle.prompt);
}

/** The soonest a hold runs out (epoch ms after `now`), or null when nobody is holding. */
export function nextHoldEnd(model: OfficeModel, now: number): number | null {
  const ends = model.everyone.map((w) => w.spot.holdUntil ?? Infinity).filter((t) => t > now);
  const next = Math.min(...ends);
  return Number.isFinite(next) ? next : null;
}

/**
 * When the floor should be built again with nothing else changing: a hold runs out, or an idle worker is
 * due its "go home" prompt or its auto-archive. Epoch ms, or null.
 */
export function nextOfficeLook(model: OfficeModel, office: OfficeInput['office'], now: Date): number | null {
  const ends = [
    nextHoldEnd(model, now.getTime()),
    nextIdleDeadline(model.everyone, office?.marks ?? {}, office?.idle ?? DEFAULT_IDLE, now),
  ].filter((t): t is number => t !== null);
  return ends.length ? Math.min(...ends) : null;
}
