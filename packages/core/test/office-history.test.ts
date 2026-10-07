import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendHistory,
  lastHistoryState,
  pruneHistory,
  readHistory,
  readOfficeMarks,
  resolvePaths,
  updateOfficeMark,
  type Paths,
} from '../src/node/index.ts';
import {
  buildOffice,
  diffFloor,
  filterRecord,
  floorStates,
  historyDay,
  officeAt,
  type CharState,
  type HistoryRecord,
  type OfficeInput,
  type ProjectRecord,
  type SessionView,
  type TaskRecord,
} from '../src/shared/index.ts';

const T0 = Date.parse('2026-10-06T12:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

const char = (key: string, zone: CharState['zone'], extra: Partial<CharState> = {}): CharState => ({
  key,
  sessionId: `s-${key}`,
  parentId: null,
  project: key.split('/')[0]!,
  taskId: null,
  worktree: null,
  name: key,
  role: 'worker',
  desk: 1,
  zone,
  reason: zone,
  prop: null,
  stage: null,
  cost: null,
  mr: null,
  ...extra,
});
const frame = (ts: string, chars: CharState[]): HistoryRecord => ({ v: 1, type: 'frame', ts, chars });
const move = (ts: string, c: CharState, from: CharState['zone'] | null): HistoryRecord => ({
  ...c,
  v: 1,
  type: 'move',
  ts,
  from,
});

function session(id: string, status: SessionView['status'], extra: Partial<SessionView> = {}): SessionView {
  return {
    id,
    title: id,
    status,
    rawStatus: status,
    statusSince: at(-30),
    parentId: null,
    branch: null,
    projectPath: null,
    group: null,
    tool: 'claude',
    unread: false,
    lastError: null,
    createdAt: at(-60),
    lastAccessedAt: null,
    prompt: null,
    pinned: false,
    archived: false,
    locked: false,
    ...extra,
  };
}

function project(name: string, control: string | null): ProjectRecord {
  return {
    schema: 1,
    name,
    repoPath: `/r/${name}`,
    remoteUrl: null,
    controlSessionId: control,
    idPrefix: 'XX',
    nextTaskSeq: 1,
    installMode: 'user',
    createdAt: at(-60),
    updatedAt: at(-60),
  };
}

function task(id: string, proj: string, sessionId: string, extra: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schema: 1,
    rev: 1,
    id,
    project: proj,
    name: 'Gareth',
    desk: 1,
    title: 'Do a thing',
    brief: '',
    branch: `sc/${id}`,
    baseBranch: 'main',
    worktreePath: `/w/${id}`,
    aoeSessionId: sessionId,
    parentSessionId: 'ctl',
    stage: 'implementing',
    blockedFrom: null,
    openQuestion: null,
    plan: null,
    mr: null,
    createdAt: at(-60),
    updatedAt: at(-60),
    history: [],
    ...extra,
  };
}

const input = (sessions: SessionView[], tasks: TaskRecord[]): OfficeInput => ({
  sessions,
  projects: [project('alpha', 'ctl')],
  tasks,
  needsYou: [],
});

describe('buildOffice (core)', () => {
  it('places the lead and workers, and keeps a hold in the memory it is given', () => {
    const holds = new Map();
    const working = input(
      [session('ctl', 'working'), session('w1', 'working')],
      [task('A-1', 'alpha', 'w1')],
    );
    const m1 = buildOffice(working, new Date(T0), holds);
    expect(m1.everyone.map((w) => [w.key, w.zone])).toEqual([
      ['alpha/lead', 'desk'],
      ['alpha/A-1', 'desk'],
    ]);
    expect(m1.teams[0]!.seated.map((w) => w.key)).toEqual(['alpha/A-1']);
    // Just went idle: it finishes up at its desk (a hold), because it was last seen there.
    const idle = input(
      [session('ctl', 'working'), session('w1', 'idle', { statusSince: new Date(T0 - 1000).toISOString() })],
      [task('A-1', 'alpha', 'w1')],
    );
    expect(buildOffice(idle, new Date(T0), holds).everyone[1]!.zone).toBe('desk');
    // A fresh memory has not seen it: it goes straight to the pantry.
    expect(buildOffice(idle, new Date(T0), new Map()).everyone[1]!.zone).toBe('pantry');
  });

  it('gives spawned sessions the free desks after the tasks', () => {
    const m = buildOffice(
      input(
        [session('ctl', 'idle'), session('w1', 'working'), session('x', 'working', { parentId: 'ctl' })],
        [task('A-1', 'alpha', 'w1')],
      ),
      new Date(T0),
    );
    expect(m.everyone.find((w) => w.key === 'alpha/s/x')?.desk).toBe(2);
  });
});

