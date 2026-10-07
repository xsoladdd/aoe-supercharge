import { fnv1a } from './hash.ts';
import { workerLabel } from './names.ts';
import type { SessionPrompt } from './prompt.ts';
import type { NeedsYouItem, ProjectRecord, SessionView, TaskRecord } from './types.ts';

/** One line on what a waiting worker's menu asks. */
export function promptDetail(prompt: SessionPrompt | null): string {
  if (!prompt) return 'Approval or input waiting in AoE';
  if (prompt.kind === 'plan') return 'Plan ready for your approval';
  if (prompt.kind === 'permission' && prompt.tool)
    return `Wants to use ${prompt.tool.name}${prompt.tool.summary ? `: ${prompt.tool.summary}` : ''}`;
  return prompt.question || 'Claude is asking you something';
}

export interface NeedsYouInput {
  tasks: TaskRecord[];
  sessions: SessionView[];
  projects: ProjectRecord[];
  aoeReachable: boolean;
  now: Date;
  waitingDebounceSeconds: number;
}

/**
 * Everything that needs a human, oldest first (SPEC §14.1).
 * A session counts as a "control" chat if a project registered it as such, or if other AoE sessions
 * point at it as their parent (so pre-existing AoE parent/child setups light up too).
 */
export function computeNeedsYou(input: NeedsYouInput): NeedsYouItem[] {
  const { tasks, sessions, projects, aoeReachable, now } = input;
  const items: NeedsYouItem[] = [];
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const taskBySession = new Map(tasks.map((t) => [t.aoeSessionId, t]));
  const projectByControl = new Map(
    projects.filter((p) => p.controlSessionId).map((p) => [p.controlSessionId as string, p]),
  );
  const parentIds = new Set(sessions.map((s) => s.parentId).filter((x): x is string => !!x));
  const debounceMs = input.waitingDebounceSeconds * 1000;
  const iso = (s: string | null, fallback: string) => s ?? fallback;
  const nowIso = now.toISOString();

  for (const t of tasks) {
    if (t.stage === 'blocked' && t.openQuestion && !t.openQuestion.answeredAt) {
      items.push({
        id: `question:${t.id}`,
        kind: 'question',
        project: t.project,
        taskId: t.id,
        sessionId: t.aoeSessionId,
        title: `${workerLabel(t)} ${t.title}`,
        detail: t.openQuestion.text,
        since: t.openQuestion.askedAt,
      });
    }
    if (t.stage === 'ready_for_review') {
      const at = [...t.history].reverse().find((h) => h.to === 'ready_for_review')?.at ?? t.updatedAt;
      items.push({
        id: `mr_ready:${t.id}`,
        kind: 'mr_ready',
        project: t.project,
        taskId: t.id,
        sessionId: t.aoeSessionId,
        title: `${workerLabel(t)} ${t.title}`,
        detail: t.mr ? `Ready for review: !${t.mr.iid}` : 'Ready for review',
        since: at,
      });
    }
    if (t.mr?.state === 'closed' && t.stage !== 'done') {
      items.push({
        id: `mr_closed:${t.id}`,
        kind: 'mr_closed',
        project: t.project,
        taskId: t.id,
        sessionId: t.aoeSessionId,
        title: `${workerLabel(t)} ${t.title}`,
        detail: `MR !${t.mr.iid} was closed without merging`,
        since: iso(t.mr.checkedAt, t.updatedAt),
      });
    }
    if (aoeReachable && t.stage !== 'done' && !sessionById.has(t.aoeSessionId)) {
      items.push({
        id: `missing:${t.id}`,
        kind: 'session_missing',
        project: t.project,
        taskId: t.id,
        sessionId: t.aoeSessionId,
        title: `${workerLabel(t)} ${t.title}`,
        detail: 'Its AoE session no longer exists',
        since: t.updatedAt,
      });
    }
  }

  for (const s of sessions) {
    if (s.archived) continue;
    const project = projectByControl.get(s.id) ?? null;
    const isControl = !!project || parentIds.has(s.id);
    const task = taskBySession.get(s.id) ?? null;
    const since = iso(s.statusSince, nowIso);
    const label = task ? `${workerLabel(task)} ${task.title}` : s.title;
    const projectName = project?.name ?? task?.project ?? null;

    if (s.status === 'waiting') {
      if (now.getTime() - Date.parse(since) < debounceMs) continue;
      const kind = isControl
        ? 'control_waiting'
        : s.prompt?.kind === 'plan'
          ? 'plan_approval'
          : s.prompt?.kind === 'permission'
            ? 'permission'
            : s.prompt?.kind === 'question'
              ? 'question'
              : 'approval';
      items.push({
        id: `${kind === 'question' ? 'ask' : kind}:${s.id}`,
        kind,
        project: projectName,
        taskId: task?.id ?? null,
        sessionId: s.id,
        title: isControl ? `${project ? project.name : s.title} control chat` : label,
        detail: isControl ? 'Control chat is waiting for you' : promptDetail(s.prompt),
        since,
      });
    } else if (s.status === 'error') {
      items.push({
        id: `error:${s.id}`,
        kind: 'session_error',
        project: projectName,
        taskId: task?.id ?? null,
        sessionId: s.id,
        title: label,
        detail: s.lastError ?? 'AoE reports an error for this session',
        since,
      });
    } else if (s.status === 'idle' && isControl && s.unread) {
      items.push({
        id: `control_replied:${s.id}`,
        kind: 'control_replied',
        project: projectName,
        taskId: null,
        sessionId: s.id,
        title: `${project ? project.name : s.title} control chat`,
        detail: 'Control chat replied',
        since,
      });
    }
  }

  // What the control chats' latest replies list under NEEDS YOU.
  for (const s of sessions) {
    if (s.archived || !s.asks?.items.length) continue;
    const project = projectByControl.get(s.id) ?? null;
    if (!project && !parentIds.has(s.id)) continue;
    for (const a of s.asks.items)
      items.push({
        id: `control_needs:${s.id}:${fnv1a(a.text).toString(16)}`,
        kind: a.blocker ? 'control_blocker' : 'control_needs',
        project: project?.name ?? null,
        taskId: null,
        sessionId: s.id,
        title: `${project ? project.name : s.title} control chat`,
        detail: a.text,
        since: s.asks.at,
      });
  }

  return items.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
}
