import { z } from 'zod';
import type { AoeCli } from './cli.ts';
import {
  AoeAboutSchema,
  AoeDeleteResponseSchema,
  AoeOutputSchema,
  AoeSendResponseSchema,
  AoeSessionsResponseSchema,
  type AoeSession,
} from './schemas.ts';

export type AoeErrorKind = 'unreachable' | 'auth' | 'protocol' | 'http';

/** AoE would not hand Supercharge the session's typing lock, even when asked to take over. */
export class TerminalBusyError extends Error {
  constructor() {
    super('AoE would not let Supercharge type into this session just now. Try again in a moment.');
  }
}

export class AoeError extends Error {
  constructor(
    message: string,
    public kind: AoeErrorKind,
    public status?: number,
  ) {
    super(message);
  }
}

/**
 * REST client for `aoe serve`. The token is read server-side only (`aoe url --token-only`),
 * kept in memory and re-read once on a 401 (AoE can regenerate it on restart). Requests send
 * `Authorization: Bearer` and no Origin header, like AoE's own internal client (SPEC §1.2).
 */
export class AoeClient {
  private origin: string | null = null;
  private token: string | null = null;

  constructor(
    private cli: AoeCli,
    private urlOverride: string = '',
  ) {}

  get currentOrigin(): string | null {
    return this.origin;
  }

  async discover(): Promise<{ origin: string; hasToken: boolean }> {
    const origin = this.urlOverride || (await this.cli.origin());
    if (!origin) throw new AoeError('aoe serve is not running (aoe url returned nothing)', 'unreachable');
    this.origin = origin;
    this.token = await this.cli.token();
    return { origin, hasToken: !!this.token };
  }

