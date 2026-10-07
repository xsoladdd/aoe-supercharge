import { describe, expect, it } from 'vitest';
import {
  computeNeedsYou,
  formatWatchNotice,
  markerOf,
  parseWatchLine,
  splitWatchNotices,
  watchEvents,
  watchStep,
  watchWorkers,
  type OfficeInput,
  type SessionView,
  type TaskRecord,
  type WatchBook,
  type WatchMarker,
  type WatchNotice,
} from '../src/shared/index.ts';
import { at, project, session, T0, task } from './office-fixtures.ts';

const LEGACY =
  '[WATCH] worker="fix-1989-ci" status=error kind=error log=/Users/me/.control-watch/logs/fix-1989-ci.txt';

const notice = (extra: Partial<WatchNotice> = {}): WatchNotice => ({
  worker: 'w',
  kind: 'done',
  status: null,
  log: null,
  name: null,
  project: null,
  task: null,
  stage: null,
  session: null,
  at: null,
  detail: null,
  ...extra,
});

describe('watch notice lines', () => {
  it("reads control-watch.sh's lines", () => {
    expect(parseWatchLine(LEGACY)).toEqual(
      notice({
        worker: 'fix-1989-ci',
        status: 'error',
        kind: 'error',
        log: '/Users/me/.control-watch/logs/fix-1989-ci.txt',
      }),
    );
  });

  it('reads quoted values with escapes, ignores keys it does not know and odd words', () => {
    const n = parseWatchLine(
      '  [WATCH] worker="a b" kind=question colour=blue stray detail="He said \\"hi\\" \\\\ there"',
    );
    expect(n).toMatchObject({ worker: 'a b', kind: 'question', detail: 'He said "hi" \\ there' });
  });

  it('is not a notice without the prefix or a worker', () => {
    expect(parseWatchLine('worker="x" kind=done')).toBeNull();
    expect(parseWatchLine('[WATCH] kind=done')).toBeNull();
    expect(parseWatchLine('Please look at the [WATCH] lines')).toBeNull();
  });

  it('writes worker, status, kind and log first, as control-watch.sh did, and reads back the same', () => {
    const n = notice({
      worker: 'AS-0013 Built-in watch',
      status: 'waiting',
      kind: 'permission',
      log: '/s/supercharge/watch/logs/abc-20261008T091200Z.txt',
      name: 'Norbert',
      project: 'aoe-supercharge',
      task: 'AS-0013',
      stage: 'implementing',
      session: 'abc',
      at: '2026-10-08T09:12:00.000Z',
      detail: 'Wants to use Bash: rm -rf "build"',
    });
    const line = formatWatchNotice(n);
    expect(line).toMatch(
      /^\[WATCH\] worker="AS-0013 Built-in watch" status=waiting kind=permission log=\/s\/supercharge\/watch\/logs\/abc-20261008T091200Z\.txt name="Norbert" /,
    );
    expect(parseWatchLine(line)).toEqual(n);
  });

  it('keeps a notice on one line, and its detail short', () => {
    const line = formatWatchNotice(notice({ detail: `first\nsecond ${'x'.repeat(400)}` }));
    expect(line).not.toContain('\n');
    expect(parseWatchLine(line)!.detail!.length).toBeLessThanOrEqual(200);
    expect(parseWatchLine(line)!.detail).toMatch(/^first second x+…$/);
  });

  it('splits a typed turn into its notices and the rest', () => {
    const text = [LEGACY, 'and can you check this?', '[WATCH] worker="other" status=idle kind=done'].join(
      '\n',
    );
    const { notices, rest } = splitWatchNotices(text);
    expect(notices.map((n) => n.worker)).toEqual(['fix-1989-ci', 'other']);
    expect(rest).toBe('and can you check this?');
    expect(splitWatchNotices('just text')).toEqual({ notices: [], rest: 'just text' });
  });
});

describe('markerOf: QUESTION: and DONE: in a plain worker reply', () => {
  it('finds the last marker, with what it says', () => {
    expect(markerOf('Looked at it.\n\nQUESTION: Use Postgres or SQLite?\nEither works.')).toEqual({
      kind: 'question',
      text: 'Use Postgres or SQLite? Either works.',
    });
    expect(markerOf('QUESTION: old one\n\n**DONE:** shipped the fix')).toEqual({
      kind: 'done',
      text: 'shipped the fix',
    });
  });

  it('needs the marker at the start of a line', () => {
    expect(markerOf('When stuck, write QUESTION: followed by the question.')).toBeNull();
    expect(markerOf('All good, nothing to report.')).toBeNull();
  });
});

const now = new Date(T0);
const minutesAgo = (m: number) => new Date(T0 - m * 60_000).toISOString();

