import { randomBytes } from 'node:crypto';
import { readHeld, writeHeld } from '@aoe-supercharge/core/node';
import type { HeldMessage, SessionView } from '@aoe-supercharge/core/shared';
import type { Ctx } from '../context.ts';
import { kickoffUnconfirmed, MenuOpenError, sendToSession } from '../workflow.ts';
import type { Store } from './store.ts';

/** A pass at least this often (nothing else changes while a session sits idle with a fresh list). */
const PASS_EVERY_MS = 5_000;
/** A session gone from AoE this long (while AoE answers) takes its held messages with it. */
const GONE_MS = 10 * 60_000;

export interface HeldDeps {
  send?: (s: SessionView, message: string, project: string | null, taskId: string | null) => Promise<void>;
  now?: () => Date;
}

export const RESTARTED_WHILE_SENDING =
  'The daemon restarted while sending this. Check the chat: it may already be there.';

/** Thrown for a held message that is being typed right now (it can't be cancelled or changed). */
export class HeldBusyError extends Error {}

/**
 * Messages held while Claude is busy, typed in one at a time once their session is free (idle, no menu,
 * and a status read after the last typing). Kept on disk, so a reload or a restart loses none. A typing
 * error is never retried by itself (it may have gone in): the message waits for you, and so does the
 * line behind it.
 */
export class HeldMessages {
  private held: Record<string, HeldMessage[]> = {};
  private loaded: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  /** Since when each session with held messages has been missing from AoE (ms). */
  private missing = new Map<string, number>();
  /** Writes in order, so an older state never lands after a newer one. */
  private writing: Promise<void> = Promise.resolve();
  private send: NonNullable<HeldDeps['send']>;
  private now: () => Date;

  constructor(
    private ctx: Ctx,
    private store: Store,
    deps: HeldDeps = {},
  ) {
    this.send =
      deps.send ??
      ((s, message, project, taskId) =>
        sendToSession(ctx, {
          sessionId: s.id,
          message,
          actor: 'ui',
          project,
          taskId,
          details: { mode: 'hold', held: true },
        }));
    this.now = deps.now ?? (() => new Date());
  }

  /** Reads what was held before a restart. A message caught mid-send is not sent again by itself. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      const read = await readHeld(this.ctx.paths).catch((err: unknown): Record<string, HeldMessage[]> => {
        this.ctx.logger.warn('could not read held messages', { err: (err as Error).message });
        return {};
      });
      let changed = false;
      for (const [id, list] of Object.entries(read))
        read[id] = list.map((m) => {
          if (m.state !== 'sending') return m;
          changed = true;
          return { ...m, state: 'failed' as const, error: RESTARTED_WHILE_SENDING };
        });
      this.held = read;
      this.store.setHeld(this.held);
      if (changed) await this.save();
    })();
    return this.loaded;
  }

  start() {
    void this.load().then(() => this.schedule());
    this.unsubscribe = this.store.subscribe((e) => {
      if (e.type === 'sessions' || e.type === 'tasks' || e.type === 'held') this.schedule();
    });
    const loop = () => {
      this.schedule();
      this.timer = setTimeout(loop, PASS_EVERY_MS);
      this.timer.unref();
    };
    this.timer = setTimeout(loop, PASS_EVERY_MS);
    this.timer.unref();
  }

  stop() {
    this.unsubscribe?.();
    if (this.timer) clearTimeout(this.timer);
    if (this.soon) clearTimeout(this.soon);
  }

  /** The session's held messages, oldest first. */
  list(sessionId: string): HeldMessage[] {
    return this.held[sessionId] ?? [];
  }

  has(sessionId: string): boolean {
    return this.list(sessionId).length > 0;
  }

  /** Hold a message: last in line, or `front` (an interrupt that Claude didn't stop for in time). */
  async hold(sessionId: string, message: string, opts: { front?: boolean } = {}): Promise<HeldMessage> {
    await this.load();
    const m: HeldMessage = {
      id: randomBytes(6).toString('hex'),
      sessionId,
      message: message.trim(),
      heldAt: this.now().toISOString(),
      state: 'held',
      error: null,
    };
    const list = this.list(sessionId);
    // In front of the others, but behind one being typed right now.
    const at = opts.front ? list.findIndex((x) => x.state !== 'sending') : -1;
    const next = at < 0 ? [...list, m] : [...list.slice(0, at), m, ...list.slice(at)];
    await this.set(sessionId, next);
    return m;
  }

  /** Take a held message out (Cancel, or Edit back into the composer). Null when there is none. */
  async remove(sessionId: string, id: string): Promise<HeldMessage | null> {
    await this.load();
    const list = this.list(sessionId);
    const m = list.find((x) => x.id === id);
    if (!m) return null;
    if (m.state === 'sending') throw new HeldBusyError('This message is being sent right now.');
    await this.set(
      sessionId,
      list.filter((x) => x.id !== id),
    );
    return m;
  }

