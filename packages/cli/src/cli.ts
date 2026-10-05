import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { copyFile, open, readFile, rm, stat, watch as fsWatch } from 'node:fs/promises';
import { Command, Option } from 'commander';
import {
  ensureConfigFile,
  ensureToken,
  getByPath,
  loadConfig,
  setConfigValue,
  ConfigValidationError,
} from '@aoe-supercharge/core/node';
import {
  isStage,
  LIVE_STATUS_LABEL,
  normalizeAoeStatus,
  relativeTime,
  STAGE_LABEL,
  STAGES,
  type ProjectStatus,
  type SessionView,
} from '@aoe-supercharge/core/shared';
import { checkAoeCompat, createCtx, dashboardOrigin, VERSION, type Ctx } from './context.ts';
import { aoeUpgrade } from './commands/aoe-upgrade.ts';
import { printDoctor, runDoctor } from './commands/doctor.ts';
import { proxyCommand } from './commands/proxy.ts';
import { runDaemon } from './daemon/index.ts';
import { serviceManager, servicePathEnv } from './service/index.ts';
import { installUserSkills, removeUserSkills } from './skills.ts';
import { buildProjectStatus } from './status.ts';
import { daemonHealth, daemonRequest, waitForDaemon } from './util/daemon-client.ts';
import { CliError, EXIT } from './util/errors.ts';
import { which } from './util/exec.ts';
import { c, confirm, json, out, readStdin, sym } from './util/term.ts';
import {
  askQuestion,
  deleteProject,
  findTask,
  initProject,
  newTask,
  replyToTask,
  savePlan,
  stageTask,
  whoami,
} from './workflow.ts';

const cwd = () => process.cwd();

async function ctx(): Promise<Ctx> {
  return createCtx();
}

function openUrl(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
}

/** Commander accumulator for repeatable options. */
const collect = (value: string, previous: string[]) => [...previous, value];

