import {
  EMPTY_GENERAL,
  generalSessionIds,
  STAGES,
  type ProjectRecord,
  type SessionView,
  type Snapshot,
  type Stage,
  type TaskRecord,
} from '@aoe-supercharge/core/shared';

export interface ProjectView {
  project: ProjectRecord;
  control: SessionView | null;
  tasks: TaskRecord[];
  counts: Record<Stage, number>;
  /**
   * Sessions the control chat started straight through AoE (`aoe add -P <control>`) rather than as
   * tasks: no stage or worker card, but they are this project's, so they are listed with it.
   */
  spawned: SessionView[];
}

export function sessionMap(snap: Snapshot): Map<string, SessionView> {
  return new Map(snap.sessions.map((s) => [s.id, s]));
}

export function projectViews(snap: Snapshot): ProjectView[] {
  const byId = sessionMap(snap);
  const managed = managedIds(snap);
  return snap.projects.map((project) => {
    const tasks = snap.tasks.filter((t) => t.project === project.name);
    const counts = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
    for (const t of tasks) counts[t.stage]++;
    const spawned = spawnedBy(snap, project.controlSessionId, managed).sort(byRecent);
    return {
      project,
      control: project.controlSessionId ? (byId.get(project.controlSessionId) ?? null) : null,
      tasks,
      counts,
      spawned,
    };
  });
}

export interface SessionGroup {
  parent: SessionView | null;
  children: SessionView[];
}

/**
 * AoE sessions Supercharge doesn't manage, grouped parent → children. This is the Phase 1 read-only
 * view, and it makes pre-existing AoE control/worker setups visible straight away.
 */
function managedIds(snap: Snapshot): Set<string> {
  return new Set<string>([
    ...snap.projects.map((p) => p.controlSessionId).filter((x): x is string => !!x),
    ...snap.tasks.map((t) => t.aoeSessionId),
  ]);
}

/** Pinned first, keeping the order otherwise (Array.prototype.sort is stable). */
export function pinnedFirst<T>(items: T[], pinned: (item: T) => boolean): T[] {
  return [...items].sort((a, b) => Number(pinned(b)) - Number(pinned(a)));
}

/** Sessions a control chat started straight through AoE (`aoe add -P <control>`), not as tasks. */
export function spawnedBy(
  snap: Snapshot,
  controlSessionId: string | null,
  managed: Set<string> = managedIds(snap),
): SessionView[] {
  if (!controlSessionId) return [];
  return snap.sessions.filter((s) => s.parentId === controlSessionId && !managed.has(s.id) && !s.archived);
}

/** Pinned first, then most recently used. */
const byRecent = (a: SessionView, b: SessionView) =>
  Number(b.pinned) - Number(a.pinned) || (b.lastAccessedAt ?? '').localeCompare(a.lastAccessedAt ?? '');

export interface GeneralView {
  controlId: string | null;
  /** Null when there is none yet, or it is gone from AoE. */
  control: SessionView | null;
  /** General chats and workers, not archived: pinned first, then most recently used. */
  sessions: SessionView[];
}

/** Chats with no project (SPEC §14.7): the General control chat, and General chats and workers. */
export function generalView(snap: Snapshot): GeneralView {
  const general = snap.general ?? EMPTY_GENERAL;
  const ids = generalSessionIds(general, snap.sessions);
  const control = snap.sessions.find((s) => s.id === general.controlSessionId) ?? null;
  return {
    controlId: general.controlSessionId,
    control,
    sessions: snap.sessions.filter((s) => ids.has(s.id) && !s.archived).sort(byRecent),
  };
}

/** The General control chat and every General chat and worker. */
function generalIds(snap: Snapshot): Set<string> {
  const general = snap.general ?? EMPTY_GENERAL;
  const ids = generalSessionIds(general, snap.sessions);
  if (general.controlSessionId) ids.add(general.controlSessionId);
  return ids;
}

export function unmanagedGroups(snap: Snapshot): SessionGroup[] {
  // General sessions are listed in their own section; archived ones stay with archivedUnmanaged.
  const managed = new Set([...managedIds(snap), ...generalIds(snap)]);
  // Sessions a control chat started are listed with its project (ProjectView.spawned).
  const controls = new Set(snap.projects.map((p) => p.controlSessionId).filter((x): x is string => !!x));
  const rest = snap.sessions.filter(
    (s) => !managed.has(s.id) && !s.archived && !(s.parentId && controls.has(s.parentId)),
  );
  const ids = new Set(rest.map((s) => s.id));
  const childrenOf = new Map<string, SessionView[]>();
  for (const s of rest) {
    if (s.parentId && ids.has(s.parentId))
      childrenOf.set(s.parentId, [...(childrenOf.get(s.parentId) ?? []), s]);
  }
  const groups: SessionGroup[] = rest
    .filter((s) => childrenOf.has(s.id))
    .map((parent) => ({ parent, children: (childrenOf.get(parent.id) ?? []).sort(byRecent) }));
  const loose = rest
    .filter((s) => !childrenOf.has(s.id) && !(s.parentId && ids.has(s.parentId)))
    .sort(byRecent);
  if (loose.length) groups.push({ parent: null, children: loose });
  return groups;
}

/** Archived AoE sessions Supercharge doesn't manage, most recent first. */
export function archivedUnmanaged(snap: Snapshot): SessionView[] {
  const managed = managedIds(snap);
  return snap.sessions
    .filter((s) => s.archived && !managed.has(s.id))
    .sort((a, b) => (b.lastAccessedAt ?? '').localeCompare(a.lastAccessedAt ?? ''));
}

export function taskSession(snap: Snapshot, task: TaskRecord): SessionView | null {
  return snap.sessions.find((s) => s.id === task.aoeSessionId) ?? null;
}

export function aoeLink(snap: Snapshot): string | null {
  return snap.health.aoe.origin;
}