  /** Try a failed message again: it goes back in line, where it was. */
  async retry(sessionId: string, id: string): Promise<HeldMessage | null> {
    await this.load();
    const list = this.list(sessionId);
    const m = list.find((x) => x.id === id);
    if (!m) return null;
    if (m.state === 'sending') throw new HeldBusyError('This message is being sent right now.');
    const next = { ...m, state: 'held' as const, error: null };
    await this.set(
      sessionId,
      list.map((x) => (x.id === id ? next : x)),
    );
    return next;
  }

  /** A pass in a moment. */
  nudge() {
    this.schedule();
  }

  private schedule() {
    if (this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.tick().catch((err: unknown) =>
        this.ctx.logger.warn('held messages failed', { err: (err as Error).message }),
      );
    }, 250);
    this.soon.unref();
  }

  /** One pass over every session with held messages; a pass asked for while one runs follows it. Exposed for tests. */
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

  private async pass(): Promise<void> {
    await this.load();
    const { store } = this;
    // Without a fresh view of AoE a session's status can't be trusted, and every session looks gone.
    if (!store.sessionsLoaded || !store.ledgerLoaded || store.health.aoe.state !== 'ok') return;
    const now = this.now().getTime();
    for (const sessionId of Object.keys(this.held)) {
      const list = this.list(sessionId);
      if (!list.length) continue;
      const session = store.sessions.find((s) => s.id === sessionId);
      if (!session) {
        const since = this.missing.get(sessionId) ?? now;
        this.missing.set(sessionId, since);
        if (now - since >= GONE_MS) {
          this.ctx.logger.warn('dropped held messages for a session that is gone from AoE', {
            session: sessionId,
            count: list.length,
          });
          this.missing.delete(sessionId);
          await this.set(sessionId, []);
        }
        continue;
      }
      this.missing.delete(sessionId);
      await this.deliver(session, list);
    }
  }

  /** Types the first held message in, when its session is free. */
  private async deliver(session: SessionView, list: HeldMessage[]) {
    const first = list[0]!;
    if (first.state !== 'held') return;
    // Busy, a menu open, or archived (typing would bring it back): it waits.
    if (session.status === 'working' || session.prompt || session.archived) return;
    const task = this.store.tasks.find((t) => t.aoeSessionId === session.id) ?? null;
    // A new worker's first message goes first; a held one must not beat it or meet a resend of it.
    if (task && ((task.kickoffAt === null && task.stage === 'planning') || kickoffUnconfirmed(task))) return;
    const project =
      task?.project ?? this.store.projects.find((p) => p.controlSessionId === session.id)?.name ?? null;
    if (session.locked && first.message === '/clear') {
      await this.update(session.id, first.id, {
        state: 'failed',
        error: 'This session is locked. Unlock it to clear it.',
      });
      return;
    }
    const release = this.store.claimTyping(session.id, this.now().getTime());
    if (!release) return;
    // On disk before typing: a crash from here on must not type it again by itself.
    await this.update(session.id, first.id, { state: 'sending', error: null });
    try {
      await this.send(session, first.message, project, task?.id ?? null);
    } catch (err) {
      if (err instanceof MenuOpenError) {
        release();
        await this.update(session.id, first.id, { state: 'held' });
        return;
      }
      this.ctx.logger.warn('could not send a held message', {
        session: session.id,
        err: (err as Error).message,
      });
      await this.update(session.id, first.id, {
        state: 'failed',
        error: `${(err as Error).message} It may have gone in anyway: check the chat, then Retry or Cancel.`,
      });
      return;
    }
    await this.set(
      session.id,
      this.list(session.id).filter((x) => x.id !== first.id),
    );
  }

  private async update(sessionId: string, id: string, patch: Partial<HeldMessage>) {
    await this.set(
      sessionId,
      this.list(sessionId).map((x) => (x.id === id ? { ...x, ...patch } : x)),
    );
  }

  private async set(sessionId: string, list: HeldMessage[]) {
    const { [sessionId]: _, ...rest } = this.held;
    this.held = list.length ? { ...rest, [sessionId]: list } : rest;
    this.store.setHeld(this.held);
    await this.save();
  }

  private save(): Promise<void> {
    const snapshot = this.held;
    this.writing = this.writing.catch(() => {}).then(() => writeHeld(this.ctx.paths, snapshot));
    return this.writing.catch((err: unknown) =>
      this.ctx.logger.warn('could not save held messages', { err: (err as Error).message }),
    );
  }
}
