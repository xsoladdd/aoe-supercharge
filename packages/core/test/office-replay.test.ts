import { describe, expect, it } from 'vitest';
import {
  awayHeadline,
  awaySummary,
  eventTimes,
  formatUsd,
  historyModel,
  historyPeople,
  sortedRecords,
  stateAt,
  type CharState,
  type HistoryWindow,
  type MoveRecord,
} from '../src/shared/index.ts';
import { at, T0 } from './office-fixtures.ts';

const char = (key: string, extra: Partial<CharState> = {}): CharState => ({
  key,
  sessionId: `s-${key}`,
  parentId: 'ctl',
  project: key.split('/')[0]!,
  taskId: key.split('/')[1] ?? null,
  worktree: null,
  name: `Name ${key}`,
  role: 'worker',
  desk: 1,
  zone: 'desk',
  reason: 'Implementing',
  prop: null,
  stage: 'implementing',
  cost: { tokens: 1000, usd: 1 },
  mr: null,
  ...extra,
});
const move = (min: number, c: CharState, from: CharState['zone'] | null): MoveRecord => ({
  v: 1,
  type: 'move',
  ts: at(min),
  from,
  ...c,
});

// Made-up history: alpha has a lead and two workers; one raises an MR whose pipeline fails, one
// finishes, and a third arrives and needs you.
const a1 = char('alpha/XX-0001');
const a2 = char('alpha/XX-0002', { desk: 2, cost: { tokens: 5000, usd: 2 } });
const lead = char('alpha/lead', {
  taskId: null,
  role: 'lead',
  desk: null,
  stage: null,
  name: 'Control chat',
});
const mr = { iid: 9, url: 'https://gitlab.example.com/a/b/-/merge_requests/9', state: 'opened', threads: 0 };
const h: HistoryWindow = {
  start: { ts: at(-120), chars: [lead, a1, a2] },
  records: [
    move(
      -100,
      {
        ...a1,
        zone: 'review',
        stage: 'mr_raised',
        reason: 'Waiting on the pipeline',
        prop: 'folder_amber',
        mr: { ...mr, pipeline: 'running' },
        cost: { tokens: 3000, usd: 3 },
      },
      'desk',
    ),
    move(
      -80,
      {
        ...a1,
        zone: 'review',
        stage: 'watching_mr',
        reason: 'Pipeline failed',
        prop: 'folder_red',
        mr: { ...mr, pipeline: 'failed' },
        cost: { tokens: 3000, usd: 3 },
      },
      'review',
    ),
    move(
      -60,
      { ...a2, zone: 'gone', stage: 'done', reason: 'Done', cost: { tokens: 9000, usd: 4.5 } },
      'desk',
    ),
    move(-30, char('alpha/XX-0003', { desk: 3, cost: { tokens: 10, usd: 0.25 } }), null),
    move(
      -20,
      char('alpha/XX-0003', {
        desk: 3,
        zone: 'door',
        reason: 'Question',
        prop: 'speech',
        cost: { tokens: 10, usd: 0.25 },
      }),
      'desk',
    ),
    move(-10, char('beta/YY-0001', { project: 'beta' }), null),
    // Older than the start, which already has it: skipped.
    move(-150, { ...a1, zone: 'away', reason: 'Stopped' }, 'desk'),
  ],
};

