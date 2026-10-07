import { describe, expect, it } from 'vitest';
import {
  buildOffice,
  comesBack,
  goingHome,
  idleCheck,
  idleSince,
  markChange,
  nextIdleDeadline,
  nextOfficeLook,
  NO_MARK,
  SNOOZE_MS,
  type IdleLimits,
  type IdleSubject,
  type OfficeMark,
} from '../src/shared/index.ts';
import { at, input, session, T0, task } from './office-fixtures.ts';

const limits: IdleLimits = { promptMinutes: 30, autoArchiveMinutes: 0 };
const now = new Date(T0);
const idle = (sinceMin: number): IdleSubject => ({
  role: 'worker',
  spot: { zone: 'pantry' },
  session: { status: 'idle', statusSince: at(sinceMin) },
});
const mark = (m: Partial<OfficeMark>): OfficeMark => ({ ...NO_MARK, ...m });

describe('idle timeout (SPEC §14.5)', () => {
  it('counts only a worker idle in the pantry', () => {
    expect(idleSince(idle(-40))).toBe(at(-40));
    expect(idleSince({ ...idle(-40), role: 'lead' })).toBeNull();
    expect(idleSince({ ...idle(-40), spot: { zone: 'review' } })).toBeNull();
    expect(idleSince({ ...idle(-40), session: { status: 'working', statusSince: at(-40) } })).toBeNull();
    expect(idleSince({ ...idle(-40), session: { status: 'idle', statusSince: null } })).toBeNull();
  });

  it('asks after promptMinutes, not before', () => {
    expect(idleCheck(idle(-29), null, limits, now)).toEqual({
      since: at(-29),
      prompt: false,
      autoArchive: false,
    });
    expect(idleCheck(idle(-30), null, limits, now).prompt).toBe(true);
    expect(idleCheck(idle(-30), null, { ...limits, promptMinutes: 0 }, now).prompt).toBe(false);
  });

  it('Keep holds for this idle stretch only', () => {
    expect(idleCheck(idle(-40), mark({ keptAt: at(-5) }), limits, now).prompt).toBe(false);
    // Kept during an earlier stretch: this one asks again.
    expect(idleCheck(idle(-40), mark({ keptAt: at(-50) }), limits, now).prompt).toBe(true);
  });

  it('a snooze holds the prompt and the auto-archive until it runs out', () => {
    const both = { promptMinutes: 30, autoArchiveMinutes: 60 };
    const snoozed = mark({ snoozedUntil: at(10) });
    expect(idleCheck(idle(-90), snoozed, both, now)).toMatchObject({ prompt: false, autoArchive: false });
    expect(idleCheck(idle(-90), snoozed, both, new Date(T0 + 11 * 60_000)).autoArchive).toBe(true);
  });

  it('auto-archives after autoArchiveMinutes (off at 0), instead of asking', () => {
    const both = { promptMinutes: 30, autoArchiveMinutes: 120 };
    expect(idleCheck(idle(-119), null, both, now)).toMatchObject({ prompt: true, autoArchive: false });
    expect(idleCheck(idle(-120), null, both, now)).toMatchObject({ prompt: false, autoArchive: true });
    expect(idleCheck(idle(-500), null, limits, now).autoArchive).toBe(false);
    expect(idleCheck(idle(-500), mark({ keptAt: at(-1) }), both, now).autoArchive).toBe(false);
  });

  it('never asks one that is already archived', () => {
    expect(idleCheck(idle(-90), mark({ archivedAt: at(-10) }), limits, now).prompt).toBe(false);
  });

  it('knows when the next prompt or auto-archive is due', () => {
    const chars = [
      { key: 'a', ...idle(-10) },
      { key: 'b', ...idle(-25) },
      { key: 'c', ...idle(-40) },
    ];
    expect(nextIdleDeadline(chars, {}, limits, now)).toBe(T0 + 5 * 60_000);
    expect(nextIdleDeadline(chars, { b: mark({ keptAt: at(-1) }) }, limits, now)).toBe(T0 + 20 * 60_000);
    expect(nextIdleDeadline(chars, { c: mark({ snoozedUntil: at(3) }) }, limits, now)).toBe(T0 + 3 * 60_000);
    expect(nextIdleDeadline([], {}, limits, now)).toBeNull();
  });

  it('comes back when its session works or it needs you', () => {
    expect(comesBack({ spot: { zone: 'pantry' }, session: { status: 'idle', statusSince: null } })).toBe(
      false,
    );
    expect(comesBack({ spot: { zone: 'door' }, session: { status: 'idle', statusSince: null } })).toBe(true);
    expect(comesBack({ spot: { zone: 'desk' }, session: { status: 'working', statusSince: null } })).toBe(
      true,
    );
  });

  it('turns an action into a mark change', () => {
    expect(markChange('archive', now)).toEqual({ archivedAt: now.toISOString(), snoozedUntil: null });
    expect(markChange('keep', now)).toEqual({ keptAt: now.toISOString(), snoozedUntil: null });
    expect(markChange('snooze', now)).toEqual({ snoozedUntil: new Date(T0 + SNOOZE_MS).toISOString() });
    expect(markChange('restore', now)).toEqual({
      archivedAt: null,
      keptAt: now.toISOString(),
      snoozedUntil: null,
    });
  });
});

describe('buildOffice with office marks', () => {
  const base = () =>
    input(
      [session('ctl', 'idle'), session('s1', 'idle', { statusSince: at(-45) }), session('s2', 'working')],
      [task('XX-0001', 'alpha', 's1'), task('XX-0002', 'alpha', 's2', { desk: 2 })],
    );

  it('asks the idle worker in the pantry to go home', () => {
    const model = buildOffice(base(), now);
    expect(goingHome(model).map((w) => w.key)).toEqual(['alpha/XX-0001']);
    expect(model.everyone.find((w) => w.key === 'alpha/XX-0001')?.idle.since).toBe(at(-45));
  });

  it('takes an archived worker off the floor, and lists it apart', () => {
    const marks = { 'alpha/XX-0001': mark({ archivedAt: at(-5) }) };
    const model = buildOffice({ ...base(), office: { marks } }, now);
    expect(model.archived.map((w) => w.key)).toEqual(['alpha/XX-0001']);
    expect(model.pantry).toEqual([]);
    expect(goingHome(model)).toEqual([]);
    expect(model.everyone.find((w) => w.key === 'alpha/XX-0001')?.mark?.archivedAt).toBe(at(-5));
  });

  it('brings an archived worker back once its session works', () => {
    const marks = { 'alpha/XX-0002': mark({ archivedAt: at(-5) }) };
    const model = buildOffice({ ...base(), office: { marks } }, now);
    expect(model.archived).toEqual([]);
    expect(model.everyone.find((w) => w.key === 'alpha/XX-0002')?.zone).toBe('desk');
  });

  it('uses the idle limits it is given, and looks again when the prompt is due', () => {
    const fresh = input(
      [session('ctl', 'idle'), session('s1', 'idle', { statusSince: at(-20) })],
      [task('XX-0001', 'alpha', 's1')],
    );
    const model = buildOffice(fresh, now);
    expect(goingHome(model)).toEqual([]);
    expect(nextOfficeLook(model, undefined, now)).toBe(T0 + 10 * 60_000);
    const sooner = { marks: {}, idle: { promptMinutes: 15, autoArchiveMinutes: 0 } };
    expect(goingHome(buildOffice({ ...fresh, office: sooner }, now))).toHaveLength(1);
  });
});
