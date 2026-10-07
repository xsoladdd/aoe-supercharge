import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { ensureToken, readDismissed, readJson, writeJsonAtomic } from '@aoe-supercharge/core/node';
import type { Health } from '@aoe-supercharge/core/shared';
import { checkAoeCompat, createCtx, SHIPPED_COMPAT, VERSION } from '../context.ts';
import { notify, Notifier } from '../notify.ts';
import { mrProvider } from '../workflow.ts';
import { createApp } from './app.ts';
import { attachShellSockets } from './shell.ts';
import { PromptReader } from '../prompt.ts';
import { transcriptStore } from '../transcript.ts';
import { BranchWatcher } from './branch-watcher.ts';
import { MrWatcher } from './mr-watcher.ts';
import { CostWatcher, OfficeWatcher, WeatherWatcher } from './office.ts';
import { Store } from './store.ts';
import { AoeWatcher, ConfigWatcher, LedgerWatcher, NotesWatcher } from './watchers.ts';

export const RESTART_EXIT_CODE = 75;

/**
 * Foreground runs get a tiny supervisor so the dashboard's Restart button works without
 * launchd/systemd: the worker exits with 75 and is started again. Under a service manager
 * (SUPERCHARGE_SERVICE set by the unit file) the service manager does the restarting.
 */
export async function runDaemon(): Promise<void> {
  if (!process.env.SUPERCHARGE_SERVICE && !process.env.SUPERCHARGE_SUPERVISED) return supervise();
  return runWorker();
}

function supervise(): Promise<void> {
  return new Promise(() => {
    let child: ReturnType<typeof spawn> | null = null;
    let stopping = false;
    const start = () => {
      child = spawn(process.execPath, process.argv.slice(1), {
        stdio: 'inherit',
        env: { ...process.env, SUPERCHARGE_SUPERVISED: '1' },
      });
      child.on('exit', (code, signal) => {
        if (!stopping && code === RESTART_EXIT_CODE) {
          process.stderr.write('supercharge: restarting daemon\n');
          setTimeout(start, 300);
          return;
        }
        process.exit(code ?? (signal ? 1 : 0));
      });
    };
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.on(sig, () => {
        stopping = true;
        child?.kill(sig);
      });
    }
    start();
  });
}

function uiDir(): string | null {
  const candidates = [
    process.env.SUPERCHARGE_UI_DIR,
    fileURLToPath(new URL('./ui/', import.meta.url)),
  ].filter(Boolean) as string[];
  return candidates.find((d) => existsSync(`${d}/index.html`)) ?? null;
}