export function buildProgram(): Command {
  const program = new Command('supercharge')
    .description(
      'Agent of Empires: Supercharge. One control chat per project, one worker per task, one dashboard.',
    )
    .version(VERSION, '-v, --version')
    .showSuggestionAfterError()
    .configureHelp({ sortSubcommands: false });

  // ── service lifecycle ──
  program
    .command('start')
    .description('install or refresh the background service and start it')
    .action(async () => {
      const x = await ctx();
      if (x.configErrors.length)
        throw new CliError(
          `config.toml is invalid:\n  ${x.configErrors.join('\n  ')}`,
          EXIT.configInvalid,
          'supercharge config edit',
        );
      const compat = await checkAoeCompat(x);
      if (!compat.ok)
        throw new CliError(compat.message ?? 'AoE is not compatible.', EXIT.aoeIncompatible, compat.fix);
      await ensureConfigFile(x.paths);
      await ensureToken(x.paths);
      const tools = await Promise.all(
        ['aoe', 'tmux', 'git', 'glab', 'claude', x.config.aoe.binary, x.config.mr.gitlab.glabBinary].map(
          (b) => which(b),
        ),
      );
      const svc = serviceManager(x.paths);
      await svc.install({
        nodePath: process.execPath,
        cliPath: realpathSync(process.argv[1]!),
        pathEnv: await servicePathEnv(tools),
        logsDir: x.paths.logsDir,
        home: x.paths.home,
      });
      await svc.start();
      const skills = await installUserSkills(x.paths, VERSION);
      out(`${sym.ok} Service installed (${svc.kind}): ${svc.file}`);
      for (const s of skills.filter((k) => k.state === 'installed' || k.state === 'updated'))
        out(`${sym.ok} Skill ${s.state}: ${s.dir}`);
      for (const s of skills.filter((k) => k.state === 'user-modified' || k.state === 'user-owned'))
        out(`${sym.warn} Left your ${s.name} skill alone (${s.state})`);
      if (await waitForDaemon(x)) {
        out(`${sym.ok} Dashboard: ${dashboardOrigin(x.config)}`);
        out(`  Sign in on this machine with: ${c.bold('supercharge open')}`);
      } else {
        throw new CliError(
          'The service started but the daemon did not answer.',
          EXIT.error,
          'supercharge logs -n 50',
        );
      }
    });

  program
    .command('stop')
    .description('stop the background service')
    .action(async () => {
      const x = await ctx();
      await serviceManager(x.paths).stop();
      out(`${sym.ok} Stopped`);
    });

  program
    .command('restart')
    .description('restart the background service')
    .action(async () => {
      const x = await ctx();
      const svc = serviceManager(x.paths);
      const st = await svc.status();
      if (!st.installed) throw new CliError('The service is not installed.', EXIT.error, 'supercharge start');
      await svc.restart();
      out(
        (await waitForDaemon(x))
          ? `${sym.ok} Restarted`
          : `${sym.warn} Restarted, but the daemon is not answering yet (supercharge logs)`,
      );
    });

  program
    .command('status')
    .description('daemon, AoE and project overview; --project gives the control-chat status')
    .option('-p, --project <name>', 'one project, in the control-chat format')
    .option('--json', 'machine-readable output')
    .action(async (o: { project?: string; json?: boolean }) => {
      const x = await ctx();
      if (o.project) return statusProject(x, o.project, !!o.json);
      return statusOverview(x, !!o.json);
    });

  program
    .command('logs')
    .description('show daemon logs')
    .option('-f, --follow', 'keep printing new lines')
    .option('-n, --lines <n>', 'lines to show', '100')
    .option('--raw', 'print raw JSON lines')
    .action(async (o: { follow?: boolean; lines: string; raw?: boolean }) => {
      const x = await ctx();
      await showLogs(x.paths.logFile, Number(o.lines) || 100, !!o.follow, !!o.raw);
    });

  program
    .command('open')
    .description('sign in and open the dashboard in your browser')
    .option('--print', 'print the one-time sign-in URL instead of opening it')
    .action(async (o: { print?: boolean }) => {
      const x = await ctx();
      if (!(await daemonHealth(x)))
        throw new CliError('The daemon is not running.', EXIT.error, 'supercharge start');
      const r = await daemonRequest<{ nonce: string }>(x, 'POST', '/api/auth/nonce');
      if (!r || r.status !== 200)
        throw new CliError('The daemon refused the sign-in request.', EXIT.error, 'supercharge doctor');
      const url = `${dashboardOrigin(x.config)}/auth/callback?nonce=${r.body.nonce}`;
      if (o.print) out(url);
      else {
        openUrl(url);
        out(`${sym.ok} Opening ${dashboardOrigin(x.config)}`);
      }
    });

  const config = program.command('config').description('read and change ~/.config/supercharge/config.toml');
  config
    .command('get [key]')
    .description('print a value (or the whole effective config)')
    .action(async (key?: string) => {
      const x = await ctx();
      if (x.configErrors.length)
        throw new CliError(x.configErrors.join('\n'), EXIT.configInvalid, 'supercharge config edit');
      const v = key ? getByPath(x.config, key) : x.config;
      if (v === undefined) throw new CliError(`Unknown key "${key}".`, EXIT.usage);
      out(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    });
  config
    .command('set <key> <value>')
    .description('validate and write a value (comments are preserved)')
    .action(async (key: string, value: string) => {
      const x = await ctx();
      try {
        const r = await setConfigValue(x.paths, key, value);
        out(
          r.changedKeys.length
            ? `${sym.ok} ${key} = ${JSON.stringify(getByPath(r.config, key))}`
            : `${sym.info} ${key} unchanged`,
        );
        if (r.restartRequired.length) out(`${sym.warn} Restart required: supercharge restart`);
      } catch (e) {
        if (e instanceof ConfigValidationError) throw new CliError(e.issues.join('\n'), EXIT.usage);
        throw e;
      }
    });
  config
    .command('edit')
    .description('open config.toml in $EDITOR and validate on save')
    .action(async () => {
      const x = await ctx();
      await ensureConfigFile(x.paths);
      const file = x.paths.configFile;
      await copyFile(file, `${file}.bak`);
      for (;;) {
        await new Promise<void>((res) => {
          const ed = (process.env.VISUAL || process.env.EDITOR || 'vi').split(' ');
          spawn(ed[0]!, [...ed.slice(1), file], { stdio: 'inherit' }).on('exit', () => res());
        });
        const l = await loadConfig(x.paths);
        if (!l.errors.length) {
          out(`${sym.ok} config.toml is valid`);
          return;
        }
        out(`${sym.fail} config.toml is invalid:\n  ${l.errors.join('\n  ')}`);
        if (!(await confirm('Edit again?', true))) {
          await copyFile(`${file}.bak`, file);
          out(`${sym.info} Restored the previous version (${file}.bak)`);
          return;
        }
      }
    });
  config
    .command('path')
    .description('print the config file path')
    .action(async () => out((await ctx()).paths.configFile));

  program
    .command('doctor')
    .description('check every dependency and setting, with fixes')
    .option('--json', 'machine-readable output')
    .action(async (o: { json?: boolean }) => {
      const checks = await runDoctor(await ctx());
      if (o.json) json(checks);
      else printDoctor(checks);
      process.exitCode = checks.some((ch) => ch.status === 'fail') ? EXIT.error : EXIT.ok;
    });

  program
    .command('aoe')
    .description('Agent of Empires version management')
    .command('upgrade')
    .description('test the latest AoE in a sandbox, then upgrade and widen the allowed range')
    .option('--check', 'only report whether an upgrade is available and tested')
    .option('-y, --yes', 'upgrade without asking once the tests pass')
    .action(async (o: { check?: boolean; yes?: boolean }) => {
      process.exitCode = await aoeUpgrade(await ctx(), o);
    });

  program
    .command('proxy <action>')
    .description('opt-in clean URL without a port via local Caddy: enable | disable | status')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (action: string, o: { yes?: boolean }) => {
      if (!['enable', 'disable', 'status'].includes(action))
        throw new CliError('Use: supercharge proxy enable | disable | status', EXIT.usage);
      await proxyCommand(await ctx(), action as 'enable' | 'disable' | 'status', !!o.yes);
    });

  program
    .command('remove-project <name>')
    .description(
      'forget a project (its tasks, plans, comments and notes); --sessions also deletes them in AoE',
    )
    .option('--sessions', 'also delete its control chat and worker sessions in AoE')
    .option('--worktrees', 'with --sessions: delete their worktrees too')
    .option('--branches', 'with --sessions: delete their branches too')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(
      async (
        name: string,
        o: { sessions?: boolean; worktrees?: boolean; branches?: boolean; yes?: boolean },
      ) => {
        const x = await ctx();
        const what = o.sessions
          ? `the project "${name}" and its AoE sessions${o.worktrees ? ', worktrees' : ''}${o.branches ? ', branches' : ''}`
          : `the project "${name}" from Supercharge (AoE sessions are kept)`;
        if (!o.yes && !(await confirm(`Delete ${what}? This cannot be undone.`))) return;
        const r = await deleteProject(x, {
          name,
          deleteSessions: !!o.sessions,
          deleteWorktrees: !!o.sessions && !!o.worktrees,
          deleteBranches: !!o.sessions && !!o.branches,
          actor: 'cli',
        });
        out(
          `${sym.ok} Removed ${r.project} (${r.tasks} tasks)${r.deleted.length ? `, deleted ${r.deleted.length} AoE sessions` : ''}`,
        );
        for (const f of r.failed) out(`${sym.warn} Could not delete ${f.sessionId}: ${f.error}`);
      },
    );

  program
    .command('uninstall')
    .description('remove the service and the Supercharge-managed skills')
    .option('--purge', 'also delete config, data (the ledger) and state')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (o: { purge?: boolean; yes?: boolean }) => {
      const x = await ctx();
      const svc = serviceManager(x.paths);
      await svc.uninstall();
      out(`${sym.ok} Removed ${svc.file}`);
      for (const s of await removeUserSkills(x.paths, VERSION)) {
        out(
          s.state === 'missing'
            ? `${sym.ok} Removed skill ${s.dir}`
            : `${sym.info} Kept ${s.dir} (${s.state})`,
        );
      }
      if (o.purge) {
        const dirs = [x.paths.configDir, x.paths.dataDir, x.paths.stateDir];
        out(`This deletes:\n  ${dirs.join('\n  ')}`);
        if (o.yes || (await confirm('Delete these directories, including the task ledger?'))) {
          for (const d of dirs) await rm(d, { recursive: true, force: true });
          out(`${sym.ok} Purged`);
        }
      }
    });

  // ── workflow ──
  program
    .command('init')
    .description('register this repository and create its control session in AoE')
    .option('--name <slug>', 'project name (default: directory name)')
    .option('--commit', 'also commit the skills and a CLAUDE.md block into the repository')
    .option('--json', 'machine-readable output')
    .action(async (o: { name?: string; commit?: boolean; json?: boolean }) => {
      const r = await initProject(await ctx(), { cwd: cwd(), name: o.name, commit: o.commit });
      if (o.json) return json(r);
      out(`${sym.ok} Project ${c.bold(r.project.name)} (${r.project.repoPath})`);
      out(
        `${sym.ok} Control session ${r.project.controlSessionId}${r.controlCreated ? ' created' : ' already running'}`,
      );
      out(
        r.committed
          ? `${sym.ok} Committed skills and CLAUDE.md block`
          : `${sym.info} Nothing written to the repository (user-level skills)`,
      );
      for (const w of r.warnings) out(`${sym.warn} ${w}`);
    });

  const task = program.command('task').description('create and list tasks');
  task
    .command('new <title>')
    .description('create a branch, worktree, AoE worker session and ledger entry')
    .option('-p, --project <name>', 'project (default: the one for this repository)')
    .option('--brief <text>', 'task brief')
    .option('--brief-file <path>', 'read the brief from a file')
    .option('--base <branch>', 'base branch')
    .option('--json', 'machine-readable output')
    .action(
      async (
        title: string,
        o: { project?: string; brief?: string; briefFile?: string; base?: string; json?: boolean },
      ) => {
        const x = await ctx();
        const brief = o.briefFile ? await readFile(o.briefFile, 'utf8') : o.brief;
        const who = await whoami(x, cwd()).catch(() => null);
        const t = await newTask(x, {
          cwd: cwd(),
          title,
          project: o.project,
          brief,
          base: o.base,
          actor: who?.role === 'control' ? 'control' : 'user',
        });
        if (o.json)
          return json({
            id: t.id,
            project: t.project,
            branch: t.branch,
            worktree: t.worktreePath,
            aoeSessionId: t.aoeSessionId,
            stage: t.stage,
            warnings: t.warnings ?? [],
          });
        for (const w of t.warnings ?? []) out(`${sym.warn} ${w}`);
        out(`${sym.ok} ${c.bold(t.id)} ${t.title}`);
        out(`  branch   ${t.branch} (from ${t.baseBranch})`);
        out(`  worktree ${t.worktreePath}`);
        out(`  session  ${t.aoeSessionId}`);
      },
    );
  task
    .command('list')
    .description('list tasks')
    .option('-p, --project <name>')
    .option('--json')
    .action(async (o: { project?: string; json?: boolean }) => {
      const x = await ctx();
      const tasks = await x.ledger.listTasks(o.project);
      if (o.json) return json(tasks);
      if (!tasks.length) return out('No tasks yet. Create one with: supercharge task new "<title>"');
      for (const t of tasks)
        out(
          `${t.id.padEnd(9)} ${STAGE_LABEL[t.stage].padEnd(17)} ${t.title}  ${c.dim(relativeTime(t.updatedAt))}`,
        );
    });

  program
    .command('whoami')
    .description('show the role of this session (control | worker | none)')
    .option('--json')
    .action(async (o: { json?: boolean }) => {
      const { record: _r, projectRecord: _p, ...who } = await whoami(await ctx(), cwd());
      if (o.json) return json(who);
      out(`role     ${who.role}`);
      out(`project  ${who.project ?? 'none'}`);
      if (who.task) out(`task     ${who.task.id} ${who.task.title} (${STAGE_LABEL[who.task.stage]})`);
      out(`branch   ${who.branch ?? 'none'}`);
    });

  program
    .command('stage <stage>')
    .description(`report a stage change: ${STAGES.join(' | ')}`)
    .option('--note <text>', 'short note for the history')
    .option('--mr <url>', 'merge request URL (for mr_raised)')
    .addOption(new Option('--force', 'skip transition checks (reopening, corrections)').hideHelp())
    .action(async (stage: string, o: { note?: string; mr?: string; force?: boolean }) => {
      if (!isStage(stage))
        throw new CliError(`Unknown stage "${stage}".`, EXIT.usage, `Stages: ${STAGES.join(', ')}`);
      const t = await stageTask(await ctx(), {
        cwd: cwd(),
        stage,
        note: o.note,
        mrUrl: o.mr,
        force: o.force,
      });
      out(`${sym.ok} ${t.id} is now ${c.bold(STAGE_LABEL[t.stage])}`);
      if (t.stage === 'mr_raised')
        out(
          `  Supercharge watches ${t.mr?.url} from here; it moves the task to Ready for review when it is.`,
        );
    });

  program
    .command('ask <question>')
    .description('block this task on a question for the user')
    .option('-o, --option <answer>', 'a suggested answer the user can pick (repeat for more)', collect, [])
    .action(async (question: string, o: { option: string[] }) => {
      const t = await askQuestion(await ctx(), { cwd: cwd(), question, options: o.option });
      out(`${sym.ok} ${t.id} is blocked on your question. Stop now and wait for the answer.`);
    });

  program
    .command('plan <file>')
    .description('save the approved plan into the ledger ("-" reads stdin)')
    .option('--draft', 'save as a draft for review instead of approved')
    .action(async (file: string, o: { draft?: boolean }) => {
      const markdown = file === '-' ? await readStdin() : await readFile(file, 'utf8');
      const t = await savePlan(await ctx(), { cwd: cwd(), markdown, draft: o.draft });
      out(`${sym.ok} Plan saved for ${t.id} (${t.plan?.status})`);
    });

  program
    .command('reply <task-id> <message>')
    .description('send a reply to a worker (explicit, audited)')
    .option('-p, --project <name>')
    .option('-y, --yes', 'send without asking')
    .action(async (taskId: string, message: string, o: { project?: string; yes?: boolean }) => {
      const x = await ctx();
      const t = await findTask(x, taskId, o.project);
      out(`To ${c.bold(`${t.id} ${t.title}`)} (session ${t.aoeSessionId}):\n  ${message}`);
      if (!o.yes && !(await confirm('Send this prompt to the worker?'))) {
        out('Not sent.');
        return;
      }
      const who = await whoami(x, cwd()).catch(() => null);
      await replyToTask(x, {
        project: t.project,
        taskId: t.id,
        message,
        actor: who?.role === 'control' ? 'control' : 'cli',
      });
      out(`${sym.ok} Sent and recorded in the audit log`);
    });

  program
    .command('daemon', { hidden: true })
    .description('run the daemon in the foreground')
    .action(async () => {
      await runDaemon();
    });

  return program;
}

