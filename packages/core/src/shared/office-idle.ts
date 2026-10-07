import type { OfficeSpot } from './office.ts';
import type { OfficeMark, SessionView } from './types.ts';

/**
 * The office's idle timeout (SPEC §14.5). A worker idle in the pantry for `promptMinutes` is asked to
 * go home: Archive, Keep, or Snooze 30m. With `autoArchiveMinutes` set it goes home by itself. Archive
 * is office-only: the character walks out and leaves the floor; its AoE session, worktree, transcript
 * and history are never touched, and it comes back by itself when its session works or needs you.
 * Pure, so the daemon and the dashboard decide the same way.
 */

export interface IdleLimits {
  /** Minutes idle in the pantry before the "go home" prompt; 0 is off. */
  promptMinutes: number;
  /** Minutes idle before it goes home by itself; 0 is off. */
  autoArchiveMinutes: number;
}

export type OfficeAction = 'archive' | 'keep' | 'snooze' | 'restore';

export const SNOOZE_MS = 30 * 60_000;

export const NO_MARK: OfficeMark = { archivedAt: null, keptAt: null, snoozedUntil: null };

/** What a character needs for the idle checks. */
export interface IdleSubject {
  role: 'worker' | 'lead';
  spot: Pick<OfficeSpot, 'zone'>;
  session: Pick<SessionView, 'status' | 'statusSince'> | null;
}

/** When its idle stretch in the pantry began, or null when it is not idle there (or nobody knows when). */
export function idleSince(w: IdleSubject): string | null {
  if (w.role !== 'worker' || w.spot.zone !== 'pantry' || w.session?.status !== 'idle') return null;
  return w.session.statusSince ?? null;
}

export interface IdleCheck {
  /** Since when, for "idle 42m". */
  since: string | null;
  /** Show the "go home" prompt. */
  prompt: boolean;
  /** Archive it now, by itself. */
  autoArchive: boolean;
}

const NONE: IdleCheck = { since: null, prompt: false, autoArchive: false };

/**
 * Whether to ask it to go home, or send it. "Keep" holds for the idle stretch it was pressed in (a new
 * stretch starts after it works again); a snooze holds both the prompt and the auto-archive until it
 * runs out.
 */
export function idleCheck(
  w: IdleSubject,
  mark: OfficeMark | null | undefined,
  limits: IdleLimits,
  now: Date,
): IdleCheck {
  const since = idleSince(w);
  if (!since || mark?.archivedAt) return NONE;
  const t = now.getTime();
  const idleMs = t - Date.parse(since);
  if (!Number.isFinite(idleMs)) return NONE;
  const kept = !!mark?.keptAt && mark.keptAt >= since;
  const snoozed = !!mark?.snoozedUntil && Date.parse(mark.snoozedUntil) > t;
  if (kept || snoozed) return { since, prompt: false, autoArchive: false };
  const over = (minutes: number) => minutes > 0 && idleMs >= minutes * 60_000;
  const autoArchive = over(limits.autoArchiveMinutes);
  return { since, prompt: !autoArchive && over(limits.promptMinutes), autoArchive };
}

/** When the next idle check changes (a prompt or an auto-archive is due), or null. */
export function nextIdleDeadline(
  chars: (IdleSubject & { key: string })[],
  marks: Record<string, OfficeMark>,
  limits: IdleLimits,
  now: Date,
): number | null {
  const t = now.getTime();
  let next = Infinity;
  for (const w of chars) {
    const since = idleSince(w);
    const mark = marks[w.key];
    if (!since || mark?.archivedAt) continue;
    if (mark?.keptAt && mark.keptAt >= since) continue;
    const start = Date.parse(since);
    const snoozedUntil = mark?.snoozedUntil ? Date.parse(mark.snoozedUntil) : 0;
    if (snoozedUntil > t) next = Math.min(next, snoozedUntil);
    for (const minutes of [limits.promptMinutes, limits.autoArchiveMinutes])
      if (minutes > 0) {
        const due = start + minutes * 60_000;
        if (due > t) next = Math.min(next, due);
      }
  }
  return Number.isFinite(next) ? next : null;
}

/**
 * Whether an archived character comes back by itself: its session is working again, or it needs you.
 * `spot` is where it would stand if it were not archived.
 */
export function comesBack(w: Pick<IdleSubject, 'spot' | 'session'>): boolean {
  return w.spot.zone === 'door' || w.session?.status === 'working';
}

/** The change an action makes to a character's mark. Restore also counts as "Keep" for this stretch. */
export function markChange(action: OfficeAction, now: Date): Partial<OfficeMark> {
  const ts = now.toISOString();
  switch (action) {
    case 'archive':
      return { archivedAt: ts, snoozedUntil: null };
    case 'keep':
      return { keptAt: ts, snoozedUntil: null };
    case 'snooze':
      return { snoozedUntil: new Date(now.getTime() + SNOOZE_MS).toISOString() };
    case 'restore':
      return { archivedAt: null, keptAt: ts, snoozedUntil: null };
  }
}
