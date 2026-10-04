import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAoeVersion } from '@aoe-supercharge/core/node';
import { normalizeAoeStatus } from '@aoe-supercharge/core/shared';
import { run } from '../util/exec.ts';
import { AoeCli } from './cli.ts';
import { AoeClient } from './client.ts';
import { AoeAboutSchema, AoeCliListSchema, AoeSessionsResponseSchema } from './schemas.ts';

export interface ContractCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ContractResult {
  ok: boolean;
  version: string | null;
  checks: ContractCheck[];
  fixtures: Record<string, unknown>;
}

const KNOWN_STATUS = [
  'Running',
  'Waiting',
  'Idle',
  'Unknown',
  'Stopped',
  'Error',
  'Starting',
  'Deleting',
  'Creating',
];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Live contract test (SPEC §10.3): runs a real AoE binary in a sandbox (temporary HOME, separate
 * tmux socket, throwaway git repo, a stand-in agent instead of Claude) and checks every behaviour Supercharge
 * depends on. It never touches the real ~/.agent-of-empires, because a newer AoE may migrate data.
 */
export async function runLiveContract(
  aoeBin: string,
  log: (line: string) => void = () => {},
): Promise<ContractResult> {
  const checks: ContractCheck[] = [];
  const fixtures: Record<string, unknown> = {};
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
    return ok;
  };

  const root = await mkdtemp(join(tmpdir(), 'sc-contract-'));
  const home = join(root, 'home');
  const tmuxDir = join(root, 'tmux');
  const repo = join(root, 'repo');
  // Stand-in agent: AoE 1.17.2 only accepts known tools for -c, so we run `--tool claude` with
  // `--cmd-override` pointing here. It ignores the claude flags AoE appends and just reads input.
  const fakeAgent = join(root, 'bin', 'fake-agent');
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(fakeAgent, '#!/bin/sh\nexec cat >/dev/null\n');
  await chmod(fakeAgent, 0o755);
  await mkdir(home, { recursive: true });
  await mkdir(tmuxDir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    TMUX_TMPDIR: tmuxDir,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    TERM: 'xterm-256color',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    GIT_AUTHOR_NAME: 'contract',
    GIT_AUTHOR_EMAIL: 'contract@example.invalid',
    GIT_COMMITTER_NAME: 'contract',
    GIT_COMMITTER_EMAIL: 'contract@example.invalid',
  };
  const aoe = (args: string[], timeoutMs = 60_000) => run(aoeBin, args, { env, timeoutMs });
  let version: string | null = null;
  let serveStarted = false;
  let servePid: number | null = null;

  try {
    // Sandbox-only consent: a fresh AoE refuses to launch agents until its hook paths are acknowledged
    // (src/session/instance/hooks.rs). The flag goes into the throwaway HOME, never the real one, and
    // into AoE's XDG app dir, which it prefers once XDG_CONFIG_HOME is set (src/session/mod.rs).
    for (const dir of [join(home, '.config', 'agent-of-empires'), join(home, '.agent-of-empires')]) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'state.toml'), 'has_acknowledged_agent_hooks = true\n');
    }
    const v = await aoe(['--version']);
    version = v.code === 0 ? parseAoeVersion(v.stdout) : null;
    fixtures.cli_version = v.stdout.trim();
    if (!check('aoe --version', !!version, version ?? (v.stderr || v.error?.message || 'no output')))
      throw new Error('stop');

    // `aoe add -b` fetches the base branch from origin, so give the repo a local bare remote.
    const bareRemote = join(root, 'origin.git');
    await mkdir(repo, { recursive: true });
    for (const [cwd, args] of [
      [root, ['init', '-q', '--bare', '-b', 'main', bareRemote]],
      [repo, ['init', '-q', '-b', 'main']],
      [repo, ['commit', '-q', '--allow-empty', '-m', 'init']],
      [repo, ['remote', 'add', 'origin', bareRemote]],
      [repo, ['push', '-q', 'origin', 'main']],
    ] as const) {
      const r = await run('git', [...args], { cwd, env });
      if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
    }

    const port = await freePort();
    const serve = await aoe(['serve', '--daemon', '--port', String(port)], 60_000);
    serveStarted = serve.code === 0;
    servePid = Number(serve.stdout.match(/PID (\d+)/)?.[1]) || null;
    if (
      !check(
        'aoe serve --daemon',
        serveStarted,
        serveStarted ? `port ${port}` : (serve.stderr || serve.stdout).trim().slice(0, 300),
      )
    )
      throw new Error('stop');

    const cli = new AoeCli(aoeBin, 'default', env);
    let origin: string | null = null;
    for (let i = 0; i < 40 && !origin; i++) {
      origin = await cli.origin();
      if (!origin) await sleep(250);
    }
    if (!check('aoe url', !!origin, origin ?? 'no URL')) throw new Error('stop');
    const token = await cli.token();
    check('aoe url --token-only', !!token, token ? 'token present' : 'no token');

    // Profile: use whatever AoE considers default in a fresh HOME.
    const prof = await aoe(['profile', 'list']);
    const profile = prof.stdout.match(/\*\s+(\S+)/)?.[1] ?? 'default';
    cli.profile = profile;
    check('default profile', true, profile);

    const agent = ['--tool', 'claude', '--cmd-override', fakeAgent];
    const add1 = await aoe(['add', repo, '-t', 'contract control', ...agent, '-l', '-p', profile]);
    check('aoe add (control)', add1.code === 0, (add1.stderr || add1.stdout).trim().slice(0, 200) || 'ok');
    let list = AoeCliListSchema.parse(
      JSON.parse((await aoe(['list', '--json', '--state=live', '-p', profile])).stdout || '[]'),
    );
    const control = list.find((s) => s.title === 'contract control');
    if (!check('aoe list --json (control)', !!control, control ? control.id : 'control session missing'))
      throw new Error('stop');

    const add2 = await aoe([
      'add',
      repo,
      '-t',
      'contract worker',
      '-P',
      control!.id,
      '-w',
      'sc/contract-1',
      '-b',
      ...agent,
      '-l',
      '-p',
      profile,
    ]);
    check(
      'aoe add -P -w -b (worker)',
      add2.code === 0,
      (add2.stderr || add2.stdout).trim().slice(0, 200) || 'ok',
    );
    const rawList = (await aoe(['list', '--json', '--state=live', '-p', profile])).stdout;
    list = AoeCliListSchema.parse(JSON.parse(rawList || '[]'));
    fixtures.cli_list_json = JSON.parse(rawList || '[]');
    const worker = list.find((s) => s.title === 'contract worker');
    check(
      'parent_session_id',
      worker?.parent_session_id === control!.id,
      `${worker?.parent_session_id ?? 'missing'}`,
    );
    check(
      'worktree.branch',
      worker?.worktree?.branch === 'sc/contract-1',
      `${worker?.worktree?.branch ?? 'missing'}`,
    );
    check('worktree path', !!worker?.path && worker.path !== repo, worker?.path ?? 'missing');
    if (!worker) throw new Error('stop');

    const client = new AoeClient(cli, origin!);
    const about = await client.about();
    fixtures.GET_api_about = about;
    check(
      'GET /api/about',
      AoeAboutSchema.safeParse(about).success && about.version === version,
      `version ${about.version}`,
    );

    // aoe serve picks up CLI-created sessions after a short delay; wait for both.
    let sessions = await client.listSessions();
    for (
      let i = 0;
      i < 40 && ![control!.id, worker.id].every((id) => sessions.some((s) => s.id === id));
      i++
    ) {
      await sleep(250);
      sessions = await client.listSessions();
    }
    fixtures.GET_api_sessions = { sessions };
    check(
      'GET /api/sessions schema',
      AoeSessionsResponseSchema.safeParse({ sessions }).success,
      `${sessions.length} sessions`,
    );
    check(
      'GET /api/sessions contains both',
      [control!.id, worker.id].every((id) => sessions.some((s) => s.id === id)),
      'control + worker',
    );
    const unknown = sessions.map((s) => s.status ?? '').filter((s) => !KNOWN_STATUS.includes(s));
    check(
      'status enum',
      unknown.length === 0,
      unknown.length
        ? `new values: ${unknown.join(', ')}`
        : sessions.map((s) => `${s.status}→${normalizeAoeStatus(s.status)}`).join(', '),
    );

    const trap = await fetch(`${origin}/api/does-not-exist`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    check(
      'unknown /api path',
      !(trap.headers.get('content-type') ?? '').includes('application/json') || trap.status === 404,
      `${trap.status} ${trap.headers.get('content-type')}`,
    );

    const sent = await client.send(worker.id, 'echo supercharge-contract');
    check('POST /api/sessions/{id}/send', sent.sent === true, JSON.stringify(sent));

    const del = await client.deleteSession(worker.id, { deleteWorktree: true, deleteBranch: true });
    check('DELETE /api/sessions/{id}', ['deleted', 'kept'].includes(del.status), del.status);
    await client.deleteSession(control!.id, { deleteWorktree: false, deleteBranch: false }).catch(() => {});
  } catch (err) {
    if ((err as Error).message !== 'stop') check('unexpected error', false, (err as Error).message);
  } finally {
    if (serveStarted) await aoe(['serve', '--stop'], 30_000).catch(() => {});
    // Belt and braces: never leave a sandbox daemon behind, even if `serve --stop` can't find it.
    if (servePid) {
      try {
        process.kill(servePid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    await run('tmux', ['kill-server'], { env, timeoutMs: 10_000 }).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  return { ok: checks.length > 0 && checks.every((c) => c.ok), version, checks, fixtures };
}
