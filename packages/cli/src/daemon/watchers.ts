import { watch, type FSWatcher } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import {
  checkCompat,
  loadConfig,
  readLocalCompat,
  restartRequiredFor,
  type Config,
} from '@aoe-supercharge/core/node';
import {
  normalizeAoeStatus,
  type AoeState,
  type Health,
  type LiveStatus,
  type SessionView,
} from '@aoe-supercharge/core/shared';
import { AoeError } from '../aoe/client.ts';
import type { AoeCliListEntry, AoeSession } from '../aoe/schemas.ts';
import { SHIPPED_COMPAT, type Ctx } from '../context.ts';
import type { PromptReader } from '../prompt.ts';
import type { Store } from './store.ts';

const nowIso = () => new Date().toISOString();

/**
 * Polls `GET /api/sessions` (AoE has no event stream we can use, SPEC §1.2) and merges parent
 * links from `aoe list --json`. Polls fast while a dashboard is open, slowly otherwise.
 */
export class AoeWatcher {
  private since = new Map<string, { status: LiveStatus; since: string }>();
  private cliIndex = new Map<string, AoeCliListEntry>();
  private lastCliList = 0;
  private lastServeAttempt = 0;
  private lastAbout = 0;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private ctx: Ctx,
    private store: Store,
    private prompts: PromptReader | null = null,
  ) {}

  start() {
    void this.loop();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Poll now (e.g. a dashboard just connected). */
  nudge() {
    if (this.running) return;
    if (this.timer) clearTimeout(this.timer);
    void this.loop();
  }

  private setAoe(patch: Partial<Health['aoe']>) {
    this.store.setHealth({ ...this.store.health, aoe: { ...this.store.health.aoe, ...patch } });
  }

  private async loop() {
    if (this.stopped) return;
    this.running = true;
    try {
      await this.pollOnce();
    } catch (err) {
      this.ctx.logger.error('aoe poll crashed', { err });
    } finally {
      this.running = false;
      this.store.recomputeNeedsYou();
      const c = this.ctx.config.poll;
      const secs = this.store.clientCount > 0 ? c.aoeSessions : c.aoeSessionsIdle;
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.loop(), secs * 1000);
        this.timer.unref();
      }
    }
  }

  async pollOnce(): Promise<void> {
    const h = this.store.health.aoe;
    if (h.state === 'incompatible' || h.state === 'missing') {
      // Re-check occasionally: `supercharge aoe upgrade` may have verified this version since.
      if (Date.now() - this.lastAbout < 60_000) return;
      this.lastAbout = Date.now();
      const installed = await this.ctx.aoeCli.version();
      const res = checkCompat(installed, SHIPPED_COMPAT, await readLocalCompat(this.ctx.paths));
      if (!res.ok) {
        this.setAoe({
          state: installed ? 'incompatible' : 'missing',
          installedVersion: installed,
          message: res.message,
          fix: res.fix,
        });
        return;
      }
      this.setAoe({ state: 'starting', installedVersion: installed, message: null, fix: null });
    }

    let sessions: AoeSession[];
    try {
      sessions = await this.ctx.aoe.listSessions();
    } catch (err) {
      await this.onUnreachable(err);
      return;
    }

    if (Date.now() - this.lastAbout > 5 * 60_000 || this.store.health.aoe.serveVersion === null) {
      this.lastAbout = Date.now();
      try {
        const about = await this.ctx.aoe.about();
        const res = checkCompat(about.version, SHIPPED_COMPAT, await readLocalCompat(this.ctx.paths));
        if (!res.ok) {
          this.setAoe({
            state: 'incompatible',
            serveVersion: about.version,
            message: `The running aoe serve is ${about.version}, outside the tested range ${res.range}.`,
            fix: 'If you just upgraded AoE, run "supercharge aoe upgrade"; or restart an in-range daemon with "aoe serve --restart".',
          });
          this.store.setSessions([]);
          return;
        }
        this.setAoe({ serveVersion: about.version });
      } catch (err) {
        this.ctx.logger.warn('aoe about failed', { err: (err as Error).message });
      }
    }

    const profile = this.ctx.config.aoe.profile;
    const live = sessions.filter((s) => !s.profile || s.profile === profile);
    const unknown = live.some((s) => !this.cliIndex.has(s.id));
    if (unknown || Date.now() - this.lastCliList > this.ctx.config.poll.reconcile * 1000) {
      try {
        const list = await this.ctx.aoeCli.list();
        this.cliIndex = new Map(list.map((e) => [e.id, e]));
        this.lastCliList = Date.now();
      } catch (err) {
        this.ctx.logger.warn('aoe list failed; parent links may be stale', { err: (err as Error).message });
        this.lastCliList = Date.now();
      }
    }

    const views = live.map((s) => this.toView(s));
    // A waiting session may be showing a menu (plan approval, permission); read it so the dashboard can answer.
    if (this.prompts) {
      const reader = this.prompts;
      await Promise.all(
        views
          .filter((v) => v.status === 'waiting')
          .map(async (v) => {
            v.prompt = await reader.read(v.id, v.projectPath).catch(() => null);
          }),
      );
    }
    this.store.setSessions(views);
    for (const id of [...this.since.keys()]) if (!live.some((s) => s.id === id)) this.since.delete(id);
    this.setAoe({
      state: 'ok',
      origin: this.ctx.aoe.currentOrigin,
      message: null,
      fix: null,
      lastPollAt: nowIso(),
    });
  }

  private toView(s: AoeSession): SessionView {
    const status = normalizeAoeStatus(s.status);
    const prev = this.since.get(s.id);
    let since: string;
    if (prev && prev.status === status) since = prev.since;
    else if (!prev && status === 'idle' && s.idle_entered_at) since = s.idle_entered_at;
    else since = nowIso();
    this.since.set(s.id, { status, since });
    const cli = this.cliIndex.get(s.id);
    return {
      id: s.id,
      title: s.title ?? cli?.title ?? s.id,
      status,
      rawStatus: s.status ?? 'Unknown',
      statusSince: since,
      parentId: cli?.parent_session_id ?? null,
      branch: s.branch ?? cli?.worktree?.branch ?? null,
      projectPath: s.project_path ?? cli?.path ?? null,
      group: s.group_path || cli?.group || null,
      tool: s.tool ?? cli?.tool ?? null,
      unread: !!s.unread,
      lastError: s.last_error ?? null,
      createdAt: s.created_at ?? null,
      lastAccessedAt: s.last_accessed_at ?? null,
      prompt: null,
    };
  }

  private async onUnreachable(err: unknown) {
    const kind = err instanceof AoeError ? err.kind : 'unreachable';
    const msg = (err as Error).message;
    this.ctx.logger.warn('aoe unreachable', { kind, err: msg });
    let state: AoeState = 'unreachable';
    let message = kind === 'auth' ? 'aoe serve rejected the token.' : 'aoe serve is not reachable.';
    let fix: string | null =
      kind === 'auth' ? 'Restart it with "aoe serve --restart".' : 'Start it with "aoe serve --daemon".';
    if (kind === 'protocol') {
      message = `aoe serve answered unexpectedly: ${msg}`;
      fix = 'Run "supercharge doctor"; AoE may have changed its API ("supercharge aoe upgrade").';
    }
    if (
      this.ctx.config.aoe.autoStart &&
      kind === 'unreachable' &&
      Date.now() - this.lastServeAttempt > 30_000
    ) {
      this.lastServeAttempt = Date.now();
      if (!(await this.ctx.aoeCli.serveRunning())) {
        this.ctx.logger.info('starting aoe serve --daemon');
        const r = await this.ctx.aoeCli.serveStart();
        if (r.code === 0) {
          state = 'starting';
          message = 'Starting aoe serve…';
          fix = null;
        } else {
          message = `Could not start aoe serve: ${(r.stderr || r.error?.message || '').trim().slice(0, 200)}`;
        }
      }
    }
    this.setAoe({ state, message, fix });
  }
}

