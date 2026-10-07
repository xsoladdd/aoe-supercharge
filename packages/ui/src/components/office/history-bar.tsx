import {
  ArrowLeftIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CircleNotchIcon,
  PauseIcon,
  PlayIcon,
} from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { HISTORY_RANGES, SPEEDS, type HistoryPlayer } from '@/lib/office-history';
import { cn } from '@/lib/utils';

const SELECT =
  'h-8 rounded-md border border-border-strong bg-background px-2 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

/** "Tue 7 Oct, 14:05:12" in your time zone. */
export function historyTime(t: number): string {
  return new Date(t).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}

/**
 * The history mode controls (SPEC §14.5): Back to Live (always there), play or pause at 1x, 10x or
 * 60x, a scrubber over the range, a step to the previous or next change, and filters by project and
 * agent.
 */
export function HistoryBar({ player: p, onLive }: { player: HistoryPlayer; onLive: () => void }) {
  const prev = [...p.times].reverse().find((t) => t < p.at - 999);
  const next = p.times.find((t) => t > p.at);
  return (
    <div
      role="region"
      aria-label="Office history"
      data-history-bar
      data-at={p.to ? new Date(p.at).toISOString() : ''}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface px-4 py-2 lg:px-6"
    >
      <Button variant="gradient" size="sm" onClick={onLive} data-back-to-live>
        <ArrowLeftIcon />
        Back to Live
      </Button>
      <span className="rounded-full bg-st-violet/14 px-2.5 py-1 text-[0.8125rem] font-semibold text-st-violet">
        History
      </span>
      {p.error ? (
        <span role="alert" className="text-sm text-st-red">
          {p.error}
        </span>
      ) : p.loading ? (
        <span className="inline-flex items-center gap-2 text-sm text-muted-foreground" aria-busy="true">
          <CircleNotchIcon className="size-4 animate-spin" aria-hidden />
          Reading the history…
        </span>
      ) : (
        <>
          <span className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Previous change"
              disabled={prev === undefined}
              onClick={() => prev !== undefined && p.setAt(prev)}
            >
              <CaretLeftIcon />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={p.playing ? 'Pause' : 'Play'}
              aria-pressed={p.playing}
              onClick={() => p.setPlaying(!p.playing)}
              data-play
            >
              {p.playing ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Next change"
              disabled={next === undefined}
              onClick={() => next !== undefined && p.setAt(next)}
            >
              <CaretRightIcon />
            </Button>
          </span>
          <span role="group" aria-label="Speed" className="flex rounded-lg border border-border p-0.5">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={p.speed === s}
                onClick={() => p.setSpeed(s)}
                className={cn(
                  'tabular h-7 min-w-9 rounded-md px-2 text-[0.8125rem] font-semibold',
                  p.speed === s
                    ? 'bg-raised text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {s}×
              </button>
            ))}
          </span>
          <input
            type="range"
            aria-label="Time"
            aria-valuetext={historyTime(p.at)}
            min={p.from}
            max={p.to}
            step={1000}
            value={p.at}
            onChange={(e) => {
              p.setPlaying(false);
              p.setAt(Number(e.target.value));
            }}
            className="h-8 min-w-48 flex-1 accent-[var(--color-primary)]"
            data-scrubber
          />
          <output className="tabular min-w-44 text-sm font-medium" data-history-time>
            {historyTime(p.at)}
          </output>
        </>
      )}
      <span className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Range"
          className={SELECT}
          value={p.hours}
          onChange={(e) => p.setHours(Number(e.target.value))}
        >
          {HISTORY_RANGES.map((r) => (
            <option key={r.hours} value={r.hours}>
              {r.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Project"
          className={SELECT}
          value={p.filter.project ?? ''}
          onChange={(e) => p.setFilter({ project: e.target.value || null, key: null })}
        >
          <option value="">All projects</option>
          {p.projects.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select
          aria-label="Agent"
          className={SELECT}
          value={p.filter.key ?? ''}
          onChange={(e) => p.setFilter({ ...p.filter, key: e.target.value || null })}
        >
          <option value="">All agents</option>
          {p.people.map((who) => (
            <option key={who.key} value={who.key}>
              {who.name} ({who.project})
            </option>
          ))}
        </select>
      </span>
    </div>
  );
}