async function statusProject(x: Ctx, name: string, asJson: boolean) {
  let st: ProjectStatus | null = null;
  const r = await daemonRequest<ProjectStatus>(x, 'GET', `/api/projects/${encodeURIComponent(name)}/status`);
  if (r?.status === 200) st = r.body;
  else {
    const project = await x.ledger.getProject(name);
    if (!project) throw new CliError(`Unknown project "${name}".`, EXIT.usage);
    // Daemon down: read AoE directly. buildProjectStatus only needs id + status.
    const sessions = await x.aoe
      .listSessions()
      .then((list) => list.map((s) => ({ id: s.id, status: normalizeAoeStatus(s.status) }) as SessionView))
      .catch(() => null);
    st = buildProjectStatus(
      project,
      await x.ledger.listTasks(name),
      sessions,
      x.config.remoteControl.enabled,
    );
  }
  if (asJson) return json(st);
  out(
    `${c.bold(st.project)}  control ${LIVE_STATUS_LABEL[st.control.status as keyof typeof LIVE_STATUS_LABEL] ?? st.control.status}${st.control.remoteControl ? ', Remote Control on' : ''}`,
  );
  out(
    `  ${
      STAGES.filter((s) => st!.counts[s])
        .map((s) => `${STAGE_LABEL[s]} ${st!.counts[s]}`)
        .join('   ') || 'No tasks yet'
    }`,
  );
  for (const b of st.blocked)
    out(`  ${sym.warn} ${b.taskId} blocked ${relativeTime(b.since)}: ${b.question}`);
  for (const rdy of st.readyForReview) out(`  ${sym.ok} ${rdy.taskId} ready for review ${rdy.mrUrl ?? ''}`);
  for (const f of st.failingPipelines) out(`  ${sym.fail} ${f.taskId} pipeline failed ${f.mrUrl ?? ''}`);
}