/** Ledger changes arrive through fs.watch, with a periodic rescan as a safety net. */
export class LedgerWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;

  constructor(
    private ctx: Ctx,
    private store: Store,
  ) {}

  async start() {
    await mkdir(this.ctx.paths.projectsDir, { recursive: true });
    await this.reload();
    try {
      this.watcher = watch(this.ctx.paths.projectsDir, { recursive: true }, (_e, file) => {
        if (file && (String(file).endsWith('.tmp') || String(file).includes('.lock'))) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => void this.reload(), 120);
      });
      this.watcher.on('error', (err) => this.ctx.logger.warn('ledger watch error', { err: err.message }));
    } catch (err) {
      this.ctx.logger.warn('fs.watch unavailable; relying on periodic rescans', {
        err: (err as Error).message,
      });
    }
    this.schedule();
  }

  private schedule() {
    this.timer = setTimeout(async () => {
      await this.reload();
      this.schedule();
    }, this.ctx.config.poll.reconcile * 1000);
    this.timer.unref();
  }

  async reload() {
    try {
      const [projects, tasks] = await Promise.all([
        this.ctx.ledger.listProjects(),
        this.ctx.ledger.listTasks(),
      ]);
      this.store.setLedger(projects, tasks);
    } catch (err) {
      this.ctx.logger.error('ledger reload failed', { err });
    }
  }

  stop() {
    this.watcher?.close();
    if (this.timer) clearTimeout(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
  }
}