function world(over: { sessions?: SessionView[]; tasks?: TaskRecord[] } = {}): OfficeInput {
  const sessions = over.sessions ?? [
    session('ctl', 'idle'),
    session('s1', 'working', { title: 'AS-0001 Do a thing' }),
    session('crew1', 'working', { title: 'fix-1989-ci', parentId: 'ctl' }),
  ];
  const tasks = over.tasks ?? [task('AS-0001', 'alpha', 's1')];
  const projects = [{ ...project('alpha', 'ctl'), crew: { crew1: 'Norbert' } }, project('beta', 'ctl2')];
  const needsYou = computeNeedsYou({
    tasks,
    sessions,
    projects,
    aoeReachable: true,
    now,
    waitingDebounceSeconds: 20,
  });
  return { sessions, tasks, projects, needsYou };
}

function eventsOf(input: OfficeInput, opts: { markers?: Record<string, WatchMarker>; stall?: number } = {}) {
  const p = input.projects.find((x) => x.name === 'alpha')!;
  const workers = watchWorkers(input, p);
  return watchEvents({
    project: 'alpha',
    workers,
    needsYou: input.needsYou,
    markers: opts.markers ?? {},
    now,
    stallMinutes: opts.stall ?? 15,
  });
}

describe('watchWorkers', () => {
  it("takes a project's tasks and its control chat's crew, never the control chat", () => {
    const w = world({
      sessions: [
        session('ctl', 'idle'),
        session('s1', 'working'),
        session('s2', 'idle', { archived: true }),
        session('s3', 'idle'),
        session('crew1', 'idle', { title: 'fix-1989-ci', parentId: 'ctl' }),
        session('crew2', 'idle', { parentId: 'ctl', archived: true }),
        session('other', 'idle', { parentId: 'ctl2' }),
      ],
      tasks: [
        task('AS-0001', 'alpha', 's1'),
        task('AS-0002', 'alpha', 's2'),
        task('AS-0003', 'alpha', 's3', { stage: 'done' }),
        task('BB-0001', 'beta', 'other'),
      ],
    });
    const workers = watchWorkers(w, w.projects[0]!);
    expect(workers.map((x) => [x.sessionId, x.name, x.title])).toEqual([
      ['s1', 'Gareth', 's1'],
      ['crew1', 'Norbert', 'fix-1989-ci'],
    ]);
  });

  it('watches nothing for a project without a control chat', () => {
    const w = world();
    expect(watchWorkers(w, project('alpha', null))).toEqual([]);
  });
});

describe('watchEvents', () => {
  it('reports an error once per session, with what AoE said', () => {
    const w = world({
      sessions: [session('ctl', 'idle'), session('s1', 'error', { lastError: 'tmux died' })],
    });
    expect(eventsOf(w)).toMatchObject([
      {
        key: 'error:s1',
        hold: 'error:s1',
        kind: 'error',
        status: 'error',
        detail: 'tmux died',
        taskId: 'AS-0001',
      },
    ]);
  });

  it('reports a permission prompt and a plan to approve after the waiting debounce, not before', () => {
    const perm = {
      key: 'k',
      kind: 'permission' as const,
      question: 'Do you want to proceed?',
      options: [],
      tool: { name: 'Bash', summary: 'npm publish' },
      answerable: true,
    };
    const waiting = (since: string, prompt = perm) =>
      world({ sessions: [session('ctl', 'idle'), session('s1', 'waiting', { statusSince: since, prompt })] });
    expect(eventsOf(waiting(new Date(T0 - 5_000).toISOString()))).toEqual([]);
    expect(eventsOf(waiting(minutesAgo(1)))).toMatchObject([
      {
        key: 'permission:s1',
        hold: 'waiting:s1',
        kind: 'permission',
        detail: 'Wants to use Bash: npm publish',
      },
    ]);
    expect(eventsOf(waiting(minutesAgo(1), { ...perm, kind: 'plan' as never }))).toMatchObject([
      { key: 'plan_approval:s1', kind: 'permission', detail: 'Plan ready for your approval' },
    ]);
  });

  it('reports a blocked question and a task ready for review', () => {
    const blocked = world({
      sessions: [session('ctl', 'idle'), session('s1', 'idle', { statusSince: minutesAgo(60) })],
      tasks: [
        task('AS-0001', 'alpha', 's1', {
          stage: 'blocked',
          openQuestion: { text: 'Postgres or SQLite?', askedAt: at(-40), answeredAt: null },
        }),
      ],
    });
    // Blocked is waiting on you, not stalled.
    expect(eventsOf(blocked)).toMatchObject([
      { key: `question:AS-0001:${at(-40)}`, hold: 'blocked:AS-0001', kind: 'question', stage: 'blocked' },
    ]);
    const ready = world({
      sessions: [session('ctl', 'idle'), session('s1', 'idle', { statusSince: minutesAgo(60) })],
      tasks: [task('AS-0001', 'alpha', 's1', { stage: 'ready_for_review' })],
    });
    expect(eventsOf(ready)).toMatchObject([
      {
        key: 'done:AS-0001',
        hold: 'ready:AS-0001',
        kind: 'done',
        detail: 'Branch ready to merge: sc/AS-0001',
      },
    ]);
  });

  it('calls a worker idle past the threshold stalled, once per idle stretch', () => {
    const idle = (m: number) =>
      world({ sessions: [session('ctl', 'idle'), session('s1', 'idle', { statusSince: minutesAgo(m) })] });
    expect(eventsOf(idle(14))).toEqual([]);
    expect(eventsOf(idle(16))).toMatchObject([
      { key: 'stalled:s1', hold: 'idle:s1', kind: 'stalled', detail: 'Idle for 16 min' },
    ]);
    expect(eventsOf(idle(16), { stall: 30 })).toEqual([]);
  });

  it("reads a plain worker's QUESTION: or DONE: instead of calling it stalled", () => {
    const w = world({
      sessions: [
        session('ctl', 'idle'),
        session('crew1', 'idle', { title: 'fix-1989-ci', parentId: 'ctl', statusSince: minutesAgo(40) }),
      ],
      tasks: [],
    });
    expect(eventsOf(w)).toMatchObject([{ key: 'stalled:crew1', worker: 'fix-1989-ci', name: 'Norbert' }]);
    expect(eventsOf(w, { markers: { crew1: { kind: 'question', id: 'm1', text: 'Which env?' } } })).toEqual([
      expect.objectContaining({ key: 'marker:crew1:m1', hold: null, kind: 'question', detail: 'Which env?' }),
    ]);
  });
});

