import { describe, expect, it } from 'vitest';
import {
  approvedAt,
  buildOffice,
  charState,
  diffFloor,
  EAT_MS,
  historyModel,
  kitchenMemory,
  kitchenStations,
  nextOfficeLook,
  plannedAt,
  planMoves,
  type HistoryEntry,
  type KitchenMemory,
  type OfficeInput,
  type SessionView,
  type TaskRecord,
  type Zone,
} from '../src/shared/index.ts';
import { at, input, session, T0, task } from './office-fixtures.ts';

const entry = (when: string, from: HistoryEntry['from'], to: HistoryEntry['to']): HistoryEntry => ({
  at: when,
  from,
  to,
  by: 'worker',
  note: null,
});

/** A worker planning since `min` minutes from T0, its session working. */
const planner = (n: number, min: number, extra: Partial<TaskRecord> = {}): TaskRecord =>
  task(`A-${n}`, 'alpha', `w${n}`, {
    name: `Cook ${n}`,
    desk: n,
    stage: 'planning',
    history: [entry(at(min), null, 'planning')],
    ...extra,
  });

/** A worker whose plan was approved `secs` seconds before T0 (planning since an hour before that). */
const approved = (n: number, secs: number, extra: Partial<TaskRecord> = {}): TaskRecord =>
  task(`A-${n}`, 'alpha', `w${n}`, {
    name: `Chef ${n}`,
    title: `Plan ${n}`,
    desk: n,
    stage: 'implementing',
    history: [
      entry(at(-60), null, 'planning'),
      entry(new Date(T0 - secs * 1000).toISOString(), 'planning', 'implementing'),
    ],
    ...extra,
  });

/** A worker idle in the pantry with a coffee since `min` minutes from T0. */
const idler = (n: number, min: number): [SessionView, TaskRecord] => [
  session(`w${n}`, 'idle', { statusSince: at(min) }),
  task(`A-${n}`, 'alpha', `w${n}`, { name: `Idle ${n}`, desk: n }),
];

const floor = (sessions: SessionView[], tasks: TaskRecord[]): OfficeInput =>
  input([session('ctl', 'working'), ...sessions], tasks);

const build = (inp: OfficeInput, t: number, pots: KitchenMemory, holds = new Map<string, Zone>()) =>
  buildOffice(inp, new Date(t), holds, pots);

