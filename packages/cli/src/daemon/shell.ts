import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ServerType } from '@hono/node-server';
import { appendAudit, hmac, safeEqual } from '@aoe-supercharge/core/node';
import { CONTROL_SHELL_INDEX, type RunTerminal } from '@aoe-supercharge/core/shared';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { followAttachedClient, tmuxWindow, type TmuxWindow } from '../attach.ts';
import type { Ctx } from '../context.ts';
import { hostsFor, originsFor, SESSION_COOKIE } from './app.ts';
import type { RunTerminals } from './run-terminals.ts';
import type { Store } from './store.ts';

/** Same limit as a command run through Claude Code's shell mode. */
const MAX_COMMAND = 20_000;
/** Control messages a browser may send on to AoE (src/server/live_ws.rs, AoE 1.17.2). No `caps`: frames stay JSON text. */
const PASSED_ON = new Set(['resize', 'claim', 'claim_if_vacant', 'cadence', 'window', 'resync']);
/** The Shell tab's terminal, the agent's own pane, or a terminal a Run opened in the chat. */
const PATH = /^\/api\/sessions\/([^/?#]+)\/(shell|agent|terminals\/([^/?#]+))\/ws(?:[?#]|$)/;
/** How often an open agent terminal checks whether you attached to the session in a terminal. */
const ATTACH_POLL_MS = 2000;

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
 * A session's shells in the dashboard: plain terminals AoE keeps next to each session, in its folder. The
 * daemon relays AoE's live view so its token never reaches the browser, and the browser types into it as
 * you would in AoE.
 *
 * - `/shell/ws` is the control chat's Shell tab: Supercharge's own paired terminal of the session
 *   (`CONTROL_SHELL_INDEX`), so Restart can close it. A command from Run in control shell comes as a
 *   `run` message.
 * - `/terminals/<id>/ws` is a terminal Run in a new terminal opened under the command; its command is
 *   typed in once, the first time a browser shows it.
 * - `/agent/ws` is the agent's own pane, the chat's Terminal view. Keys go straight in (no `prompt_sent`
 *   audit, no open-menu guard: SPEC §8.4); one `terminal_opened` audit per connection. While you are
 *   attached to the session in a terminal (`aoe session attach`, which AoE's size lock does not see), the
 *   browser's `resize` is dropped and it is told your window's size (`sc_window`), so it does not resize
 *   your terminal.
 *
 * Each command is recorded in the audit log, then pasted (bracketed, so a multi-line command waits whole
 * at the prompt) and entered. Only the dashboard's own pages may connect: the signed-in cookie, a known
 * Host (DNS rebinding) and a dashboard Origin (no other site can open it with your cookie).
 */
export function attachShellSockets(
  server: ServerType,
  deps: { ctx: Ctx; store: Store; token: string; terminals?: RunTerminals },
) {
  const { ctx, store, terminals } = deps;
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
    if (m[2] === 'shell')
      return wss.handleUpgrade(req, socket, head, (client) => void relay(client, id, null));
    if (m[2] === 'agent')
      return wss.handleUpgrade(req, socket, head, (client) => void relay(client, id, null, true));
    const tid = decodeURIComponent(m[3]!);
    void (terminals?.get(id, tid) ?? Promise.resolve(null)).then((record) => {
      if (!record) return refuse(socket, '404 Not Found');
      wss.handleUpgrade(req, socket, head, (client) => void relay(client, id, record));
    });
  });

  /** The project and task a session belongs to, for the audit log. */
  function owners(id: string) {
    const task = store.tasks.find((t) => t.aoeSessionId === id);
    return {
      project: store.projects.find((p) => p.controlSessionId === id)?.name ?? task?.project ?? null,
      taskId: task?.id ?? null,
    };
  }

  async function relay(client: WebSocket, id: string, record: RunTerminal | null, agent = false) {
    const index = record?.index ?? CONTROL_SHELL_INDEX;
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
    let poll: ReturnType<typeof setInterval> | undefined;
    client.on('close', () => {
      closed = true;
      clearInterval(poll);
      upstream?.close();
    });
    // A frame over `maxPayload` or a broken one: ws closes the connection, and the relay with it.
    client.on('error', () => upstream?.close());
    // Whether you are attached in a terminal, read before AoE sees the browser's first `resize`.
    let attached: TmuxWindow | null = null;
    const checkAttached = async () => {
      const w = await tmuxWindow(id).catch(() => null);
      const now = w?.attached ? w : null;
      if (now && !attached) await followAttachedClient(now.name).catch(() => {});
      if (JSON.stringify(now) === JSON.stringify(attached)) return;
      attached = now;
      toClient({ type: 'sc_window', attached: !!now, cols: now?.cols ?? 0, rows: now?.rows ?? 0 });
    };
    try {
      let socketOf: { url: string; headers: Record<string, string> };
      if (agent) {
        await checkAttached();
        poll = setInterval(() => void checkAttached(), ATTACH_POLL_MS);
        await appendAudit(ctx.paths, {
          actor: 'ui',
          action: 'terminal_opened',
          ...owners(id),
          sessionId: id,
          details: { where: 'agent' },
        });
        socketOf = await ctx.aoe.agentSocket(id);
      } else {
        const { created } = await ctx.aoe.ensureTerminal(id, index);
        // Its shell had gone (AoE was restarted, or someone typed `exit`), so AoE started another.
        if (record?.ran && created)
          toClient({ type: 'sc_note', message: 'The earlier shell had ended, so this is a fresh one.' });
        socketOf = await ctx.aoe.terminalSocket(id, index);
      }
      const { url, headers } = socketOf;
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
          // The browser has sized the terminal: type in the command it was opened for.
          const command = record && terminals?.takeRun(record);
          if (command) enqueue(command);
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
        // Typing into the agent: what has been read about the session is stale until AoE lists it again.
        if (agent) ctx.onTyped?.(id);
        return;
      }
      let m: { type?: unknown; command?: unknown };
      try {
        m = JSON.parse(data.toString()) as typeof m;
      } catch {
        return;
      }
      if (agent && attached && m.type === 'resize') return;
      if (typeof m.type === 'string' && PASSED_ON.has(m.type)) {
        up.send(data.toString());
        return;
      }
      if (m.type === 'run' && typeof m.command === 'string' && !record && !agent) enqueue(m.command);
    }

    function enqueue(raw: string) {
      const command = raw.replace(/^\s*\n+/, '').replace(/\s+$/, '');
      queue = queue
        .then(() => run(command))
        .catch((err: Error) => {
          ctx.logger.warn('shell relay: run failed', { session: id, err: err.message });
          toClient({ type: 'sc_error', message: `Could not run that: ${err.message}` });
        });
    }

    async function run(command: string) {
      if (!command || command.length > MAX_COMMAND) {
        toClient({ type: 'sc_error', message: 'That command is empty or too long to run here.' });
        return;
      }
      await appendAudit(ctx.paths, {
        actor: 'ui',
        action: 'command_run',
        ...owners(id),
        sessionId: id,
        text: command,
        details: record ? { where: 'new_terminal', index, terminal: record.id } : { where: 'terminal' },
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
