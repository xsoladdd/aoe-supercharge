import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ChatResponse, NoteRecord, Snapshot, TaskRecord } from '@aoe-supercharge/core/shared';
import type { HistoryRange } from '@aoe-supercharge/core/node';
import { KICKOFF_MESSAGE } from '../src/workflow.ts';
import {
  ASK_MENU,
  PERMISSION_MENU,
  PLAN_MENU,
  startFakeAoe,
  type FakeAoe,
} from '../../fake-aoe/src/server.ts';

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
  home = await mkdtemp(join(tmpdir(), 'sc-int-'));
  fake = await startFakeAoe({
    transcripts: { claudeDir: join(home, '.claude'), hooksDir: join(home, 'aoe-hooks') },
  });
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
  // Not from the session running these tests: CLAUDECODE would make every note Claude's.
  const {
    AOE_INSTANCE_ID: _a,
    SUPERCHARGE_SERVICE: _b,
    SUPERCHARGE_SUPERVISED: _c,
    CLAUDECODE: _d,
    ...base
  } = process.env;
  env = {
    ...base,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    SUPERCHARGE_AOE_HOOKS_DIR: join(home, 'aoe-hooks'),
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
    // Control chats run on Opus (agent.controlModel); workers get the model the control chat picks.
    expect(fake.state.sessions.find((s) => s.id === controlId)?.extra_args).toContain('--model opus');
    for (const s of ['supercharge-control', 'supercharge-worker', 'note', 'todo', 'gnote']) {
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
    // Every worker gets a medieval name, kept on its task.
    expect((worker as unknown as { name: string }).name).toMatch(/^[A-Z][a-z]+$/);
    expect((await readTask('NO-0001')).name).toBe((worker as unknown as { name: string }).name);
    // ...and its own desk in the office view.
    expect((await readTask('NO-0001')).desk).toBe(1);
    expect(worker.branch).toBe('sc/no-0001-build-templates');
    expect(existsSync(worker.worktree)).toBe(true);
    expect(fake.state.sessions.find((s) => s.id === worker.aoeSessionId)?.parent_session_id).toBe(controlId);
    const t = await readTask('NO-0001');
    expect(t.stage).toBe('planning');
    // Claude Code waits for a first message, so the worker is sent one once it is at its prompt.
    expect(fake.state.sent.filter((m) => m.id === worker.aoeSessionId).map((m) => m.message)).toEqual([
      KICKOFF_MESSAGE,
    ]);
    expect(t.kickoffAt).toBeTruthy();
    const audit = await readFile(join(home, '.local/state/supercharge/audit.jsonl'), 'utf8');
    expect(audit).toMatch(/"actor":"cli","action":"prompt_sent","project":"northwind","taskId":"NO-0001"/);
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
    const ask = ['ask', 'Which copy deck is final?', '--option', 'Friday', '--option', 'Revised'];
    expect((await asWorker(ask)).code).toBe(0);
    let t = await readTask('NO-0001');
    expect(t.stage).toBe('blocked');
    expect(t.openQuestion?.options).toEqual(['Friday', 'Revised']);
    expect(t.blockedFrom).toBe('verifying');
    const st = JSON.parse((await sc(['status', '--project', 'northwind', '--json'])).stdout);
    expect(st.blocked[0]).toMatchObject({
      taskId: 'NO-0001',
      question: 'Which copy deck is final?',
      options: ['Friday', 'Revised'],
    });
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

  const reset5 = Math.floor(Date.now() / 1000) + 3600;
  const reset7 = Math.floor(Date.now() / 1000) + 3 * 86_400;
  const statusInput = (fiveHour: number, extra: object = {}) =>
    JSON.stringify({
      ...extra,
      rate_limits: {
        five_hour: { used_percentage: fiveHour, resets_at: reset5 },
        seven_day: { used_percentage: 10, resets_at: reset7 },
      },
    });

  it('the status line records your usage; a stale lower reading never pulls it down', async () => {
    const r = await sc(['statusline'], {
      input: statusInput(40, {
        model: { display_name: 'Sonnet 5.5' },
        context_window: { used_percentage: 12.4 },
      }),
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('Sonnet 5.5 · context 12% · 5h 40% · week 10%');
    expect((await sc(['statusline'], { input: statusInput(20) })).code).toBe(0);
    const u = JSON.parse((await sc(['usage', '--json'])).stdout);
    expect(u).toMatchObject({
      known: true,
      level: 'ok',
      fiveHour: { usedPercentage: 40 },
      sevenDay: { usedPercentage: 10 },
      activeWorkers: 0,
      canStart: true,
      canStartCount: 4,
    });
  });

  it('task new takes the model the control chat picked and passes the auto-compact and status line settings', async () => {
    const bad = await sc(['task', 'new', 'Nope', '--model', 'opus;rm']);
    expect(bad.code).toBe(2);
    const r = await sc(['task', 'new', 'Fix footer typo', '--model', 'sonnet', '--brief', 'Typo.', '--json']);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    // Workers start in plan mode and plan with Opus: Sonnet-level work starts on opusplan.
    expect(out).toMatchObject({ model: 'opusplan', usage: { activeWorkers: 1, canStartCount: 3 } });
    const settingsFile = join(home, '.local/state/supercharge/claude-settings.json');
    const args = fake.state.sessions.find((s) => s.id === out.aoeSessionId)?.extra_args ?? '';
    expect(args).toContain('--model opusplan');
    expect(args).toContain('--permission-mode plan');
    expect(args).toContain(`--settings ${settingsFile}`);
    const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
    expect(settings.autoCompactWindow).toBe(500_000);
    expect(settings.statusLine).toMatchObject({ type: 'command', padding: 0 });
    expect(settings.statusLine.command).toMatch(/supercharge\.mjs' statusline$/);
    expect((await readTask(out.id)).model).toBe('opusplan');
    expect((await sc(['stage', 'done'], { cwd: out.worktree })).code).toBe(0);
  });

  it('holds new workers while the 5-hour window is nearly used, unless forced', async () => {
    expect((await sc(['statusline'], { input: statusInput(90) })).code).toBe(0);
    const held = await sc(['task', 'new', 'Another one', '--json']);
    expect(held.code).toBe(6);
    expect(held.stderr).toMatch(/5-hour limit at 90%/);
    expect(held.stderr).toMatch(/--force/);
    const forced = await sc(['task', 'new', 'Another one', '--force', '--json']);
    expect(forced.code, forced.stderr).toBe(0);
    const audit = await readFile(join(home, '.local/state/supercharge/audit.jsonl'), 'utf8');
    expect(audit).toMatch(/"action":"task_created".*"forced":"5-hour limit at 90%/);
    expect((await sc(['stage', 'done'], { cwd: JSON.parse(forced.stdout).worktree })).code).toBe(0);
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
    const names = snap.tasks.map((t) => t.name);
    expect(names.every(Boolean)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    const desks = snap.tasks.filter((t) => t.stage !== 'done').map((t) => t.desk);
    expect(desks.every((d) => typeof d === 'number' && d > 0)).toBe(true);
    expect(new Set(desks).size).toBe(desks.length);
    expect(snap.ui.displayName).toBe('');
    const w = snap.sessions.find((s) => s.id === snap.tasks[0]!.aoeSessionId);
    expect(w?.parentId).toBe(snap.projects[0]!.controlSessionId);
    expect(snap.health.aoe.serveVersion).toBe('1.17.2');
    expect(snap.usage).toMatchObject({ known: true, level: 'stop', fiveHour: { usedPercentage: 90 } });
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

  it('logs the office history and serves it, filtered (GET /api/office/history)', async () => {
    const auth = { authorization: `Bearer ${bearer}` };
    const from = new Date(Date.now() - 60 * 60_000).toISOString();
    const history = await until(async () => {
      const h = (await (
        await fetch(`${base()}/api/office/history?from=${from}`, { headers: auth })
      ).json()) as HistoryRange;
      return h.records.some(
        (r) => r.type === 'move' && r.taskId === 'NO-0001' && r.stage === 'ready_for_review',
      )
        ? h
        : null;
    });
    expect(history.start.type).toBe('frame');
    expect(history.records.some((r) => r.type === 'move' && r.key === 'northwind/lead')).toBe(true);
    const one = (await (
      await fetch(`${base()}/api/office/history?from=${from}&key=northwind/NO-0001`, { headers: auth })
    ).json()) as HistoryRange;
    expect(one.records.length).toBeGreaterThan(0);
    expect(one.records.every((r) => r.type === 'frame' || r.key === 'northwind/NO-0001')).toBe(true);
    const bad = await fetch(`${base()}/api/office/history?from=nope`, { headers: auth });
    expect(bad.status).toBe(400);
  });

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

  it('reads a waiting menu, refuses stray messages, and answers it by number (audited)', async () => {
    const auth = { authorization: `Bearer ${bearer}` };
    const post = (path: string, body: unknown) =>
      fetch(`${base()}${path}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const snapshot = async () =>
      (await (await fetch(`${base()}/api/snapshot`, { headers: auth })).json()) as Snapshot;
    const id = (await snapshot()).tasks[0]!.aoeSessionId;
    await fetch(`${fake.url}/__fake/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'Waiting', menu: PERMISSION_MENU }),
    });
    const snap = await until(async () => {
      const s = await snapshot();
      return s.sessions.find((x) => x.id === id)?.prompt ? s : null;
    });
    const prompt = snap.sessions.find((x) => x.id === id)!.prompt!;
    expect(prompt).toMatchObject({ question: 'Do you want to proceed?', answerable: true });
    expect(prompt.options).toHaveLength(3);

    // A typed message would land on the menu and pick its highlighted option, so it is refused.
    const stray = await post(`/api/sessions/${id}/send`, { message: 'hello' });
    expect(stray.status).toBe(409);
    expect(((await stray.json()) as { error: string }).error).toBe('menu_open');
    const command = await post(`/api/sessions/${id}/run`, { command: 'ls' });
    expect(command.status).toBe(409);
    expect(((await command.json()) as { error: string }).error).toBe('menu_open');
    const reply = await sc(['reply', 'NO-0001', 'hello', '--yes']);
    expect(reply.code).not.toBe(0);
    expect(reply.stderr).toMatch(/showing a menu/);

    const fresh = (await (await fetch(`${base()}/api/sessions/${id}/prompt`, { headers: auth })).json()) as {
      prompt: { key: string };
    };
    expect(fresh.prompt.key).toBe(prompt.key);
    expect((await post(`/api/sessions/${id}/answer`, { key: 'deadbeef', option: 1 })).status).toBe(409);

    const sentBefore = fake.state.sent.length;
    const ok = await post(`/api/sessions/${id}/answer`, {
      key: prompt.key,
      option: 3,
      text: 'Run it at 50 requests a second instead.',
    });
    expect(ok.status).toBe(200);
    // The digit first (it closes the menu), then the feedback as a normal prompt.
    expect(fake.state.sent.slice(sentBefore).map((m) => m.message)).toEqual([
      '3',
      'Run it at 50 requests a second instead.',
    ]);
    const audit = await readFile(join(home, '.local/state/supercharge/audit.jsonl'), 'utf8');
    expect(audit).toMatch(/"action":"prompt_answered".*3\. No, and tell Claude what to do differently/);
    await until(async () => !(await snapshot()).sessions.find((x) => x.id === id)?.prompt);
    await fetch(`${fake.url}/__fake/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'Idle' }),
    });
  });

  it("answers Claude's own multiple-choice questions: Escape through the live terminal, then the answers", async () => {
    const auth = { authorization: `Bearer ${bearer}` };
    const post = (path: string, body: unknown) =>
      fetch(`${base()}${path}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const snapshot = async () =>
      (await (await fetch(`${base()}/api/snapshot`, { headers: auth })).json()) as Snapshot;
    const id = (await snapshot()).tasks[0]!.aoeSessionId;
    const questions = [
      {
        question: 'Which browsers should the QA pass cover?',
        header: 'Browsers',
        multiSelect: true,
        options: [{ label: 'Chrome' }, { label: 'Safari' }, { label: 'Firefox' }],
      },
      {
        question: 'Before or after content entry?',
        header: 'Timing',
        options: [{ label: 'Before' }, { label: 'After' }],
      },
    ];
    await fetch(`${fake.url}/__fake/sessions/${id}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questions }),
    });
    const snap = await until(async () => {
      const s = await snapshot();
      return s.sessions.find((x) => x.id === id)?.prompt?.kind === 'question' ? s : null;
    });
    const prompt = snap.sessions.find((x) => x.id === id)!.prompt!;
    expect(snap.needsYou.some((n) => n.sessionId === id && n.kind === 'question')).toBe(true);
    const detail = (await (await fetch(`${base()}/api/sessions/${id}/prompt`, { headers: auth })).json()) as {
      questions: { question: string }[];
    };
    expect(detail.questions.map((q) => q.question)).toEqual(questions.map((q) => q.question));

    // Only when AoE refuses even a take-over does Supercharge give up, and say so.
    fake.state.viewers[id] = 'stuck';
    const busy = await post(`/api/sessions/${id}/answer-questions`, {
      toolId: prompt.key,
      answers: [{ question: questions[0]!.question, picked: ['Chrome'] }],
    });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toBe('terminal_busy');

    expect(
      (await post(`/api/sessions/${id}/answer-questions`, { toolId: 'toolu_stale', answers: [] })).status,
    ).toBe(409);
    // With the session open in AoE, Supercharge asks for the typing lock, then takes it over.
    fake.state.viewers[id] = true;
    fake.state.claims = [];
    const ok = await post(`/api/sessions/${id}/answer-questions`, {
      toolId: prompt.key,
      answers: [
        { question: questions[0]!.question, picked: ['Chrome', 'Safari'] },
        { question: questions[1]!.question, picked: [], other: 'After, but only the launch pages' },
      ],
    });
    expect(ok.status).toBe(200);
    expect(fake.state.claims).toEqual([
      { id, type: 'claim_if_vacant', owner: false },
      { id, type: 'claim', owner: true },
    ]);
    fake.state.viewers[id] = false;
    expect(fake.state.keys.filter((k) => k.id === id).map((k) => k.hex)).toEqual(['1b']);
    const sent = fake.state.sent.filter((m) => m.id === id).at(-1)!.message;
    expect(sent).toContain('1. Which browsers should the QA pass cover?\n   Answer: Chrome; Safari');
    expect(sent).toContain('Answer: After, but only the launch pages');
    await until(async () => !(await snapshot()).sessions.find((x) => x.id === id)?.prompt);
    await fetch(`${fake.url}/__fake/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'Idle' }),
    });
  });

  it('answers a question it can only read from the screen (Claude has not written the call yet)', async () => {
    const auth = { authorization: `Bearer ${bearer}` };
    const snapshot = async () =>
      (await (await fetch(`${base()}/api/snapshot`, { headers: auth })).json()) as Snapshot;
    const id = (await snapshot()).tasks[0]!.aoeSessionId;
    await fetch(`${fake.url}/__fake/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'Waiting', menu: ASK_MENU }),
    });
    const snap = await until(async () => {
      const s = await snapshot();
      return s.sessions.find((x) => x.id === id)?.prompt?.kind === 'question' ? s : null;
    });
    const prompt = snap.sessions.find((x) => x.id === id)!.prompt!;
    expect(prompt).toMatchObject({ tabs: ['Browsers', 'Devices'], multi: true });
    const detail = (await (await fetch(`${base()}/api/sessions/${id}/prompt`, { headers: auth })).json()) as {
      questions: { question: string; multiSelect: boolean; options: { label: string }[] }[];
      otherTabs: string[];
    };
    expect(detail.questions).toHaveLength(1);
    expect(detail.questions[0]).toMatchObject({
      question: 'Which browsers should the QA pass cover?',
      multiSelect: true,
    });
    expect(detail.questions[0]!.options.map((o) => o.label)).toEqual(['Chrome', 'Safari', 'Firefox']);
    expect(detail.otherTabs).toEqual(['Browsers', 'Devices']);
    const keysBefore = fake.state.keys.length;
    const ok = await fetch(`${base()}/api/sessions/${id}/answer-questions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        toolId: prompt.key,
        answers: [{ question: detail.questions[0]!.question, picked: ['Firefox'] }],
        note: 'Ask me about devices again.',
      }),
    });
    expect(ok.status).toBe(200);
    expect(fake.state.keys.slice(keysBefore).map((k) => k.hex)).toEqual(['1b']);
    const sent = fake.state.sent.filter((m) => m.id === id).at(-1)!.message;
    expect(sent).toContain('Answer: Firefox');
    expect(sent).toContain('Ask me about devices again.');
    await fetch(`${fake.url}/__fake/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'Idle' }),
    });
  });

  it('reads a session conversation and sends a message into it (audited)', async () => {
    const auth = { authorization: `Bearer ${bearer}` };
    const snap = (await (await fetch(`${base()}/api/snapshot`, { headers: auth })).json()) as Snapshot;
    const control = snap.projects[0]!.controlSessionId!;
    const send = await fetch(`${base()}/api/sessions/${control}/send`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Create one task for the README.' }),
    });
    expect(send.status).toBe(200);
    expect(fake.state.sent.at(-1)).toMatchObject({ id: control, message: 'Create one task for the README.' });
    const out = (await (
      await fetch(`${base()}/api/sessions/${control}/output`, { headers: auth })
    ).json()) as {
      content: string;
      rcUrl: string | null;
    };
    expect(out.content).toMatch(/❯ Create one task for the README\./);
    expect(out.rcUrl).toMatch(/^https:\/\/claude\.ai\/code\/session_/);
    const audit = await readFile(join(home, '.local/state/supercharge/audit.jsonl'), 'utf8');
    expect(audit).toMatch(/"actor":"ui","action":"prompt_sent".*Create one task for the README/);
    expect((await fetch(`${base()}/api/sessions/ffffffffffffffff/output`, { headers: auth })).status).toBe(
      404,
    );
    // The chat view reads the same conversation from Claude Code's transcript.
    const chat = await until(async () => {
      const c = (await (
        await fetch(`${base()}/api/sessions/${control}/chat`, { headers: auth })
      ).json()) as ChatResponse;
      return c.messages.some((m) => m.role === 'assistant') ? c : null;
    });
    expect(chat.state).toBe('ok');
    expect(chat.messages).toContainEqual(
      expect.objectContaining({
        role: 'user',
        blocks: [{ kind: 'text', text: 'Create one task for the README.' }],
      }),
    );
    const same = await fetch(
      `${base()}/api/sessions/${control}/chat?version=${encodeURIComponent(chat.version)}`,
      {
        headers: auth,
      },
    );
    expect(await same.json()).toEqual({ unchanged: true, version: chat.version });
    expect((await fetch(`${base()}/api/sessions/ffffffffffffffff/chat`, { headers: auth })).status).toBe(404);
    const empty = await fetch(`${base()}/api/sessions/${control}/send`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    });
    expect(empty.status).toBe(400);
  });

  it("runs a command from Claude's shell block in the session's shell mode (audited)", async () => {
    const auth = { authorization: `Bearer ${bearer}` };
    const snap = (await (await fetch(`${base()}/api/snapshot`, { headers: auth })).json()) as Snapshot;
    const control = snap.projects[0]!.controlSessionId!;
    const run = (body: unknown) =>
      fetch(`${base()}/api/sessions/${control}/run`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const command = 'aoe remove old-worker      # merged\naoe remove other-worker';
    expect((await run({ command: `\n${command}\n` })).status).toBe(200);
    // Typed as `!` and the command, which Claude Code runs as you; several lines run as one script.
    expect(fake.state.sent.at(-1)).toMatchObject({ id: control, message: `!${command}` });
    const audit = await readFile(join(home, '.local/state/supercharge/audit.jsonl'), 'utf8');
    expect(audit).toMatch(/"actor":"ui","action":"command_run".*aoe remove old-worker/);
    const chat = await until(async () => {
      const c = (await (
        await fetch(`${base()}/api/sessions/${control}/chat`, { headers: auth })
      ).json()) as ChatResponse;
      return c.messages.some((m) => m.blocks.some((b) => b.kind === 'shell' && b.command === command))
        ? c
        : null;
    });
    expect(chat.messages.flatMap((m) => m.blocks).find((b) => b.kind === 'shell')).toEqual({
      kind: 'shell',
      command,
      stdout: 'ran: aoe remove old-worker      # merged\nran: aoe remove other-worker',
      stderr: '',
    });
    const sent = fake.state.sent.length;
    expect((await run({ command: '  ' })).status).toBe(400);
    expect((await run({})).status).toBe(400);
    expect((await run({ command: 'x'.repeat(20_001) })).status).toBe(400);
    expect(
      (await fetch(`${base()}/api/sessions/ffffffffffffffff/run`, { method: 'POST', headers: auth })).status,
    ).toBe(404);
    expect(fake.state.sent.length).toBe(sent);
  });

  it('switches a running session’s model and effort by typing /model and /effort (audited)', async () => {
    const auth = { authorization: `Bearer ${bearer}` };
    const snap = (await (await fetch(`${base()}/api/snapshot`, { headers: auth })).json()) as Snapshot;
    const control = snap.projects[0]!.controlSessionId!;
    const post = (body: unknown) =>
      fetch(`${base()}/api/sessions/${control}/model`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post({ model: 'sonnet' })).status).toBe(200);
    expect(fake.state.sent.at(-1)).toMatchObject({ id: control, message: '/model sonnet' });
    expect((await post({ effort: 'max' })).status).toBe(200);
    expect(fake.state.sent.at(-1)).toMatchObject({ id: control, message: '/effort max' });
    // Only the listed aliases: anything else never reaches the session.
    const bad = await post({ model: 'sonnet; rm -rf ~' });
    expect(bad.status).toBe(400);
    expect(fake.state.sent.at(-1)!.message).toBe('/effort max');
    const chat = (await (
      await fetch(`${base()}/api/sessions/${control}/chat`, { headers: auth })
    ).json()) as ChatResponse;
    expect([chat.model, chat.effort]).toEqual(['claude-sonnet-5', 'max']);
    // A control chat says which model Supercharge starts control chats on, so the dashboard can flag Sonnet.
    expect(chat.expectedModel).toBe('opus');
    expect(chat.claudeVersion).toBe('2.1.285');
    const audit = await readFile(join(home, '.local/state/supercharge/audit.jsonl'), 'utf8');
    expect(audit).toMatch(/"action":"prompt_sent".*\/model sonnet/);
  });

  it('stores attachments outside the repo and serves only images inline', async () => {
    const auth = { authorization: `Bearer ${bearer}` };
    const snap = (await (await fetch(`${base()}/api/snapshot`, { headers: auth })).json()) as Snapshot;
    const control = snap.projects[0]!.controlSessionId!;
    const upload = (name: string, body: Uint8Array<ArrayBuffer>) =>
      fetch(`${base()}/api/sessions/${control}/uploads`, {
        method: 'POST',
        headers: {
          ...auth,
          'content-type': 'application/octet-stream',
          'x-file-name': encodeURIComponent(name),
        },
        body: new Blob([body]),
      });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const r = await upload('my shot (1).png', png);
    expect(r.status).toBe(200);
    const saved = (await r.json()) as { path: string; url: string; file: string };
    expect(saved.path.startsWith(join(home, '.local/state/supercharge/uploads', control))).toBe(true);
    expect(saved.file).toMatch(/^\d{8}T\d{6}-[0-9a-f]{4}-my-shot-1-\.png$/);
    const got = await fetch(`${base()}${saved.url}`, { headers: auth });
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(png);
    // An SVG could run script as the dashboard, so it only ever downloads.
    const svg = (await (await upload('x.svg', new TextEncoder().encode('<svg/>'))).json()) as { url: string };
    const svgRes = await fetch(`${base()}${svg.url}`, { headers: auth });
    expect(svgRes.headers.get('content-type')).toBe('application/octet-stream');
    expect(svgRes.headers.get('content-disposition')).toBe('attachment');
    expect(
      (await fetch(`${base()}/api/uploads/${control}/..%2F..%2Fconfig.toml`, { headers: auth })).status,
    ).toBe(404);
    expect((await upload('empty.txt', new Uint8Array())).status).toBe(400);
  });

  it('plan comments: added, listed per project, sent in one batch (as plan feedback while it waits)', async () => {
    const auth = { authorization: `Bearer ${bearer}` };
    const json = { ...auth, 'content-type': 'application/json' };
    const snap = (await (await fetch(`${base()}/api/snapshot`, { headers: auth })).json()) as Snapshot;
    const task = snap.tasks[0]!;
    const url = `${base()}/api/tasks/${task.project}/${task.id}/comments`;
    const add = (quote: string, text: string) =>
      fetch(url, { method: 'POST', headers: json, body: JSON.stringify({ quote, text }) });
    expect((await add('', 'no quote')).status).toBe(400);
    await add('Use the deck from Friday', 'Wait for Monday instead');
    const second = (await (await add('Storybook', 'Skip the visual tests')).json()) as {
      comment: { id: string };
    };
    const third = (await (await add('Throwaway', 'Delete me')).json()) as { comment: { id: string } };
    await fetch(`${url}/${third.comment.id}`, { method: 'DELETE', headers: auth });
    const project = (await (
      await fetch(`${base()}/api/projects/${task.project}/comments`, { headers: auth })
    ).json()) as {
      tasks: { taskId: string; comments: { text: string }[] }[];
    };
    expect(project.tasks.find((t) => t.taskId === task.id)?.comments.map((c) => c.text)).toEqual([
      'Wait for Monday instead',
      'Skip the visual tests',
    ]);
    // The worker shows its plan for approval: the comments go in as "Tell Claude what to change".
    await fetch(`${fake.url}/__fake/sessions/${task.aoeSessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'Waiting', menu: PLAN_MENU }),
    });
    const before = fake.state.sent.length;
    const sent = await fetch(`${url}/send`, { method: 'POST', headers: json, body: '{}' });
    expect(sent.status).toBe(200);
    const out = fake.state.sent.slice(before).map((m) => m.message);
    expect(out[0]).toBe('3');
    expect(out[1]).toContain('Comments on your plan:');
    expect(out[1]).toContain('1. On "Use the deck from Friday"\n   Wait for Monday instead');
    expect(out[1]).toContain('2. On "Storybook"\n   Skip the visual tests');
    const after = ((await sent.json()) as { comments: { sentAt: string | null }[] }).comments;
    expect(after.every((c) => c.sentAt)).toBe(true);
    expect(second.comment.id).toBeTruthy();
    // Nothing left to send.
    expect((await fetch(`${url}/send`, { method: 'POST', headers: json, body: '{}' })).status).toBe(400);
    await fetch(`${fake.url}/__fake/sessions/${task.aoeSessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'Idle', menu: null }),
    });
  });

  it('project notes are saved next to the ledger', async () => {
    const auth = { authorization: `Bearer ${bearer}` };
    const url = `${base()}/api/projects/northwind/notes`;
    expect(((await (await fetch(url, { headers: auth })).json()) as { text: string }).text).toBe('');
    const put = await fetch(url, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '# Ideas\n- compare NO-0001 with the deck' }),
    });
    expect(put.status).toBe(200);
    expect(await readFile(join(home, '.local/share/supercharge/projects/northwind/notes.md'), 'utf8')).toBe(
      '# Ideas\n- compare NO-0001 with the deck',
    );
  });

  it('adopts an AoE parent and its children as tasks (ledger only), skipping other repositories', async () => {
    const auth = { authorization: `Bearer ${bearer}` };
    const json = { ...auth, 'content-type': 'application/json' };
    const mk = async (body: Record<string, unknown>) =>
      (await (
        await fetch(`${fake.url}/__fake/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as { id: string };
    const parent = await mk({ title: 'hq', project_path: join(home, 'hq'), status: 'Idle' });
    const kid = (title: string, branch: string, repoPath: string) =>
      mk({
        title,
        project_path: join(home, 'code', 'northwind-worktrees', title),
        main_repo_path: `${repoPath}/`,
        branch,
        base_branch: 'main',
        parent_session_id: parent.id,
        status: 'Idle',
      });
    const a = await kid('swippy-35-theme-search', 'feature/idea-35', repo);
    const b = await kid('web-456-footer', 'bugfix/idea-456', repo);
    const elsewhere = await kid('other-repo-thing', 'feature/x', join(home, 'somewhere-else'));
    const sentBefore = fake.state.sent.length;
    const preview = await until(async () => {
      const r = await fetch(`${base()}/api/adopt/${parent.id}`, { headers: auth });
      const p = (await r.json()) as { children: { id: string }[]; suggestion: { project: string | null } };
      return p.children?.length === 3 ? p : null;
    });
    expect(preview.suggestion.project).toBe('northwind');
    const r = await fetch(`${base()}/api/adopt`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        controlSessionId: parent.id,
        projectName: 'northwind',
        children: [a.id, b.id, elsewhere.id],
        makeControl: false,
      }),
    });
    expect(r.status).toBe(200);
    const out = (await r.json()) as { tasks: string[]; skipped: { title: string; reason: string }[] };
    expect(out.tasks).toHaveLength(2);
    expect(out.skipped).toEqual([
      expect.objectContaining({
        title: 'other-repo-thing',
        reason: expect.stringMatching(/another repository/),
      }),
    ]);
    const t = await readTask(out.tasks[0]!);
    expect(t).toMatchObject({
      title: 'swippy-35-theme-search',
      branch: 'feature/idea-35',
      aoeSessionId: a.id,
      parentSessionId: parent.id,
      stage: 'implementing',
    });
    // Adopting writes the ledger only: nothing was sent to any session.
    expect(fake.state.sent.length).toBe(sentBefore);
    // Adopting again skips what is already a task.
    const again = await fetch(`${base()}/api/adopt`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        controlSessionId: parent.id,
        projectName: 'northwind',
        children: [a.id],
        makeControl: false,
      }),
    });
    expect(((await again.json()) as { skipped: { reason: string }[] }).skipped[0]?.reason).toBe(
      'already part of a project',
    );
  });

  it('lists the commands "/" can complete in a session', async () => {
    const auth = { authorization: `Bearer ${bearer}` };
    const snap = (await (await fetch(`${base()}/api/snapshot`, { headers: auth })).json()) as Snapshot;
    const id = snap.projects[0]!.controlSessionId!;
    const r = (await (await fetch(`${base()}/api/sessions/${id}/commands`, { headers: auth })).json()) as {
      commands: { name: string; kind: string }[];
    };
    expect(r.commands.find((c) => c.name === 'compact')).toMatchObject({ kind: 'builtin' });
    // The skills Supercharge installed for you are there too.
    expect(r.commands.find((c) => c.name === 'supercharge-control')).toMatchObject({ kind: 'skill' });
    expect((await fetch(`${base()}/api/sessions/nope/commands`, { headers: auth })).status).toBe(404);
  });

  it('right-click actions: lock guards, archive and unarchive, pin, and delete to the trash takes the worker out until restored', async () => {
    const auth = { authorization: `Bearer ${bearer}` };
    type Results = { results: { id: string; ok: boolean; error?: string; locked?: boolean }[] };
    const act = async (action: string, ids: string[], extra: object = {}) =>
      (await (
        await fetch(`${base()}/api/sessions/actions`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ action, ids, ...extra }),
        })
      ).json()) as Results;
    const snapshot = async () =>
      (await (await fetch(`${base()}/api/snapshot`, { headers: auth })).json()) as Snapshot;
    const view = async (id: string) => (await snapshot()).sessions.find((s) => s.id === id);
    const made = JSON.parse(
      (await sc(['task', 'new', 'Right-click target', '--force', '--json'])).stdout,
    ) as {
      id: string;
      aoeSessionId: string;
      worktree: string;
    };
    const id = made.aoeSessionId;
    await until(async () => (await view(id)) ?? null);

    expect((await act('lock', [id])).results[0]).toMatchObject({ ok: true });
    await until(async () => (await view(id))?.locked);
    for (const guarded of ['archive', 'delete', 'stop'])
      expect((await act(guarded, [id])).results[0]).toMatchObject({ ok: false, locked: true });
    expect((await act('unlock', [id])).results[0]!.ok).toBe(true);

    expect((await act('archive', [id])).results[0]!.ok).toBe(true);
    expect(fake.state.sessions.find((s) => s.id === id)?.status).toBe('Stopped');
    await until(async () => (await view(id))?.archived);
    expect((await act('unarchive', [id])).results[0]!.ok).toBe(true);
    expect(fake.state.sessions.find((s) => s.id === id)).toMatchObject({ archived_at: null, status: 'Idle' });

    expect((await act('pin', [id])).results[0]!.ok).toBe(true);
    await until(async () => (await view(id))?.pinned);

    const control = (await snapshot()).projects.find((p) => p.name === 'northwind')!.controlSessionId!;
    expect((await act('delete', [control])).results[0]).toMatchObject({ ok: false });
    expect(fake.state.sessions.find((s) => s.id === control)?.trashed_at ?? null).toBeNull();

    expect((await act('delete', [id])).results[0]!.ok).toBe(true);
    expect(fake.state.sessions.find((s) => s.id === id)?.trashed_at).toBeTruthy();
    expect(existsSync(taskFile(made.id))).toBe(false);
    const removed = join(home, '.local/share/supercharge/projects/northwind/removed', made.id, 'task.json');
    expect(existsSync(removed)).toBe(true);
    await until(async () => !(await snapshot()).tasks.some((t) => t.id === made.id));

    // Restored from AoE's trash: the worker comes back with its plan and history.
    await fetch(`${fake.url}/__fake/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trashed_at: null, status: 'Idle' }),
    });
    await until(async () => (await snapshot()).tasks.some((t) => t.id === made.id), 30_000);
    expect(existsSync(removed)).toBe(false);
    const audit = await readFile(join(home, '.local/state/supercharge/audit.jsonl'), 'utf8');
    expect(audit).toMatch(/"action":"session_action".*"action":"lock"/);
    expect(audit).toMatch(new RegExp(`"action":"task_restored","project":"northwind","taskId":"${made.id}"`));
    expect((await sc(['stage', 'done'], { cwd: made.worktree })).code).toBe(0);
  }, 60_000);

  it('a worker whose session is trashed in AoE leaves the dashboard (kept under removed/)', async () => {
    const auth = { authorization: `Bearer ${bearer}` };
    const snapshot = async () =>
      (await (await fetch(`${base()}/api/snapshot`, { headers: auth })).json()) as Snapshot;
    const made = JSON.parse((await sc(['task', 'new', 'Trashed in AoE', '--force', '--json'])).stdout) as {
      id: string;
      aoeSessionId: string;
    };
    await until(async () => (await snapshot()).tasks.some((t) => t.id === made.id));
    await fetch(`${fake.url}/__fake/sessions/${made.aoeSessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trashed_at: new Date().toISOString(), status: 'Stopped' }),
    });
    const snap = await until(async () => {
      const s = await snapshot();
      return s.tasks.some((t) => t.id === made.id) ? null : s;
    });
    expect(snap.needsYou.some((n) => n.taskId === made.id)).toBe(false);
    expect(existsSync(join(home, '.local/share/supercharge/projects/northwind/removed', made.id))).toBe(true);
  });

  it('deletes a project only after its name is typed; optionally its AoE sessions too', async () => {
    const auth = { authorization: `Bearer ${bearer}` };
    const json = { ...auth, 'content-type': 'application/json' };
    // A throwaway project: adopt a parent and a child in a fresh repository.
    const other = join(home, 'code', 'throwaway');
    await mkdir(other, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: other });
    execFileSync(
      'git',
      [
        '-c',
        'user.email=t@example.invalid',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ],
      { cwd: other },
    );
    const mk = async (body: Record<string, unknown>) =>
      (await (
        await fetch(`${fake.url}/__fake/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as { id: string };
    const parent = await mk({ title: 'throwaway control', project_path: join(home, 'tc'), status: 'Idle' });
    const child = await mk({
      title: 'throwaway-1',
      project_path: join(home, 'code', 'throwaway-worktrees', 't1'),
      main_repo_path: other,
      branch: 'feature/t1',
      parent_session_id: parent.id,
      status: 'Idle',
    });
    await until(async () => (await fetch(`${base()}/api/adopt/${parent.id}`, { headers: auth })).ok);
    const adopted = await fetch(`${base()}/api/adopt`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        controlSessionId: parent.id,
        projectName: 'throwaway',
        repoPath: other,
        children: [child.id],
        makeControl: true,
      }),
    });
    expect(adopted.status).toBe(200);
    const del = (body: unknown) =>
      fetch(`${base()}/api/projects/throwaway`, {
        method: 'DELETE',
        headers: json,
        body: JSON.stringify(body),
      });
    expect((await del({ confirm: 'nope' })).status).toBe(400);
    const r = await del({
      confirm: 'throwaway',
      deleteSessions: true,
      deleteWorktrees: false,
      deleteBranches: false,
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { deleted: string[] }).deleted.sort()).toEqual([child.id, parent.id].sort());
    expect(fake.state.sessions.some((s) => s.id === parent.id || s.id === child.id)).toBe(false);
    expect(existsSync(join(home, '.local/share/supercharge/projects/throwaway'))).toBe(false);
    const audit = await readFile(join(home, '.local/state/supercharge/audit.jsonl'), 'utf8');
    expect(audit).toMatch(/"action":"project_deleted","project":"throwaway"/);
  });

  it("relays a session's shell to signed-in dashboard pages only, and audits a command run there", async () => {
    const r = await sc(['open', '--print']);
    const url = new URL(r.stdout.trim());
    const cb = await fetch(`${base()}${url.pathname}${url.search}`, { redirect: 'manual' });
    const jar = (cb.headers.get('set-cookie') ?? '').split(';')[0]!;
    const control = (
      (await (await fetch(`${base()}/api/snapshot`, { headers: { cookie: jar } })).json()) as Snapshot
    ).projects[0]!.controlSessionId!;
    const wsUrl = `${base().replace(/^http/, 'ws')}/api/sessions/${control}/shell/ws`;
    const origin = `http://127.0.0.1:${port}`;
    // Refused without the cookie, or from another site's page.
    const refused = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(wsUrl, { headers });
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('open', () => resolve(101));
        ws.on('error', () => {});
      });
    expect(await refused({ origin })).toBe(401);
    expect(await refused({ origin: 'http://evil.example', cookie: jar })).toBe(403);

    const ws = new WebSocket(wsUrl, { headers: { origin, cookie: jar } });
    const got: { type: string; content?: string; is_owner?: boolean }[] = [];
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 12 }));
    await until(async () => got.some((m) => m.type === 'size_owner' && m.is_owner));
    ws.send(JSON.stringify({ type: 'run', command: 'aoe session empty-trash' }));
    await until(async () => fake.state.shellRan.some((x) => x.id === control));
    expect(fake.state.shellRan.at(-1)).toMatchObject({ id: control, command: 'aoe session empty-trash' });
    await until(async () =>
      got.some((m) => m.type === 'frame' && m.content?.includes('ran: aoe session empty-trash')),
    );
    ws.close();
    const audit = await readFile(join(home, '.local/state/supercharge/audit.jsonl'), 'utf8');
    expect(audit).toMatch(/"action":"command_run".*"text":"aoe session empty-trash".*"where":"terminal"/);

    // A frame over the size limit closes that connection, not the daemon.
    const big = new WebSocket(wsUrl, { headers: { origin, cookie: jar } });
    await new Promise((resolve, reject) => {
      big.on('open', resolve);
      big.on('error', reject);
    });
    const closed = new Promise<number>((resolve) => big.on('close', (code) => resolve(code)));
    big.on('error', () => {});
    big.send(Buffer.alloc((1 << 20) + 1));
    expect(await closed).toBe(1009);
    expect((await fetch(`${base()}/healthz`)).status).toBe(200);
  });

  it('keeps notes and todos: Claude adds them from a session; the dashboard ticks and archives them', async () => {
    // As Claude does through /note: from the project's folder, the text on stdin.
    const n = await sc(['note', 'add', '-', '--json'], {
      input: 'Staging is read-only until Friday\n',
      extraEnv: { CLAUDECODE: '1' },
    });
    expect(n.code, n.stderr).toBe(0);
    const note = JSON.parse(n.stdout);
    expect(note).toMatchObject({ project: 'northwind', kind: 'note', by: 'claude' });
    expect(note.text).toBe('Staging is read-only until Friday');
    const todo = JSON.parse(
      (await sc(['todo', 'add', 'Ask', 'Jonas', 'about', 'the', 'export', '--json'])).stdout,
    );
    expect(todo).toMatchObject({ project: 'northwind', kind: 'todo', done: false, by: 'you' });
    const global = JSON.parse(
      (await sc(['note', 'add', '--global', 'Renew the token', '--json'], { cwd: home })).stdout,
    );
    expect(global.project).toBeNull();
    // Outside a project, without --global: refused, with the way out.
    const outside = await sc(['note', 'add', 'Lost'], { cwd: home });
    expect(outside.code).toBe(2);
    expect(outside.stderr).toMatch(/--global/);
    expect((await sc(['todo', 'done', note.id])).stderr).toMatch(/is a note, not a todo/);
    // Readable as a board: the project's todos and notes, then the global ones.
    expect((await sc(['notes'])).stdout).toBe(
      [
        'northwind',
        '  To do',
        `    [ ] ${todo.id}  Ask Jonas about the export`,
        '  Notes',
        `    -   ${note.id}  Staging is read-only until Friday`,
        '',
        'Global',
        '  Notes',
        `    -   ${global.id}  Renew the token`,
        '',
      ].join('\n'),
    );

    // The dashboard has them live, ticks the todo and archives the note.
    const auth = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' };
    const snapshot = async () =>
      (await (await fetch(`${base()}/api/snapshot`, { headers: auth })).json()) as Snapshot;
    await until(async () => (await snapshot()).notes.length === 3);
    const patch = (id: string, body: unknown) =>
      fetch(`${base()}/api/notes/${id}`, { method: 'PATCH', headers: auth, body: JSON.stringify(body) });
    const ticked = (await (await patch(todo.id, { done: true })).json()) as { note: NoteRecord };
    expect(ticked.note).toMatchObject({ done: true });
    expect(ticked.note.doneAt).toBeTruthy();
    expect((await patch(note.id, { archived: true })).status).toBe(200);
    expect((await patch('zzzz', { done: true })).status).toBe(404);
    expect((await snapshot()).notes.map((x) => x.id).sort()).toEqual([global.id, todo.id].sort());
    const archived = (await (await fetch(`${base()}/api/notes?archived=1`, { headers: auth })).json()) as {
      notes: NoteRecord[];
    };
    expect(archived.notes.map((x) => x.id)).toEqual([note.id]);
    expect((await sc(['notes'])).stdout).toContain(`[x] ${todo.id}`);
    const added = await fetch(`${base()}/api/notes`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ kind: 'todo', text: 'From the board', project: 'nope' }),
    });
    expect(added.status).toBe(404);
  });

  it('a new worker on the trust dialog gets its first message from the daemon once the menu is answered', async () => {
    const r = await sc(['task', 'new', 'Trust first', '--force', '--json'], {
      extraEnv: { FAKE_AOE_START_MENU: 'trust', SUPERCHARGE_KICKOFF_WAIT_MS: '1500' },
    });
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as TaskRecord & { warnings: string[]; worktree: string };
    expect(out.warnings.join('\n')).toMatch(/not at its prompt yet.*the daemon sends its first message/);
    const sentTo = () => fake.state.sent.filter((m) => m.id === out.aoeSessionId).map((m) => m.message);
    // Typing over the menu would pick its option, so nothing goes in while it is open.
    await sleep(2_500);
    expect(sentTo()).toEqual([]);
    expect((await readTask(out.id)).kickoffAt).toBeNull();
    await fetch(`${fake.url}/__fake/sessions/${out.aoeSessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'Idle', menu: null }),
    });
    await until(async () => sentTo().length > 0);
    expect(sentTo()).toEqual([KICKOFF_MESSAGE]);
    expect((await readTask(out.id)).kickoffAt).toBeTruthy();
    const audit = await readFile(join(home, '.local/state/supercharge/audit.jsonl'), 'utf8');
    expect(audit).toMatch(new RegExp(`"actor":"daemon","action":"prompt_sent".*"taskId":"${out.id}"`));
    // Sent once, however often the daemon looks again.
    await sleep(2_500);
    expect(sentTo()).toEqual([KICKOFF_MESSAGE]);
    expect((await sc(['stage', 'done'], { cwd: out.worktree })).code).toBe(0);
  });

  it('a new worker someone already wrote to is not sent a first message', async () => {
    const r = await sc(['task', 'new', 'Already talking', '--force', '--json'], {
      extraEnv: { FAKE_AOE_START_MENU: 'trust', SUPERCHARGE_KICKOFF_WAIT_MS: '0' },
    });
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as TaskRecord & { worktree: string };
    // Someone typed in the terminal (straight past the dashboard), then the dialog was answered.
    await fetch(`${fake.url}/__fake/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: out.aoeSessionId, message: 'Look at the footer first.' }),
    });
    await fetch(`${fake.url}/__fake/sessions/${out.aoeSessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'Idle', menu: null }),
    });
    await until(async () => (await readTask(out.id)).kickoffAt);
    expect(fake.state.sent.filter((m) => m.id === out.aoeSessionId).map((m) => m.message)).toEqual([
      'Look at the footer first.',
    ]);
    expect((await sc(['stage', 'done'], { cwd: out.worktree })).code).toBe(0);
  });

  it('serves the project status in the control-chat format', async () => {
    const r = await sc(['status', '--project', 'northwind', '--json']);
    const st = JSON.parse(r.stdout);
    expect(st.readyForReview[0]).toMatchObject({ taskId: 'NO-0001' });
    expect(st.control.status).not.toBe('missing');
  });
});
