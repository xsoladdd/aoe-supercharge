import { NO_MARK } from './office-idle.ts';
import {
  applyRecord,
  matchesFilter,
  type CharState,
  type HistoryFilter,
  type HistoryRecord,
} from './office-history.ts';
import type { OfficeModel, OfficeTeam, OfficeWorker } from './office-model.ts';
import { chatPath, taskPath } from './office-model.ts';
import { byQueue, DESK_POSE, type OfficeSpot, type Pose } from './office.ts';
import { outfitFor } from './outfit.ts';
import { NO_TOKENS } from './model-prices.ts';
import type { MrState, TaskRecord } from './types.ts';

/**
 * Office history mode (SPEC §14.5): the floor at any time in the history, and what happened while you
 * were away. Pure: the dashboard replays what `GET /api/office/history` returns.
 */

/** A history read back: the state at its start, then the records after it. */
export interface HistoryWindow {
  start: { ts: string; chars: CharState[] };
  records: HistoryRecord[];
}

const byTime = (a: HistoryRecord, b: HistoryRecord) =>
  Date.parse(a.ts) - Date.parse(b.ts) || (a.type === 'frame' ? -1 : 1) - (b.type === 'frame' ? -1 : 1);

/** The records in time order, narrowed to a project or a character. */
export function sortedRecords(h: HistoryWindow, filter: HistoryFilter = {}): HistoryRecord[] {
  return h.records
    .map((r) => (r.type === 'frame' ? { ...r, chars: r.chars.filter((c) => matchesFilter(c, filter)) } : r))
    .filter((r) => r.type === 'frame' || matchesFilter(r, filter))
    .sort(byTime);
}

/** Everyone on the floor at `t` (epoch ms): the start, then every record up to `t`. */
export function stateAt(
  h: HistoryWindow,
  sorted: HistoryRecord[],
  t: number,
  filter: HistoryFilter = {},
): CharState[] {
  const floor = new Map<string, CharState>();
  for (const c of h.start.chars) if (c.zone !== 'gone' && matchesFilter(c, filter)) floor.set(c.key, c);
  const from = Date.parse(h.start.ts);
  for (const r of sorted) {
    const ts = Date.parse(r.ts);
    if (ts > t) break;
    // The start already has everything before it.
    if (ts >= from) applyRecord(floor, r);
  }
  return [...floor.values()];
}

/** The times something happened, for the scrubber's ticks and stepping. */
export const eventTimes = (sorted: HistoryRecord[]) =>
  [...new Set(sorted.filter((r) => r.type === 'move').map((r) => Date.parse(r.ts)))].sort((a, b) => a - b);

/** Everyone the history has seen, for the agent filter: by key, with the latest name. */
export function historyPeople(h: HistoryWindow): { key: string; name: string; project: string }[] {
  const out = new Map<string, { key: string; name: string; project: string }>();
  const see = (c: CharState) =>
    out.set(c.key, {
      key: c.key,
      name: c.role === 'lead' ? `${c.project} lead` : c.name,
      project: c.project,
    });
  for (const c of h.start.chars) see(c);
  for (const r of h.records) if (r.type === 'move') see(r);
  return [...out.values()].sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
}

function poseOf(c: CharState): Pose {
  switch (c.zone) {
    case 'desk':
      return c.stage ? DESK_POSE[c.stage] : c.role === 'lead' ? 'reading' : 'typing';
    case 'door':
    case 'review':
      return 'waiting';
    case 'pantry':
      return c.prop === 'letter' ? 'reading' : 'coffee';
    case 'gone':
      return 'waving';
    default:
      return 'away';
  }
}

/** The recorded MR as the live floor carries it; the history keeps no provider, so its URL tells. */
function mrOf(c: CharState): MrState | null {
  if (!c.mr) return null;
  return {
    provider: /\/pull\/\d+/.test(c.mr.url) ? 'github' : 'gitlab',
    host: '',
    repo: '',
    iid: c.mr.iid,
    url: c.mr.url,
    state: c.mr.state as MrState['state'],
    draft: false,
    pipeline: c.mr.pipeline,
    unresolvedThreads: c.mr.threads,
    detailedMergeStatus: null,
    checkedAt: null,
    error: null,
  };
}

function taskOf(c: CharState): TaskRecord | null {
  if (!c.taskId || !c.stage) return null;
  const mr = mrOf(c);
  return {
    schema: 1,
    rev: 0,
    id: c.taskId,
    project: c.project,
    name: c.name,
    ...(c.desk ? { desk: c.desk } : {}),
    title: c.reason,
    brief: '',
    branch: c.worktree ?? '',
    baseBranch: '',
    worktreePath: '',
    aoeSessionId: c.sessionId ?? '',
    parentSessionId: c.parentId ?? '',
    stage: c.stage,
    blockedFrom: null,
    openQuestion: null,
    plan: null,
    mr,
    createdAt: '',
    updatedAt: '',
    history: [],
  };
}

