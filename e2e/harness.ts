import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeSession, startFakeAoe, type FakeAoe } from '../packages/fake-aoe/src/server.ts';

/**
 * Demo / E2E world: a fake AoE, two real git repos, and a ledger built through the real CLI
 * (init, task new, stage, ask, plan), so every screen has realistic data. Used by Playwright and
 * by `npm run demo`.
 */
const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'packages/cli/dist/supercharge.mjs');
const SHIMS = join(ROOT, 'packages/fake-aoe/bin');

export interface Demo {
  dir: string;
  env: NodeJS.ProcessEnv;
  port: number;
  fake: FakeAoe;
  daemon: ChildProcess;
  baseUrl: string;
  signInUrl: () => Promise<string>;
  stop: () => Promise<void>;
}

/** Async on purpose: the fake AoE server lives in this process, so blocking calls would deadlock the shim. */
function sc(
  env: NodeJS.ProcessEnv,
  args: string[],
  cwd: string,
  extra: NodeJS.ProcessEnv = {},
  input?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...extra } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.stdin.end(input ?? '');
    child.on('close', (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`supercharge ${args.join(' ')} failed (${code}): ${err.trim()}`)),
    );
  });
}

function repo(dir: string, name: string, remote: string): string {
  const path = join(dir, 'code', name);
  mkdirSync(path, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: path, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(path, 'README.md'), `# ${name}\n`);
  git('add', '.');
  git('-c', 'user.email=demo@example.invalid', '-c', 'user.name=demo', 'commit', '-q', '-m', 'init');
  git('remote', 'add', 'origin', remote);
  return path;
}

const mrJson = (
  iid: number,
  path: string,
  state: string,
  pipeline: string | null,
  extra: Record<string, unknown> = {},
) =>
  JSON.stringify({
    iid,
    state,
    draft: false,
    web_url: `https://gitlab.example.com/${path}/-/merge_requests/${iid}`,
    detailed_merge_status: state === 'opened' ? 'not_approved' : 'not_open',
    head_pipeline: pipeline ? { status: pipeline } : null,
    ...extra,
  });

const unresolved = (n: number) =>
  JSON.stringify([
    ...Array.from({ length: n }, () => ({ notes: [{ resolvable: true, resolved: false }] })),
    { notes: [{ resolvable: false, resolved: null }] },
  ]);

