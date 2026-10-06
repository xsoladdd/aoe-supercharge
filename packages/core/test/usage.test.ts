import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordUsage, resolvePaths } from '../src/node/index.ts';
import {
  countActiveWorkers,
  mergeWindow,
  usageReport,
  type SpawnLimits,
  type UsageRecord,
} from '../src/shared/index.ts';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const LIMITS: SpawnLimits = {
  enabled: true,
  maxWorkers: 4,
  busyMaxWorkers: 2,
  fiveHourBusyAt: 50,
  fiveHourStopAt: 85,
  weeklyBusyAt: 75,
  weeklyStopAt: 95,
};
const rec = (fiveHour: number | null, sevenDay: number | null = 10): UsageRecord => ({
  fiveHour: fiveHour === null ? null : { usedPercentage: fiveHour, resetsAt: at(120) },
  sevenDay: sevenDay === null ? null : { usedPercentage: sevenDay, resetsAt: at(3 * 1440) },
  capturedAt: at(-1),
});

describe('mergeWindow', () => {
  it('keeps the highest reading within one window, even when its reset time drifts', () => {
    const hi = { usedPercentage: 40, resetsAt: at(120) };
    const lo = { usedPercentage: 20, resetsAt: at(121) };
    expect(mergeWindow(hi, lo)).toEqual({ usedPercentage: 40, resetsAt: at(121) });
    expect(mergeWindow(lo, hi)).toEqual(hi);
  });
  it('a newer window replaces an older one, whatever its reading', () => {
    const old = { usedPercentage: 90, resetsAt: at(-10) };
    const fresh = { usedPercentage: 3, resetsAt: at(290) };
    expect(mergeWindow(old, fresh)).toEqual(fresh);
    expect(mergeWindow(fresh, old)).toEqual(fresh);
  });
});

describe('usageReport', () => {
  it('ok: room up to maxWorkers', () => {
    const r = usageReport(rec(20), 1, LIMITS, NOW);
    expect(r).toMatchObject({ level: 'ok', maxWorkers: 4, canStartCount: 3, canStart: true });
  });
  it('busy: the 5-hour window getting full lowers the cap', () => {
    const r = usageReport(rec(60), 1, LIMITS, NOW);
    expect(r).toMatchObject({ level: 'busy', maxWorkers: 2, canStartCount: 1 });
    expect(usageReport(rec(60), 2, LIMITS, NOW)).toMatchObject({ canStart: false, canStartCount: 0 });
  });
  it('busy: so does the weekly limit', () => {
    expect(usageReport(rec(10, 80), 0, LIMITS, NOW)).toMatchObject({ level: 'busy', maxWorkers: 2 });
  });
  it('stop: nothing new near either limit', () => {
    expect(usageReport(rec(86), 0, LIMITS, NOW)).toMatchObject({ level: 'stop', canStart: false });
    expect(usageReport(rec(10, 96), 0, LIMITS, NOW)).toMatchObject({ level: 'stop', canStart: false });
    expect(usageReport(rec(86), 0, LIMITS, NOW).advice).toMatch(/5-hour limit at 86%/);
  });
  it('a window that has reset since the reading counts as 0', () => {
    const r = usageReport(
      { ...rec(null), fiveHour: { usedPercentage: 99, resetsAt: at(-5) } },
      0,
      LIMITS,
      NOW,
    );
    expect(r.fiveHour).toEqual({ usedPercentage: 0, resetsAt: null, reset: true });
    expect(r.canStart).toBe(true);
  });
  it('unknown without a reading, still capped by maxWorkers', () => {
    expect(usageReport(null, 4, LIMITS, NOW)).toMatchObject({
      known: false,
      level: 'unknown',
      canStart: false,
    });
    expect(usageReport(null, 0, LIMITS, NOW)).toMatchObject({ canStartCount: 4 });
  });
  it('off: never holds a worker back', () => {
    expect(usageReport(rec(99), 9, { ...LIMITS, enabled: false }, NOW)).toMatchObject({
      level: 'off',
      canStart: true,
      canStartCount: null,
    });
  });
});

describe('countActiveWorkers', () => {
  it('counts active stages with a live session only', () => {
    const tasks = [
      { stage: 'planning', aoeSessionId: 'a' },
      { stage: 'blocked', aoeSessionId: 'b' },
      { stage: 'implementing', aoeSessionId: 'gone' },
      { stage: 'verifying', aoeSessionId: 'stopped' },
      { stage: 'ready_for_review', aoeSessionId: 'c' },
      { stage: 'done', aoeSessionId: 'd' },
    ] as const;
    const status: Record<string, string> = {
      a: 'working',
      b: 'waiting',
      stopped: 'stopped',
      c: 'idle',
      d: 'idle',
    };
    expect(countActiveWorkers(tasks, (id) => status[id] ?? null)).toBe(2);
  });
});

describe('recordUsage', () => {
  it('saves the status line rate_limits and ignores input without them', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sc-usage-'));
    try {
      const paths = resolvePaths({ HOME: home }, home);
      expect(await recordUsage(paths, undefined)).toBe(false);
      expect(await recordUsage(paths, { five_hour: { used_percentage: 'x' } })).toBe(false);
      const ok = await recordUsage(
        paths,
        { five_hour: { used_percentage: 41.5, resets_at: NOW / 1000 + 3600 } },
        new Date(NOW),
      );
      expect(ok).toBe(true);
      expect(JSON.parse(await readFile(paths.usageFile, 'utf8'))).toEqual({
        fiveHour: { usedPercentage: 41.5, resetsAt: at(60) },
        sevenDay: null,
        capturedAt: at(0),
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
