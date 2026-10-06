import { BroadcastIcon, ChatCircleTextIcon, ChatTeardropTextIcon } from '@phosphor-icons/react';
import { relativeTime, STAGE_LABEL, type Stage } from '@aoe-supercharge/core/shared';
import { Link } from 'wouter';
import { useSessionHref } from '@/lib/nav';
import { LiveStatus, STAGE_META } from '@/components/status';
import { Button } from '@/components/ui/button';
import type { ProjectView } from '@/lib/derive';
import { useNow } from '@/lib/theme';
import { cn } from '@/lib/utils';

const ORDER: Stage[] = [
  'planning',
  'implementing',
  'verifying',
  'mr_raised',
  'watching_mr',
  'ready_for_review',
  'blocked',
  'done',
];

/** The control (parent) chat's status box: live status plus a rollup of its children (SPEC §14.1). */
export function ControlBox({ view, remoteControl }: { view: ProjectView; remoteControl: boolean }) {
  const now = useNow();
  const sessionHref = useSessionHref();
  const { control, tasks, counts, project } = view;
  const active = tasks.filter((t) => t.stage !== 'done');
  const done = counts.done;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const blocked = tasks
    .filter((t) => t.stage === 'blocked' && t.openQuestion)
    .sort((a, b) => a.openQuestion!.askedAt.localeCompare(b.openQuestion!.askedAt))[0];
  const ready = tasks.filter((t) => t.stage === 'ready_for_review');

  return (
    <section aria-labelledby="control-heading" className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-border px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-raised">
            <ChatTeardropTextIcon className="size-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id="control-heading" className="text-base font-semibold">
              Control chat
            </h2>
            {project.controlSessionId ? (
              <Link
                translate="no"
                href={sessionHref(project.controlSessionId)}
                className="font-mono text-[0.8125rem] text-muted-foreground hover:text-foreground hover:underline"
              >
                {project.controlSessionId}
              </Link>
            ) : (
              <span className="text-[0.8125rem] text-muted-foreground">No session</span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <LiveStatus
            status={control?.status ?? 'missing'}
            unread={control?.unread}
            className="text-[0.9375rem]"
          />
          <span
            className={cn(
              'inline-flex items-center gap-1.5 text-[0.9375rem]',
              remoteControl ? 'text-st-green' : 'text-muted-foreground',
            )}
          >
            <BroadcastIcon weight="bold" className="size-4" aria-hidden />
            Remote Control {remoteControl ? 'on' : 'off'}
          </span>
          {project.controlSessionId && (
            <Button variant="secondary" asChild>
              <Link href={sessionHref(project.controlSessionId)}>
                <ChatCircleTextIcon weight="bold" />
                Open chat
              </Link>
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-5 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
        <div>
          <div className="flex items-end gap-3">
            <span className="tabular text-[2rem] leading-none font-semibold tracking-[-0.02em]">{pct}%</span>
            <span className="pb-0.5 text-[0.9375rem] text-muted-foreground">
              {done} of {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'} done, {active.length} active
            </span>
          </div>
          <div
            className="mt-3 h-1.5 overflow-hidden rounded-full bg-raised"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Tasks done"
          >
            <div
              className="h-full origin-left rounded-full bg-progress transition-transform"
              style={{ transform: `scaleX(${pct / 100})` }}
            />
          </div>
          <dl className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2">
            {ORDER.map((s) => {
              const { icon: I, color } = STAGE_META[s];
              return (
                <div
                  key={s}
                  className="flex items-center justify-between gap-2 rounded-md bg-raised/60 px-3 py-2"
                >
                  {/* Zero counts are quieter via muted colour, never opacity (keeps AA contrast). */}
                  <dt
                    className={cn(
                      'flex min-w-0 items-center gap-1.5 text-sm',
                      counts[s] === 0 ? 'text-muted-foreground' : color,
                    )}
                  >
                    <I weight="bold" className="size-4 shrink-0" aria-hidden />
                    <span
                      className={cn(
                        'truncate',
                        counts[s] === 0 ? 'text-muted-foreground' : 'text-foreground',
                      )}
                    >
                      {STAGE_LABEL[s]}
                    </span>
                  </dt>
                  <dd
                    className={cn(
                      'tabular text-base font-semibold',
                      counts[s] === 0 && 'text-muted-foreground',
                    )}
                  >
                    {counts[s]}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
        <div className="flex flex-col gap-3 text-[0.9375rem]">
          <div className="rounded-md border border-border px-3.5 py-3">
            <div className="text-sm text-muted-foreground">Oldest blocked</div>
            {blocked ? (
              <Link href={`/p/${project.name}/t/${blocked.id}`} className="mt-0.5 block hover:underline">
                <span className="font-mono text-[0.875rem]">{blocked.id}</span>, waiting{' '}
                {relativeTime(blocked.openQuestion!.askedAt, now)}
                <span className="mt-0.5 line-clamp-2 block text-sm text-muted-foreground">
                  {blocked.openQuestion!.text}
                </span>
              </Link>
            ) : (
              <div className="mt-0.5">Nothing blocked</div>
            )}
          </div>
          <div className="rounded-md border border-border px-3.5 py-3">
            <div className="text-sm text-muted-foreground">Ready for review</div>
            {ready.length ? (
              <ul className="mt-0.5 space-y-0.5">
                {ready.map((t) => (
                  <li key={t.id}>
                    <Link href={`/p/${project.name}/t/${t.id}`} className="hover:underline">
                      {t.name && <span className="font-medium">{t.name} </span>}
                      <span className="font-mono text-[0.875rem]">{t.id}</span> {t.mr ? `!${t.mr.iid}` : ''}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-0.5">No MRs ready yet</div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
