import { randomBytes } from 'node:crypto';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';

/**
 * Fake `aoe serve` for tests and demos. Mirrors the AoE 1.17.2 behaviour Supercharge relies on
 * (fixtures/aoe/1.17.2): bearer auth, PascalCase statuses, no parent field in REST, SPA fallback
 * for unknown /api paths. Extra /__fake/* routes let tests and the `aoe` shim drive state.
 */
export interface FakeSession {
  id: string;
  title: string;
  status:
    'Running' | 'Waiting' | 'Idle' | 'Unknown' | 'Stopped' | 'Error' | 'Starting' | 'Deleting' | 'Creating';
  branch: string | null;
  project_path: string;
  main_repo_path: string | null;
  base_branch: string | null;
  group_path: string;
  tool: string;
  unread: boolean;
  last_error: string | null;
  created_at: string;
  last_accessed_at: string | null;
  idle_entered_at: string | null;
  profile: string;
  parent_session_id: string | null;
}

export interface FakeState {
  version: string;
  token: string;
  sessions: FakeSession[];
  sent: { id: string; message: string; at: string }[];
}

export function newId(): string {
  return randomBytes(8).toString('hex');
}

export function makeSession(p: Partial<FakeSession> & { title: string; project_path: string }): FakeSession {
  const now = new Date().toISOString();
  return {
    id: newId(),
    status: 'Idle',
    branch: null,
    main_repo_path: null,
    base_branch: null,
    group_path: '',
    tool: 'claude',
    unread: false,
    last_error: null,
    created_at: now,
    last_accessed_at: now,
    idle_entered_at: now,
    profile: 'main',
    parent_session_id: null,
    ...p,
  };
}

/** REST shape: AoE 1.17.2 omits the parent link from SessionResponse. */
function toRest(s: FakeSession) {
  const { parent_session_id: _p, ...rest } = s;
  return {
    ...rest,
    artifact_dir: `/tmp/fake-aoe/${s.id}`,
    dormant: false,
    yolo_mode: false,
    is_sandboxed: false,
    scratch: false,
    favorited: false,
    urgent: false,
    has_managed_worktree: !!s.branch,
    has_cleanable_worktree: !!s.branch,
    has_terminal: s.status !== 'Stopped',
    smart_rename: 'inactive',
    default_name: false,
    tie_workdir_to_name: false,
    acp_worker_state: 'absent',
    acp_capable: true,
    acp_agent: 'claude',
    acp_can_fork: true,
    keeps_context: true,
    clear_aliases: ['/clear'],
    claude_fullscreen: false,
    workspace_repos: [],
  };
}

/** CLI shape (`aoe list --json`): carries parent_session_id and the worktree object. */
export function toCliEntry(s: FakeSession) {
  return {
    id: s.id,
    title: s.title,
    path: s.project_path,
    group: s.group_path,
    tool: s.tool,
    profile: s.profile,
    state: 'live',
    created_at: s.created_at,
    workspace_repos: [],
    worktree: s.branch
      ? {
          branch: s.branch,
          main_repo_path: s.main_repo_path,
          managed_by_aoe: true,
          base_branch: s.base_branch,
        }
      : null,
    parent_session_id: s.parent_session_id,
  };
}

export interface FakeAoe {
  url: string;
  port: number;
  state: FakeState;
  stop: () => Promise<void>;
}

export function createFakeApp(state: FakeState) {
  const app = new Hono();

  // ── test/shim control plane (no auth; loopback only) ──
  app.get('/__fake/state', (c) => c.json(state));
  app.get('/__fake/cli/list', (c) => c.json(state.sessions.map(toCliEntry)));
  app.post('/__fake/sessions', async (c) => {
    const body = (await c.req.json()) as Partial<FakeSession> & { title: string; project_path: string };
    const s = makeSession(body);
    state.sessions.push(s);
    return c.json(s, 201);
  });
  app.patch('/__fake/sessions/:id', async (c) => {
    const s = state.sessions.find((x) => x.id === c.req.param('id'));
    if (!s) return c.json({ error: 'not_found' }, 404);
    Object.assign(s, await c.req.json());
    if (s.status === 'Idle') s.idle_entered_at = new Date().toISOString();
    return c.json(s);
  });
  app.delete('/__fake/sessions/:id', (c) => {
    state.sessions = state.sessions.filter((x) => x.id !== c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/__fake/send', async (c) => {
    const { id, message } = (await c.req.json()) as { id: string; message: string };
    state.sent.push({ id, message, at: new Date().toISOString() });
    return c.json({ sent: true });
  });
  app.post('/__fake/version', async (c) => {
    state.version = ((await c.req.json()) as { version: string }).version;
    return c.json({ ok: true });
  });

  // ── AoE REST surface ──
  app.use('/api/*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return c.text('Forbidden host', 403);
    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (bearer !== state.token) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });
  app.get('/api/sessions', (c) =>
    c.json({
      sessions: state.sessions.map(toRest),
      workspace_ordering: state.sessions.map((s) => s.group_path).filter(Boolean),
    }),
  );
  app.get('/api/about', (c) =>
    c.json({
      version: state.version,
      auth_required: true,
      auth_mode: 'token',
      read_only: false,
      profile: '',
      build_flavor: 'release',
    }),
  );
  app.post('/api/sessions/:id/send', async (c) => {
    const id = c.req.param('id');
    if (!state.sessions.some((s) => s.id === id))
      return c.json({ error: 'not_found', message: 'No such session' }, 404);
    const { message } = (await c.req.json()) as { message: string };
    state.sent.push({ id, message, at: new Date().toISOString() });
    return c.json({ sent: true });
  });
  app.get('/api/sessions/:id/output', (c) => {
    const s = state.sessions.find((x) => x.id === c.req.param('id'));
    if (!s) return c.json({ error: 'not_found', message: 'No such session' }, 404);
    const lines = [
      ' ▐▛███▛█   Claude Code (fake agent)',
      `  ${s.title}`,
      ...(s.title.endsWith(' control')
        ? ['  /remote-control is active · Continue at https://claude.ai/code/session_FAKE0123']
        : []),
      '',
      ...state.sent
        .filter((m) => m.id === s.id)
        .flatMap((m) => [`❯ ${m.message}`, '', '⏺ Got it. Working on that now.', '']),
      '❯ ',
    ];
    return c.json({
      id: s.id,
      lines: Number(c.req.query('lines') ?? 50),
      format: 'text',
      content: lines.join('\n'),
    });
  });
  app.delete('/api/sessions/:id', (c) => {
    const before = state.sessions.length;
    state.sessions = state.sessions.filter((s) => s.id !== c.req.param('id'));
    return c.json({ status: before === state.sessions.length ? 'kept' : 'deleted', messages: [] });
  });
  // AoE's SPA fallback: unknown /api paths answer 200 text/html once authed.
  app.all('/api/*', (c) => c.html('<!doctype html><title>Agent of Empires</title>'));
  return app;
}

export async function startFakeAoe(
  opts: { port?: number; token?: string; version?: string; sessions?: FakeSession[] } = {},
): Promise<FakeAoe> {
  const state: FakeState = {
    version: opts.version ?? '1.17.2',
    token: opts.token ?? randomBytes(32).toString('hex'),
    sessions: opts.sessions ?? [],
    sent: [],
  };
  const app = createFakeApp(state);
  let server: ServerType;
  const port = await new Promise<number>((resolve, reject) => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: opts.port ?? 0 }, (info) =>
      resolve(info.port),
    );
    server.on('error', reject);
  });
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    stop: () => new Promise((r) => server.close(() => r())),
  };
}
