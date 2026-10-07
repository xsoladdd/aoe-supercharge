import { describe, expect, it } from 'vitest';
import {
  buildOffice,
  EntranceQueue,
  isFinish,
  planMoves,
  SPAWN_GAP_MS,
  type MrState,
  type Zone,
} from '../src/shared/index.ts';
import { at, input, session, T0, task } from './office-fixtures.ts';

const mr: MrState = {
  provider: 'gitlab',
  host: 'gitlab.example.com',
  repo: 'a/b',
  iid: 3,
  url: 'https://gitlab.example.com/a/b/-/merge_requests/3',
  state: 'opened',
  draft: false,
  pipeline: 'success',
  unresolvedThreads: 0,
  detailedMergeStatus: null,
  checkedAt: null,
  error: null,
};
const idle = session('w1', 'idle', { statusSince: at(-5) });

describe('office moves', () => {
  it('first sight (load or reconnect) places everyone, nobody walks', () => {
    const m = buildOffice(
      input([session('ctl', 'working'), session('w1', 'working')], [task('A-1', 'alpha', 'w1')]),
      new Date(T0),
    );
    expect(planMoves(null, m).map((x) => x.kind)).toEqual(['place', 'place']);
  });

  it('a newcomer walks in; a change of place is a walk; no change stays', () => {
    const m = buildOffice(
      input(
        [session('ctl', 'working'), session('w1', 'working'), session('w2', 'working')],
        [task('A-1', 'alpha', 'w1'), task('A-2', 'alpha', 'w2', { desk: 2 })],
      ),
      new Date(T0),
    );
    const seen = new Map<string, Zone>([
      ['alpha/lead', 'door'],
      ['alpha/A-1', 'desk'],
    ]);
    expect(planMoves(seen, m).map((x) => [x.key, x.kind])).toEqual([
      ['alpha/lead', 'walk'],
      ['alpha/A-1', 'stay'],
      ['alpha/A-2', 'spawn'],
    ]);
  });

  it('a worker with an MR leaving its desk runs the finish errand; going idle with none does not', () => {
    const delivered = buildOffice(
      input([session('ctl', 'working'), idle], [task('A-1', 'alpha', 'w1', { stage: 'watching_mr', mr })]),
      new Date(T0),
    );
    const w = delivered.everyone.find((x) => x.key === 'alpha/A-1')!;
    expect(isFinish('desk', w, delivered)).toBe(true);
    expect(
      planMoves(new Map([['alpha/A-1', 'desk']]), delivered).find((x) => x.key === 'alpha/A-1')?.kind,
    ).toBe('finish');
    // Back from the door is not a finish, and neither is a break without an MR.
    expect(isFinish('door', w, delivered)).toBe(false);
    const plain = buildOffice(
      input([session('ctl', 'working'), idle], [task('A-1', 'alpha', 'w1')]),
      new Date(T0),
    );
    expect(
      isFinish(
        'desk',
        plain.everyone.find((x) => x.key === 'alpha/A-1')!,
        plain,
      ),
    ).toBe(false);
    // No lead to hand it to: it just walks.
    const leaderless = buildOffice(
      {
        ...input([idle], [task('A-1', 'alpha', 'w1', { stage: 'watching_mr', mr })]),
        projects: [{ ...input([], []).projects[0]!, controlSessionId: null }],
      },
      new Date(T0),
    );
    expect(isFinish('desk', leaderless.everyone[0]!, leaderless)).toBe(false);
  });

  it('the entrance takes newcomers one at a time', () => {
    const q = new EntranceQueue();
    expect([q.next(1000), q.next(1000), q.next(1000)]).toEqual([
      1000,
      1000 + SPAWN_GAP_MS,
      1000 + 2 * SPAWN_GAP_MS,
    ]);
    // Once the entrance has been free a while, the next walks straight in.
    expect(q.next(10_000)).toBe(10_000);
    q.reset();
    expect(q.next(0)).toBe(0);
  });
});
