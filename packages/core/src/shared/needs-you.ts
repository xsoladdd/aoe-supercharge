import { crewWorker, relayState, relayTarget, taskWorker, type RelayWorker } from './control-relay.ts';
import { fnv1a } from './hash.ts';
import { workerLabel } from './names.ts';
import type { SessionPrompt } from './prompt.ts';
import type { ScheduledPrompt } from './schedule.ts';
import type { GeneralRecord, NeedsYouItem, ProjectRecord, SessionView, TaskRecord } from './types.ts';

/** One line on what a waiting worker's menu asks. */
export function promptDetail(prompt: SessionPrompt | null): string {
  if (!prompt) return 'Approval or input waiting in AoE';
  if (prompt.kind === 'plan') return 'Plan ready for your approval';
  if (prompt.kind === 'permission' && prompt.tool)
    return `Wants to use ${prompt.tool.name}${prompt.tool.summary ? `: ${prompt.tool.summary}` : ''}`;
  return prompt.question || 'Claude is asking you something';
}

/**
 * The dashboard page an item opens (and where it counts as seen): a task's page, the worker a control
 * chat passes it on for, a chat, a project, or the schedules.
 */
export function needsYouPath(item: NeedsYouItem): string {
  const chat = (id: string) => `/chat/${encodeURIComponent(id)}`;
  if (item.kind === 'schedule_failed') return '/schedules';
  // Task items open the task page, whose first tab shows its question or menu with the answer.
  if (item.project && item.taskId) return `/p/${item.project}/t/${item.taskId}`;
  // Passed on by a control chat: the worker it is about, who has the answer cards.
  if (item.relay)
    return item.project && item.relay.taskId
      ? `/p/${item.project}/t/${item.relay.taskId}`
      : chat(item.relay.sessionId);
  if (item.sessionId && item.kind.startsWith('control_')) return chat(item.sessionId);
  if (item.project) return `/p/${item.project}`;
  if (item.sessionId) return chat(item.sessionId);
  return '/';
}

/**
 * Whether the dashboard page at `path` shows `item`, so opening it counts as seeing it: the page it
 * opens, its chat, its task's page (any tab), its project's page, or the schedules for a failed run.
 */
