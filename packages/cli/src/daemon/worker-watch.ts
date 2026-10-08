import { basename } from 'node:path';
import {
  pruneWatchCaptures,
  readWatchBook,
  readWatchLog,
  saveWatchCapture,
  watchEnabled,
  writeWatchBook,
  writeWatchLog,
} from '@aoe-supercharge/core/node';
import {
  backgroundShells,
  formatWatchNotice,
  markerOf,
  stallCandidates,
  watchEvents,
  watchStep,
  watchWorkers,
  type ProjectRecord,
  type WatchBook,
  type WatchEvent,
  type WatchLogEntry,
  type WatchMarker,
  type WatchSummary,
  type WatchWorker,
} from '@aoe-supercharge/core/shared';
import type { Ctx } from '../context.ts';
import type { TranscriptStore } from '../transcript.ts';
import { MenuOpenError, sendToSession } from '../workflow.ts';
import type { Store } from './store.ts';

/** A pass at least this often, for stalls (nothing else changes while a worker sits idle). */
const WATCH_EVERY_MS = 30_000;
/** Lines of a worker's pane saved for the control chat to read, as control-watch.sh saved. */
const CAPTURE_LINES = 200;
const PRUNE_EVERY_MS = 3_600_000;

export interface WorkerWatchDeps {
  send?: (sessionId: string, message: string, project: string) => Promise<void>;
  capture?: (sessionId: string) => Promise<string>;
  now?: () => Date;
}

/**
 * Worker watch: tells each project's control chat when one of its workers (a task's, or one the
 * control chat started through AoE) asks a question, is done, waits on a permission prompt, errors or
 * stalls. Once per occurrence: what it told is kept on disk, so a restart doesn't tell it again. The
 * notices wait while the control chat is busy and go in together once it is free.
 */
export class WorkerWatch {
  private timer: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private book: WatchBook | null = null;
  private logs = new Map<string, WatchLogEntry[]>();
  /** When each idle worker was last seen with background shells running (ISO). */
  private busy = new Map<string, string>();
  private prunedAt = 0;
  private send: NonNullable<WorkerWatchDeps['send']>;
  private capture: NonNullable<WorkerWatchDeps['capture']>;
  private now: () => Date;

  constructor(
    private ctx: Ctx,
    private store: Store,
    private transcripts: Pick<TranscriptStore, 'read'> | null,
    deps: WorkerWatchDeps = {},
  ) {
    this.send =
      deps.send ??
      ((sessionId, message, project) => sendToSession(ctx, { sessionId, message, actor: 'daemon', project }));
    this.capture = deps.capture ?? (async (id) => (await ctx.aoe.output(id, CAPTURE_LINES)).content);
    this.now = deps.now ?? (() => new Date());
  }

  start() {
    this.unsubscribe = this.store.subscribe((e) => {
      if (e.type === 'sessions' || e.type === 'tasks' || e.type === 'projects' || e.type === 'needs_you')
        this.schedule();
    });
    const loop = () => {
      this.schedule();
      this.timer = setTimeout(loop, WATCH_EVERY_MS);
      this.timer.unref();
    };
    this.timer = setTimeout(loop, 5_000);
    this.timer.unref();
  }

  stop() {
    this.unsubscribe?.();
    if (this.timer) clearTimeout(this.timer);
    if (this.soon) clearTimeout(this.soon);
  }

  /** A pass in a moment: after a config change, say. */
  nudge() {
    this.schedule();
  }

