import type { Actor } from './types.ts';

export const STAGES = [
  'planning',
  'implementing',
  'verifying',
  'mr_raised',
  'watching_mr',
  'ready_for_review',
  'blocked',
  'done',
] as const;
export type Stage = (typeof STAGES)[number];

/** The happy path, in order. `blocked` and `done` are off-path. */
export const PATH_STAGES = [
  'planning',
  'implementing',
  'verifying',
  'mr_raised',
  'watching_mr',
  'ready_for_review',
] as const satisfies readonly Stage[];

export const STAGE_LABEL: Record<Stage, string> = {
  planning: 'Planning',
  implementing: 'Implementing',
  verifying: 'Verifying',
  mr_raised: 'MR raised',
  watching_mr: 'Watching MR',
  ready_for_review: 'Ready for review',
  blocked: 'Blocked',
  done: 'Done',
};

export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

export const MR_STAGES: readonly Stage[] = ['mr_raised', 'watching_mr', 'ready_for_review'];

export interface TransitionInput {
  stage: Stage;
  blockedFrom: Stage | null;
}

export interface TransitionContext {
  planApproved: boolean;
  /** mr_raised: an MR was given or found. ready_for_review: the task already has an MR. */
  hasMr: boolean;
  question?: string | null;
  force?: boolean;
}

export type TransitionResult =
  { ok: true } | { ok: false; reason: string; allowed: Stage[]; daemonOnly?: boolean };

type Edge = { to: Stage; actors: readonly Actor[] };

const HUMANS: readonly Actor[] = ['worker', 'user', 'control'];
const CLOSERS: readonly Actor[] = ['user', 'control', 'daemon'];

/** Edges out of each active stage, excluding `blocked` (via ask) and `done` (added below). */
const EDGES: Record<Exclude<Stage, 'blocked' | 'done'>, Edge[]> = {
  planning: [{ to: 'implementing', actors: HUMANS }],
  implementing: [{ to: 'verifying', actors: HUMANS }],
  verifying: [
    { to: 'implementing', actors: HUMANS },
    { to: 'mr_raised', actors: HUMANS },
    // Branch ready to merge, no MR (guarded below: only without an MR).
    { to: 'ready_for_review', actors: HUMANS },
  ],
  mr_raised: [
    { to: 'watching_mr', actors: ['daemon'] },
    { to: 'implementing', actors: HUMANS },
  ],
  watching_mr: [
    { to: 'ready_for_review', actors: ['daemon'] },
    { to: 'implementing', actors: HUMANS },
  ],
  ready_for_review: [
    { to: 'watching_mr', actors: ['daemon'] },
    { to: 'implementing', actors: HUMANS },
  ],
};

function edgesFrom(from: Stage, blockedFrom: Stage | null): Edge[] {
  if (from === 'done') return [];
  if (from === 'blocked') {
    const base =
      blockedFrom && blockedFrom !== 'blocked' && blockedFrom !== 'done' ? blockedFrom : 'planning';
    return [
      { to: base, actors: HUMANS },
      ...edgesFrom(base, null).filter((e) => e.to !== 'blocked' && e.to !== base),
    ];
  }
  return [...EDGES[from], { to: 'blocked', actors: HUMANS }, { to: 'done', actors: CLOSERS }];
}

/** Stages this actor may move to next (ignoring guards). */
export function allowedNext(task: TransitionInput, actor: Actor): Stage[] {
  const out = edgesFrom(task.stage, task.blockedFrom)
    .filter((e) => e.actors.includes(actor))
    .map((e) => e.to);
  if (task.stage === 'blocked' && !out.includes('done') && CLOSERS.includes(actor)) out.push('done');
  return [...new Set(out)];
}

/** Stages only the MR watcher sets (ready_for_review: only when the task has an MR). */
const DAEMON_STAGES: readonly Stage[] = ['watching_mr', 'ready_for_review'];

const DAEMON_ONLY_HINT =
  'happens automatically once the MR watcher sees the merge request; you never need to set it yourself';

export function transition(
  task: TransitionInput,
  to: Stage,
  actor: Actor,
  ctx: TransitionContext,
): TransitionResult {
  if (ctx.force) return { ok: true };
  const allowed = allowedNext(task, actor);
  const edges = edgesFrom(task.stage, task.blockedFrom);
  const edge =
    edges.find((e) => e.to === to) ??
    (task.stage === 'blocked' && to === 'done' ? { to, actors: CLOSERS } : undefined);

  if (task.stage === to) return { ok: false, reason: `Already in ${STAGE_LABEL[to]}.`, allowed };
  if (task.stage === 'done')
    return { ok: false, reason: 'This task is done. Use --force to reopen it.', allowed: [] };
  const mrOnlyReady = to === 'ready_for_review' && ctx.hasMr;
  if (DAEMON_STAGES.includes(to) && actor !== 'daemon' && (!edge?.actors.includes(actor) || mrOnlyReady)) {
    return { ok: false, reason: `${STAGE_LABEL[to]} ${DAEMON_ONLY_HINT}.`, allowed, daemonOnly: true };
  }
  if (!edge) {
    return {
      ok: false,
      reason: `Can't go ${task.stage} → ${to}.`,
      allowed,
    };
  }
  if (!edge.actors.includes(actor)) {
    const daemonOnly = edge.actors.length === 1 && edge.actors[0] === 'daemon';
    return {
      ok: false,
      reason: daemonOnly
        ? `${STAGE_LABEL[to]} ${DAEMON_ONLY_HINT}.`
        : `Only ${edge.actors.join('/')} can move a task to ${STAGE_LABEL[to]}.`,
      allowed,
      daemonOnly,
    };
  }
  if (to === 'blocked' && !ctx.question?.trim())
    return { ok: false, reason: 'Blocking needs a question. Use: supercharge ask "<question>"', allowed };
  if (task.stage === 'planning' && to === 'implementing' && !ctx.planApproved) {
    return {
      ok: false,
      reason:
        'Implementing needs an approved plan first. Save it with: supercharge plan <file>  (or "-" for stdin)',
      allowed,
    };
  }
  if (to === 'mr_raised' && !ctx.hasMr) {
    return {
      ok: false,
      reason:
        'No merge request found for this branch. Pass it explicitly: supercharge stage mr_raised --mr <url>',
      allowed,
    };
  }
  return { ok: true };
}

/** Human hint for each allowed next stage, used in CLI rejections. */
export function nextStageHint(stage: Stage): string {
  switch (stage) {
    case 'implementing':
      return 'supercharge stage implementing';
    case 'verifying':
      return 'supercharge stage verifying';
    case 'mr_raised':
      return 'supercharge stage mr_raised --mr <url>';
    case 'ready_for_review':
      return 'supercharge stage ready_for_review  (branch pushed and ready to merge, no MR)';
    case 'blocked':
      return 'supercharge ask "<question>"';
    case 'done':
      return 'supercharge stage done';
    case 'planning':
      return 'supercharge stage planning';
    default:
      return `(automatic) ${STAGE_LABEL[stage]}`;
  }
}

/** Index on the 6-step stepper, or -1 for off-path stages. */
export function pathIndex(stage: Stage): number {
  return (PATH_STAGES as readonly Stage[]).indexOf(stage);
}
