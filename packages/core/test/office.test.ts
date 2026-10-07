import { describe, expect, it } from 'vitest';
import {
  byQueue,
  deskChanges,
  doorLabel,
  DRESS_CODES,
  fnv1a,
  leadSpot,
  mulberry32,
  officeSpot,
  outfitFor,
  PANTRY_DWELL_MS,
  pickDesk,
  type NeedsYouItem,
  type NeedsYouKind,
  type SessionView,
  type Stage,
  type TaskRecord,
} from '../src/shared/index.ts';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

type T = Pick<TaskRecord, 'stage' | 'openQuestion' | 'mr'>;
const task = (stage: Stage, extra: Partial<T> = {}): T => ({ stage, openQuestion: null, mr: null, ...extra });
type S = Pick<SessionView, 'status' | 'statusSince' | 'archived'>;
const session = (status: SessionView['status'], since = ago(60_000), archived = false): S => ({
  status,
  statusSince: since,
  archived,
});
const item = (kind: NeedsYouKind, since = ago(5_000)): NeedsYouItem => ({
  id: `${kind}:x`,
  kind,
  project: 'p',
  taskId: 'P-0001',
  sessionId: 's',
  title: 't',
  detail: 'd',
  since,
});
const mr = (pipeline: NonNullable<TaskRecord['mr']>['pipeline']): TaskRecord['mr'] => ({
  provider: 'gitlab',
  host: 'gitlab.com',
  repo: 'a/b',
  iid: 1,
  url: 'u',
  state: 'opened',
  draft: false,
  pipeline,
  unresolvedThreads: 0,
  detailedMergeStatus: null,
  checkedAt: null,
  error: null,
});

