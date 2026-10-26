import { randomBytes } from 'node:crypto';
import { appendAudit, readSchedules, writeSchedules } from '@aoe-supercharge/core/node';
import { dueAt, type ScheduledPrompt, type ScheduleResult } from '@aoe-supercharge/core/shared';
import type { Ctx } from '../context.ts';
import { sessionAction } from '../workflow.ts';
import type { HeldMessages } from './held.ts';
import type { Store } from './store.ts';

/** A pass at least this often: a prompt goes out within this long of its time. */
const PASS_EVERY_MS = 20_000;

export type ScheduleInput = Pick<
  ScheduledPrompt,
  'name' | 'sessionId' | 'prompt' | 'time' | 'days' | 'enabled'
>;

export interface SchedulerDeps {
  /** Brings an archived or stopped chat back before its prompt is held for it. */
  wake?: (sessionId: string, action: 'unarchive' | 'start') => Promise<void>;
  now?: () => Date;
}

/**
 * Prompts sent to an existing chat at a set time each day (SPEC §8.5). A due prompt goes into the chat's
 * held-message line, so it is typed once Claude is free. A run missed while the daemon was down (or the
 * Mac asleep) goes once on the next pass, not once per missed day. A usage limit at "stop" skips the run.
 */
export class Scheduler {
  private jobs: ScheduledPrompt[] = [];
  private loaded: Promise<void> | null = null;
  /** Why `schedules.json` could not be read: nothing is written over it then. */
  private broken: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Passes and changes one at a time, so a run never goes twice and writes land in order. */
  private chain: Promise<unknown> = Promise.resolve();
  private wake: NonNullable<SchedulerDeps['wake']>;
  private now: () => Date;

