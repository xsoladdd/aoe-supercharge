import {
  ArrowSquareInIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  DoorIcon,
  GitPullRequestIcon,
  HandWavingIcon,
  XCircleIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  awayHeadline,
  awaySummary,
  formatTokens,
  formatUsd,
  taskPath,
  type AwayKind,
  type HistoryWindow,
} from '@aoe-supercharge/core/shared';
import { ESTIMATE_NOTE } from '@/components/office/cost';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ApiError } from '@/lib/api';
import type { OfficeModel } from '@/lib/office';
import { fetchHistory } from '@/lib/office-history';
import { cn } from '@/lib/utils';

const SEEN_KEY = 'supercharge.office.lastSeen';

/**
 * When you last had the office open, before this visit. The office notes the time every minute while
 * it is open and when you leave; until it has a note, it is 8 hours ago.
 */
function useLastVisit(): number {
  const [previous] = useState(() => {
    try {
      const v = Number(localStorage.getItem(SEEN_KEY));
      return Number.isFinite(v) && v > 0 && v < Date.now() - 60_000 ? v : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    const note = () => {
      try {
        localStorage.setItem(SEEN_KEY, String(Date.now()));
      } catch {
        // No storage (a private window): the default of 8 hours stands.
      }
    };
    const t = setInterval(note, 60_000);
    window.addEventListener('pagehide', note);
    return () => {
      clearInterval(t);
      window.removeEventListener('pagehide', note);
      note();
    };
  }, []);
  return previous ?? Date.now() - 8 * 60 * 60 * 1000;
}

const KIND: Record<AwayKind, { icon: Icon; color: string }> = {
  arrived: { icon: ArrowSquareInIcon, color: 'text-muted-foreground' },
  finished: { icon: CheckCircleIcon, color: 'text-st-green' },
  mr_raised: { icon: GitPullRequestIcon, color: 'text-st-violet' },
  failed: { icon: XCircleIcon, color: 'text-st-red' },
  needed_you: { icon: DoorIcon, color: 'text-st-yellow' },
};

const clock = (t: number) =>
  new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/**
 * "Since I was away" (SPEC §14.5): what the office did since you last looked, or since a time you
 * pick: who finished, raised an MR, failed or needed you, and roughly what it cost. A standup view.
 */
export function AwaySummaryButton({ office }: { office: OfficeModel }) {
  const lastVisit = useLastVisit();
  const [open, setOpen] = useState(false);
  const [since, setSince] = useState<number | 'visit'>('visit');
  const [data, setData] = useState<{ h: HistoryWindow; from: number; to: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const to = Date.now();
    const start = since === 'visit' ? lastVisit : to - (since as number);
    setData(null);
    setError(null);
    fetchHistory(start, to)
      .then((h) => !cancelled && setData({ h, from: start, to }))
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'The history could not be read.');
      });
    return () => {
      cancelled = true;
    };
  }, [open, since, lastVisit]);

  // The end of the spend is what the meters say now.
  const live = useMemo(
    () =>
      new Map(
        office.everyone.map((w) => [
          w.key,
          w.cost ? { tokens: w.cost.total.tokens, usd: w.cost.total.usd } : null,
        ]),
      ),
    [office],
  );
  const summary = useMemo(
    () => (data ? awaySummary(data.h, data.from, data.to, (k) => live.get(k) ?? undefined) : null),
    [data, live],
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" className="px-3" data-away-button>
          <HandWavingIcon />
          Since I was away
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-lg" data-away-summary>
        <DialogHeader>
          <DialogTitle>Since {data ? clock(data.from) : 'you were away'}</DialogTitle>
          <DialogDescription>
            What the office did while you were away. Spend is an estimate.
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Since</span>
          <select
            aria-label="Since"
            className="h-8 rounded-md border border-border-strong bg-background px-2 text-sm"
            value={String(since)}
            onChange={(e) => setSince(e.target.value === 'visit' ? 'visit' : Number(e.target.value))}
          >
            <option value="visit">My last visit ({clock(lastVisit)})</option>
            <option value={String(60 * 60 * 1000)}>An hour ago</option>
            <option value={String(8 * 60 * 60 * 1000)}>8 hours ago</option>
            <option value={String(24 * 60 * 60 * 1000)}>Yesterday this time</option>
          </select>
        </label>
        {error ? (
          <p role="alert" className="text-sm text-st-red">
            {error}
          </p>
        ) : !summary ? (
          <p className="inline-flex items-center gap-2 text-sm text-muted-foreground" aria-busy="true">
            <CircleNotchIcon className="size-4 animate-spin" aria-hidden />
            Reading the history…
          </p>
        ) : (
          <div className="min-h-0 space-y-3 overflow-y-auto">
            <p className="text-[0.9375rem] font-medium" data-away-headline title={ESTIMATE_NOTE}>
              {awayHeadline(summary, formatUsd)}
              {summary.spent.unpricedTokens > 0 &&
                ` (+ ${formatTokens(summary.spent.unpricedTokens)} tokens unpriced)`}
              .
            </p>
            <dl className="tabular grid grid-cols-4 gap-2 text-center" aria-label="Counts">
              {(
                [
                  ['Finished', summary.finished],
                  ['MRs raised', summary.mrsRaised],
                  ['Failed', summary.failed],
                  ['Needed you', summary.neededYou],
                ] as const
              ).map(([label, n]) => (
                <div key={label} className="rounded-lg border border-border px-2 py-2">
                  <dd className="text-lg font-semibold">{n}</dd>
                  <dt className="text-[0.8125rem] text-muted-foreground">{label}</dt>
                </div>
              ))}
            </dl>
            {summary.events.length > 0 && (
              <ol
                className="divide-y divide-border rounded-lg border border-border"
                aria-label="What happened"
              >
                {summary.events.map((e) => {
                  const k = KIND[e.kind];
                  return (
                    <li
                      key={`${e.kind}|${e.key}|${e.ts}`}
                      className="flex items-center gap-2.5 px-3 py-2 text-sm"
                      data-away-event={e.kind}
                    >
                      <k.icon weight="bold" className={cn('size-4 shrink-0', k.color)} aria-hidden />
                      <span className="tabular w-11 shrink-0 text-muted-foreground">
                        {clock(Date.parse(e.ts))}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {e.taskId ? (
                          <Link
                            href={taskPath(e.project, e.taskId)}
                            className="font-medium hover:underline"
                            onClick={() => setOpen(false)}
                          >
                            {e.name}
                          </Link>
                        ) : (
                          <span className="font-medium">{e.name}</span>
                        )}{' '}
                        <span className="text-muted-foreground">
                          {e.text} · {e.project}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
