import { readFile } from 'node:fs/promises';
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
