import { describe, expect, it } from 'vitest';
import { nextRunAt } from '../src/shared/schedule.ts';

const TZ = 'Europe/Stockholm';
const next = (time: string, after: string, days: 'daily' | 'weekdays' = 'daily') =>
  nextRunAt({ time, days }, new Date(after), TZ).toISOString();

describe('nextRunAt: the next time a scheduled prompt is due', () => {
  it('is later today, or tomorrow once the time has passed', () => {
    expect(next('09:00', '2026-06-10T05:00:00Z')).toBe('2026-06-10T07:00:00.000Z');
    expect(next('09:00', '2026-06-10T07:00:00Z')).toBe('2026-06-11T07:00:00.000Z');
    expect(next('00:00', '2026-06-10T21:59:00Z')).toBe('2026-06-10T22:00:00.000Z');
  });

  it('skips Saturday and Sunday on weekdays', () => {
    // Friday 2026-06-12 after 09:00 → Monday the 15th.
    expect(next('09:00', '2026-06-12T08:00:00Z', 'weekdays')).toBe('2026-06-15T07:00:00.000Z');
    expect(next('09:00', '2026-06-12T08:00:00Z')).toBe('2026-06-13T07:00:00.000Z');
  });

  it('keeps local midnight across the spring-forward night (23 h day)', () => {
    // 00:00 CET on 29 March, then 00:00 CEST on 30 March.
    const first = next('00:00', '2026-03-28T22:00:00Z');
    expect(first).toBe('2026-03-28T23:00:00.000Z');
    expect(next('00:00', first)).toBe('2026-03-29T22:00:00.000Z');
  });

  it('fires a time the clocks skip right after the jump', () => {
    // 02:30 doesn't happen on 29 March: it goes at 03:30 CEST.
    expect(next('02:30', '2026-03-28T23:00:00Z')).toBe('2026-03-29T01:30:00.000Z');
    expect(next('03:30', '2026-03-28T23:00:00Z')).toBe('2026-03-29T01:30:00.000Z');
  });

  it('keeps local midnight across the fall-back night (25 h day)', () => {
    expect(next('00:00', '2026-10-24T22:00:00Z')).toBe('2026-10-25T23:00:00.000Z');
  });

  it('fires a time that happens twice only once, the first time', () => {
    const first = next('02:30', '2026-10-24T23:00:00Z');
    expect(first).toBe('2026-10-25T00:30:00.000Z');
    // From the first 02:30, the next is the following day, not the second 02:30 an hour later.
    expect(next('02:30', first)).toBe('2026-10-26T01:30:00.000Z');
  });

  it('works in a zone west of UTC', () => {
    expect(
      nextRunAt(
        { time: '23:30', days: 'daily' },
        new Date('2026-06-10T12:00:00Z'),
        'America/New_York',
      ).toISOString(),
    ).toBe('2026-06-11T03:30:00.000Z');
  });
});
