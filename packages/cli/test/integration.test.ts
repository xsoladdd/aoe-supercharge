import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Snapshot, TaskRecord } from '@aoe-supercharge/core/shared';
import { startFakeAoe, type FakeAoe } from '../../fake-aoe/src/server.ts';

const ROOT = join(import.meta.dirname, '../../..');
const CLI = join(ROOT, 'packages/cli/dist/supercharge.mjs');
const SHIMS = join(ROOT, 'packages/fake-aoe/bin');

let fake: FakeAoe;
let home: string;
let repo: string;
let glabDir: string;
let env: NodeJS.ProcessEnv;
let port: number;
let daemon: ChildProcess | null = null;

interface Res {
  code: number | null;
  stdout: string;
  stderr: string;
}

function sc(
  args: string[],
  opts: { cwd?: string; extraEnv?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<Res> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: opts.cwd ?? repo,
      env: { ...env, ...opts.extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(opts.input ?? '');
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(250);
  }
}

const taskFile = (id: string) =>
  join(home, '.local/share/supercharge/projects/northwind/tasks', id, 'task.json');
const readTask = async (id: string) => JSON.parse(await readFile(taskFile(id), 'utf8')) as TaskRecord;

beforeAll(async () => {
  if (!existsSync(CLI))
    execFileSync('npm', ['run', 'build', '-w', 'aoe-supercharge'], { cwd: ROOT, stdio: 'ignore' });
  fake = await startFakeAoe();
  home = await mkdtemp(join(tmpdir(), 'sc-int-'));
  repo = join(home, 'code', 'northwind');
  glabDir = join(home, 'glab');
  await mkdir(repo, { recursive: true });
  await mkdir(glabDir, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git(
    '-c',
    'user.email=t@example.invalid',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  );
  git('remote', 'add', 'origin', 'git@gitlab.example.com:acme/northwind.git');
  port = await freePort();
  const { AOE_INSTANCE_ID: _a, SUPERCHARGE_SERVICE: _b, SUPERCHARGE_SUPERVISED: _c, ...base } = process.env;
  env = {
    ...base,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    PATH: `${SHIMS}:${process.env.PATH}`,
    FAKE_AOE_URL: fake.url,
    FAKE_GLAB_DIR: glabDir,
    NO_COLOR: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
  };
  for (const [k, v] of [
    ['server.port', String(port)],
    ['mr.gitlab.hosts', 'gitlab.com,gitlab.example.com'],
    ['poll.mr', '10'],
    ['poll.aoeSessions', '1'],
    ['poll.aoeSessionsIdle', '1'],
    ['notifications.enabled', 'false'],
    ['notifications.waitingDebounceSeconds', '0'],
  ]) {
    const r = await sc(['config', 'set', k!, v!]);
    expect(r.code, r.stderr).toBe(0);
  }
});

afterAll(async () => {
  daemon?.kill('SIGTERM');
  await fake?.stop();
  if (home) await rm(home, { recursive: true, force: true });
});

describe('workflow through the real CLI against fake AoE', () => {
  let controlId = '';
  let worker: { id: string; worktree: string; aoeSessionId: string; branch: string };

  it('init registers the project, creates the control session, installs user-level skills, leaves the repo untouched', async () => {
    const r = await sc(['init', '--json']);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    controlId = out.project.controlSessionId;
    expect(out.project.name).toBe('northwind');
    expect(out.project.idPrefix).toBe('NO');
    expect(fake.state.sessions.find((s) => s.id === controlId)?.title).toBe('northwind control');
    for (const s of ['supercharge-control', 'supercharge-worker']) {
      expect(existsSync(join(home, '.claude/skills', s, 'SKILL.md'))).toBe(true);
      expect(existsSync(join(home, '.claude/skills', s, '.supercharge-managed'))).toBe(true);
    }
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString()).toBe('');
    const again = await sc(['init', '--json']);
    expect(JSON.parse(again.stdout).controlCreated).toBe(false);
  });

  it('task new creates a worktree, a child session of the control chat, and a ledger entry', async () => {
    const r = await sc([
      'task',
      'new',
      'Build templates',
      '--brief',
      'Header, listing and detail templates.',
      '--json',
    ]);
    expect(r.code, r.stderr).toBe(0);
    worker = JSON.parse(r.stdout);
    expect(worker.id).toBe('NO-0001');
    expect(worker.branch).toBe('sc/no-0001-build-templates');
    expect(existsSync(worker.worktree)).toBe(true);
    expect(fake.state.sessions.find((s) => s.id === worker.aoeSessionId)?.parent_session_id).toBe(controlId);
    const t = await readTask('NO-0001');
    expect(t.stage).toBe('planning');
    expect(
      await readFile(
        join(home, '.local/share/supercharge/projects/northwind/tasks/NO-0001/session-prompt.md'),
        'utf8',
      ),
    ).toMatch(/Header, listing and detail templates/);
  });

  it('keeps a session AoE created but could not launch, and says how to finish', async () => {
    const r = await sc(['task', 'new', 'Hook consent missing', '--json'], {
      extraEnv: { FAKE_AOE_LAUNCH_FAIL: '1' },
    });
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.warnings[0]).toMatch(/could not launch it: launch failed: agent hook paths/);
    expect(out.warnings[0]).toMatch(/aoe session start [0-9a-f]{16}/);
    expect(fake.state.sessions.some((s) => s.id === out.aoeSessionId)).toBe(true);
    // Done with it: close it so later assertions about NO-0001 stay simple.
    expect((await sc(['stage', 'done'], { cwd: out.worktree })).code).toBe(0);
  });

  it('whoami identifies the worker and rejects a foreign session id', async () => {
    const ok = await sc(['whoami', '--json'], {
      cwd: worker.worktree,
      extraEnv: { AOE_INSTANCE_ID: worker.aoeSessionId },
    });
    expect(JSON.parse(ok.stdout)).toMatchObject({
      role: 'worker',
      project: 'northwind',
      actor: 'worker',
      task: { id: 'NO-0001' },
    });
    const control = await sc(['whoami', '--json'], { extraEnv: { AOE_INSTANCE_ID: controlId } });
    expect(JSON.parse(control.stdout).role).toBe('control');
    const bad = await sc(['whoami'], {
      cwd: worker.worktree,
      extraEnv: { AOE_INSTANCE_ID: 'ffffffffffffffff' },
    });
    expect(bad.code).toBe(4);
  });

  const asWorker = (args: string[], input?: string) =>
    sc(args, { cwd: worker.worktree, extraEnv: { AOE_INSTANCE_ID: worker.aoeSessionId }, input });

  it('rejects invalid transitions with exit 3 and a hint', async () => {
    const skip = await asWorker(['stage', 'verifying']);
    expect(skip.code).toBe(3);
    expect(skip.stderr).toMatch(/Can't go planning → verifying/);
    expect(skip.stderr).toMatch(/supercharge stage implementing/);
    const noPlan = await asWorker(['stage', 'implementing']);
    expect(noPlan.code).toBe(3);
    expect(noPlan.stderr).toMatch(/approved plan/);
  });

  it('plan from stdin, then implementing → verifying', async () => {
    expect((await asWorker(['plan', '-'], '# Plan\n\n1. Build header\n2. Build listing\n')).code).toBe(0);
    expect((await asWorker(['stage', 'implementing'])).code).toBe(0);
    expect((await asWorker(['stage', 'verifying', '--note', 'tests green'])).code).toBe(0);
    const t = await readTask('NO-0001');
    expect(t.plan?.status).toBe('approved');
    expect(t.history.map((h) => h.to)).toEqual(['planning', 'implementing', 'verifying']);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: worker.worktree }).toString()).toBe('');
  });

  it('ask blocks with the question; status --project (daemon down) shows it; returning answers it', async () => {
    expect((await asWorker(['ask', 'Which copy deck is final?'])).code).toBe(0);
    let t = await readTask('NO-0001');
    expect(t.stage).toBe('blocked');
    expect(t.blockedFrom).toBe('verifying');
    const st = JSON.parse((await sc(['status', '--project', 'northwind', '--json'])).stdout);
    expect(st.blocked[0]).toMatchObject({ taskId: 'NO-0001', question: 'Which copy deck is final?' });
    expect(st.counts.blocked).toBe(1);
    expect((await asWorker(['stage', 'verifying'])).code).toBe(0);
    t = await readTask('NO-0001');
    expect(t.openQuestion?.answeredAt).not.toBeNull();
  });

  it('reply is explicit and audited', async () => {
    const r = await sc(['reply', 'NO-0001', 'Use the deck from Friday.', '--yes']);
    expect(r.code, r.stderr).toBe(0);
    expect(fake.state.sent.at(-1)).toMatchObject({
      id: worker.aoeSessionId,
      message: 'Use the deck from Friday.',
    });
    const audit = await readFile(join(home, '.local/state/supercharge/audit.jsonl'), 'utf8');
    expect(audit).toMatch(/"action":"prompt_sent".*Use the deck from Friday/);
  });

  it('mr_raised auto-detects the MR via glab; daemon-only stages are refused', async () => {
    await writeFile(
      join(glabDir, 'mr-list.json'),
      JSON.stringify([
        {
          iid: 7,
          source_branch: worker.branch,
          web_url: 'https://gitlab.example.com/acme/northwind/-/merge_requests/7',
        },
      ]),
    );
    const r = await asWorker(['stage', 'mr_raised']);
    expect(r.code, r.stderr).toBe(0);
    expect((await readTask('NO-0001')).mr?.iid).toBe(7);
    const refused = await asWorker(['stage', 'ready_for_review']);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toMatch(/automatically/);
  });
});

