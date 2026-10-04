import {
  STAGES,
  type ProjectRecord,
  type ProjectStatus,
  type SessionView,
  type Stage,
  type TaskRecord,
} from '@aoe-supercharge/core/shared';

/**
 * The control chat's "status" answer (SPEC §8.3). Same JSON from `supercharge status --project <p> --json`
 * and `GET /api/projects/:p/status`, so the phone gets the same picture as the dashboard.
 */
export function buildProjectStatus(
  project: ProjectRecord,
  tasks: TaskRecord[],
  sessions: SessionView[] | null,
  remoteControl: boolean,
): ProjectStatus {
  const own = tasks.filter((t) => t.project === project.name);
  const byId = new Map((sessions ?? []).map((s) => [s.id, s]));
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  for (const t of own) counts[t.stage]++;
  const control = project.controlSessionId ? byId.get(project.controlSessionId) : undefined;
  return {
    project: project.name,
    control: {
      sessionId: project.controlSessionId,
      status: sessions === null ? 'unknown' : control ? control.status : 'missing',
      remoteControl,
    },
    counts,
    blocked: own
      .filter((t) => t.stage === 'blocked' && t.openQuestion)
      .map((t) => ({
        taskId: t.id,
        title: t.title,
        question: t.openQuestion!.text,
        options: t.openQuestion!.options ?? [],
        since: t.openQuestion!.askedAt,
      }))
      .sort((a, b) => a.since.localeCompare(b.since)),
    readyForReview: own
      .filter((t) => t.stage === 'ready_for_review')
      .map((t) => ({ taskId: t.id, title: t.title, mrUrl: t.mr?.url ?? null })),
    failingPipelines: own
      .filter((t) => t.mr?.pipeline === 'failed' && t.stage !== 'done')
      .map((t) => ({ taskId: t.id, title: t.title, mrUrl: t.mr?.url ?? null })),
    tasks: own.map((t) => {
      const s = byId.get(t.aoeSessionId);
      return {
        id: t.id,
        title: t.title,
        stage: t.stage,
        branch: t.branch,
        aoeStatus: sessions === null ? 'unknown' : s ? s.status : 'missing',
        mr: t.mr
          ? { url: t.mr.url, pipeline: t.mr.pipeline, unresolvedThreads: t.mr.unresolvedThreads }
          : null,
        updatedAt: t.updatedAt,
      };
    }),
    generatedAt: new Date().toISOString(),
  };
}
