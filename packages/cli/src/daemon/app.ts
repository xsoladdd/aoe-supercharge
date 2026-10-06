import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import {
  appendAudit,
  ConfigValidationError,
  configJsonSchema,
  hmac,
  loadConfig,
  patchConfig,
  safeEqual,
} from '@aoe-supercharge/core/node';
import type { PlanComment, SlashCommand } from '@aoe-supercharge/core/shared';
import { VERSION, type Ctx } from '../context.ts';
import { buildProjectStatus } from '../status.ts';
import { CliError } from '../util/errors.ts';
import { PromptReader } from '../prompt.ts';
import { listSlashCommands } from '../slash.ts';
import { MAX_UPLOAD_BYTES, readUpload, saveUpload } from '../uploads.ts';
import type { TranscriptStore } from '../transcript.ts';
import {
  adoptSessions,
  answerPrompt,
  deleteProject,
  realDir,
  detectAdoptedMrs,
  answerQuestions,
  MenuOpenError,
  PromptChangedError,
  replyToTask,
  SESSION_ACTIONS,
  sendPlanComments,
  sendToSession,
  sessionAction,
  SessionLockedError,
  setSessionModel,
  TerminalBusyCliError,
  type QuestionAnswer,
  type SessionAction,
} from '../workflow.ts';
import type { Store } from './store.ts';

export interface AppDeps {
  ctx: Ctx;
  store: Store;
  token: string;
  uiDir: string | null;
  /** Called after a successful config write so the daemon reloads immediately. */
  onConfigWritten: () => Promise<void>;
  /** Ask the supervisor/service manager to restart us. */
  requestRestart: () => void;
  onClientConnected: () => void;
  testNotification: () => Promise<boolean>;
  transcripts: TranscriptStore;
}

export const SESSION_COOKIE = 'sc_session';
const NONCE_TTL_MS = 60_000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** A refused or failed send: 409 while a menu is open, 400 for usage errors, 502 when AoE failed. */
function sendError(c: Context, err: unknown, code: string) {
  const e = err as CliError;
  if (err instanceof MenuOpenError)
    return c.json({ error: 'menu_open', message: e.message, hint: e.hint }, 409);
  return c.json({ error: code, message: e.message }, err instanceof CliError ? 400 : 502);
}