  constructor(
    private ctx: Ctx,
    private store: Store,
    private held: Pick<HeldMessages, 'load' | 'hold' | 'list'>,
    deps: SchedulerDeps = {},
  ) {
    this.wake =
      deps.wake ?? ((sessionId, action) => sessionAction(ctx, { sessionId, action, actor: 'daemon' }));
    this.now = deps.now ?? (() => new Date());
  }

  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        this.jobs = await readSchedules(this.ctx.paths);
      } catch (err) {
        this.broken = (err as Error).message;
        this.ctx.logger.warn('could not read scheduled prompts', { err: this.broken });
      }
      this.publish();
    })();
    return this.loaded;
  }

  start() {
    const loop = () => {
      void this.tick().catch((err: unknown) =>
        this.ctx.logger.warn('scheduled prompts failed', { err: (err as Error).message }),
      );
      this.timer = setTimeout(loop, PASS_EVERY_MS);
      this.timer.unref();
    };
    this.timer = setTimeout(loop, 1_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  list(): ScheduledPrompt[] {
    return this.jobs;
  }

  add(input: ScheduleInput): Promise<ScheduledPrompt> {
    return this.serial(async () => {
      const at = this.now().toISOString();
      const job: ScheduledPrompt = {
        id: randomBytes(4).toString('hex'),
        ...input,
        prompt: input.prompt.trim(),
        createdAt: at,
        scheduledFrom: at,
        lastRunAt: null,
        lastResult: null,
      };
      await this.save([...this.jobs, job]);
      return job;
    });
  }

  /** Any change counts the next run from now: an edit or re-enable never fires at once. Null when gone. */
  update(id: string, patch: Partial<ScheduleInput>): Promise<ScheduledPrompt | null> {
    return this.serial(async () => {
      const job = this.jobs.find((j) => j.id === id);
      if (!job) return null;
      const next: ScheduledPrompt = {
        ...job,
        ...patch,
        prompt: (patch.prompt ?? job.prompt).trim(),
        scheduledFrom: this.now().toISOString(),
      };
      await this.save(this.jobs.map((j) => (j.id === id ? next : j)));
      return next;
    });
  }

  remove(id: string): Promise<boolean> {
    return this.serial(async () => {
      if (!this.jobs.some((j) => j.id === id)) return false;
      await this.save(this.jobs.filter((j) => j.id !== id));
      return true;
    });
  }

  /** Run now: sends (or skips) it straight away, leaving its daily time as it was. Null when gone. */
  runNow(id: string): Promise<ScheduleResult | null> {
    return this.serial(async () => {
      await this.held.load();
      const job = this.jobs.find((j) => j.id === id);
      return job ? this.fire(job, true) : null;
    });
  }

  /** One pass: follow up queued runs, fire what is due. Exposed for tests. */
  tick(): Promise<void> {
    return this.serial(() => this.pass());
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      await this.load();
      return fn();
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private async pass(): Promise<void> {
    const { store } = this;
    // Without a fresh view of AoE a chat's status can't be trusted, and every chat looks gone.
    if (!store.sessionsLoaded || !store.ledgerLoaded || store.health.aoe.state !== 'ok') return;
    await this.held.load();
    const tz = this.ctx.config.office.clocks.home;
    const job = (id: string) => this.jobs.find((j) => j.id === id)!;
    for (const { id } of this.jobs) {
      const r = job(id).lastResult;
      if (r?.status === 'queued') await this.followUp(job(id), r);
      if (job(id).enabled && dueAt(job(id), tz).getTime() <= this.now().getTime())
        await this.fire(job(id), false);
    }
    this.publish();
  }

  /** A queued run is sent once its held message is gone, failed if typing it failed. */
  private async followUp(job: ScheduledPrompt, r: ScheduleResult) {
    const m = this.held.list(job.sessionId).find((x) => x.id === r.heldId);
    if (m?.state === 'held' || m?.state === 'sending') return;
    // shortcut: a held message you cancelled also reads as sent; track cancels if that confuses anyone.
    const gone = !m && !this.store.sessions.some((s) => s.id === job.sessionId);
    const next: ScheduleResult =
      m || gone
        ? { ...r, status: 'failed', detail: m?.error ?? 'The chat is gone from AoE.' }
        : { ...r, status: 'sent', detail: null };
    await this.record(job, next, false);
  }

  private async fire(job: ScheduledPrompt, manual: boolean): Promise<ScheduleResult> {
    const at = this.now().toISOString();
    const result = (status: ScheduleResult['status'], detail: string | null, heldId: string | null = null) =>
      ({ at, status, detail, heldId, manual }) satisfies ScheduleResult;
    let r: ScheduleResult;
    const usage = this.store.usage;
    const session = this.store.sessions.find((s) => s.id === job.sessionId);
    if (usage?.level === 'stop') r = result('skipped', usage.advice);
    else if (!session) r = result('failed', 'The chat is gone from AoE.');
    else
      try {
        if (session.archived) await this.wake(session.id, 'unarchive');
        else if (session.status === 'stopped') await this.wake(session.id, 'start');
        r = result('queued', null, (await this.held.hold(session.id, job.prompt)).id);
      } catch (err) {
        r = result('failed', (err as Error).message);
      }
    await this.record(job, r, !manual);
    return r;
  }

  private async record(job: ScheduledPrompt, r: ScheduleResult, ran: boolean) {
    const next = { ...job, lastResult: r, ...(ran ? { lastRunAt: r.at } : {}) };
    await this.save(this.jobs.map((j) => (j.id === job.id ? next : j)));
    await appendAudit(this.ctx.paths, {
      actor: 'daemon',
      action: 'scheduled_prompt',
      sessionId: job.sessionId,
      text: job.prompt,
      details: { schedule: job.id, name: job.name, status: r.status, detail: r.detail, manual: r.manual },
    }).catch((err: unknown) =>
      this.ctx.logger.warn('could not audit a scheduled prompt', { err: (err as Error).message }),
    );
  }

  private async save(jobs: ScheduledPrompt[]) {
    if (this.broken)
      throw new Error(`Scheduled prompts can't be saved: schedules.json is unreadable (${this.broken}).`);
    await writeSchedules(this.ctx.paths, jobs);
    this.jobs = jobs;
    this.publish();
  }

  private publish() {
    const tz = this.ctx.config.office.clocks.home;
    this.store.setSchedules(
      this.jobs.map((j) => ({ ...j, nextRunAt: j.enabled ? dueAt(j, tz).toISOString() : null })),
    );
  }
}