describe('daemon: security, live state and the MR watcher', () => {
  const base = () => `http://127.0.0.1:${port}`;
  let bearer = '';

  beforeAll(async () => {
    daemon = spawn(process.execPath, [CLI, 'daemon'], {
      env: { ...env, SUPERCHARGE_SERVICE: 'test' },
      stdio: 'ignore',
    });
    await until(async () => (await fetch(`${base()}/healthz`)).ok);
    bearer = (await readFile(join(home, '.config/supercharge/auth.token'), 'utf8')).trim();
  });

  it('requires auth, gates the Host header, and sends strict headers', async () => {
    expect((await fetch(`${base()}/api/snapshot`)).status).toBe(401);
    // fetch() drops custom Host headers, so use a raw request for the DNS-rebinding gate.
    const evilStatus = await new Promise<number>((resolve) =>
      request({ host: '127.0.0.1', port, path: '/healthz', headers: { host: 'evil.example.com' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).end(),
    );
    expect(evilStatus).toBe(421);
    const ok = await fetch(`${base()}/api/snapshot`, { headers: { authorization: `Bearer ${bearer}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-security-policy')).toMatch(/frame-ancestors 'none'/);
    expect(ok.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('snapshot merges the ledger with AoE sessions (parent links from aoe list)', async () => {
    const snap = await until(async () => {
      const s = (await (
        await fetch(`${base()}/api/snapshot`, { headers: { authorization: `Bearer ${bearer}` } })
      ).json()) as Snapshot;
      return s.health.aoe.state === 'ok' && s.sessions.length >= 2 ? s : null;
    });
    expect(snap.projects[0]?.name).toBe('northwind');
    expect(snap.tasks[0]?.id).toBe('NO-0001');
    const w = snap.sessions.find((s) => s.id === snap.tasks[0]!.aoeSessionId);
    expect(w?.parentId).toBe(snap.projects[0]!.controlSessionId);
    expect(snap.health.aoe.serveVersion).toBe('1.17.2');
  });

  it('one-time nonce → httpOnly cookie; cookie writes need CSRF + Origin', async () => {
    const r = await sc(['open', '--print']);
    expect(r.code, r.stderr).toBe(0);
    const url = new URL(r.stdout.trim());
    const cb = await fetch(`${base()}${url.pathname}${url.search}`, { redirect: 'manual' });
    expect(cb.status).toBe(302);
    const cookie = cb.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const reuse = await fetch(`${base()}${url.pathname}${url.search}`, { redirect: 'manual' });
    expect(reuse.status).toBe(401);
    const jar = cookie.split(';')[0]!;
    expect((await fetch(`${base()}/api/snapshot`, { headers: { cookie: jar } })).status).toBe(200);
    const body = JSON.stringify({ patch: { ui: { theme: 'light' } } });
    const noCsrf = await fetch(`${base()}/api/config`, {
      method: 'PUT',
      headers: { cookie: jar, 'content-type': 'application/json' },
      body,
    });
    expect(noCsrf.status).toBe(403);
    const { token: csrf } = (await (
      await fetch(`${base()}/api/csrf`, { headers: { cookie: jar } })
    ).json()) as { token: string };
    const origin = `http://127.0.0.1:${port}`;
    const ok = await fetch(`${base()}/api/config`, {
      method: 'PUT',
      headers: { cookie: jar, 'content-type': 'application/json', 'x-csrf-token': csrf, origin },
      body,
    });
    expect(ok.status).toBe(200);
    expect(await readFile(join(home, '.config/supercharge/config.toml'), 'utf8')).toMatch(/theme = "light"/);
    const bad = await fetch(`${base()}/api/config`, {
      method: 'PUT',
      headers: { cookie: jar, 'content-type': 'application/json', 'x-csrf-token': csrf, origin },
      body: JSON.stringify({ patch: { server: { port: 80 } } }),
    });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { issues: string[] }).issues[0]).toMatch(/server.port/);
  });

  it('streams a snapshot first over SSE', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base()}/api/events`, {
      headers: { authorization: `Bearer ${bearer}` },
      signal: ctrl.signal,
    });
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
    ctrl.abort();
    expect(text).toMatch(/^event: snapshot$/m);
    expect(text).toMatch(/^id: \d+$/m);
    expect(text).toMatch(/^data: \{"seq":/m);
  });

  it('the MR watcher moves the task to ready_for_review and it shows in Needs you', async () => {
    await writeFile(
      join(glabDir, 'mr-7.json'),
      JSON.stringify({
        iid: 7,
        state: 'opened',
        draft: false,
        web_url: 'https://gitlab.example.com/acme/northwind/-/merge_requests/7',
        detailed_merge_status: 'mergeable',
        head_pipeline: { status: 'success' },
      }),
    );
    await writeFile(
      join(glabDir, 'discussions-7.json'),
      JSON.stringify([{ notes: [{ resolvable: true, resolved: true }] }]),
    );
    const t = await until(async () => {
      const x = await readTask('NO-0001');
      return x.stage === 'ready_for_review' ? x : null;
    }, 30_000);
    expect(t.history.slice(-2).map((h) => [h.to, h.by])).toEqual([
      ['watching_mr', 'daemon'],
      ['ready_for_review', 'daemon'],
    ]);
    const snap = await until(async () => {
      const s = (await (
        await fetch(`${base()}/api/snapshot`, { headers: { authorization: `Bearer ${bearer}` } })
      ).json()) as Snapshot;
      return s.needsYou.some((n) => n.kind === 'mr_ready') ? s : null;
    });
    expect(snap.needsYou.find((n) => n.kind === 'mr_ready')?.taskId).toBe('NO-0001');
  }, 40_000);

  it('a waiting worker session becomes an approval item', async () => {
    const snap0 = (await (
      await fetch(`${base()}/api/snapshot`, { headers: { authorization: `Bearer ${bearer}` } })
    ).json()) as Snapshot;
    await fetch(`${fake.url}/__fake/sessions/${snap0.tasks[0]!.aoeSessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'Waiting' }),
    });
    const snap = await until(async () => {
      const s = (await (
        await fetch(`${base()}/api/snapshot`, { headers: { authorization: `Bearer ${bearer}` } })
      ).json()) as Snapshot;
      return s.needsYou.some((n) => n.kind === 'approval') ? s : null;
    });
    expect(snap.needsYou.find((n) => n.kind === 'approval')?.taskId).toBe('NO-0001');
  });

  it('serves the project status in the control-chat format', async () => {
    const r = await sc(['status', '--project', 'northwind', '--json']);
    const st = JSON.parse(r.stdout);
    expect(st.readyForReview[0]).toMatchObject({ taskId: 'NO-0001' });
    expect(st.control.status).not.toBe('missing');
  });
});