describe('kitchen: who cooks where', () => {
  it('takes when each went into planning, else when the task was made', () => {
    expect(plannedAt(task('A-1', 'alpha', 'w1'))).toBe(at(-60));
    const back = task('A-1', 'alpha', 'w1', {
      history: [
        entry(at(-50), null, 'planning'),
        entry(at(-40), 'planning', 'blocked'),
        entry(at(-20), 'blocked', 'planning'),
      ],
    });
    expect(plannedAt(back)).toBe(at(-20));
    expect(approvedAt(back)).toBeNull();
    expect(approvedAt(approved(1, 10))).toBe(T0 - 10_000);
  });

  it('first come, first served: five stoves, the rest at the prep counter', () => {
    const memory = new Set<string>();
    const cooks = [6, 1, 4, 2, 7, 3, 5].map((n) => ({ key: `k${n}`, since: at(n) }));
    const got = kitchenStations(cooks, memory);
    expect([...got].filter(([, s]) => s === 'stove').map(([k]) => k)).toEqual(['k1', 'k2', 'k3', 'k4', 'k5']);
    expect(got.get('k6')).toBe('counter');
    expect(got.get('k7')).toBe('counter');
    // Ties go by key.
    expect([
      ...kitchenStations(
        [
          { key: 'b', since: at(1) },
          { key: 'a', since: at(1) },
        ],
        new Set(),
        1,
      ),
    ]).toEqual([
      ['a', 'stove'],
      ['b', 'counter'],
    ]);
  });

  it('nobody is bumped: an earlier planner coming back waits at the counter', () => {
    const memory = new Set(['k2', 'k3', 'k4', 'k5', 'k6']);
    const cooks = [1, 2, 3, 4, 5, 6].map((n) => ({ key: `k${n}`, since: at(n) }));
    const got = kitchenStations(cooks, memory);
    expect(got.get('k1')).toBe('counter');
    expect(got.get('k6')).toBe('stove');
  });

  it('a free stove goes to whoever has waited longest at the counter', () => {
    const memory = new Set(['k1', 'k2', 'k3', 'k4', 'k5']);
    const cooks = [2, 3, 4, 5, 7, 6].map((n) => ({ key: `k${n}`, since: at(n) }));
    const got = kitchenStations(cooks, memory);
    expect(got.get('k6')).toBe('stove');
    expect(got.get('k7')).toBe('counter');
    expect([...memory].sort()).toEqual(['k2', 'k3', 'k4', 'k5', 'k6']);
  });

  it('on the floor: planners cook, the sixth chops; held cooks keep their stove; idle ones go to the pantry', () => {
    const pots = kitchenMemory();
    const tasks = [1, 2, 3, 4, 5, 6].map((n) => planner(n, -60 + n));
    const working = tasks.map((t) => session(t.aoeSessionId, 'working'));
    const holds = new Map<string, Zone>();
    const m = build(floor(working, tasks), T0, pots, holds);
    expect(m.kitchen.map((w) => [w.id, w.spot.pose, w.spot.prop])).toEqual([
      ['A-1', 'cooking', 'pot'],
      ['A-2', 'cooking', 'pot'],
      ['A-3', 'cooking', 'pot'],
      ['A-4', 'cooking', 'pot'],
      ['A-5', 'cooking', 'pot'],
      ['A-6', 'chopping', 'board'],
    ]);
    expect(m.kitchen[5]!.spot.reason).toBe('Planning at the prep counter');
    expect(m.kitchen[0]!.spot.reason).toBe('Planning at the stove');
    // Nobody at a desk: their desks stay theirs.
    expect(m.teams[0]!.seated.filter((w) => w.role === 'worker')).toEqual([]);
    expect(m.teams[0]!.desks).toBe(6);

    // A-1 waits inside the debounce: still at its stove, with the pot, not chopping.
    const waiting = working.map((s) => (s.id === 'w1' ? { ...s, status: 'waiting' as const } : s));
    const held = build(floor(waiting, tasks), T0 + 1000, pots, holds);
    const a1 = held.everyone.find((w) => w.id === 'A-1')!;
    expect(a1).toMatchObject({ zone: 'kitchen', spot: { prop: 'pot', pose: 'waiting', hold: true } });
    expect(held.kitchen.find((w) => w.id === 'A-6')!.spot.prop).toBe('board');

    // A-1 goes idle and leaves for the pantry: A-6 moves up to the stove.
    const idle = working.map((s) =>
      s.id === 'w1' ? { ...s, status: 'idle' as const, statusSince: new Date(T0 - 60_000).toISOString() } : s,
    );
    const later = build(floor(idle, tasks), T0 + 2000, pots, holds);
    expect(later.pantry.map((w) => w.id)).toEqual(['A-1']);
    expect(later.kitchen.find((w) => w.id === 'A-6')!.spot.prop).toBe('pot');

    // A-1 comes back to its plan: the earliest planner, but the stoves are taken, so the counter.
    const back = build(floor(working, tasks), T0 + 3000, pots, holds);
    expect(back.kitchen.find((w) => w.id === 'A-1')!.spot.prop).toBe('board');
    expect(back.kitchen.find((w) => w.id === 'A-6')!.spot.prop).toBe('pot');
  });

  it('the door wins over the kitchen; leads and crew without a task never cook', () => {
    const tasks = [planner(1, -10)];
    const inp: OfficeInput = {
      ...floor([session('w1', 'waiting'), session('crew', 'working', { parentId: 'ctl' })], tasks),
      needsYou: [
        {
          id: 'plan_approval:A-1',
          kind: 'plan_approval',
          project: 'alpha',
          taskId: 'A-1',
          sessionId: 'w1',
          title: 't',
          detail: 'd',
          since: at(-1),
        },
      ],
    };
    const m = build(inp, T0, kitchenMemory());
    expect(m.door.map((w) => [w.id, w.spot.prop])).toEqual([['A-1', 'scroll']]);
    expect(m.kitchen).toEqual([]);
    expect(m.everyone.find((w) => w.key === 'alpha/s/crew')!.zone).toBe('desk');
    expect(m.teams[0]!.lead!.zone).toBe('desk');
  });
});

