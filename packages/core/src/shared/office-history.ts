import type { OfficeModel, OfficeWorker } from './office-model.ts';
import type { Prop, Zone } from './office.ts';
import type { Stage } from './stages.ts';
import type { PipelineStatus } from './types.ts';

/**
 * The office history (SPEC §14.5): every change of where a character is, or why, as one record. A
 * `frame` holds everyone's state; the state at any time is the latest frame before it plus the moves
 * after that. Pure, so the daemon writes and the dashboard replays with the same rules.
 */

export interface CharState {
  key: string;
  sessionId: string | null;
  parentId: string | null;
  project: string;
  taskId: string | null;
  worktree: string | null;
  name: string;
  role: 'worker' | 'lead';
  desk: number | null;
  zone: Zone;
  reason: string;
  prop: Prop;
  stage: Stage | null;
  /** Tokens and the estimated cost of its conversation so far, when known. */
  cost: { tokens: number; usd: number | null } | null;
  mr: { iid: number; url: string; state: string; pipeline: PipelineStatus | null; threads: number } | null;
}

export interface MoveRecord extends CharState {
  v: 1;
  type: 'move';
  ts: string;
  /** Where it was before; null when it just arrived. */
  from: Zone | null;
}

export interface FrameRecord {
  v: 1;
  type: 'frame';
  ts: string;
  chars: CharState[];
}

export type HistoryRecord = MoveRecord | FrameRecord;

/** A frame is written at least this often, so a replay never starts far back. */
export const FRAME_EVERY_MS = 6 * 60 * 60 * 1000;

export type CostLookup = (w: OfficeWorker) => CharState['cost'];

export function charState(w: OfficeWorker, cost: CostLookup = () => null): CharState {
  const mr = w.task?.mr ?? null;
  return {
    key: w.key,
    sessionId: w.session?.id ?? w.task?.aoeSessionId ?? null,
    parentId: w.session?.parentId ?? w.task?.parentSessionId ?? null,
    project: w.project,
    taskId: w.id,
    worktree: w.task?.branch ?? w.session?.branch ?? null,
    name: w.name,
    role: w.role,
    desk: w.desk,
    zone: w.zone,
    reason: w.spot.reason,
    prop: w.spot.prop,
    stage: w.task?.stage ?? null,
    cost: cost(w),
    mr: mr
      ? { iid: mr.iid, url: mr.url, state: mr.state, pipeline: mr.pipeline, threads: mr.unresolvedThreads }
      : null,
  };
}

export function floorStates(model: OfficeModel, cost?: CostLookup): CharState[] {
  return model.everyone.map((w) => charState(w, cost));
}

/** What counts as a change worth a record: not the cost, which moves with every reply. */
function moved(a: CharState, b: CharState): boolean {
  return (
    a.zone !== b.zone ||
    a.reason !== b.reason ||
    a.prop !== b.prop ||
    a.stage !== b.stage ||
    a.desk !== b.desk ||
    a.mr?.pipeline !== b.mr?.pipeline ||
    a.mr?.state !== b.mr?.state ||
    a.mr?.iid !== b.mr?.iid
  );
}

/**
 * The moves from `prev` to `next`: who arrived, who changed, and who left (a move to `gone`, keeping
 * its last state).
 */
export function diffFloor(prev: ReadonlyMap<string, CharState>, next: CharState[], ts: string): MoveRecord[] {
  const out: MoveRecord[] = [];
  const seen = new Set<string>();
  for (const c of next) {
    seen.add(c.key);
    const before = prev.get(c.key);
    if (before && !moved(before, c)) continue;
    out.push({ ...c, v: 1, type: 'move', ts, from: before?.zone ?? null });
  }
  for (const [key, before] of prev) {
    if (seen.has(key) || before.zone === 'gone') continue;
    out.push({ ...before, v: 1, type: 'move', ts, from: before.zone, zone: 'gone' });
  }
  return out;
}

/** Applies one record to a floor (by key). Who went `gone` leaves it. */
export function applyRecord(floor: Map<string, CharState>, r: HistoryRecord): void {
  if (r.type === 'frame') {
    floor.clear();
    for (const c of r.chars) if (c.zone !== 'gone') floor.set(c.key, c);
    return;
  }
  const { v: _v, type: _t, ts: _ts, from: _f, ...state } = r;
  if (state.zone === 'gone') floor.delete(state.key);
  else floor.set(state.key, state);
}

/**
 * Everyone's state at `t` (epoch ms): the latest frame at or before it, plus the moves after that
 * frame up to `t`. Records need not be sorted. Null when nothing was recorded by then.
 */
export function officeAt(records: HistoryRecord[], t: number): CharState[] | null {
  const upTo = records
    .filter((r) => Date.parse(r.ts) <= t)
    .sort(
      (a, b) =>
        Date.parse(a.ts) - Date.parse(b.ts) || (a.type === 'frame' ? -1 : 1) - (b.type === 'frame' ? -1 : 1),
    );
  let start = -1;
  for (let i = upTo.length - 1; i >= 0; i--)
    if (upTo[i]!.type === 'frame') {
      start = i;
      break;
    }
  if (start < 0 && !upTo.length) return null;
  const floor = new Map<string, CharState>();
  for (const r of upTo.slice(Math.max(0, start))) applyRecord(floor, r);
  return [...floor.values()];
}

export interface HistoryFilter {
  project?: string | null;
  key?: string | null;
}

export function matchesFilter(c: Pick<CharState, 'project' | 'key'>, f: HistoryFilter): boolean {
  return (!f.project || c.project === f.project) && (!f.key || c.key === f.key);
}

/** A record narrowed to a filter: a frame keeps only the characters that match; a move matches or not. */
export function filterRecord(r: HistoryRecord, f: HistoryFilter): HistoryRecord | null {
  if (!f.project && !f.key) return r;
  if (r.type === 'frame') return { ...r, chars: r.chars.filter((c) => matchesFilter(c, f)) };
  return matchesFilter(r, f) ? r : null;
}

/** The UTC day a record goes in (`YYYY-MM-DD`), which names its history file. */
export const historyDay = (ts: string | number | Date) => new Date(ts).toISOString().slice(0, 10);