describe('watchStep: once per occurrence', () => {
  const empty: WatchBook = { seen: {}, started: {} };
  const step = (book: WatchBook, input: OfficeInput, opts: Parameters<typeof eventsOf>[1] = {}) => {
    const p = input.projects.find((x) => x.name === 'alpha')!;
    return watchStep(book, 'alpha', watchWorkers(input, p), eventsOf(input, opts), now);
  };
  const erroring = world({ sessions: [session('ctl', 'idle'), session('s1', 'error')] });
  const working = world({ sessions: [session('ctl', 'idle'), session('s1', 'working')] });

  it("takes what is already there as told on a project's first look", () => {
    const first = step(empty, erroring);
    expect(first.fresh).toEqual([]);
    expect(first.book.started.alpha).toBe(now.toISOString());
    expect(step(first.book, erroring).fresh).toEqual([]);
  });

  it('tells a new event once, and again only after its condition cleared', () => {
    let book = step(empty, working).book;
    let r = step(book, erroring);
    expect(r.fresh.map((e) => e.key)).toEqual(['error:s1']);
    r = step(r.book, erroring);
    expect(r.fresh).toEqual([]);
    book = step(r.book, working).book;
    expect(book.seen['error:s1']).toBeUndefined();
    expect(step(book, erroring).fresh.map((e) => e.key)).toEqual(['error:s1']);
  });

  it("doesn't forget while AoE doesn't know a session's status", () => {
    const told = step(step(empty, working).book, erroring).book;
    const unknown = world({ sessions: [session('ctl', 'idle'), session('s1', 'unknown')] });
    const kept = step(told, unknown).book;
    expect(kept.seen['error:s1']).toBeDefined();
    expect(step(kept, erroring).fresh).toEqual([]);
  });

  it('tells a stall once even when its idle time restarts (a daemon restart resets it)', () => {
    const idle = (m: number) =>
      world({ sessions: [session('ctl', 'idle'), session('s1', 'idle', { statusSince: minutesAgo(m) })] });
    let r = step(step(empty, working).book, idle(20));
    expect(r.fresh.map((e) => e.kind)).toEqual(['stalled']);
    r = step(r.book, idle(1));
    expect(r.book.seen['stalled:s1']).toBeDefined();
    expect(step(r.book, idle(20)).fresh).toEqual([]);
  });

  it("keeps a marker while the worker works, so the same reply isn't told twice", () => {
    const crewIdle = world({
      sessions: [session('ctl', 'idle'), session('crew1', 'idle', { parentId: 'ctl' })],
      tasks: [],
    });
    const crewWorking = world({
      sessions: [session('ctl', 'idle'), session('crew1', 'working', { parentId: 'ctl' })],
      tasks: [],
    });
    const markers = { crew1: { kind: 'done' as const, id: 'm1', text: 'fixed' } };
    let r = step(step(empty, crewWorking).book, crewIdle, { markers });
    expect(r.fresh.map((e) => e.key)).toEqual(['marker:crew1:m1']);
    r = step(r.book, crewWorking);
    expect(step(r.book, crewIdle, { markers }).fresh).toEqual([]);
  });

  it("leaves other projects' keys alone until they age out", () => {
    const book: WatchBook = {
      seen: {
        'error:zz': { at: now.toISOString(), hold: 'error:zz', sessionId: 'zz' },
        'error:old': {
          at: new Date(T0 - 40 * 86_400_000).toISOString(),
          hold: 'error:old',
          sessionId: 'old',
        },
      },
      started: { alpha: at(-60) },
    };
    const r = step(book, working);
    expect(Object.keys(r.book.seen)).toEqual(['error:zz']);
  });
});
