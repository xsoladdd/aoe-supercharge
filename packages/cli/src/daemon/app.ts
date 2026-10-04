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
import { VERSION, type Ctx } from '../context.ts';
import { buildProjectStatus } from '../status.ts';
import { CliError } from '../util/errors.ts';
import type { TranscriptStore } from '../transcript.ts';
import { replyToTask, sendToSession } from '../workflow.ts';
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
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

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
      return c.json(
        { error: 'reply_failed', message: (err as Error).message },
        err instanceof CliError ? 400 : 502,
      );
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
      return c.json(
        { error: 'send_failed', message: (err as Error).message },
        err instanceof CliError ? 400 : 502,
      );
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
