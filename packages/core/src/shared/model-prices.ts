/**
 * What Claude's tokens would cost on the Claude API, per model, for the office's cost meter
 * (SPEC §14.5). An **estimate**: on a Claude plan this is the API-equivalent value, not a bill.
 *
 * Checked against https://platform.claude.com/docs/en/about-claude/pricing on 2026-10-07 (Claude API,
 * first party, global routing). Keep this the one place prices live; check it again when models change.
 * A model not listed here shows tokens only, never a guessed price.
 */

export interface ModelPrice {
  /** US dollars per million tokens. */
  input: number;
  output: number;
  /** Cache reads (hits and refreshes). Writes are 1.25x input (5 minutes) and 2x input (1 hour). */
  cacheRead: number;
  /** Fast mode (`usage.speed: "fast"`), where the model has it: input and output; cache multipliers apply on top. */
  fast?: { input: number; output: number };
}

export const PRICES_CHECKED = '2026-10-07';

/** By model id prefix: the longest matching prefix wins, so a dated or suffixed id still finds its row. */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, fast: { input: 8, output: 40 } },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, fast: { input: 10, output: 50 } },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, fast: { input: 10, output: 50 } },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};

/** Tokens of one reply, or a sum of them, by kind. */
export interface TokenUsage {
  input: number;
  /** Written to the 5-minute cache, and to the 1-hour cache. */
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

export const NO_TOKENS: TokenUsage = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };

export const totalTokens = (u: TokenUsage) =>
  u.input + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead + u.output;

export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
  };
}

/** The price row for a model id, or null when it is not in the table. */
export function priceFor(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const id = model.toLowerCase().replace(/\[.*\]$/, '');
  let best: string | null = null;
  for (const key of Object.keys(MODEL_PRICES))
    if (
      (id === key || id.startsWith(`${key}-`) || id.startsWith(`${key}@`)) &&
      (!best || key.length > best.length)
    )
      best = key;
  return best ? MODEL_PRICES[best]! : null;
}

/**
 * The estimated cost of `u` on `model`, in US dollars, or null when the model has no price. Fast
 * mode uses the model's fast rates (when it has them) with the cache multipliers on top.
 */
export function costOf(
  u: TokenUsage,
  model: string | null | undefined,
  speed?: string | null,
): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const fast = speed === 'fast' && p.fast ? p.fast : null;
  const input = fast?.input ?? p.input;
  const output = fast?.output ?? p.output;
  const read = fast ? (p.cacheRead / p.input) * input : p.cacheRead;
  return (
    (u.input * input +
      u.cacheWrite5m * input * 1.25 +
      u.cacheWrite1h * input * 2 +
      u.cacheRead * read +
      u.output * output) /
    1_000_000
  );
}

/** "≈ $1.24", "≈ $0.08", "< $0.01". */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return '< $0.01';
  return `≈ $${usd < 100 ? usd.toFixed(2) : Math.round(usd).toLocaleString('en-US')}`;
}

/** "812", "48k", "2.3M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}
