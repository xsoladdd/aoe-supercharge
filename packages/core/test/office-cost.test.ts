import { describe, expect, it } from 'vitest';
import {
  costOf,
  costTotals,
  formatTokens,
  formatUsd,
  meterFill,
  NO_TOKENS,
  priceFor,
  runawayReasons,
  summarizeCost,
  type RunawayLimits,
  type UsageEntry,
} from '../src/shared/index.ts';

const NOW = new Date('2026-10-06T15:00:00');
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const entry = (
  id: string,
  at: string,
  usage: Partial<typeof NO_TOKENS>,
  model = 'claude-opus-5-5',
): UsageEntry => ({
  id,
  at,
  model,
  speed: null,
  usage: { ...NO_TOKENS, ...usage },
});
const LIMITS: RunawayLimits = { sessionTokens: 1_000_000, usdPerHour: 5, stallMinutes: 30 };

describe('model prices', () => {
  it('finds the row by the longest id prefix, and none for an unknown model', () => {
    expect(priceFor('claude-opus-5-5')?.input).toBe(4);
    expect(priceFor('claude-opus-5')?.input).toBe(5);
    expect(priceFor('claude-opus-5-20260101')?.input).toBe(5);
    expect(priceFor('claude-sonnet-5-5[1m]')?.output).toBe(10);
    expect(priceFor('claude-haiku-4-5')?.cacheRead).toBe(0.1);
    expect(priceFor('gpt-something')).toBeNull();
    expect(priceFor(null)).toBeNull();
  });

  it('prices input, both cache writes, cache reads and output; fast mode on its own rates', () => {
    const u = {
      input: 1_000_000,
      cacheWrite5m: 1_000_000,
      cacheWrite1h: 1_000_000,
      cacheRead: 1_000_000,
      output: 1_000_000,
    };
    // Opus 5.5: 4 + 5 + 8 + 0.20 + 20.
    expect(costOf(u, 'claude-opus-5-5')).toBeCloseTo(37.2, 6);
    // Fast: 8 + 10 + 16 + 0.40 (the same 0.05x read) + 40.
    expect(costOf(u, 'claude-opus-5-5', 'fast')).toBeCloseTo(74.4, 6);
    // A model without fast mode stays on its standard rates.
    expect(costOf(u, 'claude-sonnet-5-5', 'fast')).toBe(costOf(u, 'claude-sonnet-5-5'));
    expect(costOf(u, 'mystery-model')).toBeNull();
  });

  it('formats estimates and token counts', () => {
    expect(formatUsd(1.234)).toBe('≈ $1.23');
    expect(formatUsd(0.004)).toBe('< $0.01');
    expect(formatUsd(1234)).toBe('≈ $1,234');
    expect([
      formatTokens(812),
      formatTokens(48_200),
      formatTokens(2_340_000),
      formatTokens(51_000_000),
    ]).toEqual(['812', '48k', '2.3M', '51M']);
  });
});

describe('office cost', () => {
  it('sums the conversation, today (since local midnight) and the last hour', () => {
    const yesterday = new Date(NOW);
    yesterday.setDate(yesterday.getDate() - 1);
    const c = summarizeCost(
      's1',
      [
        entry('a', yesterday.toISOString(), { output: 1_000_000 }),
        entry('b', minAgo(120), { input: 1_000_000 }),
        entry('c', minAgo(10), { input: 500_000 }),
      ],
      NOW,
      null,
    );
    expect(c.total).toEqual({ tokens: 2_500_000, usd: 20 + 4 + 2 });
    expect(c.today).toEqual({ tokens: 1_500_000, usd: 6 });
    expect(c.lastHour).toEqual({ tokens: 500_000, usd: 2 });
    expect(c.firstAt).toBe(yesterday.toISOString());
    expect(c.lastAt).toBe(minAgo(10));
  });

  it('an unpriced model shows tokens only, and the floor totals keep them apart', () => {
    const known = summarizeCost('a', [entry('1', minAgo(5), { input: 1_000_000 })], NOW, null);
    const unknown = summarizeCost('b', [entry('2', minAgo(5), { input: 300 }, 'mystery-model')], NOW, null);
    expect(unknown.total).toEqual({ tokens: 300, usd: null });
    expect(costTotals([known, unknown]).now).toEqual({ tokens: 1_000_300, usd: 4, unpricedTokens: 300 });
  });

  it('flags a runaway: over the token limit, spending fast, or burning with no progress', () => {
    const big = summarizeCost('s', [entry('1', minAgo(1), { cacheRead: 2_000_000 })], NOW, minAgo(1));
    expect(runawayReasons(big, true, LIMITS, NOW)).toEqual(['tokens']);
    const pricey = summarizeCost('s', [entry('1', minAgo(20), { output: 300_000 })], NOW, minAgo(1));
    expect(runawayReasons(pricey, false, LIMITS, NOW)).toEqual(['spend']);
    // Working, replying a minute ago, nothing changed for 45 minutes.
    const stuck = summarizeCost(
      's',
      [entry('1', minAgo(50), { input: 100 }), entry('2', minAgo(1), { input: 100 })],
      NOW,
      minAgo(45),
    );
    expect(runawayReasons(stuck, true, LIMITS, NOW)).toEqual(['stall']);
    // Not working, or not spending lately, or progress recently: no stall.
    expect(runawayReasons(stuck, false, LIMITS, NOW)).toEqual([]);
    expect(runawayReasons({ ...stuck, progressAt: minAgo(5) }, true, LIMITS, NOW)).toEqual([]);
    expect(runawayReasons({ ...stuck, lastAt: minAgo(10) }, true, LIMITS, NOW)).toEqual([]);
    // No progress ever: counted from its first reply.
    expect(runawayReasons({ ...stuck, progressAt: null }, true, LIMITS, NOW)).toEqual(['stall']);
    // 0 turns a check off.
    expect(runawayReasons(big, true, { ...LIMITS, sessionTokens: 0 }, NOW)).toEqual([]);
    expect(runawayReasons(stuck, true, { ...LIMITS, stallMinutes: 0 }, NOW)).toEqual([]);
  });

  it('fills the meter towards the token limit', () => {
    const c = { total: { tokens: 250_000, usd: 1 } };
    expect(meterFill(c, { sessionTokens: 1_000_000 })).toBe(0.25);
    expect(meterFill({ total: { tokens: 9e9, usd: 1 } }, { sessionTokens: 1_000_000 })).toBe(1);
    expect(meterFill(c, { sessionTokens: 0 })).toBe(0.05);
  });
});