  private schedule() {
    if (this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.tick().catch((err: unknown) =>
        this.ctx.logger.warn('worker watch failed', { err: (err as Error).message }),
      );
    }, 1_000);
    this.soon.unref();
  }

  /** One pass over every project; a pass asked for while one runs follows it. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.pass().finally(() => (this.running = null));
    await this.running;
    if (this.again) {
      this.again = false;
      await this.tick();
    }
  }

  /** A project's log, oldest first. */
  async log(project: string): Promise<WatchLogEntry[]> {
    let log = this.logs.get(project);
    if (!log) {
      log = await readWatchLog(this.ctx.paths, project);
      this.logs.set(project, log);
    }
    return log;
  }

  private async saveLog(project: string, log: WatchLogEntry[]) {
    this.logs.set(project, log);
    await writeWatchLog(this.ctx.paths, project, log);
  }

  private async pass(): Promise<void> {
    const { ctx, store } = this;
    // Without a fresh view of AoE every session would look gone, and what it told would be forgotten.
    if (!store.sessionsLoaded || !store.ledgerLoaded || store.health.aoe.state !== 'ok') return;
    const now = this.now();
    let book = (this.book ??= await readWatchBook(ctx.paths));
    const summaries: Record<string, WatchSummary> = {};
    for (const project of store.projects) {
      if (!project.controlSessionId) continue;
      const enabled = watchEnabled(ctx.config, project.name);
      let log = await this.log(project.name);
      let workers: WatchWorker[] = [];
      if (!enabled) {
        // Off: turning it back on starts afresh, and what it hadn't sent stays unsent.
        if (book.started[project.name]) {
          const { [project.name]: _, ...started } = book.started;
          book = { ...book, started };
        }
        if (log.some((e) => e.state === 'pending')) {
          log = log.map((e) => (e.state === 'pending' ? { ...e, state: 'dropped' as const } : e));
          await this.saveLog(project.name, log);
        }
      } else {
        workers = watchWorkers(store, project);
        const events = watchEvents({
          project: project.name,
          workers,
          needsYou: store.needsYou,
          markers: await this.markers(workers),
          now,
          stallMinutes: ctx.config.watch.stallMinutes,
          busy: await this.shells(workers, book, now),
        });
        const step = watchStep(book, project.name, workers, events, now);
        book = step.book;
        if (step.fresh.length) {
          // Remembered before it is sent: a crash in between loses a notice rather than repeating one.
          await this.saveBook(book);
          const added: WatchLogEntry[] = [];
          for (const e of step.fresh) added.push(await this.entry(e, now));
          log = [...log, ...added];
          await this.saveLog(project.name, log);
          ctx.logger.info('worker watch', {
            project: project.name,
            notices: added.map((e) => `${e.worker}: ${e.kind}`),
          });
        }
      }
      const held = enabled ? await this.deliver(project, log, now) : null;
      log = await this.log(project.name);
      summaries[project.name] = {
        enabled,
        stallMinutes: ctx.config.watch.stallMinutes,
        watching: workers.length,
        pending: log.filter((e) => e.state === 'pending').length,
        lastAt: log.at(-1)?.at ?? null,
        held,
      };
    }
    await this.saveBook(book);
    store.setWatch(summaries);
    if (now.getTime() - this.prunedAt > PRUNE_EVERY_MS) {
      this.prunedAt = now.getTime();
      await pruneWatchCaptures(ctx.paths, now).catch(() => {});
    }
  }

  /**
   * Idle workers that would be called stalled but have background shells running (the "N shells" in
   * Claude Code's footer, say a full e2e run): they are working, so their stall clock restarts now. Only
   * panes of would-be stalls are read, and one that can't be read counts as no shells.
   */
  private async shells(workers: WatchWorker[], book: WatchBook, now: Date): Promise<Record<string, string>> {
    const idle = new Set(workers.filter((w) => w.session?.status === 'idle').map((w) => w.sessionId));
    for (const id of this.busy.keys()) if (!idle.has(id)) this.busy.delete(id);
    const candidates = stallCandidates(
      workers,
      now,
      this.ctx.config.watch.stallMinutes,
      (key) => !!book.seen[key],
    );
    await Promise.all(
      candidates.map(async (w) => {
        const pane = await this.capture(w.sessionId).catch(() => '');
        if (backgroundShells(pane) > 0) this.busy.set(w.sessionId, now.toISOString());
      }),
    );
    return Object.fromEntries(this.busy);
  }

  private async saveBook(book: WatchBook) {
    if (this.book && JSON.stringify(this.book) === JSON.stringify(book)) return;
    this.book = book;
    await writeWatchBook(this.ctx.paths, book);
  }

  /**
   * `QUESTION:` / `DONE:` in each plain worker's latest reply, read once it has finished (idle, or
   * waiting on a menu). Task workers say so through Supercharge instead.
   */
  private async markers(workers: WatchWorker[]): Promise<Record<string, WatchMarker | null>> {
    const out: Record<string, WatchMarker | null> = {};
    if (!this.transcripts) return out;
    const transcripts = this.transcripts;
    await Promise.all(
      workers
        .filter((w) => !w.task && (w.session?.status === 'idle' || w.session?.status === 'waiting'))
        .map(async (w) => {
          const chat = await transcripts.read(w.sessionId, w.session?.projectPath ?? null).catch(() => null);
          const last = chat?.messages.at(-1);
          if (last?.role !== 'assistant') return;
          const m = markerOf(last.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('\n'));
          out[w.sessionId] = m ? { ...m, id: last.id } : null;
        }),
    );
    return out;
  }

  private async entry(e: WatchEvent, now: Date): Promise<WatchLogEntry> {
    const at = now.toISOString();
    let file: string | null = null;
    try {
      file = await saveWatchCapture(this.ctx.paths, e.sessionId, await this.capture(e.sessionId), now);
    } catch (err) {
      this.ctx.logger.warn('worker watch: no capture', {
        sessionId: e.sessionId,
        err: (err as Error).message,
      });
    }
    const line = formatWatchNotice({
      worker: e.worker,
      status: e.status,
      kind: e.kind,
      log: file,
      name: e.name !== e.worker ? e.name : null,
      project: e.project,
      task: e.taskId,
      stage: e.stage,
      session: e.sessionId,
      at,
      detail: e.detail,
    });
    return {
      id: `${e.key}@${at}`,
      at,
      kind: e.kind,
      project: e.project,
      sessionId: e.sessionId,
      taskId: e.taskId,
      worker: e.worker,
      name: e.name,
      status: e.status,
      stage: e.stage,
      detail: e.detail,
      capture: file ? basename(file) : null,
      line,
      state: 'pending',
      sentAt: null,
    };
  }

  /**
   * Types the pending notices into the project's control chat, all at once, when it is free: idle,
   * or stopped (AoE starts it again). Busy or showing a menu, they wait. Returns why they can't go at
   * all (the control chat is archived or gone), or null.
   */
  private async deliver(project: ProjectRecord, log: WatchLogEntry[], now: Date): Promise<string | null> {
    const control = this.store.sessions.find((s) => s.id === project.controlSessionId);
    if (!control) return 'The control chat is not in AoE';
    if (control.archived) return 'The control chat is archived';
    const pending = log.filter((e) => e.state === 'pending');
    if (!pending.length) return null;
    if (control.status !== 'idle' && control.status !== 'stopped') return null;
    // Wait for a status read after the last typing into it (held messages, too), so idle means idle.
    const release = this.store.claimTyping(control.id, now.getTime());
    if (!release) return null;
    try {
      await this.send(control.id, pending.map((e) => e.line).join('\n'), project.name);
    } catch (err) {
      if (err instanceof MenuOpenError) release();
      else
        this.ctx.logger.warn('worker watch: could not reach the control chat', {
          project: project.name,
          err: (err as Error).message,
        });
      return null;
    }
    const sentAt = now.toISOString();
    const ids = new Set(pending.map((e) => e.id));
    const current = await this.log(project.name);
    await this.saveLog(
      project.name,
      current.map((e) => (ids.has(e.id) ? { ...e, state: 'sent' as const, sentAt } : e)),
    );
    return null;
  }
}
