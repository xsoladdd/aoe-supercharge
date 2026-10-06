import type { Stage } from './stages.ts';

/** One Claude plan window as a session's status line last saw it. */
export interface UsageWindow {
  /** 0-100. */
  usedPercentage: number;
  resetsAt: string;
}

/** What Supercharge sessions report through their status line (<state>/usage.json). */
export interface UsageRecord {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  capturedAt: string;
}

/**
 * Keep the newest window, and within one window the highest reading. Usage only grows until the
 * window resets, so an idle session redrawing an old reading can never pull the number down.
 */
export function mergeWindow(prev: UsageWindow | null, next: UsageWindow | null): UsageWindow | null {
  if (!next) return prev;
  if (!prev) return next;
  const a = Date.parse(prev.resetsAt);
  const b = Date.parse(next.resetsAt);
  // The same window can report a reset time that drifts by a few seconds between responses.
  if (Math.abs(a - b) < 5 * 60_000)
    return next.usedPercentage >= prev.usedPercentage ? next : { ...prev, resetsAt: next.resetsAt };
  return b > a ? next : prev;
}

export function mergeUsage(prev: UsageRecord | null, next: UsageRecord): UsageRecord {
  return {
    fiveHour: mergeWindow(prev?.fiveHour ?? null, next.fiveHour),
    sevenDay: mergeWindow(prev?.sevenDay ?? null, next.sevenDay),
    capturedAt: next.capturedAt,
  };
}

/** Limits for starting workers (config [limits]). Percentages are 0-100. */
export interface SpawnLimits {
  enabled: boolean;
  maxWorkers: number;
  busyMaxWorkers: number;
  fiveHourBusyAt: number;
  fiveHourStopAt: number;
  weeklyBusyAt: number;
  weeklyStopAt: number;
}

/** Stages where a worker is (or will be again, once you answer) spending your limit. */
export const ACTIVE_STAGES: readonly Stage[] = ['planning', 'implementing', 'verifying', 'blocked'];

export interface WindowView {
  /** null when nothing was reported yet. 0 once the reported window has reset. */
  usedPercentage: number | null;
  resetsAt: string | null;
  /** The reading is from a window that has since reset. */
  reset: boolean;
}

export interface UsageReport {
  /** False when no Supercharge session has reported limits yet (or you use an API key). */
  known: boolean;
  fiveHour: WindowView;
  sevenDay: WindowView;
  capturedAt: string | null;
  activeWorkers: number;
  /** How many workers may run at once right now. */
  maxWorkers: number;
  /** How many more may start now (0 when `canStart` is false, null when limits are off). */
  canStartCount: number | null;
  canStart: boolean;
  level: 'ok' | 'busy' | 'stop' | 'unknown' | 'off';
  /** The thresholds this was judged against, for showing where the lines are. */
  limits: SpawnLimits;
  /** One sentence for people and for the control chat. */
  advice: string;
}

function view(w: UsageWindow | null, now: number): WindowView {
  if (!w) return { usedPercentage: null, resetsAt: null, reset: false };
  if (Date.parse(w.resetsAt) <= now) return { usedPercentage: 0, resetsAt: null, reset: true };
  return { usedPercentage: Math.round(w.usedPercentage), resetsAt: w.resetsAt, reset: false };
}

function clock(iso: string | null, now: number): string {
  if (!iso) return 'soon';
  const d = new Date(iso);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? hm : `${d.toLocaleDateString([], { weekday: 'short' })} ${hm}`;
}

/** Whether a new worker may start, from the last reported usage and the workers already active. */
export function usageReport(
  record: UsageRecord | null,
  activeWorkers: number,
  limits: SpawnLimits,
  now: number = Date.now(),
): UsageReport {
  const fiveHour = view(record?.fiveHour ?? null, now);
  const sevenDay = view(record?.sevenDay ?? null, now);
  const known = fiveHour.usedPercentage !== null || sevenDay.usedPercentage !== null;
  const base = {
    known,
    fiveHour,
    sevenDay,
    capturedAt: record?.capturedAt ?? null,
    activeWorkers,
    limits,
  };
  const room = (max: number) => Math.max(0, max - activeWorkers);

  if (!limits.enabled) {
    return {
      ...base,
      maxWorkers: limits.maxWorkers,
      canStartCount: null,
      canStart: true,
      level: 'off',
      advice: 'Usage limits are off in Settings: nothing stops new workers.',
    };
  }
  const h = fiveHour.usedPercentage ?? 0;
  const w = sevenDay.usedPercentage ?? 0;
  if (w >= limits.weeklyStopAt)
    return {
      ...base,
      maxWorkers: 0,
      canStartCount: 0,
      canStart: false,
      level: 'stop',
      advice: `Weekly limit at ${w}%. Start no new workers until it resets (${clock(sevenDay.resetsAt, now)}) unless the user says to.`,
    };
  if (h >= limits.fiveHourStopAt)
    return {
      ...base,
      maxWorkers: 0,
      canStartCount: 0,
      canStart: false,
      level: 'stop',
      advice: `5-hour limit at ${h}%. Start no new workers until it resets at ${clock(fiveHour.resetsAt, now)} unless the user says to.`,
    };
  const busy = h >= limits.fiveHourBusyAt || w >= limits.weeklyBusyAt;
  const max = busy ? Math.min(limits.busyMaxWorkers, limits.maxWorkers) : limits.maxWorkers;
  const n = room(max);
  const why = busy
    ? h >= limits.fiveHourBusyAt
      ? `5-hour limit at ${h}% (resets ${clock(fiveHour.resetsAt, now)}), so at most ${max} workers at once`
      : `weekly limit at ${w}%, so at most ${max} workers at once`
    : known
      ? `5-hour limit at ${h}%, weekly at ${w}%; up to ${max} workers at once`
      : `No usage reading yet; up to ${max} workers at once`;
  return {
    ...base,
    maxWorkers: max,
    canStartCount: n,
    canStart: n > 0,
    level: !known ? 'unknown' : busy ? 'busy' : 'ok',
    advice:
      n > 0
        ? `${why}. ${activeWorkers} active, so ${n} more can start.`
        : `${why}, and ${activeWorkers} are already active. Wait for one to finish (or reach review) before starting another.`,
  };
}

/**
 * Workers that count against `maxWorkers`: across all projects (your limits are per account), in an
 * active stage, with an AoE session that is not stopped or gone.
 */
export function countActiveWorkers(
  tasks: readonly { stage: Stage; aoeSessionId: string }[],
  sessionStatus: (sessionId: string) => string | null,
): number {
  return tasks.filter((t) => {
    if (!ACTIVE_STAGES.includes(t.stage)) return false;
    const s = sessionStatus(t.aoeSessionId);
    return s !== null && s !== 'stopped';
  }).length;
}