describe('history replay (SPEC §14.5)', () => {
  const sorted = sortedRecords(h);

  it('puts everyone where they were at any time', () => {
    const zones = (t: number) => Object.fromEntries(stateAt(h, sorted, t).map((c) => [c.key, c.zone]));
    expect(zones(T0 - 110 * 60_000)).toMatchObject({ 'alpha/XX-0001': 'desk', 'alpha/XX-0002': 'desk' });
    expect(zones(T0 - 90 * 60_000)['alpha/XX-0001']).toBe('review');
    // Finished: gone from the floor.
    expect(zones(T0 - 50 * 60_000)['alpha/XX-0002']).toBeUndefined();
    expect(zones(T0)).toMatchObject({ 'alpha/XX-0003': 'door', 'alpha/lead': 'desk' });
  });

  it('narrows to a project or one agent', () => {
    const one = { key: 'alpha/XX-0001' };
    expect(stateAt(h, sortedRecords(h, one), T0, one).map((c) => c.key)).toEqual(['alpha/XX-0001']);
    const beta = { project: 'beta' };
    expect(stateAt(h, sortedRecords(h, beta), T0, beta).map((c) => c.key)).toEqual(['beta/YY-0001']);
  });

  it('lists the moments something happened, and who was seen', () => {
    expect(eventTimes(sorted)).toHaveLength(7);
    expect(historyPeople(h).map((p) => p.key)).toEqual([
      'alpha/lead',
      'alpha/XX-0001',
      'alpha/XX-0002',
      'alpha/XX-0003',
      'beta/YY-0001',
    ]);
    expect(historyPeople(h).find((p) => p.key === 'alpha/lead')?.name).toBe('alpha lead');
  });

  it('draws the past floor in the live floor’s shape', () => {
    const model = historyModel(stateAt(h, sorted, T0 - 90 * 60_000));
    expect(model.review.map((w) => w.key)).toEqual(['alpha/XX-0001']);
    expect(model.review[0]?.task?.mr?.iid).toBe(9);
    expect(model.review[0]?.spot).toMatchObject({ pose: 'waiting', prop: 'folder_amber' });
    expect(model.teams).toHaveLength(1);
    expect(model.teams[0]?.lead?.key).toBe('alpha/lead');
    expect(model.teams[0]?.seated.map((w) => w.key)).toEqual(['alpha/XX-0002']);
    expect(model.everyone.find((w) => w.key === 'alpha/XX-0002')?.spot.pose).toBe('typing');
    // Nothing live in the past: no prompts, no runaways.
    expect(model.everyone.every((w) => !w.idle.prompt && !w.cost?.runaway.length)).toBe(true);
  });

  it('a lead that was on the phone for its workers is on the phone in the past too', () => {
    const calling = { ...lead, reason: 'Calling for Aldric', prop: 'phone' as const };
    const model = historyModel([calling]);
    expect(model.teams[0]?.lead?.spot).toMatchObject({ zone: 'desk', pose: 'phone', prop: 'phone' });
    expect(historyModel([lead]).teams[0]?.lead?.spot.pose).toBe('reading');
  });
});

describe('since I was away', () => {
  it('counts who finished, raised an MR, failed and needed you, and what it cost', () => {
    const s = awaySummary(h, T0 - 120 * 60_000, T0);
    expect(s).toMatchObject({ finished: 1, mrsRaised: 1, failed: 1, neededYou: 1 });
    // a1 1 → 3, a2 2 → 4.5, a3 and beta arrived at 0.25 and 1; the lead had no cost change.
    expect(s.spent.usd).toBeCloseTo(2 + 2.5 + 0.25 + 1, 5);
    expect(s.events.map((e) => e.kind)).toEqual([
      'arrived',
      'needed_you',
      'arrived',
      'finished',
      'failed',
      'mr_raised',
    ]);
    expect(s.events.find((e) => e.kind === 'failed')?.text).toBe('Pipeline failed on !9');
    expect(awayHeadline(s, formatUsd)).toBe(
      '1 agent finished, 1 MR raised, 1 failed, 1 agent needed you, ≈ $5.75 spent',
    );
  });

  it('only counts what happened in the time asked for', () => {
    const s = awaySummary(h, T0 - 70 * 60_000, T0);
    expect(s).toMatchObject({ finished: 1, mrsRaised: 0, failed: 0, neededYou: 1 });
  });

  it('uses the live meters for the end when given, and a new conversation counts in full', () => {
    const s = awaySummary(h, T0 - 120 * 60_000, T0, (key) =>
      key === 'alpha/XX-0001' ? { tokens: 500, usd: 0.5 } : undefined,
    );
    // a1 was cleared: its new conversation's 0.5 counts, not 3 - 1.
    expect(s.spent.usd).toBeCloseTo(0.5 + 2.5 + 0.25 + 1, 5);
  });

  it('does not count what a daemon start found already on the floor', () => {
    // A start: a frame of what it last recorded (nobody), then everyone it finds, at the same moment.
    const startUp: HistoryWindow = {
      start: { ts: at(-60), chars: [] },
      records: [
        { v: 1, type: 'frame', ts: at(-30), chars: [] },
        move(
          -30,
          { ...a1, zone: 'review', mr: { ...mr, pipeline: 'failed' }, cost: { tokens: 9000, usd: 9 } },
          null,
        ),
        // After the start, news again.
        move(-10, { ...a1, zone: 'gone', stage: 'done', cost: { tokens: 9500, usd: 9.5 } }, 'review'),
      ],
    };
    const s = awaySummary(startUp, T0 - 60 * 60_000, T0);
    expect(s).toMatchObject({ finished: 1, mrsRaised: 0, failed: 0 });
    expect(s.events.map((e) => e.kind)).toEqual(['finished']);
    expect(s.spent.usd).toBeCloseTo(0.5, 5);
  });

  it('says so when nothing happened', () => {
    const quiet = awaySummary({ start: { ts: at(-10), chars: [a1] }, records: [] }, T0 - 600_000, T0);
    expect(awayHeadline(quiet, formatUsd)).toBe('Nothing happened');
    expect(quiet.events).toEqual([]);
  });
});
