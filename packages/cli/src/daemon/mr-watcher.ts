import { applyStage } from '@aoe-supercharge/core/node';
import {
  evaluateMr,
  MR_STAGES,
  transition,
  type MrState,
  type TaskRecord,
} from '@aoe-supercharge/core/shared';
import type { Ctx } from '../context.ts';
import type { MrProvider } from '../mr/gitlab.ts';
import type { Store } from './store.ts';

/**
 * Watches merge requests for tasks in mr_raised / watching_mr / ready_for_review (SPEC §11).
 * This script does the watching, never an LLM loop. Transitions go through the same stage machine
 * as the CLI, with actor "daemon".
 */
export class MrWatcher {
  private timer: NodeJS.Timeout | null = null;
  private backoff = 1;
  private stopped = false;
  private running = false;

  constructor(
    private ctx: Ctx,
    private store: Store,
    private provider: () => MrProvider,
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
      this.schedule(Math.min(this.ctx.config.poll.mr * 1000 * this.backoff, 10 * 60_000));
    }, ms);
    this.timer.unref();
  }

  async pollOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = this.store.tasks.filter((t) => MR_STAGES.includes(t.stage) && t.mr);
      let rateLimited = false;
      for (let i = 0; i < due.length; i += 2) {
        const results = await Promise.all(due.slice(i, i + 2).map((t) => this.check(t)));
        rateLimited ||= results.includes('rate_limited');
      }
      this.backoff = rateLimited ? Math.min(this.backoff * 2, 10) : 1;
    } finally {
      this.running = false;
    }
  }

  private async check(task: TaskRecord): Promise<'ok' | 'error' | 'rate_limited'> {
    const mr = task.mr!;
    const provider = this.provider();
    try {
      const status = await provider.status({ host: mr.host, repo: mr.repo, iid: mr.iid, url: mr.url });
      const checked: MrState = { ...status, checkedAt: new Date().toISOString(), error: null };
      await this.ctx.ledger.updateTask(task.project, task.id, (t) => this.advance(t, checked));
      return 'ok';
    } catch (err) {
      const message = (err as Error).message;
      this.ctx.logger.warn('mr check failed', { task: task.id, err: message });
      await this.ctx.ledger
        .updateTask(task.project, task.id, (t) =>
          t.mr ? { ...t, mr: { ...t.mr, error: message, checkedAt: new Date().toISOString() } } : t,
        )
        .catch(() => {});
      return /429|rate.?limit/i.test(message) ? 'rate_limited' : 'error';
    }
  }

  /** Pure: apply the latest MR state and any daemon transitions it implies. */
  advance(task: TaskRecord, mr: MrState): TaskRecord {
    let t: TaskRecord = { ...task, mr };
    if (!MR_STAGES.includes(t.stage)) return t;
    const verdict = evaluateMr(mr, { requireNonDraft: this.ctx.config.mr.gitlab.readyRequiresNonDraft });
    const move = (to: TaskRecord['stage'], note: string) => {
      const res = transition(t, to, 'daemon', { planApproved: true, hasMr: true });
      if (res.ok) t = { ...applyStage(t, to, 'daemon', note), mr };
    };
    if (verdict === 'merged') {
      move('done', `MR !${mr.iid} merged`);
      return t;
    }
    if (t.stage === 'mr_raised') move('watching_mr', `Watching MR !${mr.iid}`);
    if (t.stage === 'watching_mr' && verdict === 'ready')
      move('ready_for_review', 'Pipeline passed and no open threads');
    else if (t.stage === 'ready_for_review' && verdict === 'not_ready') {
      const why =
        mr.unresolvedThreads > 0
          ? `${mr.unresolvedThreads} open thread(s)`
          : `pipeline ${mr.pipeline ?? 'missing'}`;
      move('watching_mr', `No longer ready: ${why}`);
    }
    return t;
  }
}