describe('kitchen: serving the plan', () => {
  const at0 = T0;

  it('an approved plan goes to whoever has idled longest in the pantry, who eats it', () => {
    const [s2, t2] = idler(2, -20);
    const [s3, t3] = idler(3, -40);
    const m = build(
      floor([session('w1', 'working'), s2, s3], [approved(1, 5), t2, t3]),
      at0,
      kitchenMemory(),
    );
    expect(m.meals).toEqual([
      {
        id: `alpha/A-1@${at0 - 5000}`,
        server: 'alpha/A-1',
        eater: 'alpha/A-3',
        serverName: 'Chef 1',
        title: 'Plan 1',
        at: at0 - 5000,
        until: at0 - 5000 + EAT_MS,
      },
    ]);
    const eater = m.everyone.find((w) => w.id === 'A-3')!;
    expect(eater).toMatchObject({
      zone: 'pantry',
      spot: { pose: 'eating', prop: 'plate', reason: 'Eating Chef 1’s plan' },
    });
    expect(eater.plate?.server).toBe('alpha/A-1');
    expect(m.everyone.find((w) => w.id === 'A-2')!.spot.pose).toBe('coffee');
    // The server is implementing at its desk at once; the plate is cleared a minute after the approval.
    expect(m.everyone.find((w) => w.id === 'A-1')).toMatchObject({
      zone: 'desk',
      spot: { reason: 'Implementing' },
    });
    expect(nextOfficeLook(m, undefined, new Date(at0))).toBe(at0 - 5000 + EAT_MS);
  });

  it('one plate each: the third plan finds nobody without one, and leaves nothing behind', () => {
    const [s4, t4] = idler(4, -20);
    const [s5, t5] = idler(5, -40);
    const servers = [approved(1, 9), approved(2, 6), approved(3, 3)];
    const m = build(
      floor([...servers.map((t) => session(t.aoeSessionId, 'working')), s4, s5], [...servers, t4, t5]),
      at0,
      kitchenMemory(),
    );
    expect(m.meals.map((x) => [x.server, x.eater])).toEqual([
      ['alpha/A-1', 'alpha/A-5'],
      ['alpha/A-2', 'alpha/A-4'],
    ]);
  });

  it('an empty pantry gets no plate, and nobody who arrives later gets it either', () => {
    const pots = kitchenMemory();
    const server = approved(1, 5);
    const empty = build(floor([session('w1', 'working')], [server]), at0, pots);
    expect(empty.meals).toEqual([]);
    const [s2, t2] = idler(2, -30);
    const later = build(floor([session('w1', 'working'), s2], [server, t2]), at0 + 1000, pots);
    expect(later.meals).toEqual([]);
    expect(later.everyone.find((w) => w.id === 'A-2')!.spot.pose).toBe('coffee');
  });

  it('the eater leaves at once when it gets work, and the plate does not come back or go to anyone else', () => {
    const pots = kitchenMemory();
    const [s2, t2] = idler(2, -40);
    const [s3, t3] = idler(3, -20);
    const tasks = [approved(1, 5), t2, t3];
    const first = build(floor([session('w1', 'working'), s2, s3], tasks), at0, pots);
    expect(first.meals.map((x) => x.eater)).toEqual(['alpha/A-2']);

    const working = build(
      floor([session('w1', 'working'), session('w2', 'working'), s3], tasks),
      at0 + 1000,
      pots,
    );
    expect(working.meals).toEqual([]);
    expect(working.everyone.find((w) => w.id === 'A-2')!.zone).toBe('desk');
    expect(working.everyone.find((w) => w.id === 'A-3')!.spot.pose).toBe('coffee');

    const backIdle = session('w2', 'idle', { statusSince: at(-40) });
    const again = build(floor([session('w1', 'working'), backIdle, s3], tasks), at0 + 2000, pots);
    expect(again.meals).toEqual([]);
  });

  it('the plate is cleared after about a minute, back to coffee', () => {
    const pots = kitchenMemory();
    const [s2, t2] = idler(2, -40);
    const inp = floor([session('w1', 'working'), s2], [approved(1, 5), t2]);
    expect(build(inp, at0, pots).meals).toHaveLength(1);
    expect(build(inp, at0 + EAT_MS - 5001, pots).meals).toHaveLength(1);
    const done = build(inp, at0 + EAT_MS - 5000, pots);
    expect(done.meals).toEqual([]);
    expect(done.everyone.find((w) => w.id === 'A-2')!.spot).toMatchObject({ pose: 'coffee', prop: 'mug' });
  });

  it('serves only from its desk: approved while idle, it serves once it is back at work', () => {
    const pots = kitchenMemory();
    const [s2, t2] = idler(2, -40);
    const server = approved(1, 5);
    const idle = build(floor([session('w1', 'idle', { statusSince: at(-1) }), s2], [server, t2]), at0, pots);
    expect(idle.meals).toEqual([]);
    const working = build(floor([session('w1', 'working'), s2], [server, t2]), at0 + 1000, pots);
    expect(working.meals.map((x) => x.eater)).toEqual(['alpha/A-2']);
  });

  it('a page opened mid-meal shows the plate, but only for someone idle before the approval', () => {
    const [s2, t2] = idler(2, -40);
    const late = session('w3', 'idle', { statusSince: new Date(at0 - 2000).toISOString() });
    const [, t3] = idler(3, 0);
    const m = build(
      floor([session('w1', 'working'), late, s2], [approved(1, 30), t2, t3]),
      at0,
      kitchenMemory(),
    );
    expect(m.meals.map((x) => x.eater)).toEqual(['alpha/A-2']);
    // Someone who only went idle after the approval is passed over, even when alone.
    const alone = build(floor([session('w1', 'working'), late], [approved(1, 30), t3]), at0, kitchenMemory());
    expect(alone.meals).toEqual([]);
  });

  it('reading your reply is not idling with a coffee: no plate', () => {
    const reader = task('A-2', 'alpha', 'w2', {
      stage: 'blocked',
      openQuestion: { text: 'q', askedAt: at(-50), answeredAt: at(-45) },
    });
    const m = build(
      floor(
        [session('w1', 'working'), session('w2', 'idle', { statusSince: at(-40) })],
        [approved(1, 5), reader],
      ),
      at0,
      kitchenMemory(),
    );
    expect(m.meals).toEqual([]);
  });

  it('serving is its own move: to the desk from the kitchen with a plate; a plain walk without one', () => {
    const [s2, t2] = idler(2, -40);
    const served = build(floor([session('w1', 'working'), s2], [approved(1, 5), t2]), at0, kitchenMemory());
    const seen = new Map<string, Zone>([
      ['alpha/lead', 'desk'],
      ['alpha/A-1', 'kitchen'],
      ['alpha/A-2', 'pantry'],
    ]);
    expect(planMoves(seen, served).find((x) => x.key === 'alpha/A-1')!.kind).toBe('serve');
    expect(planMoves(null, served).find((x) => x.key === 'alpha/A-1')!.kind).toBe('place');
    const alone = build(floor([session('w1', 'working')], [approved(1, 5)]), at0, kitchenMemory());
    expect(planMoves(seen, alone).find((x) => x.key === 'alpha/A-1')!.kind).toBe('walk');
  });

  it('the history records the plate and whose plan it was, and replays it', () => {
    const pots = kitchenMemory();
    const [s2, t2] = idler(2, -40);
    const before = build(floor([session('w1', 'working'), s2], [planner(1, -60), t2]), at0 - 10_000, pots);
    const after = build(floor([session('w1', 'working'), s2], [approved(1, 5), t2]), at0, pots);
    const prev = new Map(before.everyone.map((w) => [w.key, charState(w)]));
    const moves = diffFloor(
      prev,
      after.everyone.map((w) => charState(w)),
      at(0),
    );
    expect(moves.map((r) => [r.key, r.from, r.zone, r.prop])).toEqual([
      ['alpha/A-1', 'kitchen', 'desk', null],
      ['alpha/A-2', 'pantry', 'pantry', 'plate'],
    ]);
    expect(moves[1]!.meal).toEqual({ server: 'alpha/A-1', name: 'Chef 1', title: 'Plan 1' });
    expect(prev.get('alpha/A-1')).toMatchObject({ zone: 'kitchen', prop: 'pot' });
    expect('meal' in prev.get('alpha/A-2')!).toBe(false);

    const replay = historyModel(after.everyone.map((w) => charState(w)));
    expect(replay.meals.map((x) => [x.server, x.eater, x.title])).toEqual([
      ['alpha/A-1', 'alpha/A-2', 'Plan 1'],
    ]);
    expect(replay.everyone.find((w) => w.key === 'alpha/A-2')!.spot.pose).toBe('eating');
    const cooking = historyModel(before.everyone.map((w) => charState(w)));
    expect(cooking.kitchen.map((w) => [w.key, w.spot.pose])).toEqual([['alpha/A-1', 'cooking']]);
  });
});
