import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RequestTokens, StatusContext } from '../shared/chat.ts';
import { mergeUsage, type UsageRecord, type UsageWindow } from '../shared/usage.ts';
import { writeFileAtomic } from './fs.ts';
import type { Paths } from './paths.ts';

export async function readUsage(paths: Paths): Promise<UsageRecord | null> {
  try {
    const v = JSON.parse(await readFile(paths.usageFile, 'utf8')) as UsageRecord;
    return v && typeof v === 'object' && 'capturedAt' in v ? v : null;
  } catch {
    return null;
  }
}

/** A `rate_limits.<window>` object from Claude Code's status line input, if it is well formed. */
function statusWindow(v: unknown): UsageWindow | null {
  if (!v || typeof v !== 'object') return null;
  const { used_percentage: used, resets_at: resets } = v as Record<string, unknown>;
  if (typeof used !== 'number' || !Number.isFinite(used) || typeof resets !== 'number') return null;
  return {
    usedPercentage: Math.min(100, Math.max(0, used)),
    resetsAt: new Date(resets * 1000).toISOString(),
  };
}

/**
 * Merge the `rate_limits` from one status line update into usage.json. Returns false when the
 * input has none (API key users, or before the session's first reply).
 */
export async function recordUsage(paths: Paths, rateLimits: unknown, now = new Date()): Promise<boolean> {
  if (!rateLimits || typeof rateLimits !== 'object') return false;
  const r = rateLimits as Record<string, unknown>;
  const next: UsageRecord = {
    fiveHour: statusWindow(r.five_hour),
    sevenDay: statusWindow(r.seven_day),
    capturedAt: now.toISOString(),
  };
  if (!next.fiveHour && !next.sevenDay) return false;
  const prev = await readUsage(paths);
  const merged = mergeUsage(prev, next);
  const same =
    prev &&
    JSON.stringify({ ...prev, capturedAt: null }) === JSON.stringify({ ...merged, capturedAt: null }) &&
    now.getTime() - Date.parse(prev.capturedAt) < 60_000;
  if (!same) await writeFileAtomic(paths.usageFile, `${JSON.stringify(merged)}\n`, 0o600);
  return true;
}

/** Claude Code's context figures, one file per conversation (`context/<session id>.json` in the state dir). */
const contextDir = (paths: Paths) => join(paths.stateDir, 'context');
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Days a conversation's context figures are kept after their last update. */
export const CONTEXT_KEEP_DAYS = 7;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Claude Code's `context_window.current_usage`, if it is well formed. */
function requestTokens(v: unknown): RequestTokens | null {
  if (!v || typeof v !== 'object') return null;
  const u = v as Record<string, unknown>;
  const t = {
    input: num(u.input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    output: num(u.output_tokens),
  };
  if (Object.values(t).every((x) => x === null)) return null;
  return {
    input: t.input ?? 0,
    cacheWrite: t.cacheWrite ?? 0,
    cacheRead: t.cacheRead ?? 0,
    output: t.output ?? 0,
  };
}

/**
 * Save the `context_window` from one status line update for its conversation, so the dashboard shows
 * Claude Code's own figures (the real window size, 1M included). Writes only when they changed.
 * Returns false when the input has none, or no usable session id.
 */
export async function recordContext(paths: Paths, input: unknown, now = new Date()): Promise<boolean> {
  if (!input || typeof input !== 'object') return false;
  const i = input as Record<string, unknown>;
  const cw = i.context_window as Record<string, unknown> | undefined;
  if (typeof i.session_id !== 'string' || !SESSION_ID.test(i.session_id) || !cw || typeof cw !== 'object')
    return false;
  const model = (i.model ?? {}) as Record<string, unknown>;
  const figures = {
    model: {
      id: typeof model.id === 'string' ? model.id : null,
      name: typeof model.display_name === 'string' ? model.display_name : null,
    },
    window: num(cw.context_window_size),
    used: num(cw.total_input_tokens),
    percent: num(cw.used_percentage),
    current: requestTokens(cw.current_usage),
  };
  if (figures.used === null && figures.window === null) return false;
  const file = join(contextDir(paths), `${i.session_id.toLowerCase()}.json`);
  const prev = await readFile(file, 'utf8')
    .then((t) => JSON.parse(t) as StatusContext)
    .catch(() => null);
  // Unchanged figures are written again after a minute, so `at` keeps up with the replies.
  const same =
    prev &&
    JSON.stringify([prev.model, prev.window, prev.used, prev.percent, prev.current]) ===
      JSON.stringify([figures.model, figures.window, figures.used, figures.percent, figures.current]) &&
    now.getTime() - Date.parse(prev.at) < 60_000;
  if (same) return true;
  const next: StatusContext = { sessionId: i.session_id.toLowerCase(), at: now.toISOString(), ...figures };
  await writeFileAtomic(file, `${JSON.stringify(next)}\n`, 0o600);
  return true;
}

/** A conversation's latest context figures from Claude Code, and the file's mtime (ms); null when there are none. */
export async function readContext(
  paths: Paths,
  claudeSessionId: string,
): Promise<{ context: StatusContext; mtimeMs: number } | null> {
  if (!SESSION_ID.test(claudeSessionId)) return null;
  const file = join(contextDir(paths), `${claudeSessionId.toLowerCase()}.json`);
  try {
    const [text, st] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    const context = JSON.parse(text) as StatusContext;
    return context && typeof context === 'object' && typeof context.at === 'string'
      ? { context, mtimeMs: st.mtimeMs }
      : null;
  } catch {
    return null;
  }
}

/** Remove context figures not updated for `CONTEXT_KEEP_DAYS`; returns how many went. */
export async function pruneContext(paths: Paths, now = Date.now()): Promise<number> {
  const dir = contextDir(paths);
  const names = await readdir(dir).catch(() => [] as string[]);
  let removed = 0;
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const st = await stat(join(dir, n)).catch(() => null);
    if (st && now - st.mtimeMs > CONTEXT_KEEP_DAYS * 86_400_000) {
      await rm(join(dir, n), { force: true });
      removed++;
    }
  }
  return removed;
}
