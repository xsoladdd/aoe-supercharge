/** Which days a scheduled prompt runs on, at its time of day. */
export type ScheduleDays = 'daily' | 'weekdays';
export const SCHEDULE_DAYS: readonly ScheduleDays[] = ['daily', 'weekdays'];

/** `HH:MM`, 24-hour. */
export const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * How a run went. `queued`: handed to the held-message line, typed once the chat is free · `sent`:
 * typed · `skipped`: not sent, on purpose (a usage limit says stop) · `failed`: needs you.
 */
export interface ScheduleResult {
  at: string;
  status: 'queued' | 'sent' | 'skipped' | 'failed';
  detail: string | null;
  /** The held message a `queued` run is waiting on. */
  heldId: string | null;
  /** Run now, not the daily time. */
  manual: boolean;
}

/** A prompt the daemon sends to an existing chat every day (or weekday) at a set time (SPEC §8.5). */
export interface ScheduledPrompt {
  id: string;
  name: string;
  sessionId: string;
  prompt: string;
  /** `HH:MM` in your home time zone (`office.clocks.home`). */
  time: string;
  days: ScheduleDays;
  enabled: boolean;
  createdAt: string;
  /** Runs count from here: moved on every change, so an edit or re-enable never fires at once. */
  scheduledFrom: string;
  lastRunAt: string | null;
  lastResult: ScheduleResult | null;
}

/** A scheduled prompt as the dashboard shows it: with its next run (null while it is off). */
export interface ScheduleView extends ScheduledPrompt {
  nextRunAt: string | null;
}

const DAY = 86_400_000;

/** How far `tz`'s wall clock is ahead of UTC at instant `at` (ms). */
function offsetMs(at: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return wall - Math.floor(at / 1000) * 1000;
}

/**
 * The instant `tz`'s clock shows wall time `wall` (given as if it were UTC). Of a time that happens twice
 * (clocks go back), the first; of one that never happens (clocks go forward), the same time after the jump.
 */
function zonedInstant(wall: number, tz: string): number {
  const before = wall - offsetMs(wall - DAY, tz);
  const after = wall - offsetMs(wall + DAY, tz);
  const real = [before, after].filter((c) => c + offsetMs(c, tz) === wall);
  return real.length ? Math.min(...real) : before;
}

/** The first time `job` is due strictly after `after`, in time zone `tz`. */
export function nextRunAt(job: Pick<ScheduledPrompt, 'time' | 'days'>, after: Date, tz: string): Date {
  const [h, m] = job.time.split(':').map(Number) as [number, number];
  const local = new Date(after.getTime() + offsetMs(after.getTime(), tz));
  for (let i = 0; ; i++) {
    const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + i, h, m);
    const weekday = new Date(day).getUTCDay();
    if (job.days === 'weekdays' && (weekday === 0 || weekday === 6)) continue;
    const at = zonedInstant(day, tz);
    if (at > after.getTime()) return new Date(at);
  }
}

/** When `job` runs next: counted from its last run or its last change, whichever is later. */
export function dueAt(job: ScheduledPrompt, tz: string): Date {
  const from = [job.lastRunAt, job.scheduledFrom]
    .filter((x): x is string => !!x)
    .sort()
    .at(-1)!;
  return nextRunAt(job, new Date(from), tz);
}