export function createApp(deps: AppDeps) {
  const { ctx, store, token } = deps;
  const app = new Hono();
  const nonces = new Map<string, number>();
  const sessionValue = hmac(token, 'ui-session');
  const csrfValue = hmac(token, 'csrf');

  const allowedHosts = () => {
    const { hostname, port } = ctx.config.server;
    return new Set([
      `${hostname}:${port}`,
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
      hostname,
    ]);
  };
  const allowedOrigins = () => {
    const { hostname, port } = ctx.config.server;
    return new Set([
      `http://${hostname}:${port}`,
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      `http://${hostname}`,
    ]);
  };

  // DNS-rebinding gate + security headers on every response. No CORS headers, ever.
  app.use('*', async (c, next) => {
    const host = (c.req.header('host') ?? '').toLowerCase();
    if (!allowedHosts().has(host)) return c.text('Unknown host', 421);
    await next();
    c.header('Content-Security-Policy', CSP);
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
  });

  app.get('/healthz', (c) => c.json({ ok: true, version: VERSION }));

  app.get('/auth/callback', (c) => {
    const nonce = c.req.query('nonce') ?? '';
    const exp = nonces.get(nonce);
    nonces.delete(nonce);
    if (!exp || exp < Date.now()) {
      return c.html(
        signedOutPage('That sign-in link expired or was already used. Run "supercharge open" again.'),
        401,
      );
    }
    setCookie(c, SESSION_COOKIE, sessionValue, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return c.redirect('/', 302);
  });

  // ── /api auth: browser cookie or CLI bearer; CSRF for cookie-authenticated writes ──
  type Auth = { via: 'cookie' | 'bearer' };
  const authOf = (c: Context): Auth | null => {
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearer && safeEqual(bearer, token)) return { via: 'bearer' };
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie && safeEqual(cookie, sessionValue)) return { via: 'cookie' };
    return null;
  };

  app.use('/api/*', async (c, next) => {
    const auth = authOf(c);
    if (!auth) return c.json({ error: 'unauthorized', message: 'Run "supercharge open" to sign in.' }, 401);
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
    if (mutating && auth.via === 'cookie') {
      const origin = c.req.header('origin');
      const csrf = c.req.header('x-csrf-token') ?? '';
      if (!origin || !allowedOrigins().has(origin) || !safeEqual(csrf, csrfValue)) {
        return c.json({ error: 'csrf', message: 'Missing or invalid CSRF token.' }, 403);
      }
    }
    c.set('auth' as never, auth as never);
    await next();
  });

  app.post('/api/auth/nonce', (c) => {
    if ((c.get('auth' as never) as Auth).via !== 'bearer') return c.json({ error: 'forbidden' }, 403);
    for (const [n, exp] of nonces) if (exp < Date.now()) nonces.delete(n);
    const nonce = randomBytes(24).toString('hex');
    nonces.set(nonce, Date.now() + NONCE_TTL_MS);
    return c.json({ nonce, expiresInSec: NONCE_TTL_MS / 1000 });
  });

  app.post('/api/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/api/csrf', (c) => c.json({ token: csrfValue }));

  app.get('/api/snapshot', (c) => {
    deps.onClientConnected();
    return c.json(store.snapshot());
  });

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      let closed = false;
      let chain = Promise.resolve();
      const send = (id: number, event: string, data: unknown) => {
        chain = chain
          .then(() =>
            closed ? undefined : stream.writeSSE({ id: String(id), event, data: JSON.stringify(data) }),
          )
          .catch(() => {});
      };
      const lastId = Number(c.req.header('last-event-id'));
      const replay = Number.isFinite(lastId) ? store.since(lastId) : null;
      if (replay) for (const e of replay) send(e.seq, e.type, e.data);
      else {
        const snap = store.snapshot();
        send(snap.seq, 'snapshot', snap);
      }
      const unsub = store.subscribe((e) => send(e.seq, e.type, e.data));
      deps.onClientConnected();
      const ping = setInterval(() => {
        chain = chain
          .then(() => (closed ? undefined : stream.writeSSE({ event: 'ping', data: '' })))
          .catch(() => {});
      }, 20_000);
      await new Promise<void>((done) => stream.onAbort(() => done()));
      closed = true;
      clearInterval(ping);
      unsub();
    }),
  );

  app.get('/api/projects', (c) => c.json(store.projects));

  app.get('/api/projects/:project/status', (c) => {
    const p = store.projects.find((x) => x.name === c.req.param('project'));
    if (!p) return c.json({ error: 'not_found', message: 'Unknown project' }, 404);
    const sessions = store.health.aoe.state === 'ok' ? store.sessions : null;
    return c.json(buildProjectStatus(p, store.tasks, sessions, ctx.config.remoteControl.enabled));
  });

  app.get('/api/tasks/:project/:id', async (c) => {
    const { project, id } = c.req.param();
    const task = await ctx.ledger.getTask(project, id);
    if (!task) return c.json({ error: 'not_found', message: 'Unknown task' }, 404);
    return c.json({ task, plan: await ctx.ledger.readPlan(project, id) });
  });

  // Delete a project (Project settings, danger zone). The body must repeat the project's name.
  app.delete('/api/projects/:name', async (c) => {
    const name = c.req.param('name');
    const body = (await c.req.json().catch(() => ({}))) as {
      confirm?: unknown;
      deleteSessions?: unknown;
      deleteWorktrees?: unknown;
      deleteBranches?: unknown;
    };
    if (body.confirm !== name)
      return c.json({ error: 'confirm_required', message: 'Type the project name to delete it.' }, 400);
    try {
      const sessions = body.deleteSessions === true;
      const result = await deleteProject(ctx, {
        name,
        deleteSessions: sessions,
        deleteWorktrees: sessions && body.deleteWorktrees === true,
        deleteBranches: sessions && body.deleteBranches === true,
        actor: 'ui',
      });
      deps.onClientConnected();
      return c.json({ ok: true, ...result });
    } catch (err) {
      return sendError(c, err, 'delete_failed');
    }
  });

  // What "/" can run in a session: Claude Code's commands plus your and the project's skills and
  // commands. Read from disk, so it is cached briefly per project folder.
  const slashCache = new Map<string, { at: number; commands: SlashCommand[] }>();
  app.get('/api/sessions/:id/commands', async (c) => {
    const session = store.sessions.find((s) => s.id === c.req.param('id'));
    if (!session) return c.json({ error: 'not_found', message: 'Unknown session' }, 404);
    const key = session.projectPath ?? '';
    const hit = slashCache.get(key);
    if (hit && Date.now() - hit.at < 30_000) return c.json({ commands: hit.commands });
    const commands = await listSlashCommands(ctx.paths, session.projectPath);
    slashCache.set(key, { at: Date.now(), commands });
    return c.json({ commands });
  });

  // The right-click menu: one action on one or more sessions, each done (and audited) on its own so
  // a locked or failing one does not stop the rest.
  app.post('/api/sessions/actions', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      action?: unknown;
      ids?: unknown;
      permanent?: unknown;
      deleteWorktree?: unknown;
      deleteBranch?: unknown;
    };
    const action = body.action;
    if (typeof action !== 'string' || !(SESSION_ACTIONS as readonly string[]).includes(action))
      return c.json(
        { error: 'bad_action', message: `Unknown action. Use one of: ${SESSION_ACTIONS.join(', ')}.` },
        400,
      );
    const ids = Array.isArray(body.ids)
      ? [
          ...new Set(
            body.ids.filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x)),
          ),
        ]
      : [];
    if (!ids.length || ids.length > 200)
      return c.json({ error: 'bad_ids', message: 'Pick between 1 and 200 sessions.' }, 400);
    const known = new Set(store.sessions.map((s) => s.id));
    const permanent = body.permanent === true;
    const results: { id: string; ok: boolean; error?: string; locked?: boolean }[] = [];
    for (const id of ids) {
      if (!known.has(id)) {
        results.push({ id, ok: false, error: 'Unknown session' });
        continue;
      }
      try {
        await sessionAction(ctx, {
          sessionId: id,
          action: action as SessionAction,
          permanent,
          deleteWorktree: permanent && body.deleteWorktree === true,
          deleteBranch: permanent && body.deleteBranch === true,
          actor: 'ui',
        });
        results.push({ id, ok: true });
      } catch (err) {
        results.push({
          id,
          ok: false,
          error: (err as Error).message,
          ...(err instanceof SessionLockedError ? { locked: true } : {}),
        });
      }
    }
    deps.onClientConnected();
    return c.json({ results });
  });

  // Adopting an AoE parent session and its children: what would happen, then do it.
  app.get('/api/adopt/:sessionId', async (c) => {
    const id = c.req.param('sessionId');
    const list = await ctx.aoeCli.list().catch(() => null);
    if (!list) return c.json({ error: 'aoe_error', message: 'Could not list AoE sessions.' }, 502);
    const control = list.find((e) => e.id === id);
    if (!control) return c.json({ error: 'not_found', message: 'Unknown session' }, 404);
    const managed = new Set([
      ...store.tasks.map((t) => t.aoeSessionId),
      ...store.projects.map((p) => p.controlSessionId).filter((x): x is string => !!x),
    ]);
    const repoOf = async (e: (typeof list)[number]) => {
      const p = e.worktree?.main_repo_path ?? e.path;
      return p ? realDir(p) : '';
    };
    const children = await Promise.all(
      list
        .filter((e) => e.parent_session_id === id)
        .map(async (e) => ({
          id: e.id,
          title: e.title ?? e.id,
          branch: e.worktree?.branch ?? null,
          repo: await repoOf(e),
          managed: managed.has(e.id),
        })),
    );
    // Suggest the repository most children live in, and the project already registered for it.
    const counts = new Map<string, number>();
    for (const ch of children) if (ch.repo) counts.set(ch.repo, (counts.get(ch.repo) ?? 0) + 1);
    const repo = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    let project: (typeof store.projects)[number] | null = null;
    for (const p of store.projects) if (repo && (await realDir(p.repoPath)) === repo) project = p;
    return c.json({
      control: {
        id: control.id,
        title: control.title ?? control.id,
        path: control.path ?? null,
        managed: managed.has(id),
      },
      children,
      // Real paths, so the dialog can flag children from another repository whichever project you pick.
      projects: await Promise.all(
        store.projects.map(async (p) => ({ name: p.name, repo: await realDir(p.repoPath) })),
      ),
      suggestion: {
        repoPath: repo,
        project: project?.name ?? null,
        currentControl: project?.controlSessionId ?? null,
      },
    });
  });

  app.post('/api/adopt', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      controlSessionId?: unknown;
      projectName?: unknown;
      repoPath?: unknown;
      children?: unknown;
      makeControl?: unknown;
    };
    if (
      typeof body.controlSessionId !== 'string' ||
      typeof body.projectName !== 'string' ||
      !Array.isArray(body.children)
    )
      return c.json(
        { error: 'bad_request', message: 'Pass the parent session, a project and the children.' },
        400,
      );
    try {
      const result = await adoptSessions(ctx, {
        controlSessionId: body.controlSessionId,
        projectName: body.projectName,
        repoPath: typeof body.repoPath === 'string' ? body.repoPath : undefined,
        children: body.children.filter((x): x is string => typeof x === 'string'),
        makeControl: body.makeControl === true,
        actor: 'user',
      });
      // Look up open MRs in the background; the ledger watcher shows the stage changes as they land.
      void detectAdoptedMrs(ctx, result.project, result.tasks).catch((err) =>
        ctx.logger.warn('MR lookup after adoption failed', { err: (err as Error).message }),
      );
      deps.onClientConnected();
      return c.json({
        ok: true,
        project: result.project.name,
        tasks: result.tasks.map((t) => t.id),
        skipped: result.skipped,
      });
    } catch (err) {
      return sendError(c, err, 'adopt_failed');
    }
  });

  // Plan comments: select text in a plan, comment, then send them to the worker in one go.
  app.get('/api/tasks/:project/:id/comments', async (c) => {
    const { project, id } = c.req.param();
    if (!(await ctx.ledger.getTask(project, id)))
      return c.json({ error: 'not_found', message: 'Unknown task' }, 404);
    return c.json({ comments: await ctx.ledger.readComments(project, id) });
  });

  app.post('/api/tasks/:project/:id/comments', async (c) => {
    const { project, id } = c.req.param();
    if (!(await ctx.ledger.getTask(project, id)))
      return c.json({ error: 'not_found', message: 'Unknown task' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { quote?: unknown; text?: unknown };
    const quote = typeof body.quote === 'string' ? body.quote.trim().slice(0, 4000) : '';
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 8000) : '';
    if (!quote || !text)
      return c.json({ error: 'bad_request', message: 'Select some text and write a comment.' }, 400);
    const comment: PlanComment = {
      id: randomBytes(6).toString('hex'),
      quote,
      text,
      createdAt: new Date().toISOString(),
      sentAt: null,
    };
    const comments = await ctx.ledger.updateComments(project, id, (cur) => [...cur, comment]);
    return c.json({ comment, comments });
  });

  app.delete('/api/tasks/:project/:id/comments/:cid', async (c) => {
    const { project, id, cid } = c.req.param();
    const comments = await ctx.ledger.updateComments(project, id, (cur) => cur.filter((x) => x.id !== cid));
    return c.json({ comments });
  });

  app.post('/api/tasks/:project/:id/comments/send', async (c) => {
    const { project, id } = c.req.param();
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((x): x is string => typeof x === 'string')
      : undefined;
    try {
      const comments = await sendPlanComments(ctx, { project, taskId: id, ids, actor: 'ui' });
      return c.json({ ok: true, comments });
    } catch (err) {
      return sendError(c, err, 'comments_failed');
    }
  });

  // Every active task's comments, for the control chat's side panel.
  app.get('/api/projects/:name/comments', async (c) => {
    const name = c.req.param('name');
    const tasks = store.tasks.filter((t) => t.project === name && t.stage !== 'done');
    const out = await Promise.all(
      tasks.map(async (t) => ({ taskId: t.id, comments: await ctx.ledger.readComments(name, t.id) })),
    );
    return c.json({ tasks: out });
  });

  app.get('/api/projects/:name/notes', async (c) => {
    const name = c.req.param('name');
    if (!store.projects.some((p) => p.name === name))
      return c.json({ error: 'not_found', message: 'Unknown project' }, 404);
    return c.json({ text: await ctx.ledger.readNotes(name) });
  });

  app.put('/api/projects/:name/notes', async (c) => {
    const name = c.req.param('name');
    if (!store.projects.some((p) => p.name === name))
      return c.json({ error: 'not_found', message: 'Unknown project' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
    if (typeof body.text !== 'string' || body.text.length > 200_000)
      return c.json({ error: 'bad_request', message: 'Notes must be text, up to 200k characters.' }, 400);
    await ctx.ledger.writeNotes(name, body.text);
    return c.json({ ok: true });
  });

  app.post('/api/tasks/:project/:id/reply', async (c) => {
    const { project, id } = c.req.param();
    const body = (await c.req.json().catch(() => ({}))) as { message?: string; confirm?: boolean };
    if (body.confirm !== true)
      return c.json(
        { error: 'confirm_required', message: 'Sending a prompt to an agent must be confirmed.' },
        400,
      );
    try {
      const task = await replyToTask(ctx, { project, taskId: id, message: body.message ?? '', actor: 'ui' });
      return c.json({ ok: true, task });
    } catch (err) {
      return sendError(c, err, 'reply_failed');
    }
  });

  // Live conversation of any known AoE session (control chats, workers, others). Text only, no ANSI.
  app.get('/api/sessions/:id/output', async (c) => {
    const id = c.req.param('id');
    if (!store.sessions.some((s) => s.id === id))
      return c.json({ error: 'not_found', message: 'Unknown session' }, 404);
    const lines = Math.min(Math.max(Number(c.req.query('lines')) || 300, 20), 2000);
    try {
      const out = await ctx.aoe.output(id, lines);
      const rcUrl = out.content.match(/https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+/)?.[0] ?? null;
      return c.json({ content: out.content.replace(/\s+$/, ''), rcUrl });
    } catch (err) {
      return c.json({ error: 'aoe_error', message: (err as Error).message }, 502);
    }
  });

  // The session's conversation parsed from Claude Code's transcript, for the chat view.
  app.get('/api/sessions/:id/chat', async (c) => {
    const id = c.req.param('id');
    const session = store.sessions.find((s) => s.id === id);
    if (!session) return c.json({ error: 'not_found', message: 'Unknown session' }, 404);
    try {
      const chat = await deps.transcripts.read(id, session.projectPath);
      if (c.req.query('version') === chat.version) return c.json({ unchanged: true, version: chat.version });
      return c.json(chat);
    } catch (err) {
      ctx.logger.warn('transcript read failed', { session: id, err: (err as Error).message });
      return c.json({
        state: 'unavailable',
        version: 'error',
        title: null,
        messages: [],
        truncated: 0,
        note: 'Could not read this conversation. The Terminal view still works.',
      });
    }
  });

  // Typing into a session from the dashboard: an explicit Send, always audited.
  app.post('/api/sessions/:id/send', async (c) => {
    const id = c.req.param('id');
    const session = store.sessions.find((s) => s.id === id);
    if (!session) return c.json({ error: 'not_found', message: 'Unknown session' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { message?: string };
    if (session.locked && body.message?.trim() === '/clear')
      return c.json({ error: 'locked', message: 'This session is locked. Unlock it to clear it.' }, 409);
    const task = store.tasks.find((t) => t.aoeSessionId === id) ?? null;
    const project = task?.project ?? store.projects.find((p) => p.controlSessionId === id)?.name ?? null;
    try {
      await sendToSession(ctx, {
        sessionId: id,
        message: body.message ?? '',
        actor: 'ui',
        project,
        taskId: task?.id ?? null,
      });
      return c.json({ ok: true });
    } catch (err) {
      return sendError(c, err, 'send_failed');
    }
  });

  // A file you attach in a chat: saved outside the repo, under the session's uploads folder. The chat
  // then sends its path in the message, and Claude opens it (the Read tool shows images to the model).
  app.post('/api/sessions/:id/uploads', async (c) => {
    const id = c.req.param('id');
    if (!store.sessions.some((s) => s.id === id))
      return c.json({ error: 'not_found', message: 'Unknown session' }, 404);
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > MAX_UPLOAD_BYTES)
      return c.json({ error: 'too_large', message: 'Files up to 20 MB can be attached.' }, 413);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.length) return c.json({ error: 'empty', message: 'The file is empty.' }, 400);
    if (bytes.length > MAX_UPLOAD_BYTES)
      return c.json({ error: 'too_large', message: 'Files up to 20 MB can be attached.' }, 413);
    let name = 'file';
    try {
      name = decodeURIComponent(c.req.header('x-file-name') ?? 'file');
    } catch {
      // keep the default
    }
    const saved = await saveUpload(ctx.paths, id, name, bytes);
    ctx.logger.info('upload saved', { session: id, file: saved.file, bytes: bytes.length });
    return c.json(saved);
  });

  app.get('/api/uploads/:sessionId/:file', async (c) => {
    const found = await readUpload(ctx.paths, c.req.param('sessionId'), c.req.param('file'));
    if (!found) return c.json({ error: 'not_found', message: 'No such file' }, 404);
    return new Response(new Uint8Array(found.bytes), {
      headers: {
        'content-type': found.type,
        'content-disposition': found.inline ? 'inline' : 'attachment',
        'cache-control': 'private, max-age=86400',
        'x-content-type-options': 'nosniff',
      },
    });
  });

  // Switch a running session's model or effort (/model, /effort). The UI warns that Claude Code also
  // saves it as the user's default before calling this.
  app.post('/api/sessions/:id/model', async (c) => {
    const id = c.req.param('id');
    if (!store.sessions.some((s) => s.id === id))
      return c.json({ error: 'not_found', message: 'Unknown session' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { model?: unknown; effort?: unknown };
    const task = store.tasks.find((t) => t.aoeSessionId === id) ?? null;
    const project = task?.project ?? store.projects.find((p) => p.controlSessionId === id)?.name ?? null;
    try {
      await setSessionModel(ctx, {
        sessionId: id,
        model: typeof body.model === 'string' ? body.model : undefined,
        effort: typeof body.effort === 'string' ? body.effort : undefined,
        actor: 'ui',
        project,
        taskId: task?.id ?? null,
      });
      return c.json({ ok: true });
    } catch (err) {
      return sendError(c, err, 'model_failed');
    }
  });

  // What a waiting session's menu is asking, read fresh, plus the plan or questions it is about.
  app.get('/api/sessions/:id/prompt', async (c) => {
    const id = c.req.param('id');
    const session = store.sessions.find((s) => s.id === id);
    if (!session) return c.json({ error: 'not_found', message: 'Unknown session' }, 404);
    const prompt = await new PromptReader(ctx, deps.transcripts).read(id, session.projectPath);
    let detail: unknown = null;
    if (prompt?.kind === 'plan' || prompt?.kind === 'question') {
      const tool = await deps.transcripts.pendingTool(id, session.projectPath).catch(() => null);
      try {
        detail = tool ? JSON.parse(tool.input) : null;
      } catch {
        detail = null; // clipped beyond the JSON's end
      }
    }
    const input = detail as { plan?: unknown; questions?: unknown } | null;
    // Claude Code may not have written the AskUserQuestion call yet; then the screen is all there is:
    // the question in front, and the other questions' headers from its tab bar.
    const fromScreen =
      prompt?.kind === 'question' && !Array.isArray(input?.questions)
        ? [
            {
              question: prompt.question,
              multiSelect: !!prompt.multi,
              options: prompt.options
                .filter((o) => !/^(type something\.?|chat about this)$/i.test(o.label))
                .map((o) => ({ label: o.label, description: o.hint ?? undefined })),
            },
          ]
        : null;
    return c.json({
      prompt,
      plan: typeof input?.plan === 'string' ? input.plan : null,
      questions: Array.isArray(input?.questions) ? input.questions : fromScreen,
      // With questions from the screen, the others are known only by their tab headers.
      otherTabs: fromScreen ? (prompt?.tabs ?? []) : [],
    });
  });

  // Answer Claude's multiple-choice questions (AskUserQuestion): close them with Escape, send the answers.
  app.post('/api/sessions/:id/answer-questions', async (c) => {
    const id = c.req.param('id');
    const session = store.sessions.find((s) => s.id === id);
    if (!session) return c.json({ error: 'not_found', message: 'Unknown session' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      toolId?: string;
      answers?: QuestionAnswer[];
      note?: string;
    };
    if (typeof body.toolId !== 'string' || !Array.isArray(body.answers))
      return c.json({ error: 'bad_request', message: 'Pass the question call id and the answers.' }, 400);
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
    const answers = body.answers
      .filter((a) => a && typeof a.question === 'string')
      .map((a) => ({
        question: text(a.question, 2000),
        picked: (Array.isArray(a.picked) ? a.picked : []).map((p) => text(p, 2000)).filter(Boolean),
        other: text(a.other, 10_000) || undefined,
      }));
    const task = store.tasks.find((t) => t.aoeSessionId === id) ?? null;
    const project = task?.project ?? store.projects.find((p) => p.controlSessionId === id)?.name ?? null;
    try {
      await answerQuestions(ctx, deps.transcripts, {
        sessionId: id,
        cwd: session.projectPath,
        toolId: body.toolId,
        answers,
        note: text(body.note, 10_000) || undefined,
        actor: 'ui',
        project,
        taskId: task?.id ?? null,
      });
      deps.onClientConnected();
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof PromptChangedError)
        return c.json({ error: 'prompt_changed', message: err.message }, 409);
      if (err instanceof TerminalBusyCliError)
        return c.json({ error: 'terminal_busy', message: err.message }, 409);
      return sendError(c, err, 'answer_failed');
    }
  });

  // Answer that menu: an explicit click in the dashboard, audited, only while the same menu is on screen.
  app.post('/api/sessions/:id/answer', async (c) => {
    const id = c.req.param('id');
    const session = store.sessions.find((s) => s.id === id);
    if (!session) return c.json({ error: 'not_found', message: 'Unknown session' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { key?: string; option?: number; text?: string };
    if (typeof body.key !== 'string' || !Number.isInteger(body.option))
      return c.json({ error: 'bad_request', message: 'Pass the menu key and an option number.' }, 400);
    const task = store.tasks.find((t) => t.aoeSessionId === id) ?? null;
    const project = task?.project ?? store.projects.find((p) => p.controlSessionId === id)?.name ?? null;
    try {
      await answerPrompt(ctx, {
        sessionId: id,
        key: body.key,
        option: body.option!,
        text: body.text,
        actor: 'ui',
        project,
        taskId: task?.id ?? null,
      });
      deps.onClientConnected(); // re-poll now so the answered menu clears quickly
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof PromptChangedError)
        return c.json({ error: 'prompt_changed', message: err.message }, 409);
      return sendError(c, err, 'answer_failed');
    }
  });

  app.get('/api/config', async (c) => {
    const loaded = await loadConfig(ctx.paths);
    return c.json({
      config: loaded.config,
      errors: loaded.errors,
      path: ctx.paths.configFile,
      schema: configJsonSchema(),
      restartRequired: store.health.config.restartRequired,
      restartPrefixes: ['server', 'aoe', 'agent'],
      supervised: !!(process.env.SUPERCHARGE_SERVICE || process.env.SUPERCHARGE_SUPERVISED),
    });
  });

  app.put('/api/config', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { patch?: Record<string, unknown> } | null;
    if (!body?.patch || typeof body.patch !== 'object')
      return c.json({ error: 'bad_request', message: 'Expected { patch }' }, 400);
    try {
      const res = await patchConfig(ctx.paths, body.patch);
      if (res.changedKeys.length) {
        await appendAudit(ctx.paths, {
          actor: 'ui',
          action: 'config_changed',
          details: { keys: res.changedKeys },
        });
        await deps.onConfigWritten();
      }
      return c.json({
        ok: true,
        changedKeys: res.changedKeys,
        restartRequired: store.health.config.restartRequired,
        config: res.config,
      });
    } catch (err) {
      if (err instanceof ConfigValidationError)
        return c.json({ error: 'invalid', message: 'Some values are invalid.', issues: err.issues }, 422);
      throw err;
    }
  });

  app.post('/api/daemon/restart', async (c) => {
    await appendAudit(ctx.paths, { actor: 'ui', action: 'daemon_restart' });
    setTimeout(() => deps.requestRestart(), 150);
    return c.json({ ok: true, message: 'Restarting.' });
  });

  app.post('/api/notifications/test', async (c) => c.json({ ok: await deps.testNotification() }));

  app.all('/api/*', (c) => c.json({ error: 'not_found', message: 'Unknown API route' }, 404));

  // ── Static UI with SPA fallback. The shell is public; all data is behind /api. ──
  app.get('*', async (c) => {
    if (!deps.uiDir)
      return c.html(signedOutPage('The dashboard bundle is missing. Rebuild with "npm run build".'), 503);
    const root = resolve(deps.uiDir);
    const rel = normalize(decodeURIComponent(new URL(c.req.url).pathname)).replace(/^([/\\])+/, '');
    let file = resolve(join(root, rel));
    if (file !== root && !file.startsWith(root + sep)) return c.text('Not found', 404);
    let isFile = false;
    try {
      isFile = (await stat(file)).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      if (extname(rel)) return c.text('Not found', 404);
      file = join(root, 'index.html');
    }
    const body = await readFile(file);
    const immutable = rel.startsWith('assets/');
    return c.body(body, 200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
  });

  app.onError((err, c) => {
    ctx.logger.error('request failed', { path: c.req.path, err });
    return c.json({ error: 'internal', message: 'Internal error; see "supercharge logs".' }, 500);
  });

  return app;
}

function signedOutPage(message: string): string {
  const esc = message.replace(
    /[&<>"]/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!,
  );
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Supercharge</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#17191a;color:#f4f4f5;font:16px/1.5 system-ui,sans-serif}main{max-width:32rem;padding:2rem}code{background:#27292d;padding:.15rem .4rem;border-radius:6px}</style>
<main><h1 style="font-size:22px;font-weight:600">Supercharge</h1><p>${esc}</p></main></html>`;
}
