import type { UsageReport, WindowView } from '@aoe-supercharge/core/shared';
import { cn } from '@/lib/utils';

function resets(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const hm = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return new Date().toDateString() === d.toDateString()
    ? hm
    : `${d.toLocaleDateString([], { weekday: 'short' })} ${hm}`;
}

function Bar({ label, w, busyAt, stopAt }: { label: string; w: WindowView; busyAt: number; stopAt: number }) {
  const used = w.usedPercentage;
  const tone =
    used === null
      ? 'bg-st-muted'
      : used >= stopAt
        ? 'bg-st-red'
        : used >= busyAt
          ? 'bg-st-yellow'
          : 'bg-st-green';
  return (
    <div className="grid grid-cols-[3.25rem_minmax(0,1fr)_2.25rem] items-center gap-1.5">
      <span>{label}</span>
      <div
        {...(used === null
          ? { 'aria-hidden': true }
          : {
              role: 'meter',
              'aria-label': `${label} usage`,
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': used,
              'aria-valuetext': `${used}%${w.resetsAt ? `, resets ${resets(w.resetsAt)}` : w.reset ? ', reset since' : ''}`,
            })}
        className="relative h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${used ?? 0}%` }} />
        <div
          aria-hidden
          className="absolute inset-y-0 w-px bg-foreground/30"
          style={{ left: `${busyAt}%` }}
        />
      </div>
      <span className="text-right tabular-nums">
        {used === null ? (
          <>
            <span aria-hidden>?</span>
            <span className="sr-only">unknown</span>
          </>
        ) : (
          `${used}%`
        )}
      </span>
    </div>
  );
}

/**
 * Your 5-hour and weekly Claude usage as Supercharge sessions last reported it, and how many more
 * workers may start. The tick on each bar is where fewer workers run at once.
 */
export function UsageMeter({ usage }: { usage: UsageReport | null }) {
  if (!usage) return null;
  const { limits } = usage;
  const workers =
    usage.level === 'off'
      ? `${usage.activeWorkers} active workers · limits off`
      : `${usage.activeWorkers} of ${usage.maxWorkers} workers active`;
  return (
    <section
      aria-label="Claude usage"
      title={usage.advice}
      className="space-y-1 px-2 pb-1.5 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden"
    >
      <Bar label="5-hour" w={usage.fiveHour} busyAt={limits.fiveHourBusyAt} stopAt={limits.fiveHourStopAt} />
      <Bar label="Week" w={usage.sevenDay} busyAt={limits.weeklyBusyAt} stopAt={limits.weeklyStopAt} />
      <p
        className={cn(
          'leading-snug',
          usage.level === 'stop' && 'text-st-red',
          usage.level === 'busy' && 'text-st-yellow',
        )}
      >
        {!usage.known
          ? 'No usage reading yet'
          : usage.level === 'stop'
            ? 'Limit nearly used: no new workers'
            : workers}
        {usage.known && usage.fiveHour.resetsAt && (
          <span className="block text-muted-foreground">5-hour resets {resets(usage.fiveHour.resetsAt)}</span>
        )}
      </p>
    </section>
  );
}
