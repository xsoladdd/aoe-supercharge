import { addTokens, costOf, NO_TOKENS, totalTokens, type TokenUsage } from './model-prices.ts';

/**
 * The office's cost meter and runaway check (SPEC §14.5). Tokens come from each session's live Claude
 * Code conversation, reply by reply; cost is an estimate from the price table. Pure, so the daemon
 * flags and the dashboard shows with the same numbers.
 */

/** One reply's usage, counted once per `message.id`. */
export interface UsageEntry {
  id: string;
  at: string;
  model: string | null;
  /** `usage.speed`: "fast" in fast mode. */
  speed: string | null;
  usage: TokenUsage;
}

export interface Spend {
  tokens: number;
  /** Null when some of it was on a model with no price: tokens only. */
  usd: number | null;
}

export type RunawayReason = 'tokens' | 'spend' | 'stall';

export const RUNAWAY_LABEL: Record<RunawayReason, string> = {
  tokens: 'Over the token limit',
  spend: 'Spending fast',
  stall: 'Burning tokens, no progress',
};

/** A session's spend, as the snapshot carries it (`costs`, by AoE session id). */
export interface SessionCost {
  sessionId: string;
  /** The model of the latest reply. */
  model: string | null;
  /** The whole live conversation. */
  total: Spend;
  /** Since local midnight. */
  today: Spend;
  /** In the last hour. */
  lastHour: Spend;
  /** By kind, for the card. */
  usage: TokenUsage;
  firstAt: string | null;
  lastAt: string | null;
  /** When it last showed progress: changed a file, or its task moved stage. */
  progressAt: string | null;
  /** Why it is flagged as a runaway; empty when it is not. */
  runaway: RunawayReason[];
}

export interface RunawayLimits {
  /** Tokens in one conversation (every kind, cache reads included); 0 is off. */
  sessionTokens: number;
  /** Estimated US dollars in the last hour; 0 is off. */
  usdPerHour: number;
  /** Working, spending, and no progress for this long; 0 is off. */
  stallMinutes: number;
}

const HOUR = 60 * 60 * 1000;

function spend(entries: UsageEntry[]): Spend {
  let tokens = 0;
  let usd: number | null = 0;
  for (const e of entries) {
    tokens += totalTokens(e.usage);
    const c = costOf(e.usage, e.model, e.speed);
    usd = usd === null || c === null ? null : usd + c;
  }
  return { tokens, usd };
}

/** Local midnight before `now`. */
export function startOfDay(now: Date): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function summarizeCost(
  sessionId: string,
  entries: UsageEntry[],
  now: Date,
  progressAt: string | null,
): SessionCost {
  const sorted = [...entries].sort((a, b) => a.at.localeCompare(b.at));
  const day = startOfDay(now);
  const hour = now.getTime() - HOUR;
  return {
    sessionId,
    model: sorted.at(-1)?.model ?? null,
    total: spend(sorted),
    today: spend(sorted.filter((e) => Date.parse(e.at) >= day)),
    lastHour: spend(sorted.filter((e) => Date.parse(e.at) >= hour)),
    usage: sorted.reduce((a, e) => addTokens(a, e.usage), NO_TOKENS),
    firstAt: sorted[0]?.at ?? null,
    lastAt: sorted.at(-1)?.at ?? null,
    progressAt,
    runaway: [],
  };
}

/**
 * Why a session is a runaway, if it is: its conversation is over the token limit, it spent more than
 * the hourly limit in the last hour, or it is working and spending but has shown no progress for
 * `stallMinutes` (no file changed, no stage moved; spending means a reply in the last two minutes).
 */
export function runawayReasons(
  cost: SessionCost,
  working: boolean,
  limits: RunawayLimits,
  now: Date,
): RunawayReason[] {
  const out: RunawayReason[] = [];
  if (limits.sessionTokens > 0 && cost.total.tokens > limits.sessionTokens) out.push('tokens');
  if (limits.usdPerHour > 0 && cost.lastHour.usd !== null && cost.lastHour.usd > limits.usdPerHour)
    out.push('spend');
  if (limits.stallMinutes > 0 && working && cost.lastAt) {
    const t = now.getTime();
    const spending = t - Date.parse(cost.lastAt) <= 2 * 60_000;
    const since = cost.progressAt ?? cost.firstAt;
    const stalled = !!since && t - Date.parse(since) >= limits.stallMinutes * 60_000;
    if (spending && stalled) out.push('stall');
  }
  return out;
}

/** A total over several conversations: dollars for the priced ones, and the tokens left unpriced. */
export interface SpendTotal {
  tokens: number;
  usd: number;
  unpricedTokens: number;
}

/** The floor's totals: the conversations of the characters on it, now and since midnight. */
export function costTotals(costs: SessionCost[]): { now: SpendTotal; today: SpendTotal } {
  const sum = (pick: (c: SessionCost) => Spend): SpendTotal =>
    costs.reduce<SpendTotal>(
      (a, c) => {
        const s = pick(c);
        return {
          tokens: a.tokens + s.tokens,
          usd: a.usd + (s.usd ?? 0),
          unpricedTokens: a.unpricedTokens + (s.usd === null ? s.tokens : 0),
        };
      },
      { tokens: 0, usd: 0, unpricedTokens: 0 },
    );
  return { now: sum((c) => c.total), today: sum((c) => c.today) };
}

/** The meter's fill: the share of the token limit used (0 to 1), or of a nominal 5M without one. */
export function meterFill(
  cost: Pick<SessionCost, 'total'>,
  limits: Pick<RunawayLimits, 'sessionTokens'>,
): number {
  const cap = limits.sessionTokens > 0 ? limits.sessionTokens : 5_000_000;
  return Math.max(0, Math.min(1, cost.total.tokens / cap));
}