describe('office history', () => {
  it('diffFloor: arrivals, changes and departures; cost alone is not a move', () => {
    const prev = new Map([
      ['a/1', char('a/1', 'desk')],
      ['a/2', char('a/2', 'pantry')],
    ]);
    const next = [char('a/1', 'desk', { cost: { tokens: 10, usd: 0.1 } }), char('a/3', 'desk')];
    const moves = diffFloor(prev, next, at(0));
    expect(moves.map((m) => m.type === 'move' && [m.key, m.from, m.zone])).toEqual([
      ['a/3', null, 'desk'],
      ['a/2', 'pantry', 'gone'],
    ]);
    expect(diffFloor(new Map([['a/1', char('a/1', 'desk')]]), [char('a/1', 'pantry')], at(0))).toHaveLength(
      1,
    );
  });

  it('officeAt: latest frame before t, plus the moves after it', () => {
    const records: HistoryRecord[] = [
      move(at(5), char('a/1', 'pantry'), 'desk'),
      frame(at(0), [char('a/1', 'desk'), char('a/2', 'desk')]),
      move(at(10), char('a/2', 'gone'), 'desk'),
      frame(at(20), [char('a/1', 'door')]),
      move(at(25), char('a/3', 'desk'), null),
    ];
    expect(officeAt(records, T0 - 1)).toBeNull();
    const z = (t: number) =>
      officeAt(records, T0 + t * 60_000)!
        .map((c) => `${c.key}:${c.zone}`)
        .sort();
    expect(z(0)).toEqual(['a/1:desk', 'a/2:desk']);
    expect(z(7)).toEqual(['a/1:pantry', 'a/2:desk']);
    expect(z(12)).toEqual(['a/1:pantry']);
    expect(z(20)).toEqual(['a/1:door']);
    expect(z(30)).toEqual(['a/1:door', 'a/3:desk']);
  });

  it('a frame and a move at the same time: the frame goes first', () => {
    const records = [move(at(0), char('a/1', 'door'), 'desk'), frame(at(0), [char('a/1', 'desk')])];
    expect(officeAt(records, T0)!.map((c) => c.zone)).toEqual(['door']);
  });

  it('filters by project and by agent', () => {
    const f = frame(at(0), [char('a/1', 'desk'), char('b/1', 'desk')]);
    expect((filterRecord(f, { project: 'b' }) as { chars: CharState[] }).chars.map((c) => c.key)).toEqual([
      'b/1',
    ]);
    expect(filterRecord(move(at(1), char('a/1', 'pantry'), 'desk'), { key: 'b/1' })).toBeNull();
    expect(filterRecord(move(at(1), char('a/1', 'pantry'), 'desk'), {})).not.toBeNull();
  });

  it('floorStates carries the MR and the stage', () => {
    const t = task('A-1', 'alpha', 'w1', {
      stage: 'watching_mr',
      mr: {
        provider: 'gitlab',
        host: 'gitlab.example.com',
        repo: 'a/b',
        iid: 9,
        url: 'https://gitlab.example.com/a/b/-/merge_requests/9',
        state: 'opened',
        draft: false,
        pipeline: 'running',
        unresolvedThreads: 2,
        detailedMergeStatus: null,
        checkedAt: null,
        error: null,
      },
    });
    const m = buildOffice(input([session('ctl', 'idle'), session('w1', 'working')], [t]), new Date(T0));
    const s = floorStates(m).find((c) => c.key === 'alpha/A-1')!;
    expect(s).toMatchObject({ stage: 'watching_mr', taskId: 'A-1', worktree: 'sc/A-1' });
    expect(s.mr).toEqual({ iid: 9, url: t.mr!.url, state: 'opened', pipeline: 'running', threads: 2 });
  });
});