/**
 * The floor as it was, from the characters' recorded states, in the shape the live floor uses: the
 * same scene and list draw it. What the history does not keep (the session, the Needs-you items, the
 * idle prompt) is left empty.
 */
export function historyModel(chars: CharState[]): OfficeModel {
  const everyone: OfficeWorker[] = chars
    .filter((c) => c.zone !== 'gone')
    .map((c) => {
      const spot: OfficeSpot = {
        zone: c.zone,
        pose: poseOf(c),
        prop: c.prop,
        reason: c.reason,
        hold: false,
        holdUntil: null,
        kind: null,
        queuedSince: null,
      };
      const task = taskOf(c);
      const mr = mrOf(c);
      return {
        key: c.key,
        role: c.role,
        project: c.project,
        id: c.taskId,
        name: c.role === 'lead' ? 'Control chat' : c.name,
        title: c.role === 'lead' ? 'Team lead' : c.reason,
        task,
        session: null,
        mr,
        desk: c.desk,
        outfit: outfitFor(c.role === 'lead' ? 'lead' : (c.taskId ?? c.sessionId ?? c.key), c.project),
        spot,
        zone: c.zone,
        since: null,
        href: c.taskId ? taskPath(c.project, c.taskId) : c.sessionId ? chatPath(c.sessionId) : '/office',
        items: [],
        cost: c.cost
          ? {
              sessionId: c.sessionId ?? c.key,
              model: null,
              total: { tokens: c.cost.tokens, usd: c.cost.usd },
              today: { tokens: 0, usd: 0 },
              lastHour: { tokens: 0, usd: 0 },
              usage: NO_TOKENS,
              firstAt: null,
              lastAt: null,
              progressAt: null,
              runaway: [],
            }
          : null,
        mark: c.zone === 'archived' ? { ...NO_MARK, archivedAt: '' } : null,
        idle: { since: null, prompt: false, autoArchive: false },
      };
    });
  const projects = [...new Set(everyone.map((w) => w.project))];
  const teams: OfficeTeam[] = projects.map((project) => {
    const mine = everyone.filter((w) => w.project === project);
    const workers = mine.filter((w) => w.role === 'worker');
    return {
      project,
      lead: mine.find((w) => w.role === 'lead') ?? null,
      seated: workers.filter((w) => w.zone === 'desk').sort((a, b) => (a.desk ?? 0) - (b.desk ?? 0)),
      desks: Math.max(0, ...workers.map((w) => w.desk ?? 0)),
    };
  });
  return {
    door: everyone
      .filter((w) => w.zone === 'door')
      .sort((a, b) => byQueue({ ...a, id: a.key }, { ...b, id: b.key })),
    teams,
    pantry: everyone.filter((w) => w.zone === 'pantry'),
    review: everyone.filter((w) => w.zone === 'review'),
    away: everyone.filter((w) => w.zone === 'away'),
    archived: everyone.filter((w) => w.zone === 'archived'),
    everyone,
  };
}

// ---------------------------------------------------------------------------------------------------
// Since I was away

export type AwayKind = 'arrived' | 'finished' | 'mr_raised' | 'failed' | 'needed_you';

export interface AwayEvent {
  ts: string;
  key: string;
  name: string;
  project: string;
  taskId: string | null;
  kind: AwayKind;
  /** "Raised !9", "Pipeline failed on !7". */
  text: string;
}

export interface AwaySummary {
  since: string;
  until: string;
  /** Distinct workers per kind. */
  finished: number;
  mrsRaised: number;
  failed: number;
  neededYou: number;
  /** Estimated spend over the time, from the cost each character carried at its start and end. */
  spent: { usd: number; unpricedTokens: number };
  /** Newest first. */
  events: AwayEvent[];
}

const FAILED = new Set(['failed', 'canceled']);

/**
 * What happened between `since` and `until`: who finished, who raised an MR, whose pipeline failed,
 * who came to your door, and roughly what it cost. `h.start` must be the state at `since`. The cost at
 * the end can come from `endCost` (the live meters); otherwise it is the last one recorded, which the
 * history keeps at every move and frame.
 */
