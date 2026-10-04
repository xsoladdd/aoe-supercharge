import type { z } from 'zod';
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

/** Someone is viewing the session in AoE (web or TUI) and holds its typing lock. */
export class TerminalBusyError extends Error {
  constructor() {
    super(
      'The session is open in AoE right now, so Supercharge cannot type into it. Answer there, or close it in AoE and try again.',
    );
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
   * live-terminal websocket: `claim_if_vacant` takes the typing lock only when nobody is viewing the
   * session in AoE; no `resize` is sent, so the window keeps its size; closing releases the lock
   * (src/server/live_ws.rs, AoE 1.17.2). Each key goes in its own frame, `gapMs` apart, so a lone
   * Escape is read as Escape and not as the start of an escape sequence.
   */
  async pressKeys(id: string, keys: (string | Uint8Array<ArrayBuffer>)[], gapMs = 300): Promise<void> {
    if (!this.origin) await this.discover();
    const url = `${this.origin!.replace(/^http/, 'ws')}/sessions/${encodeURIComponent(id)}/live-ws`;
    const ws = new WebSocket(url, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
    } as unknown as string[]);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      const owner = await new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new AoeError('AoE did not answer the terminal claim', 'protocol')),
          5000,
        );
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new AoeError('Cannot open the AoE terminal connection', 'unreachable'));
        };
        ws.onopen = () => ws.send(JSON.stringify({ type: 'claim_if_vacant' }));
        ws.onmessage = (e) => {
          if (typeof e.data !== 'string') return;
          try {
            const m = JSON.parse(e.data) as { type?: string; is_owner?: boolean };
            if (m.type === 'size_owner') {
              clearTimeout(timer);
              resolve(m.is_owner === true);
            }
          } catch {
            // frames and other messages
          }
        };
      });
      if (!owner) throw new TerminalBusyError();
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

  async listSessions(): Promise<AoeSession[]> {
    return (await this.request('GET', '/api/sessions?state=live', AoeSessionsResponseSchema)).sessions;
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
