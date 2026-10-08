import { BroomIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { ago, formatTokens, prettyModel, type ContextInfo } from '@aoe-supercharge/core/shared';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/** "200k", "1M", "312k". */
const tokens = (n: number) => (n >= 1_000_000 && n % 1_000_000 === 0 ? `${n / 1_000_000}M` : formatTokens(n));
const exact = (n: number) => n.toLocaleString('en-US');

const tone = (pct: number) =>
  pct >= 85 ? 'text-st-red' : pct >= 60 ? 'text-st-yellow' : 'text-muted-foreground';
const bar = (pct: number) => (pct >= 85 ? 'bg-st-red' : pct >= 60 ? 'bg-st-yellow' : 'bg-st-blue');

/** When Claude Code compacts: Supercharge's window for the sessions it starts, else Claude Code's own. */
function autoCompactLine(c: ContextInfo): string {
  if (c.autoCompactWindow === null)
    return "Claude Code's own setting: by default it compacts shortly before the window fills.";
  const at = Math.min(c.window, c.autoCompactWindow);
  if (c.autoCompactWindow >= c.window)
    return `Claude Code compacts shortly before the ${tokens(c.window)} window fills. Supercharge's ${tokens(c.autoCompactWindow)} auto-compact window is above it.`;
  return `Supercharge starts this session with a ${tokens(c.autoCompactWindow)} auto-compact window: Claude Code compacts shortly before ${tokens(at)}.`;
}

/**
 * How full the session's context is, as a small ring like Claude Code's own meter. Click it for the
 * figures behind it: Claude Code's own when its status line has reported them, else an estimate from
 * the transcript.
 */
export function ContextMeter({
  context,
  onStartFresh,
}: {
  context: ContextInfo | null;
  onStartFresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!context) return null;
  const { used, window, percent } = context;
  const r = 6.5;
  const c = 2 * Math.PI * r;
  const model = context.modelName ?? (context.model ? prettyModel(context.model) : null);
  const last = context.lastRequest;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        aria-label={`Context: ${percent}% of the window used. Show details`}
        className={cn(
          'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-xs tabular transition hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
          tone(percent),
        )}
      >
        <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden>
          <circle
            cx="8"
            cy="8"
            r={r}
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.25"
            strokeWidth="2.5"
          />
          <circle
            cx="8"
            cy="8"
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeDasharray={`${(percent / 100) * c} ${c}`}
            strokeLinecap="round"
          />
        </svg>
        <span aria-hidden>{percent}%</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-0" aria-label="Context details">
        <div className="space-y-3 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold">Context</h2>
            {model && (
              <span className="truncate text-xs text-muted-foreground" translate="no">
                {model}
              </span>
            )}
          </div>
          <div className="space-y-1.5">
            <p className="text-sm tabular">
              <span className="font-medium">{tokens(used)}</span>
              <span className="text-muted-foreground"> of {tokens(window)} tokens · </span>
              <span className={cn('font-medium', tone(percent))}>{percent}%</span>
            </p>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-muted"
              role="meter"
              aria-label="Context used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div className={cn('h-full rounded-full', bar(percent))} style={{ width: `${percent}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">
              {context.compacted
                ? "Compacted. What's left after compacting; the figures update after Claude's next reply."
                : context.source === 'claude'
                  ? `From Claude Code, ${ago(context.at)}.`
                  : 'Estimated from the transcript.'}
            </p>
          </div>
          {last && !context.compacted && (
            <div>
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">Last request</h3>
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-sm tabular">
                <dt>Input</dt>
                <dd className="text-right">{exact(last.input)}</dd>
                <dt>Cache read</dt>
                <dd className="text-right">{exact(last.cacheRead)}</dd>
                <dt>Cache write</dt>
                <dd className="text-right">{exact(last.cacheWrite)}</dd>
                <dt>Output</dt>
                <dd className="text-right">{exact(last.output)}</dd>
              </dl>
            </div>
          )}
          <div>
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">Auto-compact</h3>
            <p className="text-sm text-pretty">{autoCompactLine(context)}</p>
          </div>
          <p className="text-xs text-pretty text-muted-foreground">
            A breakdown by system prompt, tools, MCP and memory isn't in the transcript. Run{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-[0.75rem]" translate="no">
              /context
            </code>{' '}
            in the Terminal tab for it.
          </p>
        </div>
        <div className="flex justify-end border-t border-border px-3 py-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => {
              setOpen(false);
              onStartFresh();
            }}
          >
            <BroomIcon className="size-4" aria-hidden />
            Start fresh
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