describe('office history files', () => {
  let paths: Paths;
  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), 'sc-hist-'));
    paths = resolvePaths({ HOME: home }, home);
  });

  it('writes a file per UTC day and reads a range back with the state at its start', async () => {
    const day1 = '2026-10-05T23:50:00.000Z';
    const day2 = '2026-10-06T00:10:00.000Z';
    await appendHistory(paths, [
      frame(day1, [char('a/1', 'desk'), char('b/1', 'desk')]),
      move('2026-10-05T23:55:00.000Z', char('a/1', 'pantry'), 'desk'),
      frame(day2, [char('a/1', 'pantry'), char('b/1', 'desk')]),
      move('2026-10-06T00:20:00.000Z', char('b/1', 'door'), 'desk'),
    ]);
    expect((await readdir(paths.historyDir)).sort()).toEqual(['2026-10-05.jsonl', '2026-10-06.jsonl']);
    const r = await readHistory(paths, Date.parse('2026-10-05T23:58:00.000Z'), Date.parse(day2) + 3600_000);
    expect(r.start.chars.map((c) => `${c.key}:${c.zone}`).sort()).toEqual(['a/1:pantry', 'b/1:desk']);
    expect(r.records.map((x) => x.type)).toEqual(['frame', 'move']);
    const b = await readHistory(paths, Date.parse(day1), Date.parse(day2) + 3600_000, { project: 'b' });
    expect(b.start.chars.map((c) => c.key)).toEqual(['b/1']);
    expect(b.records.filter((x) => x.type === 'move')).toHaveLength(1);
    expect([...(await lastHistoryState(paths)).values()].map((c) => `${c.key}:${c.zone}`).sort()).toEqual([
      'a/1:pantry',
      'b/1:door',
    ]);
  });

  it('skips a torn last line', async () => {
    await appendHistory(paths, [frame(at(0), [char('a/1', 'desk')])]);
    await writeFile(join(paths.historyDir, `${historyDay(T0)}.jsonl`), '{"v":1,"type":"mo', { flag: 'a' });
    const r = await readHistory(paths, T0 + 1, T0 + 2);
    expect(r.start.chars).toHaveLength(1);
  });

  it('prunes days older than the retention', async () => {
    for (const d of ['2026-09-01', '2026-09-05', '2026-09-06', '2026-10-06'])
      await appendHistory(paths, [frame(`${d}T10:00:00.000Z`, [])]);
    // 30 days before noon on 6 October is noon on 6 September: that day still has records to keep.
    const removed = await pruneHistory(paths, 30, T0);
    expect(removed).toEqual(['2026-09-01', '2026-09-05']);
    expect((await readdir(paths.historyDir)).sort()).toEqual(['2026-09-06.jsonl', '2026-10-06.jsonl']);
  });

  it('keeps office marks, and drops a mark with nothing left in it', async () => {
    expect(await readOfficeMarks(paths)).toEqual({});
    await updateOfficeMark(paths, 'a/1', { archivedAt: at(0) });
    await updateOfficeMark(paths, 'a/2', { snoozedUntil: at(30) });
    expect(await readOfficeMarks(paths)).toEqual({
      'a/1': { archivedAt: at(0), keptAt: null, snoozedUntil: null },
      'a/2': { archivedAt: null, keptAt: null, snoozedUntil: at(30) },
    });
    await updateOfficeMark(paths, 'a/1', { archivedAt: null });
    expect(Object.keys(await readOfficeMarks(paths))).toEqual(['a/2']);
  });
});
