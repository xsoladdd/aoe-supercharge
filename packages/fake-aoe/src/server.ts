import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';
import { FakeTranscripts, type TranscriptDirs } from './transcript.ts';

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
  /** Fake only: a Claude Code menu drawn at the bottom of the pane (see PLAN_MENU). Never sent over REST. */
  menu?: string | null;
  /** Fake only: background shells the pane's footer reports ("· 2 shells ·"). Never sent over REST. */
  shells?: number;
  /** Fake only: the `aoe add --extra-args` string, so tests can see the claude flags. Never sent over REST. */
  extra_args?: string | null;
  /** Fake only: how many more sends are accepted but lost (typed before Claude Code's input was ready). */
  swallow?: number;
  /** Fake only: false when AoE's hooks are missing, so no Claude id is known before the first message. */
  hooks?: boolean;
  /** Lifecycle marks, as AoE keeps them; REST leaves each out while it is unset. */
  pinned_at?: string | null;
  archived_at?: string | null;
  trashed_at?: string | null;
}

/** Claude Code 2.1's plan approval, as it appears in the pane. */
export const PLAN_MENU = [
  '────────────────────────────────────────────────────────────────────────────────',
  ' Claude has written up a plan and is ready to execute. Would you like to',
  ' proceed?',
  '',
  ' ❯ 1. Yes, and use auto mode',
  '   2. Yes, manually approve edits',
  '   3. Tell Claude what to change',
  '      shift+tab to approve with this feedback',
  '',
  ' ctrl+g to edit in VS Code · ~/.claude/plans/node-24-upgrade.md',
].join('\n');

/** AskUserQuestion with tabs and a multi-select question, as Claude Code 2.1 draws it. */
export const ASK_MENU = [
  '────────────────────────────────────────────────────────────────────────────────',
  '←  ☐ Browsers  ☐ Devices  ✔ Submit  →',
  '',
  'Which browsers should the QA pass cover?',
  '',
  '❯ 1. [ ] Chrome',
  '  Latest stable on macOS and Windows.',
  '  2. [ ] Safari',
  '  Including Safari on iOS 26.',
  '  3. [ ] Firefox',
  '  Latest stable only.',
  '  4. [ ] Type something',
  '     Next',
  '────────────────────────────────────────────────────────────────────────────────',
  '  5. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
].join('\n');

/** A Bash permission prompt. */
export const PERMISSION_MENU = [
  '────────────────────────────────────────────────────────────────────────────────',
  ' Bash command',
  '',
  '   npm run load-test -- --rate 200',
  '   Load test the export endpoint',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for npm run load-test commands in this project",
  '   3. No, and tell Claude what to do differently (esc)',
].join('\n');