async function runWorker(): Promise<void> {
  const foreground = !process.env.SUPERCHARGE_SERVICE;
  const ctx = await createCtx({
    logFile: true,
    stderr: foreground && process.env.SUPERCHARGE_LOG_STDERR === '1',
  });
  const { paths, logger } = ctx;
  const token = await ensureToken(paths);
  const lastState = await readJson<{ port?: number }>(paths.daemonStateFile).catch(() => null);
  const configOk = ctx.configErrors.length === 0;
  const port = configOk ? ctx.config.server.port : (lastState?.port ?? ctx.config.server.port);

  const installed = await ctx.aoeCli.version();
  const compat = await checkAoeCompat(ctx, installed);
  const startedAt = new Date();
  const health: Health = {
    daemon: {
      version: VERSION,
      pid: process.pid,
      port,
      startedAt: startedAt.toISOString(),
      uptimeSec: 0,
      rssMb: 0,
      mode: !compat.ok ? 'incompatible' : configOk ? 'ok' : 'degraded',
      demo: process.env.SUPERCHARGE_DEMO === '1',
    },
    aoe: {
      state: compat.ok ? 'starting' : installed ? 'incompatible' : 'missing',
      installedVersion: installed,
      serveVersion: null,
      range: SHIPPED_COMPAT.aoe.range,
      origin: null,
      profile: ctx.config.aoe.profile,
      message: compat.message,
      fix: compat.fix,
      lastPollAt: null,
    },
    config: { ok: configOk, errors: ctx.configErrors, restartRequired: [] },
    remoteControl: ctx.config.remoteControl.enabled,
  };
  const store = new Store(health, {
    waitingDebounceSeconds: () => ctx.config.notifications.waitingDebounceSeconds,
  });
  store.dismissedReplies = await readDismissed(ctx.paths).catch(() => ({}));
  store.ui = {
    theme: ctx.config.ui.theme,
    density: ctx.config.ui.density,
    scale: ctx.config.ui.scale,
    sound: ctx.config.ui.sound,
    displayName: ctx.config.ui.displayName,
    officeAnimations: ctx.config.ui.officeAnimations,
  };

  const notifier = new Notifier(() => ctx.config);
  const transcripts = transcriptStore(ctx);
  const aoeWatcher = new AoeWatcher(ctx, store, new PromptReader(ctx, transcripts), transcripts);
  const ledgerWatcher = new LedgerWatcher(ctx, store);
  const notesWatcher = new NotesWatcher(ctx, store);
  const mrWatcher = new MrWatcher(ctx, store, () => mrProvider(ctx.config, ctx.env));
  const branchWatcher = new BranchWatcher(ctx, store);
  const officeWatcher = new OfficeWatcher(ctx, store);
  const costWatcher = new CostWatcher(ctx, store, officeWatcher, transcripts);
  const weatherWatcher = new WeatherWatcher(ctx, store);
  const configWatcher = new ConfigWatcher(ctx, store, () => {
    aoeWatcher.nudge();
    void officeWatcher.reloadMarks();
    weatherWatcher.reload();
  });

  store.subscribe((e) => {
    if (!notifier.isArmed && store.sessionsLoaded && store.ledgerLoaded) notifier.arm(store.needsYou);
    else if (e.type === 'needs_you')
      void notifier.onNeedsYou(e.data).catch((err) => logger.warn('notify failed', { err }));
  });

  let server: ServerType | null = null;
  const shutdown = async (code: number) => {
    aoeWatcher.stop();
    ledgerWatcher.stop();
    notesWatcher.stop();
    mrWatcher.stop();
    branchWatcher.stop();
    configWatcher.stop();
    officeWatcher.stop();
    costWatcher.stop();
    weatherWatcher.stop();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    setTimeout(() => process.exit(code), 50).unref();
    process.exit(code);
  };

  const app = createApp({
    ctx,
    store,
    token,
    uiDir: uiDir(),
    onConfigWritten: () => configWatcher.reload(),
    requestRestart: () => {
      logger.info('restart requested');
      void shutdown(RESTART_EXIT_CODE);
    },
    onClientConnected: () => aoeWatcher.nudge(),
    testNotification: () => notify('Supercharge', 'Notifications are working.'),
    transcripts,
    office: officeWatcher,
  });

  await ledgerWatcher.start();
  await notesWatcher.start();
  await configWatcher.start();
  if (compat.ok) aoeWatcher.start();
  else {
    logger.warn('AoE outside the compat range; not managing AoE', {
      installed,
      range: SHIPPED_COMPAT.aoe.range,
    });
    aoeWatcher.start();
  }
  mrWatcher.start();
  branchWatcher.start();
  await officeWatcher.start();
  costWatcher.start();
  weatherWatcher.reload();

  await new Promise<void>((resolveListen, rejectListen) => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => resolveListen());
    server.on('error', rejectListen);
    attachShellSockets(server, { ctx, store, token });
  }).catch(async (err: NodeJS.ErrnoException) => {
    const msg = err.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : err.message;
    logger.error('could not listen', { port, err: msg });
    await writeJsonAtomic(paths.daemonStateFile, {
      pid: process.pid,
      port,
      startedAt: startedAt.toISOString(),
      version: VERSION,
      lastError: msg,
    });
    process.stderr.write(`supercharge: ${msg} Change it with "supercharge config set server.port <port>".\n`);
    process.exit(1);
  });

  await writeJsonAtomic(paths.daemonStateFile, {
    pid: process.pid,
    port,
    startedAt: startedAt.toISOString(),
    version: VERSION,
    lastError: null,
  });
  logger.info('daemon listening', {
    port,
    url: `http://${ctx.config.server.hostname}:${port}`,
    aoe: installed,
    mode: health.daemon.mode,
  });
  if (foreground)
    process.stderr.write(
      `supercharge: dashboard on http://${ctx.config.server.hostname}:${port} (sign in with "supercharge open")\n`,
    );

  const tick = setInterval(() => {
    const h = store.health;
    store.setHealth({
      ...h,
      daemon: {
        ...h.daemon,
        uptimeSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
        rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
    });
  }, 15_000);
  tick.unref();
  store.setHealth({
    ...store.health,
    daemon: { ...store.health.daemon, rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024) },
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void shutdown(0));
}