export function needsYouShownOn(item: NeedsYouItem, path: string): boolean {
  const p = path.split(/[?#]/)[0]!.replace(/\/+$/, '') || '/';
  if (p === needsYouPath(item)) return true;
  const seg = p.split('/').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  if (seg[1] === 'chat' && seg[2]) return item.sessionId === seg[2] || item.relay?.sessionId === seg[2];
  if (seg[1] === 'p' && seg[2] && item.project === seg[2]) {
    if (seg[3] === 't') return !!seg[4] && (item.taskId === seg[4] || item.relay?.taskId === seg[4]);
    return seg[3] !== 'settings';
  }
  return p === '/schedules' && item.kind === 'schedule_failed';
}

export interface NeedsYouInput {
  tasks: TaskRecord[];
  sessions: SessionView[];
  projects: ProjectRecord[];
  /** The General control chat counts as a control chat from the start, with no project. */
  general?: GeneralRecord;
  aoeReachable: boolean;
  now: Date;
  waitingDebounceSeconds: number;
  /**
   * Items you dismissed: when, by item id. One stays hidden until something new happens on it (its
   * `since` moves past the dismissal: a new question, a new waiting stretch, a newer reply).
   */
  dismissed?: Record<string, string>;
  /** Scheduled prompts: one whose last run failed needs you until it runs again or you change it. */
  schedules?: ScheduledPrompt[];
}

/** How long a new session's `error` is taken for Claude Code still starting, not a dead pane. */
export const STARTING_MS = 60_000;

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
  const general = input.general?.controlSessionId ?? null;
  if (general) parentIds.add(general);
  const controlName = (s: SessionView, project: ProjectRecord | null) =>
    project ? project.name : s.id === general ? 'General' : s.title;
  const debounceMs = input.waitingDebounceSeconds * 1000;
  const iso = (s: string | null, fallback: string) => s ?? fallback;
  const nowIso = now.toISOString();
  /** A control chat's item is dismissed against when it was first listed, not when the list began. */
  const listedAt = new Map<string, string>();

  for (const t of tasks) {
    // Archived: put away on purpose, like its session (and `supercharge status`).
    if (sessionById.get(t.aoeSessionId)?.archived) continue;
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
        detail: t.mr ? `Ready for review: !${t.mr.iid}` : `Branch ready to merge: ${t.branch}`,
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
        // Not checkedAt: it moves on every poll, and would bring a dismissed item straight back.
        since: t.history.at(-1)?.at ?? t.updatedAt,
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
    // A session a project's control chat started through AoE belongs to that project too.
    const parentProject = s.parentId ? (projectByControl.get(s.parentId) ?? null) : null;
    const projectName = project?.name ?? task?.project ?? parentProject?.name ?? null;

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
        title: isControl ? `${controlName(s, project)} control chat` : label,
        detail: isControl ? 'Control chat is waiting for you' : promptDetail(s.prompt),
        since,
      });
    } else if (s.status === 'error' && task?.stage !== 'done') {
      // A done worker's error (a delete that failed half-way, say) has nothing left for you to do.
      // An empty first capture reads as an error while Claude Code starts: give it the debounce, and a minute.
      const created = s.createdAt ? Date.parse(s.createdAt) : NaN;
      if (now.getTime() - Date.parse(since) < debounceMs || now.getTime() - created < STARTING_MS) continue;
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
        title: `${controlName(s, project)} control chat`,
        detail: 'Control chat replied',
        since,
      });
    }
  }

  // What the control chats' latest replies list under NEEDS YOU. An item about one of its workers is
  // relayed while that worker waits on you, and gone once it has moved on (SPEC §14.5).
  const workerItems = items.filter((i) => !i.kind.startsWith('control_'));
  const taskSessions = new Set(tasks.map((t) => t.aoeSessionId));
  const workersOf = (control: SessionView, project: ProjectRecord | null): RelayWorker[] => [
    ...tasks
      .filter(
        (t) =>
          (project && t.project === project.name) || sessionById.get(t.aoeSessionId)?.parentId === control.id,
      )
      .map((t) => taskWorker(t, sessionById.get(t.aoeSessionId) ?? null)),
    ...sessions
      .filter((c) => c.parentId === control.id && !taskSessions.has(c.id) && !projectByControl.has(c.id))
      .map((c) => crewWorker(c, (project ? project.crew : input.general?.sessions)?.[c.id] ?? null)),
  ];
  for (const s of sessions) {
    if (s.archived || !s.asks?.items.length) continue;
    const project = projectByControl.get(s.id) ?? null;
    if (!project && !parentIds.has(s.id)) continue;
    const workers = workersOf(s, project);
    const lead = `${controlName(s, project)} control chat`;
    const gone = project ? goneTaskIds(project, tasks) : () => false;
    for (const a of s.asks.items) {
      const hash = fnv1a(a.text).toString(16);
      const target = relayTarget(a.text, workers);
      // About a worker that was cleaned up or deleted: nothing about it can need you any more.
      if (target === null && gone(a.text)) continue;
      const worker = target === 'ambiguous' ? null : target;
      const open = worker ? workerItems.filter((i) => i.sessionId === worker.sessionId) : [];
      const listed = a.since ?? s.asks.at;
      const state = worker ? relayState(listed, worker, open) : 'own';
      if (state === 'cleared') continue;
      if (worker && state === 'open') {
        const id = `control_relayed:${s.id}:${hash}`;
        listedAt.set(id, listed);
        items.push({
          id,
          kind: 'control_relayed',
          project: project?.name ?? null,
          taskId: null,
          sessionId: s.id,
          title: `${worker.label} via the ${lead}`,
          detail: a.text,
          since: s.asks.at,
          relay: {
            name: worker.name,
            label: worker.label,
            taskId: worker.taskId,
            sessionId: worker.sessionId,
          },
        });
        continue;
      }
      const id = `control_needs:${s.id}:${hash}`;
      listedAt.set(id, listed);
      items.push({
        id,
        kind: a.blocker ? 'control_blocker' : 'control_needs',
        project: project?.name ?? null,
        taskId: null,
        sessionId: s.id,
        title: lead,
        detail: a.text,
        since: s.asks.at,
      });
    }
  }

  for (const j of input.schedules ?? []) {
    const r = j.lastResult;
    // An edit since the failure (or turning it off) clears it.
    if (!j.enabled || r?.status !== 'failed' || r.at < j.scheduledFrom) continue;
    const task = taskBySession.get(j.sessionId) ?? null;
    items.push({
      id: `schedule_failed:${j.id}:${r.at}`,
      kind: 'schedule_failed',
      project: projectByControl.get(j.sessionId)?.name ?? task?.project ?? null,
      taskId: task?.id ?? null,
      sessionId: j.sessionId,
      title: `Scheduled prompt "${j.name}"`,
      detail: r.detail ?? 'It could not be sent',
      since: r.at,
    });
  }

  // Last, so a worker's dismissed item still decides whether the control chat relays it.
  const dismissed = (i: NeedsYouItem) => {
    const at = input.dismissed?.[i.id];
    return !!at && Date.parse(at) >= Date.parse(listedAt.get(i.id) ?? i.since);
  };
  return items.filter((i) => !dismissed(i)).sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
}

/**
 * Whether a text names one of the project's task ids that is no longer in the ledger (cleaned up, or
 * deleted with its session). Ids are never reused, so such an id can only mean a worker that left.
 */
function goneTaskIds(project: ProjectRecord, tasks: TaskRecord[]): (text: string) => boolean {
  if (!/^[A-Za-z0-9]+$/.test(project.idPrefix ?? '')) return () => false;
  const live = new Set(tasks.filter((t) => t.project === project.name).map((t) => t.id.toUpperCase()));
  const id = new RegExp(`(?<![\\p{L}\\p{N}_])${project.idPrefix}-\\d+(?![\\p{L}\\p{N}_])`, 'giu');
  return (text) => [...text.matchAll(id)].some((m) => !live.has(m[0].toUpperCase()));
}