describe('hash', () => {
  it('fnv1a matches the reference vectors', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(fnv1a('foobar')).toBe(0xbf9cf968);
  });
  it('mulberry32 is deterministic and stays in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 500 }, () => a());
    expect(xs).toEqual(Array.from({ length: 500 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(new Set(xs).size).toBeGreaterThan(490);
  });
});

describe('office: where a worker stands (SPEC §14.5)', () => {
  const at = (t: T, s: S | null, items: NeedsYouItem[] = []) => officeSpot(t, s, items, NOW);

  it('1: done workers have gone home, even with an item left over', () => {
    expect(at(task('done'), session('idle'), [item('mr_ready')]).zone).toBe('gone');
  });

  it.each([
    ['question', 'speech'],
    ['plan_approval', 'scroll'],
    ['permission', 'shield'],
    ['approval', 'hand'],
    ['mr_ready', 'folder'],
    ['mr_closed', 'folder_closed'],
    ['session_error', 'warning'],
    ['session_missing', 'lost'],
  ] as const)('2: anything that needs you queues at the door: %s holds a %s', (kind, prop) => {
    const s = at(task('implementing'), session('working'), [item(kind, ago(9_000))]);
    expect(s).toMatchObject({ zone: 'door', prop, kind, queuedSince: ago(9_000), hold: false });
  });

  it('2: several items queue once, at the oldest, with the most urgent prop', () => {
    const s = at(task('ready_for_review'), session('waiting'), [
      item('mr_ready', ago(60_000)),
      item('permission', ago(10_000)),
    ]);
    expect(s).toMatchObject({ zone: 'door', kind: 'permission', prop: 'shield', queuedSince: ago(60_000) });
  });

  it.each([
    ['planning', 'sketching'],
    ['implementing', 'typing'],
    ['verifying', 'inspecting'],
    ['watching_mr', 'typing'],
  ] as const)('3: working at the desk: %s is %s', (stage, pose) => {
    expect(at(task(stage), session('working'))).toMatchObject({ zone: 'desk', pose, hold: false });
  });

  it('4: stopped workers are away; archived ones too', () => {
    expect(at(task('implementing'), session('stopped')).zone).toBe('away');
    expect(at(task('implementing'), session('idle', ago(60_000), true)).reason).toBe('Archived');
  });

  it('5 and 6: waiting inside the debounce, unknown, error or missing stay put', () => {
    for (const s of [session('waiting'), session('unknown'), session('error'), null])
      expect(at(task('implementing'), s)).toMatchObject({ zone: 'desk', hold: true });
  });

  it('7: idle with an MR open waits on the pipeline in the pantry', () => {
    expect(at(task('watching_mr', { mr: mr('running') }), session('idle'))).toMatchObject({
      zone: 'pantry',
      prop: 'pipeline',
    });
    expect(at(task('watching_mr', { mr: mr('failed') }), session('idle')).prop).toBe('pipeline_failed');
    expect(at(task('mr_raised', { mr: mr('success') }), session('idle')).reason).toBe('Waiting on review');
  });

  it('8: idle after you answered reads your reply in the pantry', () => {
    const answered = { text: 'q', askedAt: ago(9e5), answeredAt: ago(6e4) };
    expect(at(task('blocked', { openQuestion: answered }), session('idle'))).toMatchObject({
      zone: 'pantry',
      prop: 'letter',
    });
  });

  it('9: idle goes to the pantry only after the dwell, holding until then', () => {
    expect(at(task('implementing'), session('idle', ago(PANTRY_DWELL_MS + 1)))).toMatchObject({
      zone: 'pantry',
      hold: false,
      prop: 'mug',
    });
    const early = at(task('implementing'), session('idle', ago(5_000)));
    expect(early).toMatchObject({ zone: 'pantry', hold: true });
    expect(early.holdUntil).toBe(NOW.getTime() + PANTRY_DWELL_MS - 5_000);
  });

  it('team leads: at the door when they need you, else at the lead desk', () => {
    expect(leadSpot(session('idle'), [item('control_replied')])).toMatchObject({
      zone: 'door',
      prop: 'envelope',
    });
    expect(leadSpot(session('waiting'), [item('control_waiting')]).prop).toBe('clipboard');
    expect(leadSpot(session('working'), []).zone).toBe('desk');
    expect(leadSpot(session('stopped'), []).zone).toBe('away');
    expect(leadSpot(null, [])).toMatchObject({ zone: 'desk', hold: true });
  });

  it('the door queue is oldest first, then by id', () => {
    const q = (id: string, since: string) => ({
      id,
      spot: { ...officeSpot(task('blocked'), null, [item('question', since)]) },
    });
    const sorted = [q('B', ago(10)), q('C', ago(50)), q('A', ago(10))].sort(byQueue).map((x) => x.id);
    expect(sorted).toEqual(['C', 'A', 'B']);
  });

  it('a NEEDS YOU list puts the lead in line; one that blocks work goes to the front', () => {
    const asks = [item('control_needs', ago(60_000)), item('control_needs', ago(60_000))];
    expect(leadSpot(session('idle'), asks)).toMatchObject({
      zone: 'door',
      prop: 'clipboard',
      reason: 'Needs you (2 things)',
    });
    expect(leadSpot(session('idle'), [...asks, item('control_blocker', ago(60_000))])).toMatchObject({
      prop: 'hand',
      reason: 'Blocked on you (3 things)',
    });
    // The lead has waited longest, but a worker with a question blocks work, and so does a blocker.
    const line = [
      { id: 'lead', spot: leadSpot(session('idle'), asks) },
      { id: 'mr', spot: officeSpot(task('ready_for_review'), null, [item('mr_ready', ago(30_000))]) },
      { id: 'asker', spot: officeSpot(task('blocked'), null, [item('question', ago(1_000))]) },
      { id: 'boss', spot: leadSpot(session('idle'), [item('control_blocker', ago(2_000))]) },
    ];
    expect(line.sort(byQueue).map((x) => x.id)).toEqual(['boss', 'asker', 'lead', 'mr']);
  });

  it('the door reads your name once it is set', () => {
    expect(doorLabel('Ericson')).toBe('Ericson’s office');
    expect(doorLabel('  ')).toBe('Your office');
    expect(doorLabel(undefined)).toBe('Your office');
  });
});

describe('office: desks', () => {
  const t = (id: string, desk?: number, stage: Stage = 'implementing', project = 'p') => ({
    id,
    project,
    stage,
    desk,
    createdAt: `2026-10-0${id.slice(-1)}T00:00:00Z`,
  });

  it('pickDesk takes the lowest free desk from 1', () => {
    expect(pickDesk([])).toBe(1);
    expect(pickDesk([1, 2, 4])).toBe(3);
  });

  it('seats the unseated, keeps the seated, and settles clashes on the newer task', () => {
    expect(deskChanges([t('P-1', 1), t('P-2'), t('P-3', 1), t('P-4', 3)])).toEqual([
      { project: 'p', id: 'P-2', desk: 2 },
      { project: 'p', id: 'P-3', desk: 4 },
    ]);
  });

  it('done tasks free their desk; projects have their own numbering', () => {
    expect(deskChanges([t('P-1', 1, 'done'), t('P-2'), t('Q-3', undefined, 'planning', 'q')])).toEqual([
      { project: 'p', id: 'P-2', desk: 1 },
      { project: 'q', id: 'Q-3', desk: 1 },
    ]);
  });

  it('is stable once everyone is seated', () => {
    expect(deskChanges([t('P-1', 2), t('P-2', 1)])).toEqual([]);
  });
});

describe('office: outfits', () => {
  it('are the same every time for the same worker, and differ between workers', () => {
    expect(outfitFor('NW-0001', 'northwind-web')).toEqual(outfitFor('NW-0001', 'northwind-web'));
    const many = new Set(Array.from({ length: 50 }, (_, i) => JSON.stringify(outfitFor(`NW-${i}`, 'nw'))));
    expect(many.size).toBe(50);
  });

  it('cover every dress code, with clothes that match it', () => {
    const seen = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const o = outfitFor(`T-${i}`, 'proj');
      seen.set(o.dressCode, (seen.get(o.dressCode) ?? 0) + 1);
      if (o.dressCode === 'business') expect(o.bottom.color).toBe(o.top.color);
      if (o.dressCode === 'medieval') expect(o.top.kind).toBe('tunic');
      expect(o.skin).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect([...seen.keys()].sort()).toEqual([...DRESS_CODES].sort());
    for (const n of seen.values()) expect(n).toBeGreaterThan(80);
  });
});
