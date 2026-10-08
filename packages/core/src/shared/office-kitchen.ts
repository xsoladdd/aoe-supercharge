import type { OfficeWorker } from './office-model.ts';
import type { OfficeSpot } from './office.ts';
import type { TaskRecord } from './types.ts';

/**
 * The kitchen (SPEC §14.5): a worker planning cooks its plan at one of the stoves, or at the prep
 * counter once every stove is taken. When the plan is approved it serves the dish to someone idle in
 * the pantry, who eats it for about a minute. Pure, so the daemon and the dashboard decide the same way.
 */

/** Stoves in the kitchen; planners past them chop at the prep counter (one board each, no cap). */
export const STOVES = 5;
/** How long a served plate stays on the pantry table, from when the plan was approved. */
export const EAT_MS = 60_000;

export type Station = 'stove' | 'counter';

/** A plate on the pantry table: who served it, who eats it, and until when. */
export interface Meal {
  /** `<server key>@<epoch ms the plan was approved>`. */
  id: string;
  server: string;
  eater: string;
  serverName: string;
  /** The task the plan is for. */
  title: string;
  at: number;
  until: number;
}

export interface MealDecision {
  at: number;
  /** Who got the plate; null when nobody was in the pantry (so nobody gets it later). */
  eater: string | null;
  /** Eaten, or the eater left: it never comes back. */
  ended: boolean;
}

/**
 * Who holds a stove, and who got which plate. The caller owns it so it survives between builds, like
 * the hold memory: a stove is never taken from whoever holds it, and a plate is given once.
 */
export interface KitchenMemory {
  stoves: Set<string>;
  meals: Map<string, MealDecision>;
}

export const kitchenMemory = (): KitchenMemory => ({ stoves: new Set(), meals: new Map() });

/** When the task last went into planning (its history), else when it was created. */
export function plannedAt(task: Pick<TaskRecord, 'history' | 'createdAt'>): string {
  for (let i = task.history.length - 1; i >= 0; i--) {
    const h = task.history[i]!;
    if (h.to === 'planning') return h.at;
  }
  return task.createdAt;
}

/** When the plan was approved: the task's latest move from planning to implementing (epoch ms), if any. */
export function approvedAt(task: Pick<TaskRecord, 'history'>): number | null {
  for (let i = task.history.length - 1; i >= 0; i--) {
    const h = task.history[i]!;
    if (h.from === 'planning' && h.to === 'implementing') return Date.parse(h.at);
  }
  return null;
}

const time = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
};

/**
 * Who cooks at a stove and who chops at the counter. First come, first served by when each went into
 * planning; whoever holds a stove keeps it (nobody is bumped), and a free stove goes to whoever has
 * waited longest. `memory` is the set of stove holders, updated in place.
 */
export function kitchenStations(
  cooks: { key: string; since: string | null }[],
  memory: Set<string>,
  stoves = STOVES,
): Map<string, Station> {
  const here = new Set(cooks.map((c) => c.key));
  for (const k of [...memory]) if (!here.has(k)) memory.delete(k);
  const order = [...cooks].sort((a, b) => time(a.since) - time(b.since) || a.key.localeCompare(b.key));
  for (const c of order) if (!memory.has(c.key) && memory.size < stoves) memory.add(c.key);
  return new Map(order.map((c) => [c.key, memory.has(c.key) ? 'stove' : 'counter']));
}

const STATION: Record<Station, Pick<OfficeSpot, 'pose' | 'prop' | 'reason'>> = {
  stove: { pose: 'cooking', prop: 'pot', reason: 'Planning at the stove' },
  counter: { pose: 'chopping', prop: 'board', reason: 'Planning at the prep counter' },
};

/**
 * The spot at a station. One held in the kitchen (waiting inside the debounce, or finishing up before
 * the pantry) keeps its own pose and reason but carries the station's prop, so the history knows where
 * it stood.
 */
export function stationSpot(spot: OfficeSpot, station: Station): OfficeSpot {
  const s = STATION[station];
  return spot.zone === 'kitchen' ? { ...spot, ...s } : { ...spot, prop: s.prop };
}

