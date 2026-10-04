import { readToken } from '@aoe-supercharge/core/node';
import type { Ctx } from '../context.ts';

export interface DaemonResponse<T> {
  status: number;
  body: T;
}

/** CLI → daemon over loopback with the bearer token. Returns null when the daemon is not running. */
export async function daemonRequest<T = unknown>(
  ctx: Ctx,
  method: string,
  path: string,
  body?: unknown,
): Promise<DaemonResponse<T> | null> {
  const token = await readToken(ctx.paths);
  try {
    const res = await fetch(`http://127.0.0.1:${ctx.config.server.port}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5_000),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep text
    }
    return { status: res.status, body: parsed as T };
  } catch {
    return null;
  }
}

export async function daemonHealth(ctx: Ctx): Promise<{ ok: boolean; version?: string } | null> {
  const r = await daemonRequest<{ ok: boolean; version?: string }>(ctx, 'GET', '/healthz');
  return r && r.status === 200 && typeof r.body === 'object' ? r.body : null;
}

export async function waitForDaemon(ctx: Ctx, timeoutMs = 12_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await daemonHealth(ctx)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