async function statusOverview(x: Ctx, asJson: boolean) {
  const svc = await serviceManager(x.paths)
    .status()
    .catch(() => null);
  const health = await daemonHealth(x);
  const snap = health
    ? await daemonRequest<{
        health: {
          aoe: { state: string; message: string | null; serveVersion: string | null };
          daemon: { rssMb: number };
        };
      }>(x, 'GET', '/api/snapshot')
    : null;
  const installed = await x.aoeCli.version();
  const compat = await checkAoeCompat(x, installed);
  const projects = await x.ledger.listProjects();
  const tasks = await x.ledger.listTasks();
  const data = {
    daemon: {
      running: !!health,
      version: health?.version ?? null,
      url: dashboardOrigin(x.config),
      service: svc?.detail ?? 'unknown',
      rssMb: snap?.body?.health?.daemon.rssMb ?? null,
    },
    aoe: { installed, compatible: compat.ok, range: compat.range, serve: snap?.body?.health?.aoe ?? null },
    projects: projects.map((p) => ({
      name: p.name,
      repo: p.repoPath,
      tasks: tasks.filter((t) => t.project === p.name).length,
      blocked: tasks.filter((t) => t.project === p.name && t.stage === 'blocked').length,
      ready: tasks.filter((t) => t.project === p.name && t.stage === 'ready_for_review').length,
    })),
  };
  if (asJson) return json(data);
  out(
    `${health ? sym.ok : sym.fail} daemon   ${health ? `running v${health.version} at ${data.daemon.url}${data.daemon.rssMb ? ` (${data.daemon.rssMb} MB)` : ''}` : 'not running (supercharge start)'}`,
  );
  out(`${svc?.loaded ? sym.ok : sym.warn} service  ${svc?.detail ?? 'unknown'}`);
  out(
    `${compat.ok ? sym.ok : sym.fail} aoe      ${installed ?? 'not installed'} ${compat.ok ? `(within ${compat.range})` : `(${compat.message})`}`,
  );
  if (snap?.body?.health?.aoe)
    out(
      `  aoe serve ${snap.body.health.aoe.state}${snap.body.health.aoe.message ? `: ${snap.body.health.aoe.message}` : ''}`,
    );
  if (!projects.length) out(`${sym.info} No projects yet. Run "supercharge init" inside a repository.`);
  for (const p of data.projects)
    out(
      `  ${c.bold(p.name.padEnd(20))} ${p.tasks} task(s)${p.blocked ? `, ${p.blocked} blocked` : ''}${p.ready ? `, ${p.ready} ready for review` : ''}`,
    );
}

