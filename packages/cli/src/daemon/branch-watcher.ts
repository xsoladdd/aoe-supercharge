import { applyStage } from '@aoe-supercharge/core/node';
import { transition, type TaskRecord } from '@aoe-supercharge/core/shared';
import type { Ctx } from '../context.ts';
import { hasLanded, revParse } from '../util/git.ts';
import type { Store } from './store.ts';

/** Tasks a worker reported ready to merge without an MR (SPEC §11.3). */
export const isBranchReady = (t: TaskRecord) => t.stage === 'ready_for_review' && !t.mr;

/**
 * Marks a branch-ready task done once its branch lands on the base branch (SPEC §11.3): fast-forwarded
 * or merged, or every commit cherry-picked with the same patch. Local git only (no fetch), checked
 * every `poll.mr` seconds. Kept apart from the MR watcher, which only looks at tasks with an MR.
 */
export class BranchWatcher {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = false;

  constructor(
    private ctx: Ctx,
    private store: Store,
  ) {}

  start() {
    this.schedule(5_000);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      await this.pollOnce();
      this.schedule(this.ctx.config.poll.mr * 1000);
    }, ms);
    this.timer.unref();
  }

  async pollOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const task of this.store.tasks.filter(isBranchReady)) {
        const project = this.store.projects.find((p) => p.name === task.project);
        if (!project) continue;
        const base = await landedOn(project.repoPath, task).catch(() => null);
        if (!base) continue;
        await this.ctx.ledger
          .updateTask(task.project, task.id, (t) => markLanded(t, base))
          .catch((err) => this.ctx.logger.warn('branch landing update failed', { task: task.id, err }));
      }
    } finally {
      this.running = false;
    }
  }
}

/** The base ref the task's branch landed on (`main` or `origin/main`), or null if it hasn't. */
export async function landedOn(repo: string, task: TaskRecord): Promise<string | null> {
  const head = (await revParse(repo, `refs/heads/${task.branch}`)) ?? task.readyHead ?? null;
  if (!head) return null;
  for (const base of [task.baseBranch, `origin/${task.baseBranch}`]) {
    if ((await revParse(repo, base)) && (await hasLanded(repo, base, head))) return base;
  }
  return null;
}

/** Pure: move a still branch-ready task to done. */
export function markLanded(task: TaskRecord, base: string): TaskRecord {
  if (!isBranchReady(task)) return task;
  const res = transition(task, 'done', 'daemon', { planApproved: true, hasMr: false });
  return res.ok ? applyStage(task, 'done', 'daemon', `Branch landed on ${base}`) : task;
}