/** The folder-trust dialog a new Claude Code session can open on (wording approximate). */
export const TRUST_MENU = [
  '────────────────────────────────────────────────────────────────────────────────',
  ' Accessing workspace:',
  '',
  ' Quick safety check: Is this a project you created or one you trust?',
  '',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

export interface FakeState {
  version: string;
  token: string;
  sessions: FakeSession[];
  sent: { id: string; message: string; at: string }[];
  /** Raw keys typed through the live-terminal websocket, as hex. */
  keys: { id: string; hex: string; at: string }[];
  /**
   * Fake only: who holds each session's typing lock. `true`: someone views it in AoE (a `claim` takes
   * over); `'stuck'`: not even a take-over gets it.
   */
  viewers: Record<string, boolean | 'stuck'>;
  /** Claims made through the live-terminal websocket, in order. */
  claims: { id: string; type: string; owner: boolean }[];
  /** Fake only: each session's paired shell: what it printed and the line being typed. */
  shells: Record<string, { lines: string[]; input: string }>;
  /** Commands entered in a paired shell, in order. */
  shellRan: { id: string; command: string; at: string }[];
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

/** `?state=` like AoE: live leaves out archived and trashed; trashed is only those; all (or none) is every one. */
function inScope(s: FakeSession, scope: string | undefined): boolean {
  if (scope === 'live') return !s.archived_at && !s.trashed_at;
  if (scope === 'trashed') return !!s.trashed_at;
  return true;
}

/** REST shape: AoE 1.17.2 omits the parent link from SessionResponse. */
function toRest(s: FakeSession) {
  const {
    parent_session_id: _p,
    menu: _m,
    shells: _sh,
    extra_args: _x,
    swallow: _s,
    hooks: _h,
    pinned_at: pinned,
    archived_at: archived,
    trashed_at: trashed,
    ...rest
  } = s;
  return {
    ...rest,
    ...(pinned ? { pinned_at: pinned } : {}),
    ...(archived ? { archived_at: archived } : {}),
    ...(trashed ? { trashed_at: trashed } : {}),
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
    state: s.trashed_at ? 'trashed' : s.archived_at ? 'archived' : 'live',
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
  /** Present when started with `transcripts`: Claude Code transcripts for the chat view. */
  transcripts: FakeTranscripts | null;
  stop: () => Promise<void>;
}

export function createFakeApp(state: FakeState, transcripts: FakeTranscripts | null = null) {
  const app = new Hono();
  const converse = (id: string, message: string) => {
    const s = state.sessions.find((x) => x.id === id);
    if (!s) return;
    // A digit picks an option of an open menu (Claude Code confirms on the digit alone).
    if (s.menu && /^\d$/.test(message.trim())) {
      s.menu = null;
      return;
    }
    if (transcripts) transcripts.converse(s.id, s.project_path, message);
  };

  // ── test/shim control plane (no auth; loopback only) ──
  app.get('/__fake/state', (c) => c.json(state));
  // A stand-in for Open-Meteo's forecast API (the office clock's weather), in its response shape.
  // Made-up readings; `/__fake/weather` sets the next one, `{ fail: true }` makes it answer 503.
  let weather: { temperature_2m: number; weather_code: number; is_day: number; fail?: boolean } = {
    temperature_2m: 4.5,
    weather_code: 61,
    is_day: 1,
  };
  app.put('/__fake/weather', async (c) => {
    weather = await c.req.json();
    return c.json({ ok: true });
  });
  app.get('/v1/forecast', (c) => {
    if (weather.fail) return c.json({ error: true, reason: 'unavailable' }, 503);
    const timezone = c.req.query('timezone') ?? 'GMT';
    return c.json({
      latitude: Number(c.req.query('latitude')),
      longitude: Number(c.req.query('longitude')),
      timezone,
      current_units: {
        time: 'iso8601',
        interval: 'seconds',
        temperature_2m: '°C',
        weather_code: 'wmo code',
        is_day: '',
      },
      current: {
        time: new Date().toISOString().slice(0, 16),
        interval: 900,
        temperature_2m: weather.temperature_2m,
        weather_code: weather.weather_code,
        is_day: weather.is_day,
      },
    });
  });
  app.get('/__fake/cli/list', (c) =>
    c.json(state.sessions.filter((s) => inScope(s, c.req.query('state'))).map(toCliEntry)),
  );
  app.post('/__fake/sessions', async (c) => {
    const body = (await c.req.json()) as Partial<FakeSession> & { title: string; project_path: string };
    const s = makeSession(body);
    if (s.menu === 'trust') Object.assign(s, { status: 'Waiting', menu: TRUST_MENU });
    state.sessions.push(s);
    // Claude Code's SessionStart hook: a launched session's Claude id is known before any message.
    if (transcripts && s.hooks !== false && (s.status === 'Starting' || s.menu))
      transcripts.for(s.id, s.project_path);
    // Like Claude Code under AoE: a launched session starts, then sits idle at its empty prompt.
    if (s.status === 'Starting')
      setTimeout(() => {
        if (s.status !== 'Starting') return;
        Object.assign(s, { status: 'Idle', idle_entered_at: new Date().toISOString() });
      }, 200).unref();
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
    const s = state.sessions.find((x) => x.id === id)!;
    if (s.swallow) s.swallow--;
    else converse(id, message);
    return c.json({ sent: true });
  });
  // `aoe session show --json`: Claude's session id for an AoE session.
  app.get('/__fake/agent/:id', (c) =>
    c.json({
      id: c.req.param('id'),
      agent_session_id: transcripts?.get(c.req.param('id'))?.claudeId ?? null,
    }),
  );
  // Arm an AskUserQuestion: the call in the transcript, the menu on screen, the session waiting.
  app.post('/__fake/sessions/:id/ask', async (c) => {
    const s = state.sessions.find((x) => x.id === c.req.param('id'));
    if (!s || !transcripts) return c.json({ error: 'not_found' }, 404);
    const { questions } = (await c.req.json()) as { questions: unknown[] };
    transcripts
      .for(s.id, s.project_path)
      .assistant({ type: 'tool_use', name: 'AskUserQuestion', input: { questions } });
    Object.assign(s, { status: 'Waiting', menu: ASK_MENU });
    return c.json({ ok: true });
  });
  // A permission prompt: a Bash call waiting in the transcript, its menu on screen, the session waiting.
  app.post('/__fake/sessions/:id/permission', async (c) => {
    const s = state.sessions.find((x) => x.id === c.req.param('id'));
    if (!s || !transcripts) return c.json({ error: 'not_found' }, 404);
    const { command = 'npm publish' } = (await c.req.json().catch(() => ({}))) as { command?: string };
    transcripts
      .for(s.id, s.project_path)
      .assistant({ type: 'tool_use', name: 'Bash', input: { command, description: 'Run it' } });
    Object.assign(s, { status: 'Waiting', menu: PERMISSION_MENU });
    return c.json({ ok: true });
  });
  // Claude replies with this text (a control chat's report, say); the session goes idle.
  app.post('/__fake/sessions/:id/reply', async (c) => {
    const s = state.sessions.find((x) => x.id === c.req.param('id'));
    if (!s || !transcripts) return c.json({ error: 'not_found' }, 404);
    const { text } = (await c.req.json()) as { text: string };
    transcripts.for(s.id, s.project_path).assistant({ type: 'text', text });
    Object.assign(s, { status: 'Idle', menu: null, idle_entered_at: new Date().toISOString() });
    return c.json({ ok: true });
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
  // The paired shell (src/server/api/sessions/ensure.rs): created once, then it exists.
  app.post('/api/sessions/:id/terminal', (c) => {
    const s = state.sessions.find((x) => x.id === c.req.param('id'));
    if (!s) return c.json({ error: 'not_found' }, 404);
    if (state.shells[s.id]) return c.json({ status: 'exists' }, 200);
    state.shells[s.id] = { lines: ['Last login: today on ttys001'], input: '' };
    return c.json({ status: 'created' }, 201);
  });
  app.get('/api/sessions', (c) =>
    c.json({
      sessions: state.sessions.filter((s) => inScope(s, c.req.query('state'))).map(toRest),
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
    const s = state.sessions.find((x) => x.id === id)!;
    if (s.swallow) s.swallow--;
    else converse(id, message);
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
      ...(s.menu ? [s.menu] : ['❯ ']),
      ...(s.shells ? [`  ⏵⏵ auto mode on · ${s.shells} shells · ← for agents`] : []),
    ];
    return c.json({
      id: s.id,
      lines: Number(c.req.query('lines') ?? 50),
      format: 'text',
      content: lines.join('\n'),
    });
  });
  // Lifecycle, as AoE 1.17.2 does it (src/server/api/sessions/lifecycle.rs, ensure.rs).
  const lifecycle = (
    method: 'patch' | 'post',
    action: string,
    apply: (s: FakeSession, body: Record<string, unknown>) => unknown,
  ) =>
    app[method](`/api/sessions/:id/${action}`, async (c) => {
      const s = state.sessions.find((x) => x.id === c.req.param('id'));
      if (!s) return c.json({ error: 'not_found', message: 'Session not found' }, 404);
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const out = apply(s, body);
      return c.json(out ?? toRest(s));
    });
  const now = () => new Date().toISOString();
  lifecycle('patch', 'pin', (s, b) => {
    s.pinned_at = b.pinned ? now() : null;
    if (b.pinned) s.archived_at = null;
  });
  lifecycle('patch', 'archive', (s, b) => {
    s.archived_at = b.archived ? now() : null;
    if (b.archived) s.status = 'Stopped';
  });
  lifecycle('patch', 'unread', (s, b) => {
    s.unread = !!b.unread;
  });
  lifecycle('post', 'trash', (s) => {
    s.trashed_at = now();
    s.status = 'Stopped';
  });
  lifecycle('post', 'restore', (s) => {
    s.trashed_at = null;
  });
  lifecycle('post', 'stop', (s) => {
    s.status = 'Stopped';
  });
  lifecycle('post', 'start', (s) => {
    if (s.status === 'Stopped') s.status = 'Idle';
  });
  lifecycle('post', 'ensure', (s) => {
    const dead = s.status === 'Stopped';
    if (dead) s.status = 'Idle';
    return { status: dead ? 'restarted' : 'alive' };
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
  opts: {
    port?: number;
    token?: string;
    version?: string;
    sessions?: FakeSession[];
    transcripts?: TranscriptDirs;
  } = {},
): Promise<FakeAoe> {
  const state: FakeState = {
    version: opts.version ?? '1.17.2',
    token: opts.token ?? randomBytes(32).toString('hex'),
    sessions: opts.sessions ?? [],
    sent: [],
    keys: [],
    viewers: {},
    claims: [],
    shells: {},
    shellRan: [],
  };
  const transcripts = opts.transcripts ? new FakeTranscripts(opts.transcripts) : null;
  const app = createFakeApp(state, transcripts);
  let server: ServerType;
  const port = await new Promise<number>((resolve, reject) => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: opts.port ?? 0 }, (info) =>
      resolve(info.port),
    );
    server.on('error', reject);
  });
  attachLiveTerminal(server!, state, transcripts);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    transcripts,
    stop: () => new Promise((r) => server.close(() => r())),
  };
}

/**
 * AoE's live-terminal websocket, reduced to what Supercharge uses (src/server/live_ws.rs): bearer auth,
 * `claim_if_vacant` (only when nobody views the session) and `claim` (take over) answered with
 * `size_owner`, binary frames as raw pane input. Escape on a menu closes it and rejects the call it was
 * about, like Claude Code does.
 */
function attachLiveTerminal(server: ServerType, state: FakeState, transcripts: FakeTranscripts | null) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const m = /^\/sessions\/([^/]+)\/(terminal\/)?live-ws$/.exec(new URL(req.url ?? '', 'http://x').pathname);
    const shell = !!m?.[2];
    const s = m ? state.sessions.find((x) => x.id === m[1]) : undefined;
    if (!s || req.headers.authorization !== `Bearer ${state.token}`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (shell) return fakeShell(ws, s.id, state);
      let owner = false;
      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          const msg = JSON.parse(String(data)) as { type?: string };
          if (msg.type === 'claim_if_vacant' || msg.type === 'claim') {
            const viewer = state.viewers[s.id];
            owner = msg.type === 'claim' ? viewer !== 'stuck' : !viewer;
            state.claims.push({ id: s.id, type: msg.type, owner });
            ws.send(JSON.stringify({ type: 'size_owner', is_owner: owner }));
          }
          return;
        }
        if (!owner) return;
        const bytes = Buffer.from(data as Buffer);
        state.keys.push({ id: s.id, hex: bytes.toString('hex'), at: new Date().toISOString() });
        if (bytes.length === 1 && bytes[0] === 0x1b && s.menu) {
          s.menu = null;
          transcripts?.get(s.id)?.rejectPending();
        }
      });
    });
  });
}