/** Idle in the pantry with a coffee: can be served. */
const canEat = (w: OfficeWorker) =>
  w.zone === 'pantry' && w.spot.zone === 'pantry' && w.spot.pose === 'coffee';

/**
 * The plates on the pantry table. A worker whose plan was approved (planning to implementing, in its
 * task's history) within `EAT_MS`, and which is at its desk, serves it once: to whoever has been idle in
 * the pantry longest with a coffee and no plate yet, or to nobody when the pantry is empty. A plate goes
 * when `EAT_MS` is up, or as soon as its eater leaves or stops idling. `memory` keeps the decisions.
 */
export function servedMeals(
  everyone: OfficeWorker[],
  memory: Map<string, MealDecision>,
  now: number,
): Meal[] {
  const byKey = new Map(everyone.map((w) => [w.key, w]));
  for (const [id, d] of memory) if (now - d.at >= EAT_MS) memory.delete(id);
  const serves = everyone
    .flatMap((w) => {
      const at = w.role === 'worker' && w.task ? approvedAt(w.task) : null;
      return at !== null && now - at < EAT_MS && at <= now ? [{ w, at, id: `${w.key}@${at}` }] : [];
    })
    .sort((a, b) => a.at - b.at || a.w.key.localeCompare(b.w.key));

  const out: Meal[] = [];
  const eating = new Set<string>();
  const meal = (s: (typeof serves)[number], eater: string) => {
    eating.add(eater);
    out.push({
      id: s.id,
      server: s.w.key,
      eater,
      serverName: s.w.name,
      title: s.w.title,
      at: s.at,
      until: s.at + EAT_MS,
    });
  };
  // The plates already given: still being eaten, or gone for good.
  for (const s of serves) {
    const d = memory.get(s.id);
    if (!d || d.ended || !d.eater) continue;
    const eater = byKey.get(d.eater);
    if (!eater || !canEat(eater) || eating.has(d.eater)) d.ended = true;
    else meal(s, d.eater);
  }
  // New ones: served once the server is at its desk, to the longest idle without a plate.
  for (const s of serves) {
    if (memory.has(s.id) || s.w.zone !== 'desk') continue;
    const eater = everyone
      .filter((w) => canEat(w) && !eating.has(w.key) && time(w.session?.statusSince) <= s.at)
      .sort(
        (a, b) => time(a.session?.statusSince) - time(b.session?.statusSince) || a.key.localeCompare(b.key),
      )[0];
    memory.set(s.id, { at: s.at, eater: eater?.key ?? null, ended: false });
    if (eater) meal(s, eater.key);
  }
  return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** The eater's spot: the coffee down, eating the plan. */
export function eatingSpot(spot: OfficeSpot, m: Pick<Meal, 'serverName'>): OfficeSpot {
  return { ...spot, pose: 'eating', prop: 'plate', reason: `Eating ${m.serverName}’s plan` };
}

/**
 * The kitchen and the plates for a floor, in place: who cooks at which station, and who eats which
 * plate. Returns the kitchen (stoves first, then the counter, each in arrival order) and the meals.
 */
export function cookKitchen(
  everyone: OfficeWorker[],
  memory: KitchenMemory,
  now: number,
): { kitchen: OfficeWorker[]; meals: Meal[] } {
  const inKitchen = everyone.filter((w) => w.zone === 'kitchen');
  const since = (w: OfficeWorker) => (w.task ? plannedAt(w.task) : w.since);
  const at = kitchenStations(
    inKitchen.map((w) => ({ key: w.key, since: since(w) })),
    memory.stoves,
  );
  for (const w of inKitchen) w.spot = stationSpot(w.spot, at.get(w.key)!);
  const plates = servedMeals(everyone, memory.meals, now);
  for (const m of plates) {
    const w = everyone.find((x) => x.key === m.eater)!;
    w.spot = eatingSpot(w.spot, m);
    w.plate = m;
  }
  const rank = (w: OfficeWorker) => (at.get(w.key) === 'stove' ? 0 : 1);
  const kitchen = [...inKitchen].sort(
    (a, b) => rank(a) - rank(b) || time(since(a)) - time(since(b)) || a.key.localeCompare(b.key),
  );
  return { kitchen, meals: plates };
}
