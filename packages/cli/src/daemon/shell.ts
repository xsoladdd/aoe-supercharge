import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ServerType } from '@hono/node-server';
import { appendAudit, hmac, safeEqual } from '@aoe-supercharge/core/node';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Ctx } from '../context.ts';
import { hostsFor, originsFor, SESSION_COOKIE } from './app.ts';
import type { Store } from './store.ts';

/** Same limit as a command run through Claude Code's shell mode. */
const MAX_COMMAND = 20_000;
/** Control messages a browser may send on to AoE (src/server/live_ws.rs, AoE 1.17.2). No `caps`: frames stay JSON text. */
const PASSED_ON = new Set(['resize', 'claim', 'claim_if_vacant', 'cadence', 'window', 'resync']);
const PATH = /^\/api\/sessions\/([^/?#]+)\/shell\/ws(?:[?#]|$)/;

function refuse(socket: Duplex, status: string) {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function cookieOf(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/**
 * A session's paired shell in the dashboard: the plain terminal AoE keeps next to each session, in its
 * folder (AoE's own Terminal tab). The daemon relays AoE's live view so its token never reaches the
 * browser. The browser types into it as you would in AoE; a command run from a chat's Run button comes
 * as a `run` message, which is recorded in the audit log, then pasted (bracketed, so a multi-line
 * command waits whole at the prompt) and entered.
 *
 * Only the dashboard's own pages may connect: the signed-in cookie, a known Host (DNS rebinding) and a
 * dashboard Origin (no other site can open it with your cookie).
 */
export function attachShellSockets(server: ServerType, deps: { ctx: Ctx; store: Store; token: string }) {
  const { ctx, store } = deps;
  const sessionValue = hmac(deps.token, 'ui-session');
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Node leaves an upgrading socket without an error listener; a reset connection would throw.
    socket.on('error', () => socket.destroy());
    const m = PATH.exec(req.url ?? '');
    if (!m) return refuse(socket, '404 Not Found');
    const host = (req.headers.host ?? '').toLowerCase();
    if (!hostsFor(ctx.config.server).has(host)) return refuse(socket, '421 Misdirected Request');
    if (!originsFor(ctx.config.server).has(req.headers.origin ?? '')) return refuse(socket, '403 Forbidden');
    const cookie = cookieOf(req, SESSION_COOKIE);
    if (!cookie || !safeEqual(cookie, sessionValue)) return refuse(socket, '401 Unauthorized');
    const id = decodeURIComponent(m[1]!);
    const session = store.sessions.find((s) => s.id === id && !s.archived);
    if (!session) return refuse(socket, '404 Not Found');
    wss.handleUpgrade(req, socket, head, (client) => void relay(client, id));
  });

  async function relay(client: WebSocket, id: string) {
    const toClient = (m: object) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(m));
    };
    // What the browser sends before AoE answers waits for it.
    const early: { data: RawData; binary: boolean }[] = [];
    let upstream: WebSocket | null = null;
    let closed = false;
    client.on('message', (data, binary) => {
      if (upstream?.readyState === WebSocket.OPEN) void fromClient(data, binary);
      else early.push({ data, binary });
    });
    client.on('close', () => {
      closed = true;
      upstream?.close();
    });
    // A frame over `maxPayload` or a broken one: ws closes the connection, and the relay with it.
    client.on('error', () => upstream?.close());
    try {
      await ctx.aoe.ensureTerminal(id);
      const { url, headers } = await ctx.aoe.terminalSocket(id);
      if (closed) return;
      upstream = new WebSocket(url, { headers });
    } catch (err) {
      toClient({ type: 'sc_error', message: `Could not open the terminal: ${(err as Error).message}` });
      client.close(1011);
      return;
    }
    const up = upstream;
    let owner = false;
    const ownerWaits: (() => void)[] = [];
    up.on('open', () => {
      for (const m of early.splice(0)) void fromClient(m.data, m.binary);
    });
    up.on('message', (data, binary) => {
      if (binary) return; // only with `caps.deflate`, which we never ask for
      const text = data.toString();
      try {
        const m = JSON.parse(text) as { type?: string; is_owner?: boolean };
        if (m.type === 'size_owner') {
          owner = m.is_owner === true;
          if (owner) for (const w of ownerWaits.splice(0)) w();
        }
      } catch {
        return;
      }
      if (client.readyState === WebSocket.OPEN) client.send(text);
    });
    up.on('close', () => client.close());
    up.on('error', (err) => {
      ctx.logger.warn('shell relay: AoE closed the terminal', { session: id, err: err.message });
      toClient({ type: 'sc_error', message: 'AoE closed the terminal connection.' });
      client.close(1011);
    });

    let queue = Promise.resolve();
    async function fromClient(data: RawData, binary: boolean) {
      if (binary) {
        // Your own keystrokes, as in AoE's terminal.
        if (up.readyState === WebSocket.OPEN) up.send(data, { binary: true });
        return;
      }
      let m: { type?: unknown; command?: unknown };
      try {
        m = JSON.parse(data.toString()) as typeof m;
      } catch {
        return;
      }
      if (typeof m.type === 'string' && PASSED_ON.has(m.type)) {
        up.send(data.toString());
        return;
      }
      if (m.type === 'run' && typeof m.command === 'string') {
        const command = m.command.replace(/^\s*\n+/, '').replace(/\s+$/, '');
        queue = queue
          .then(() => run(command))
          .catch((err: Error) => {
            ctx.logger.warn('shell relay: run failed', { session: id, err: err.message });
            toClient({ type: 'sc_error', message: `Could not run that: ${err.message}` });
          });
      }
    }

    async function run(command: string) {
      if (!command || command.length > MAX_COMMAND) {
        toClient({ type: 'sc_error', message: 'That command is empty or too long to run here.' });
        return;
      }
      const project =
        store.projects.find((p) => p.controlSessionId === id)?.name ??
        store.tasks.find((t) => t.aoeSessionId === id)?.project ??
        null;
      await appendAudit(ctx.paths, {
        actor: 'ui',
        action: 'command_run',
        project,
        taskId: store.tasks.find((t) => t.aoeSessionId === id)?.id ?? null,
        sessionId: id,
        text: command,
        details: { where: 'terminal' },
      });
      if (!owner) {
        // Someone has this shell open in AoE: take the typing lock over, as AoE's Take over does.
        up.send(JSON.stringify({ type: 'claim' }));
        await Promise.race([new Promise<void>((r) => ownerWaits.push(r)), sleep(3000)]);
        if (!owner) {
          toClient({ type: 'sc_error', message: 'AoE would not let Supercharge type into this terminal.' });
          return;
        }
      }
      up.send(Buffer.from(`\x1b[200~${command}\x1b[201~`), { binary: true });
      await sleep(150);
      up.send(Buffer.from('\r'), { binary: true });
      toClient({ type: 'sc_ran', command });
    }
  }
}