/**
 * A session's paired shell, reduced to a prompt: `resize` and `claim` make you the owner, binary
 * frames type (bracketed paste markers dropped), Enter runs the line, which prints `ran: <line>`.
 * Frames are the whole window, history first, like AoE's.
 */
function fakeShell(ws: import('ws').WebSocket, id: string, state: FakeState) {
  // Each connection types on its own line, so tests in parallel browsers do not garble each other's.
  const shell = { lines: [...(state.shells[id]?.lines ?? [])], input: '' };
  let owner = false;
  let rows = 24;
  let seq = 0;
  const frame = () => {
    const prompt = `$ ${shell.input.split('\n').at(-1)}`;
    const all = [
      ...shell.lines,
      ...shell.input
        .split('\n')
        .slice(0, -1)
        .map((l) => `> ${l}`),
      prompt,
    ];
    while (all.length < rows) all.unshift('');
    ws.send(
      JSON.stringify({
        type: 'frame',
        seq: ++seq,
        content: all.join('\n'),
        rows,
        history: all.length - rows,
        cursor: { x: prompt.length, y: rows - 1 },
        altScreen: false,
        mouse: false,
        mouseSgr: false,
        pane0: null,
      }),
    );
  };
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      const msg = JSON.parse(String(data)) as { type?: string; rows?: number };
      if (msg.type === 'resize' || msg.type === 'claim' || msg.type === 'claim_if_vacant') {
        if (msg.type === 'resize' && msg.rows) rows = msg.rows;
        owner = true;
        ws.send(JSON.stringify({ type: 'size_owner', is_owner: true }));
        frame();
      }
      return;
    }
    if (!owner) return;
    const text = Buffer.from(data as Buffer)
      .toString('utf8')
      .replace(/\x1b\[20[01]~/g, '');
    for (const ch of text) {
      if (ch === '\r') {
        const command = shell.input;
        shell.lines.push(`$ ${command.split('\n').join('\n> ')}`.split('\n').join('\n'));
        for (const line of command.split('\n')) if (line.trim()) shell.lines.push(`ran: ${line}`);
        state.shellRan.push({ id, command, at: new Date().toISOString() });
        shell.input = '';
      } else if (ch === '\x7f') shell.input = shell.input.slice(0, -1);
      else shell.input += ch;
    }
    frame();
  });
}