export async function startDemo(opts: {
  dir: string;
  port: number;
  aoePort?: number;
  log?: boolean;
}): Promise<Demo> {
  rmSync(opts.dir, { recursive: true, force: true });
  mkdirSync(opts.dir, { recursive: true });
  const glabDir = join(opts.dir, 'glab');
  mkdirSync(glabDir, { recursive: true });
  const fake = await startFakeAoe({ port: opts.aoePort });
  const { AOE_INSTANCE_ID: _a, SUPERCHARGE_SERVICE: _b, SUPERCHARGE_SUPERVISED: _c, ...base } = process.env;
  const env: NodeJS.ProcessEnv = {
    ...base,
    HOME: opts.dir,
    XDG_CONFIG_HOME: join(opts.dir, '.config'),
    XDG_DATA_HOME: join(opts.dir, '.local/share'),
    XDG_STATE_HOME: join(opts.dir, '.local/state'),
    CLAUDE_CONFIG_DIR: join(opts.dir, '.claude'),
    PATH: `${SHIMS}:${process.env.PATH}`,
    FAKE_AOE_URL: fake.url,
    FAKE_GLAB_DIR: glabDir,
    NO_COLOR: '1',
    GIT_AUTHOR_NAME: 'demo',
    GIT_AUTHOR_EMAIL: 'demo@example.invalid',
    GIT_COMMITTER_NAME: 'demo',
    GIT_COMMITTER_EMAIL: 'demo@example.invalid',
  };
  const home = opts.dir;
  for (const [k, v] of [
    ['server.port', String(opts.port)],
    ['mr.gitlab.hosts', 'gitlab.com,gitlab.example.com'],
    ['poll.mr', '10'],
    ['poll.aoeSessions', '1'],
    ['poll.aoeSessionsIdle', '2'],
    ['notifications.enabled', 'false'],
    ['notifications.waitingDebounceSeconds', '0'],
    ['remoteControl.enabled', 'true'],
  ] as const)
    await sc(env, ['config', 'set', k, v], home);

  // Pre-existing AoE sessions Supercharge doesn't manage (like a hand-made control + workers setup).
  const opsParent = makeSession({
    title: 'ops control',
    project_path: join(home, 'code/ops'),
    status: 'Idle',
    group_path: 'ops',
  });
  fake.state.sessions.push(
    opsParent,
    makeSession({
      title: 'release notes 4.2',
      project_path: join(home, 'code/ops-worktrees/release-notes'),
      branch: 'docs/release-notes-4-2',
      parent_session_id: opsParent.id,
      status: 'Running',
      group_path: 'ops',
    }),
    makeSession({
      title: 'flaky e2e triage',
      project_path: join(home, 'code/ops-worktrees/e2e'),
      branch: 'fix/flaky-e2e',
      parent_session_id: opsParent.id,
      status: 'Idle',
      group_path: 'ops',
    }),
    makeSession({ title: 'scratch', project_path: join(home, 'scratch'), status: 'Stopped' }),
  );

  // Project 1: northwind-web
  const nw = repo(home, 'northwind-web', 'git@gitlab.example.com:northwind/web.git');
  await sc(env, ['init', '--json'], nw);
  const tasks: Record<string, { id: string; branch: string; worktree: string; aoeSessionId: string }> = {};
  const add = async (key: string, cwd: string, title: string, brief: string) => {
    tasks[key] = JSON.parse(await sc(env, ['task', 'new', title, '--brief', brief, '--json'], cwd));
  };
  await add(
    'templates',
    nw,
    'Build page templates',
    'Header, listing and detail templates in the CMS. Match the approved Figma frames.',
  );
  await add(
    'content',
    nw,
    'Content entry for launch pages',
    'Enter the final copy for the 12 launch pages from the client deck.',
  );
  await add(
    'a11y',
    nw,
    'Accessibility audit (WCAG 2.2 AA)',
    'Audit every template before handover. Fix contrast, focus order and alt text.',
  );
  await add(
    'hosting',
    nw,
    'Set up hosting and repository',
    'Staging and production environments, CI pipeline, branch protection.',
  );
  await add(
    'qa',
    nw,
    'QA and browser testing',
    'Chrome, Safari, Firefox and mobile Safari on the launch pages.',
  );
  await add(
    'dns',
    nw,
    'DNS cutover runbook',
    'Runbook for the 06:00 to 08:00 GMT cutover window, with rollback.',
  );

  const as = (k: string, args: string[], input?: string, worker = true) =>
    sc(env, args, tasks[k]!.worktree, worker ? { AOE_INSTANCE_ID: tasks[k]!.aoeSessionId } : {}, input);
  const plan = (k: string, body: string, draft = false) =>
    as(k, ['plan', '-', ...(draft ? ['--draft'] : [])], body);
  const mrUrl = (iid: number, path: string) => `https://gitlab.example.com/${path}/-/merge_requests/${iid}`;

  await plan(
    'templates',
    '# Plan: page templates\n\n1. Header and navigation component\n2. Listing template with filters\n3. Detail template\n4. Storybook stories and visual tests\n\n**Out of scope:** content entry.\n',
  );
  await as('templates', ['stage', 'implementing']);
  await as('templates', ['stage', 'verifying', '--note', 'Storybook and visual tests green']);
  await as('templates', ['stage', 'mr_raised', '--mr', mrUrl(41, 'northwind/web')]);
  writeFileSync(join(glabDir, 'mr-41.json'), mrJson(41, 'northwind/web', 'opened', 'running'));
  writeFileSync(join(glabDir, 'discussions-41.json'), unresolved(2));

  await plan(
    'content',
    '# Plan: content entry\n\n- Enter copy for the 12 launch pages\n- Flag any copy that breaks the templates\n',
  );
  await as('content', ['stage', 'implementing']);
  await as('content', [
    'ask',
    "Is the client's copy deck from Friday final, or should I wait for the revised one?",
  ]);

  await plan(
    'a11y',
    '# Plan: accessibility audit\n\n| Area | Check |\n|---|---|\n| Contrast | All text >= 4.5:1 |\n| Focus | Visible focus, logical order |\n| Images | Meaningful alt text |\n',
  );
  await as('a11y', ['stage', 'implementing', '--note', 'Starting with the header and listing']);

  await plan(
    'hosting',
    '# Plan: hosting\n\n1. Staging on the client account\n2. CI pipeline with preview deploys\n3. Branch protection on main\n',
  );
  await as('hosting', ['stage', 'implementing']);
  await as('hosting', ['stage', 'verifying']);
  await as('hosting', ['stage', 'mr_raised', '--mr', mrUrl(38, 'northwind/web')]);
  writeFileSync(
    join(glabDir, 'mr-38.json'),
    mrJson(38, 'northwind/web', 'opened', 'success', { detailed_merge_status: 'mergeable' }),
  );
  writeFileSync(join(glabDir, 'discussions-38.json'), unresolved(0));

  await plan('qa', '# Draft: QA plan\n\n- Browser matrix\n- Mobile Safari on iOS 26\n', true);

  await plan(
    'dns',
    '# Plan: DNS cutover\n\n1. Lower TTLs 48h before\n2. Cutover at 06:00 GMT\n3. Rollback if errors > 1%\n',
  );
  await as('dns', ['stage', 'implementing']);
  await as('dns', ['stage', 'verifying']);
  await as('dns', ['stage', 'mr_raised', '--mr', mrUrl(35, 'northwind/web')]);
  writeFileSync(join(glabDir, 'mr-35.json'), mrJson(35, 'northwind/web', 'merged', 'success'));
  writeFileSync(join(glabDir, 'discussions-35.json'), unresolved(0));

  // Project 2: apollo-api
  const ap = repo(home, 'apollo-api', 'git@gitlab.example.com:apollo/api.git');
  await sc(env, ['init', '--json'], ap);
  await add(
    'ratelimit',
    ap,
    'Rate limit the export endpoint',
    'Per-tenant token bucket on /export, 429 with Retry-After.',
  );
  await add('node24', ap, 'Upgrade to Node 24', 'Bump engines, CI images and the Docker base image.');
  await plan(
    'ratelimit',
    '# Plan: rate limiting\n\n1. Token bucket in Redis\n2. 429 with Retry-After\n3. Load test\n',
  );
  await as('ratelimit', ['stage', 'implementing']);
  await as('ratelimit', ['stage', 'verifying', '--note', 'Load test running']);
  await plan('node24', '# Plan: Node 24\n\n- engines, .nvmrc, CI image, Dockerfile\n');
  await as('node24', ['stage', 'implementing']);
  await as('node24', ['stage', 'verifying']);
  await as('node24', ['stage', 'mr_raised', '--mr', mrUrl(12, 'apollo/api')]);
  writeFileSync(join(glabDir, 'mr-12.json'), mrJson(12, 'apollo/api', 'opened', 'failed'));
  writeFileSync(join(glabDir, 'discussions-12.json'), unresolved(1));

  // Live AoE statuses.
  const setStatus = (id: string, patch: Record<string, unknown>) => {
    const s = fake.state.sessions.find((x) => x.id === id);
    if (s) Object.assign(s, patch);
  };
  for (const t of Object.values(tasks)) setStatus(t.aoeSessionId, { status: 'Idle' });
  setStatus(tasks.templates!.aoeSessionId, { status: 'Waiting' });
  setStatus(tasks.a11y!.aoeSessionId, { status: 'Running' });
  setStatus(tasks.ratelimit!.aoeSessionId, { status: 'Running' });
  setStatus(tasks.qa!.aoeSessionId, { status: 'Running' });
  const controls = fake.state.sessions.filter(
    (s) => s.title.endsWith(' control') && s.group_path.startsWith('supercharge/'),
  );
  for (const c of controls)
    setStatus(
      c.id,
      c.title.startsWith('northwind') ? { status: 'Idle', unread: true } : { status: 'Running' },
    );

  const daemon = spawn(process.execPath, [CLI, 'daemon'], {
    env: { ...env, SUPERCHARGE_LOG_STDERR: opts.log ? '1' : '0', SUPERCHARGE_DEMO: '1' },
    stdio: opts.log ? 'inherit' : 'ignore',
  });
  const baseUrl = `http://supercharge.localhost:${opts.port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${opts.port}/healthz`)).ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    dir: opts.dir,
    env,
    port: opts.port,
    fake,
    daemon,
    baseUrl,
    signInUrl: async () => (await sc(env, ['open', '--print'], home)).trim(),
    stop: async () => {
      daemon.kill('SIGTERM');
      await fake.stop();
    },
  };
}
