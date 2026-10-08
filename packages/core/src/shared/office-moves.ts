import type { OfficeModel, OfficeWorker } from './office-model.ts';
import type { Zone } from './office.ts';

/**
 * How the floor moves from one model to the next (SPEC §14.5): who walks in through the entrance, who
 * takes the finish errand (to the lead's desk with a folder, then on), who serves its plan (to the
 * pantry table with a plate, then on to its desk), who simply walks, who leaves.
 * Pure, so the scene only plays what this decides. Nothing animates on first sight: a page that opens,
 * or reconnects, places everyone where they are.
 */

export type MoveKind = 'place' | 'spawn' | 'finish' | 'serve' | 'walk' | 'stay';

export interface Move {
  key: string;
  kind: MoveKind;
  from: Zone | null;
  to: Zone;
}

/** Stages that mean a worker has handed something in: an MR to look at. */
const DELIVERED = new Set(['mr_raised', 'watching_mr', 'ready_for_review']);

/**
 * Whether this move is a worker finishing: it leaves its desk for the review lounge, or for the pantry
 * with a deliverable (its MR), and its team has a lead to hand the folder to.
 */
export function isFinish(from: Zone | null | undefined, w: OfficeWorker, model: OfficeModel): boolean {
  if (w.role !== 'worker' || from !== 'desk') return false;
  if (w.zone !== 'review' && w.zone !== 'pantry') return false;
  if (w.zone === 'pantry' && !(w.task && DELIVERED.has(w.task.stage))) return false;
  return !!model.teams.find((t) => t.project === w.project)?.lead;
}

/**
 * Whether this move is a worker serving its plan: approved, it heads for its desk from anywhere else,
 * with a plate for someone in the pantry (see `servedMeals` in office-kitchen.ts).
 */
export function isServe(from: Zone | null | undefined, w: OfficeWorker, model: OfficeModel): boolean {
  if (w.role !== 'worker' || !from || from === 'desk' || w.zone !== 'desk') return false;
  return model.meals.some((m) => m.server === w.key);
}

/**
 * The moves from what was last seen (`seen`, by key; null when nothing was: first load or reconnect)
 * to `model`.
 */
export function planMoves(seen: ReadonlyMap<string, Zone> | null, model: OfficeModel): Move[] {
  return model.everyone.map((w) => {
    const from = seen?.get(w.key) ?? null;
    if (!seen) return { key: w.key, kind: 'place', from: null, to: w.zone };
    if (!seen.has(w.key)) return { key: w.key, kind: 'spawn', from: null, to: w.zone };
    if (from === w.zone) return { key: w.key, kind: 'stay', from, to: w.zone };
    const kind = isFinish(from, w, model) ? 'finish' : isServe(from, w, model) ? 'serve' : 'walk';
    return { key: w.key, kind, from, to: w.zone };
  });
}

/** Between two arrivals at the entrance, so nobody walks in on top of someone else. */
export const SPAWN_GAP_MS = 900;
/** How long a finishing worker stands at the lead's desk handing the folder over. */
export const HANDOVER_MS = 1400;
/** How long a serving worker stands at the pantry table setting the plate down. */
export const SERVE_MS = 1200;

/**
 * The entrance's queue: each arrival gets the first free moment, at least `gap` after the one before.
 * Returns when this one may come in.
 */
export class EntranceQueue {
  private freeAt = 0;
  constructor(private gap = SPAWN_GAP_MS) {}

  next(now: number): number {
    const at = Math.max(now, this.freeAt);
    this.freeAt = at + this.gap;
    return at;
  }

  reset() {
    this.freeAt = 0;
  }
}