  private async request<S extends z.ZodType>(
    method: string,
    path: string,
    schema: S,
    body?: unknown,
    retried = false,
  ): Promise<z.output<S>> {
    if (!this.origin) await this.discover();
    let res: Response;
    try {
      res = await fetch(`${this.origin}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      this.origin = null;
      throw new AoeError(`Cannot reach aoe serve: ${(err as Error).message}`, 'unreachable');
    }
    if (res.status === 401 && !retried) {
      await this.discover();
      return this.request(method, path, schema, body, true);
    }
    if (res.status === 401) throw new AoeError('aoe serve rejected the token', 'auth', 401);
    const ct = res.headers.get('content-type') ?? '';
    // Unknown /api paths fall back to the SPA (200 text/html), so content-type is the real signal.
    if (!ct.includes('application/json')) {
      throw new AoeError(
        `Unexpected ${ct || 'empty'} response from ${method} ${path} (status ${res.status})`,
        'protocol',
        res.status,
      );
    }
    const json = (await res.json()) as unknown;
    if (!res.ok) {
      const msg =
        (json as { message?: string; error?: string })?.message ?? (json as { error?: string })?.error;
      throw new AoeError(
        `${method} ${path} failed (${res.status}): ${msg ?? 'unknown error'}`,
        'http',
        res.status,
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new AoeError(
        `${method} ${path} returned an unexpected shape: ${parsed.error.issues[0]?.message}`,
        'protocol',
      );
    }
    return parsed.data;
  }

  /**
   * Press keys in a session without AoE's trailing Enter (REST `send` always adds one), through AoE's own
   * live-terminal websocket. Only the holder of a session's typing lock may type there. Supercharge asks
   * for it with `claim_if_vacant`; when you have the session open in AoE (web or TUI), it takes over with
   * `claim` instead, without a `resize`, so the window keeps your size. Closing releases the lock, and
   * AoE's web view takes it back by itself within a couple of seconds (src/server/live_ws.rs, AoE
   * 1.17.2). Each key goes in its own frame, `gapMs` apart, so a lone Escape is read as Escape and not
   * as the start of an escape sequence.
   */
  async pressKeys(id: string, keys: (string | Uint8Array<ArrayBuffer>)[], gapMs = 300): Promise<void> {
    if (!this.origin) await this.discover();
    const url = `${this.origin!.replace(/^http/, 'ws')}/sessions/${encodeURIComponent(id)}/live-ws`;
    const ws = new WebSocket(url, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
    } as unknown as string[]);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // AoE answers every claim with a `size_owner` message.
    const waiters: ((owner: boolean) => void)[] = [];
    const opened = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new AoeError('Cannot open the AoE terminal connection', 'unreachable'));
    });
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      try {
        const m = JSON.parse(e.data) as { type?: string; is_owner?: boolean };
        if (m.type === 'size_owner') waiters.shift()?.(m.is_owner === true);
      } catch {
        // frames and other messages
      }
    };
    const claim = (type: 'claim_if_vacant' | 'claim') =>
      new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new AoeError('AoE did not answer the terminal claim', 'protocol')),
          5000,
        );
        waiters.push((owner) => {
          clearTimeout(timer);
          resolve(owner);
        });
        ws.send(JSON.stringify({ type }));
      });
    try {
      await opened;
      if (!(await claim('claim_if_vacant')) && !(await claim('claim'))) throw new TerminalBusyError();
      for (const [i, key] of keys.entries()) {
        if (i > 0) await sleep(gapMs);
        // Binary frames are raw pane input; text frames are control messages.
        ws.send(typeof key === 'string' ? new TextEncoder().encode(key) : key);
      }
      await sleep(gapMs);
    } finally {
      ws.close();
    }
  }

  /**
   * Start one of the session's paired shells if it is not running: the plain terminals AoE keeps next to
   * each session in its folder (its web view's Terminal tabs). Index 0 is the session's own; 1 to 31 are
   * extra ones. 201 when it was created (or a dead one respawned), 200 when it was already up
   * (src/server/api/sessions/ensure.rs, AoE 1.17.2).
   */
  async ensureTerminal(id: string, index = 0): Promise<{ created: boolean }> {
    const res = await this.request(
      'POST',
      `/api/sessions/${encodeURIComponent(id)}/terminal${index ? `?index=${index}` : ''}`,
      z.object({ status: z.string().optional() }).loose(),
    );
    return { created: res.status === 'created' };
  }

  /**
   * Close an extra paired shell and whatever runs in it. AoE refuses index 0, which its TUI shares
   * (`kill_terminal`, #2437); a shell that is already gone counts as closed.
   */
  async killTerminal(id: string, index: number): Promise<void> {
    await this.request(
      'DELETE',
      `/api/sessions/${encodeURIComponent(id)}/terminal?index=${index}`,
      z.unknown(),
    );
  }

  /**
   * Where to connect to a paired shell's live view, with the auth AoE wants. Same protocol as the agent
   * pane's (see `pressKeys`): JSON frames down, binary input and JSON control messages up. Connecting
   * starts the shell if it is missing, or respawns it if it died (`respawn_paired_if_dead`).
   */
  async terminalSocket(id: string, index = 0): Promise<{ url: string; headers: Record<string, string> }> {
    if (!this.origin) await this.discover();
    return {
      url: `${this.origin!.replace(/^http/, 'ws')}/sessions/${encodeURIComponent(id)}/terminal/live-ws${index ? `?index=${index}` : ''}`,
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
    };
  }

  /** `live` leaves out archived and trashed sessions; `all` has every session, marked by its `*_at` fields. */
  async listSessions(scope: 'live' | 'all' = 'live'): Promise<AoeSession[]> {
    return (await this.request('GET', `/api/sessions?state=${scope}`, AoeSessionsResponseSchema)).sessions;
  }

  // Session lifecycle (src/server/api/sessions/lifecycle.rs and ensure.rs, AoE 1.17.2).
  private lifecycle(method: string, id: string, action: string, body?: unknown) {
    return this.request(method, `/api/sessions/${encodeURIComponent(id)}/${action}`, z.unknown(), body);
  }

  /** Pinned sessions list first; pinning an archived session also unarchives it. */
  setPinned(id: string, pinned: boolean) {
    return this.lifecycle('PATCH', id, 'pin', { pinned });
  }

  /** Archive tears down the session's tmux panes (Claude stops); the worktree and branch stay. */
  setArchived(id: string, archived: boolean) {
    return this.lifecycle('PATCH', id, 'archive', { archived, kill_pane: true });
  }

  /** Into AoE's trash: restorable until AoE purges it (session.trash_retention_days, 30 by default). */
  trashSession(id: string) {
    return this.lifecycle('POST', id, 'trash', { kill_pane: true });
  }

  restoreSession(id: string) {
    return this.lifecycle('POST', id, 'restore');
  }

  stopSession(id: string) {
    return this.lifecycle('POST', id, 'stop');
  }

  startSession(id: string) {
    return this.lifecycle('POST', id, 'start');
  }

  /** Restart the agent's pane if it is dead, resuming its conversation (how AoE reopens an unarchived session). */
  ensureSession(id: string) {
    return this.lifecycle('POST', id, 'ensure');
  }

  setUnread(id: string, unread: boolean) {
    return this.lifecycle('PATCH', id, 'unread', { unread });
  }

  async about() {
    return this.request('GET', '/api/about', AoeAboutSchema);
  }

  async send(id: string, message: string) {
    return this.request('POST', `/api/sessions/${encodeURIComponent(id)}/send`, AoeSendResponseSchema, {
      message,
      revive: true,
    });
  }

  /** Recent pane text of a session (plain text, no ANSI). */
  async output(id: string, lines: number) {
    return this.request(
      'GET',
      `/api/sessions/${encodeURIComponent(id)}/output?lines=${lines}&format=text`,
      AoeOutputSchema,
    );
  }

  async deleteSession(id: string, opts: { deleteWorktree: boolean; deleteBranch: boolean }) {
    return this.request('DELETE', `/api/sessions/${encodeURIComponent(id)}`, AoeDeleteResponseSchema, {
      delete_worktree: opts.deleteWorktree,
      delete_branch: opts.deleteBranch,
      delete_sandbox: true,
      force_delete: false,
      keep_scratch: false,
    });
  }
}
