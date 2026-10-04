import { relativeTime, type SessionView, type TaskRecord } from '@aoe-supercharge/core/shared';
import { Link } from 'wouter';
import { LiveStatus, MrBadge, StageBadge, StageStepper } from '@/components/status';
import { useNow } from '@/lib/theme';
import { cn } from '@/lib/utils';

export function WorkerList({
  project,
  tasks,
  sessions,
  changed,
  showDone,
}: {
  project: string;
  tasks: TaskRecord[];
  sessions: Map<string, SessionView>;
  changed: Record<string, number>;
  showDone: boolean;
}) {
  const now = useNow();
  const visible = tasks.filter((t) => showDone || t.stage !== 'done');
  if (!visible.length) {
    return (
      <div className="rounded-xl border border-dashed border-border-strong px-6 py-10 text-center">
        <div className="text-base font-medium">No workers yet</div>
        <p className="mx-auto mt-1 max-w-md text-[0.9375rem] text-muted-foreground">
          Ask this project’s control chat for work, or create a task yourself. Each task gets its own branch,
          worktree and worker session.
        </p>
      </div>
    );
  }
  return (
    <ul
      className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card"
      aria-label="Workers"
    >
      {visible.map((t) => {
        const s = sessions.get(t.aoeSessionId);
        const flash = changed[t.id] && Date.now() - changed[t.id]! < 2000;
        return (
          <li key={`${t.id}-${flash ? changed[t.id] : 0}`} className={cn(flash && 'flash')}>
            {/* Stretched link: the title link covers the whole row; the MR link sits above it. */}
            <div className="relative grid w-full grid-cols-1 items-center gap-x-6 gap-y-2 px-5 py-3.5 text-left transition-colors hover:bg-raised/70 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1.3fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1.1fr)_minmax(0,0.75fr)_minmax(0,1.5fr)_3.5rem]">
              <span className="min-w-0">
                <Link
                  href={`/p/${project}/t/${t.id}`}
                  className="flex items-baseline gap-2 rounded-sm after:absolute after:inset-0 after:content-[''] hover:underline"
                >
                  <span
                    translate="no"
                    className="shrink-0 font-mono text-[0.875rem] whitespace-nowrap text-muted-foreground"
                  >
                    {t.id}
                  </span>
                  <span className="min-w-0 truncate text-[0.9375rem] font-medium">{t.title}</span>
                </Link>
                <span
                  translate="no"
                  className="block truncate font-mono text-[0.8125rem] text-muted-foreground"
                >
                  {t.branch}
                </span>
              </span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                <StageStepper stage={t.stage} blockedFrom={t.blockedFrom} />
                <StageBadge stage={t.stage} size="sm" />
              </span>
              <span className="min-w-0">
                <LiveStatus status={s?.status ?? 'missing'} unread={s?.unread} />
              </span>
              <span className="relative z-10 min-w-0 justify-self-start">
                <MrBadge mr={t.mr} />
              </span>
              <span
                className="tabular text-sm text-muted-foreground xl:text-right"
                title={new Date(t.updatedAt).toLocaleString()}
              >
                {relativeTime(t.updatedAt, now)}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