/** Hot-reloads config.toml; changes to server/aoe/agent are flagged "restart required" (SPEC §5). */
export class ConfigWatcher {
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private boot: Config;

  constructor(
    private ctx: Ctx,
    private store: Store,
    private onApplied: (c: Config) => void,
  ) {
    this.boot = ctx.config;
  }

  async start() {
    await mkdir(this.ctx.paths.configDir, { recursive: true, mode: 0o700 });
    try {
      this.watcher = watch(this.ctx.paths.configDir, (_e, file) => {
        if (file !== 'config.toml') return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => void this.reload(), 150);
      });
    } catch (err) {
      this.ctx.logger.warn('config watch unavailable', { err: (err as Error).message });
    }
  }

  async reload() {
    const loaded = await loadConfig(this.ctx.paths);
    if (loaded.errors.length) {
      this.store.setHealth({
        ...this.store.health,
        config: { ...this.store.health.config, ok: false, errors: loaded.errors },
      });
      this.ctx.logger.warn('config.toml is invalid; keeping the last good config', { errors: loaded.errors });
      return;
    }
    const restartRequired = restartRequiredFor(
      [
        'server.port',
        'server.hostname',
        'aoe.binary',
        'aoe.profile',
        'aoe.autoStart',
        'aoe.url',
        'agent.kind',
        'agent.extraArgs',
        'agent.workerPermissionMode',
      ].filter((k) => JSON.stringify(getPath(this.boot, k)) !== JSON.stringify(getPath(loaded.config, k))),
    );
    this.ctx.config = loaded.config;
    this.ctx.logger.setLevel(loaded.config.logging.level);
    this.store.setHealth({
      ...this.store.health,
      remoteControl: loaded.config.remoteControl.enabled,
      config: { ok: true, errors: [], restartRequired },
    });
    this.store.setUi({
      theme: loaded.config.ui.theme,
      density: loaded.config.ui.density,
      scale: loaded.config.ui.scale,
    });
    this.onApplied(loaded.config);
  }

  stop() {
    this.watcher?.close();
    if (this.debounce) clearTimeout(this.debounce);
  }
}

function getPath(obj: unknown, dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>(
      (a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined),
      obj,
    );
}