export function awaySummary(
  h: HistoryWindow,
  since: number,
  until: number,
  endCost: (key: string) => CharState['cost'] | undefined = () => undefined,
): AwaySummary {
  const state = new Map<string, CharState>(h.start.chars.map((c) => [c.key, c]));
  const firstCost = new Map<string, CharState['cost']>();
  const lastCost = new Map<string, CharState['cost']>();
  for (const c of h.start.chars) {
    firstCost.set(c.key, c.cost);
    lastCost.set(c.key, c.cost);
  }
  const events: AwayEvent[] = [];
  const once = new Set<string>();
  const add = (r: CharState & { ts: string }, kind: AwayKind, text: string, id: string) => {
    if (once.has(`${kind}|${id}`)) return;
    once.add(`${kind}|${id}`);
    events.push({
      ts: r.ts,
      key: r.key,
      name: r.role === 'lead' ? `${r.project} lead` : r.name,
      project: r.project,
      taskId: r.taskId,
      kind,
      text,
    });
  };
  const frameTimes = new Set(h.records.filter((r) => r.type === 'frame').map((r) => r.ts));
  for (const r of [...h.records].sort(byTime)) {
    const t = Date.parse(r.ts);
    if (t <= since || t > until) {
      if (t <= since) applyStart(state, r, firstCost, lastCost);
      continue;
    }
    if (r.type === 'frame') {
      for (const c of r.chars) {
        if (!firstCost.has(c.key)) firstCost.set(c.key, c.cost);
        lastCost.set(c.key, c.cost);
        state.set(c.key, c);
      }
      continue;
    }
    const prev = state.get(r.key) ?? null;
    // A daemon start writes a frame, then what it finds on the floor at the same moment. Whoever it
    // had not seen before was already there: that is catching up, not news (nor new spend).
    const catchUp = frameTimes.has(r.ts) && !prev;
    if (!firstCost.has(r.key)) firstCost.set(r.key, r.from === null && !catchUp ? null : r.cost);
    lastCost.set(r.key, r.cost);
    if (catchUp) {
      if (r.zone !== 'gone') state.set(r.key, r);
      continue;
    }
    if (r.from === null && r.zone !== 'gone' && !prev) add(r, 'arrived', 'Arrived', r.key);
    if (r.stage === 'done' && prev?.stage !== 'done') add(r, 'finished', 'Finished', r.key);
    if (r.mr && (!prev?.mr || prev.mr.iid !== r.mr.iid))
      add(r, 'mr_raised', `Raised !${r.mr.iid}`, `${r.key}!${r.mr.iid}`);
    if (r.mr?.pipeline && FAILED.has(r.mr.pipeline) && !(prev?.mr?.pipeline && FAILED.has(prev.mr.pipeline)))
      add(r, 'failed', `Pipeline failed on !${r.mr.iid}`, `${r.key}!${r.mr.iid}`);
    if (r.zone === 'door' && prev?.zone !== 'door') add(r, 'needed_you', r.reason, `${r.key}@${r.ts}`);
    if (r.zone === 'gone') state.delete(r.key);
    else state.set(r.key, r);
  }
  let usd = 0;
  let unpricedTokens = 0;
  for (const key of new Set([...firstCost.keys(), ...lastCost.keys()])) {
    const a = firstCost.get(key) ?? null;
    const b = endCost(key) ?? lastCost.get(key) ?? null;
    if (!b) continue;
    // A smaller end is a new conversation (/clear): all of it is new.
    const base = a && b.tokens >= a.tokens ? a : null;
    if (b.usd !== null && (base === null || base.usd !== null)) usd += b.usd - (base?.usd ?? 0);
    else unpricedTokens += b.tokens - (base?.tokens ?? 0);
  }
  const distinct = (kind: AwayKind) => new Set(events.filter((e) => e.kind === kind).map((e) => e.key)).size;
  return {
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    finished: distinct('finished'),
    mrsRaised: events.filter((e) => e.kind === 'mr_raised').length,
    failed: distinct('failed'),
    neededYou: distinct('needed_you'),
    spent: { usd: Math.max(0, usd), unpricedTokens: Math.max(0, unpricedTokens) },
    events: events.sort((a, b) => b.ts.localeCompare(a.ts)),
  };
}

/** Records before `since` in the window (when the start is earlier than `since`): they set the scene. */
function applyStart(
  state: Map<string, CharState>,
  r: HistoryRecord,
  firstCost: Map<string, CharState['cost']>,
  lastCost: Map<string, CharState['cost']>,
) {
  const chars = r.type === 'frame' ? r.chars : [r];
  if (r.type === 'frame') state.clear();
  for (const c of chars) {
    if (c.zone === 'gone') state.delete(c.key);
    else state.set(c.key, c);
    firstCost.set(c.key, c.cost);
    lastCost.set(c.key, c.cost);
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 agents finished, 2 MRs raised, 1 failed, ≈ $4.20 spent" (or "Nothing happened"). */
export function awayHeadline(s: AwaySummary, formatUsd: (usd: number) => string): string {
  const parts = [
    s.finished ? `${plural(s.finished, 'agent')} finished` : '',
    s.mrsRaised ? `${plural(s.mrsRaised, 'MR')} raised` : '',
    s.failed ? `${s.failed} failed` : '',
    s.neededYou ? `${plural(s.neededYou, 'agent')} needed you` : '',
    s.spent.usd > 0 ? `${formatUsd(s.spent.usd)} spent` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Nothing happened';
}
