import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, readSchedules, resolvePaths } from '@aoe-supercharge/core/node';
import type { HeldMessage, SessionView, UsageReport } from '@aoe-supercharge/core/shared';
import { project, session } from '../../core/test/office-fixtures.ts';
import { Scheduler, type ScheduleInput } from '../src/daemon/scheduler.ts';
import { Store } from '../src/daemon/store.ts';

describe('Scheduler: prompts sent to a chat at a set time', () => {
  let home: string;
  let store: Store;
  let ctx: {
    config: ReturnType<typeof defaultConfig>;
    logger: object;
    paths: ReturnType<typeof resolvePaths>;
  };
  let held: Record<string, HeldMessage[]>;
  let woken: string[];
  let clock: number;

  const fakeHeld = {
    load: async () => {},
    list: (id: string) => held[id] ?? [],
    hold: async (sessionId: string, message: string) => {
      const m: HeldMessage = {
        id: `h${Object.values(held).flat().length + 1}`,
        sessionId,
        message,
        heldAt: new Date(clock).toISOString(),
        state: 'held',
        error: null,
      };
      held[sessionId] = [...(held[sessionId] ?? []), m];
      return m;
    },
  };
  const make = () =>
    new Scheduler(ctx as never, store, fakeHeld, {
      wake: async (id, action) => void woken.push(`${action}:${id}`),
      now: () => new Date(clock),
    });
  const job = (extra: Partial<ScheduleInput> = {}): ScheduleInput => ({
    name: 'Nightly',
    sessionId: 'ctl',
    prompt: 'Say hello',
    time: '00:00',
    days: 'daily',
    enabled: true,
    ...extra,
  });
  const at = (iso: string) => (clock = Date.parse(iso));
  const sessions = (...list: SessionView[]) => {
    store.sessions = list;
    store.recomputeNeedsYou();
  };
  const sent = () =>
    Object.values(held)
      .flat()
      .map((m) => `${m.sessionId}:${m.message}`);

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sc-sched-'));
    ctx = {
      config: defaultConfig(), // home clock: Europe/Stockholm
      logger: { warn() {}, info() {} },
      paths: resolvePaths({ HOME: home }, home),
    };
    store = new Store({ daemon: {}, aoe: { state: 'ok' }, config: {} } as never, {
      waitingDebounceSeconds: () => 20,
    });
    store.sessionsLoaded = true;
    store.ledgerLoaded = true;
    store.projects = [project('alpha', 'ctl')];
    sessions(session('ctl', 'idle'));
    held = {};
    woken = [];
    at('2026-06-10T12:00:00Z'); // 14:00 in Stockholm
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  it('holds the prompt for its chat at the set time, not before', async () => {
    const s = make();
    const j = await s.add(job());
    expect(store.schedules[0]!.nextRunAt).toBe('2026-06-10T22:00:00.000Z');
    at('2026-06-10T21:59:00Z');
    await s.tick();
    expect(sent()).toEqual([]);
    at('2026-06-10T22:00:10Z');
    await s.tick();
    expect(sent()).toEqual(['ctl:Say hello']);
    expect(s.list()[0]).toMatchObject({ id: j.id, lastRunAt: '2026-06-10T22:00:10.000Z' });
    expect(s.list()[0]!.lastResult).toMatchObject({ status: 'queued', heldId: 'h1', manual: false });
    await s.tick();
    expect(sent()).toHaveLength(1);
    expect(store.schedules[0]!.nextRunAt).toBe('2026-06-11T22:00:00.000Z');
    const audit = await readFile(ctx.paths.auditFile, 'utf8');
    expect(audit).toContain('"scheduled_prompt"');
  });

  it('goes once after days asleep, not once per missed day', async () => {
    const s = make();
    await s.add(job());
    at('2026-06-13T08:00:00Z');
    await s.tick();
    await s.tick();
    expect(sent()).toEqual(['ctl:Say hello']);
    expect(store.schedules[0]!.nextRunAt).toBe('2026-06-13T22:00:00.000Z');
  });

  it('does not fire at once after an edit or re-enable', async () => {
    const s = make();
    const j = await s.add(job({ enabled: false }));
    at('2026-06-15T12:00:00Z');
    await s.update(j.id, { enabled: true });
    await s.update(j.id, { time: '09:00' }); // already past today
    await s.tick();
    expect(sent()).toEqual([]);
    expect(store.schedules[0]!.nextRunAt).toBe('2026-06-16T07:00:00.000Z');
  });

  it('skips the run when the usage limit says stop, and says why', async () => {
    store.usage = { level: 'stop', advice: '5-hour limit at 95%.' } as UsageReport;
    const s = make();
    await s.add(job());
    at('2026-06-10T22:01:00Z');
    await s.tick();
    expect(sent()).toEqual([]);
    expect(s.list()[0]!.lastResult).toMatchObject({ status: 'skipped', detail: '5-hour limit at 95%.' });
    expect(store.needsYou).toEqual([]);
    // A skip is the day's run: not tried again every pass.
    store.usage = null;
    await s.tick();
    expect(sent()).toEqual([]);
  });

  it('brings an archived chat back, or starts a stopped one, before holding the prompt', async () => {
    sessions(session('ctl', 'idle', { archived: true }), session('gen', 'stopped'));
    const s = make();
    await s.add(job());
    await s.add(job({ sessionId: 'gen', prompt: 'Tidy up' }));
    at('2026-06-10T22:01:00Z');
    await s.tick();
    expect(woken).toEqual(['unarchive:ctl', 'start:gen']);
    expect(sent()).toEqual(['ctl:Say hello', 'gen:Tidy up']);
  });

  it('fails into Needs you when the chat is gone, until the job is changed', async () => {
    const s = make();
    const j = await s.add(job({ sessionId: 'gone' }));
    at('2026-06-10T22:01:00Z');
    await s.tick();
    expect(s.list()[0]!.lastResult).toMatchObject({ status: 'failed', detail: 'The chat is gone from AoE.' });
    expect(store.needsYou).toMatchObject([
      { kind: 'schedule_failed', sessionId: 'gone', title: 'Scheduled prompt "Nightly"' },
    ]);
    at('2026-06-10T22:05:00Z');
    await s.update(j.id, { sessionId: 'ctl' });
    expect(store.needsYou).toEqual([]);
  });

  it('follows a queued run: sent once typed, failed when typing failed', async () => {
    const s = make();
    await s.add(job());
    await s.add(job({ name: 'Other', prompt: 'Other' }));
    at('2026-06-10T22:01:00Z');
    await s.tick();
    held.ctl = [{ ...held.ctl![1]!, state: 'failed', error: 'AoE said no.' }];
    await s.tick();
    expect(s.list().map((j) => j.lastResult?.status)).toEqual(['sent', 'failed']);
    expect(s.list()[1]!.lastResult!.detail).toBe('AoE said no.');
    expect(store.needsYou.map((i) => i.kind)).toEqual(['schedule_failed']);
  });

  it('Run now sends straight away and leaves the daily time alone', async () => {
    const s = make();
    const j = await s.add(job());
    expect(await s.runNow(j.id)).toMatchObject({ status: 'queued', manual: true });
    expect(sent()).toEqual(['ctl:Say hello']);
    expect(s.list()[0]!.lastRunAt).toBeNull();
    expect(store.schedules[0]!.nextRunAt).toBe('2026-06-10T22:00:00.000Z');
    expect(await s.runNow('nope')).toBeNull();
  });

  it('waits for a fresh view of AoE before firing', async () => {
    store.health = { ...store.health, aoe: { state: 'unreachable' } } as never;
    const s = make();
    await s.add(job());
    at('2026-06-10T22:01:00Z');
    await s.tick();
    expect(sent()).toEqual([]);
  });

  it('keeps its jobs across a restart', async () => {
    await make().add(job());
    expect(await readSchedules(ctx.paths)).toHaveLength(1);
    const again = make();
    at('2026-06-10T22:01:00Z');
    await again.tick();
    expect(sent()).toEqual(['ctl:Say hello']);
  });
});
