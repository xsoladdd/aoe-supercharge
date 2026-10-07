import { CoinsIcon, WarningIcon } from '@phosphor-icons/react';
import {
  costTotals,
  formatTokens,
  formatUsd,
  PRICES_CHECKED,
  RUNAWAY_LABEL,
  runaways,
  type SessionCost,
  type SpendTotal,
} from '@aoe-supercharge/core/shared';
import type { OfficeModel, OfficeWorker } from '@/lib/office';
import { cn } from '@/lib/utils';

/** What every cost figure means, for titles and screen readers. */
export const ESTIMATE_NOTE = `Estimate: tokens from Claude Code's transcripts, priced at Claude API rates (checked ${PRICES_CHECKED}). On a Claude plan this is the API-equivalent value, not a bill.`;

function spendText(s: SpendTotal): string {
  if (!s.tokens) return '$0.00';
  const usd = formatUsd(s.usd);
  return s.unpricedTokens ? `${usd} + ${formatTokens(s.unpricedTokens)} tokens unpriced` : usd;
}

/**
 * The office's spend in the header (SPEC §14.5): today (since local midnight) and now (the live
 * conversations of everyone on the floor), labelled as an estimate, and who needs attention.
 */
export function CostSummary({
  office,
  onAttention,
}: {
  office: OfficeModel;
  onAttention?: (key: string) => void;
}) {
  const costs = office.everyone.map((w) => w.cost).filter((c): c is SessionCost => !!c);
  const totals = costTotals(costs);
  const flagged = runaways(office);
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span
        className="tabular inline-flex items-center gap-1.5 text-sm text-muted-foreground"
        title={ESTIMATE_NOTE}
        data-office-cost
      >
        <CoinsIcon className="size-4" aria-hidden />
        <span>
          Today {spendText(totals.today)} · now {spendText(totals.now)}{' '}
          <span className="text-[0.8125rem]">(estimate)</span>
        </span>
      </span>
      {flagged.length > 0 && (
        <button
          type="button"
          data-attention={flagged.length}
          onClick={() => onAttention?.(flagged[0]!.key)}
          className="tint inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[0.8125rem] font-semibold text-st-red"
          title={flagged.map((w) => `${w.name}: ${runawayText(w.cost!)}`).join('\n')}
        >
          <WarningIcon weight="bold" className="size-4" aria-hidden />
          {flagged.length} {flagged.length === 1 ? 'needs' : 'need'} attention
        </button>
      )}
    </span>
  );
}

export const runawayText = (c: SessionCost) => c.runaway.map((r) => RUNAWAY_LABEL[r]).join(', ');

/** A worker's spend in a list row: "≈ $1.20 · 2.3M tokens", and the runaway flag. */
export function CostLine({ w, className }: { w: OfficeWorker; className?: string }) {
  const c = w.cost;
  if (!c || !c.total.tokens) return null;
  return (
    <span
      className={cn('tabular inline-flex items-center gap-2 text-[0.8125rem]', className)}
      title={ESTIMATE_NOTE}
    >
      {c.runaway.length > 0 && (
        <span
          className="inline-flex items-center gap-1 font-semibold text-st-red"
          data-runaway={c.runaway.join(',')}
        >
          <WarningIcon weight="bold" className="size-3.5" aria-hidden />
          {runawayText(c)}
        </span>
      )}
      <span className="text-muted-foreground" data-cost={c.total.usd ?? ''}>
        {c.total.usd === null ? '' : `${formatUsd(c.total.usd)} · `}
        {formatTokens(c.total.tokens)} tokens
      </span>
    </span>
  );
}
