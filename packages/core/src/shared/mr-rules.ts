import type { MrState } from './types.ts';

export type MrVerdict = 'ready' | 'merged' | 'closed' | 'not_ready';

/**
 * SPEC §11.2. Ready = open, head pipeline succeeded, zero unresolved resolvable threads
 * (and not a draft when `requireNonDraft`). `blocking_discussions_resolved` is deliberately ignored:
 * GitLab reports it as true whenever the project doesn't require resolved threads.
 */
export function evaluateMr(
  mr: Pick<MrState, 'state' | 'draft' | 'pipeline' | 'unresolvedThreads'>,
  opts: { requireNonDraft: boolean },
): MrVerdict {
  if (mr.state === 'merged') return 'merged';
  if (mr.state === 'closed') return 'closed';
  if (mr.state !== 'opened') return 'not_ready';
  if (opts.requireNonDraft && mr.draft) return 'not_ready';
  if (mr.pipeline !== 'success') return 'not_ready';
  if (mr.unresolvedThreads > 0) return 'not_ready';
  return 'ready';
}

export function pipelineLabel(p: MrState['pipeline']): string {
  switch (p) {
    case null:
      return 'No pipeline';
    case 'success':
      return 'Pipeline passed';
    case 'failed':
      return 'Pipeline failed';
    case 'running':
      return 'Pipeline running';
    case 'pending':
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'scheduled':
      return 'Pipeline pending';
    case 'canceled':
      return 'Pipeline canceled';
    case 'skipped':
      return 'Pipeline skipped';
    case 'manual':
      return 'Pipeline manual';
  }
}

/** How an MR is named where it lives: `!12` on GitLab, `#12` for a GitHub pull request. */
export function mrLabel(mr: Pick<MrState, 'provider' | 'iid'>): string {
  return `${mr.provider === 'github' ? '#' : '!'}${mr.iid}`;
}