function formatLogLine(line: string, raw: boolean): string {
  if (raw) return line;
  try {
    const { time, level, msg, ...rest } = JSON.parse(line) as Record<string, unknown>;
    const lv = String(level);
    const colored = lv === 'error' ? c.red(lv) : lv === 'warn' ? c.yellow(lv) : c.dim(lv);
    const extra = Object.entries(rest)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    return `${c.dim(String(time).replace('T', ' ').slice(0, 19))} ${colored.padEnd(5)} ${msg} ${c.dim(extra)}`;
  } catch {
    return line;
  }
}

async function showLogs(file: string, lines: number, follow: boolean, raw: boolean) {
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch {
    out(`No logs yet at ${file}`);
    if (!follow) return;
  }
  for (const l of text.split('\n').filter(Boolean).slice(-lines)) out(formatLogLine(l, raw));
  if (!follow) return;
  let pos = (await stat(file).catch(() => ({ size: 0 }))).size;
  for await (const _ of fsWatch(file)) {
    const size = (await stat(file).catch(() => ({ size: 0 }))).size;
    if (size < pos) pos = 0;
    if (size === pos) continue;
    const fh = await open(file, 'r');
    const buf = Buffer.alloc(size - pos);
    await fh.read(buf, 0, buf.length, pos);
    await fh.close();
    pos = size;
    for (const l of buf.toString('utf8').split('\n').filter(Boolean)) out(formatLogLine(l, raw));
  }
}
