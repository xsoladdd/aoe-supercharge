import { randomBytes } from 'node:crypto';
import { readJson, writeJsonAtomic } from '@aoe-supercharge/core/node';
import { CONTROL_SHELL_INDEX, pickTerminalIndex, type RunTerminal } from '@aoe-supercharge/core/shared';
import type { Hono } from 'hono';
import type { Ctx } from '../context.ts';
import { MAX_COMMAND } from '../workflow.ts';
import type { Store } from './store.ts';

/**
 * The terminals a chat's Run opened: one of AoE's extra paired terminals each, in the session's folder,
 * under the command it ran. Kept in `terminals.json`, so a page reload or a daemon restart finds them
 * again; AoE keeps the shells and their output until you close them.
 */
export class RunTerminals {
  private records: RunTerminal[] = [];
  private loading: Promise<void> | null = null;
  private writes = Promise.resolve();

  constructor(
    private ctx: Ctx,
    private store: Store,
  ) {}

  private load(): Promise<void> {
    this.loading ??= readJson<RunTerminal[]>(this.ctx.paths.runTerminalsFile).then(
      (r) => void (this.records = Array.isArray(r) ? r : []),
      (err: Error) => this.ctx.logger.warn('run terminals: could not read', { err: err.message }),
    );
    return this.loading;
  }

  private save(): Promise<void> {
    const snapshot = [...this.records];
    this.writes = this.writes
      .then(() => writeJsonAtomic(this.ctx.paths.runTerminalsFile, snapshot))
      .catch((err: Error) => this.ctx.logger.warn('run terminals: could not save', { err: err.message }));
    return this.writes;
  }

  /** A session's open terminals, oldest first. Those of sessions that are gone or archived are let go. */
  async list(sessionId: string): Promise<RunTerminal[]> {
    await this.load();
    if (this.store.sessionsLoaded) {
      const live = new Set(this.store.sessions.filter((s) => !s.archived).map((s) => s.id));
      const kept = this.records.filter((r) => live.has(r.sessionId));
      if (kept.length !== this.records.length) {
        this.records = kept;
        await this.save();
      }
    }
    return this.records.filter((r) => r.sessionId === sessionId);
  }

  async get(sessionId: string, id: string): Promise<RunTerminal | null> {
    await this.load();
    return this.records.find((r) => r.sessionId === sessionId && r.id === id) ?? null;
  }

  /** Open a terminal for a command; it runs once a browser shows the terminal (see `takeRun`). */
  async open(sessionId: string, command: string, anchor: string): Promise<RunTerminal> {
    const used = (await this.list(sessionId)).map((r) => r.index);
    const index = pickTerminalIndex(used);
    if (index === null) throw new Error("Close one of this chat's terminals first.");
    await this.ctx.aoe.ensureTerminal(sessionId, index);
    const record: RunTerminal = {
      id: randomBytes(6).toString('hex'),
      sessionId,
      index,
      command,
      anchor,
      createdAt: new Date().toISOString(),
      ran: false,
    };
    this.records.push(record);
    await this.save();
    return record;
  }

  /**
   * The command to type into a terminal that has not run it yet, exactly once, however many browsers
   * show it.
   */
  takeRun(record: RunTerminal): string | null {
    const r = this.records.find((x) => x.id === record.id);
    if (!r || r.ran) return null;
    r.ran = true;
    void this.save();
    return r.command;
  }

  /** Close a terminal: AoE kills its shell and whatever still runs there. */
  async close(record: RunTerminal): Promise<void> {
    await this.ctx.aoe.killTerminal(record.sessionId, record.index);
    this.records = this.records.filter((r) => r.id !== record.id);
    await this.save();
  }
}

/** The REST side of run terminals, and Restart for the control chat's Shell tab. */
export function terminalRoutes(app: Hono, deps: { ctx: Ctx; store: Store; terminals: RunTerminals }) {
  const { ctx, store, terminals } = deps;
  const known = (id: string) => store.sessions.some((s) => s.id === id && !s.archived);

  app.get('/api/sessions/:id/terminals', async (c) => {
    const id = c.req.param('id');
    if (!known(id)) return c.json({ error: 'not_found', message: 'Unknown session' }, 404);
    return c.json({ terminals: await terminals.list(id) });
  });

  app.post('/api/sessions/:id/terminals', async (c) => {
    const id = c.req.param('id');
    if (!known(id)) return c.json({ error: 'not_found', message: 'Unknown session' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { command?: unknown; anchor?: unknown };
    const command = typeof body.command === 'string' ? body.command.replace(/^\s*\n+/, '').trimEnd() : '';
    if (!command.trim() || command.length > MAX_COMMAND)
      return c.json({ error: 'bad_request', message: 'That command is empty or too long to run here.' }, 400);
    const anchor = typeof body.anchor === 'string' ? body.anchor.slice(0, 500) : '';
    try {
      return c.json({ terminal: await terminals.open(id, command, anchor) }, 201);
    } catch (err) {
      return c.json({ error: 'terminal_failed', message: (err as Error).message }, 502);
    }
  });

  app.delete('/api/sessions/:id/terminals/:tid', async (c) => {
    const record = await terminals.get(c.req.param('id'), c.req.param('tid'));
    if (!record) return c.json({ error: 'not_found', message: 'That terminal is already closed.' }, 404);
    try {
      await terminals.close(record);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: 'terminal_failed', message: (err as Error).message }, 502);
    }
  });

  // A fresh shell for the Shell tab: AoE closes the old one and starts another in the same folder.
  app.post('/api/sessions/:id/shell/restart', async (c) => {
    const id = c.req.param('id');
    if (!known(id)) return c.json({ error: 'not_found', message: 'Unknown session' }, 404);
    try {
      await ctx.aoe.killTerminal(id, CONTROL_SHELL_INDEX);
      await ctx.aoe.ensureTerminal(id, CONTROL_SHELL_INDEX);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: 'restart_failed', message: (err as Error).message }, 502);
    }
  });
}
