import {
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
}

export function sessionMap(snap: Snapshot): Map<string, SessionView> {
  return new Map(snap.sessions.map((s) => [s.id, s]));
}

export function projectViews(snap: Snapshot): ProjectView[] {
  const byId = sessionMap(snap);
  return snap.projects.map((project) => {
    const tasks = snap.tasks.filter((t) => t.project === project.name);
    const counts = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
    for (const t of tasks) counts[t.stage]++;
    return {
      project,
      control: project.controlSessionId ? (byId.get(project.controlSessionId) ?? null) : null,
      tasks,
      counts,
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
export function unmanagedGroups(snap: Snapshot): SessionGroup[] {
  const managed = new Set<string>([
    ...snap.projects.map((p) => p.controlSessionId).filter((x): x is string => !!x),
    ...snap.tasks.map((t) => t.aoeSessionId),
  ]);
  const rest = snap.sessions.filter((s) => !managed.has(s.id));
  const ids = new Set(rest.map((s) => s.id));
  const childrenOf = new Map<string, SessionView[]>();
  for (const s of rest) {
    if (s.parentId && ids.has(s.parentId))
      childrenOf.set(s.parentId, [...(childrenOf.get(s.parentId) ?? []), s]);
  }
  const byRecent = (a: SessionView, b: SessionView) =>
    (b.lastAccessedAt ?? '').localeCompare(a.lastAccessedAt ?? '');
  const groups: SessionGroup[] = rest
    .filter((s) => childrenOf.has(s.id))
    .map((parent) => ({ parent, children: (childrenOf.get(parent.id) ?? []).sort(byRecent) }));
  const loose = rest
    .filter((s) => !childrenOf.has(s.id) && !(s.parentId && ids.has(s.parentId)))
    .sort(byRecent);
  if (loose.length) groups.push({ parent: null, children: loose });
  return groups;
}

export function taskSession(snap: Snapshot, task: TaskRecord): SessionView | null {
  return snap.sessions.find((s) => s.id === task.aoeSessionId) ?? null;
}

export function aoeLink(snap: Snapshot): string | null {
  return snap.health.aoe.origin;
}
