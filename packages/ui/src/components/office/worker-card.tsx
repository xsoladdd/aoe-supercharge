import {
  ArrowSquareOutIcon,
  ChatTeardropTextIcon,
  CrosshairSimpleIcon,
  GitMergeIcon,
  KanbanIcon,
  XIcon,
} from '@phosphor-icons/react';
import { Link } from 'wouter';
import { DRESS_CODE_LABEL, relativeTime, ZONE_LABEL } from '@aoe-supercharge/core/shared';
import { PromptCard, TaskAsks } from '@/components/answer';
import { Avatar } from '@/components/office/avatar';
import { Reason } from '@/components/office/roster';
import { LiveStatus, StageBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { chatHref } from '@/lib/nav';
import type { OfficeModel, OfficeWorker } from '@/lib/office';
import { cn } from '@/lib/utils';

function where(w: OfficeWorker, office: OfficeModel): string {
  if (w.zone === 'door') {
    const n = office.door.findIndex((x) => x.key === w.key) + 1;
    return n ? `Number ${n} at your door` : ZONE_LABEL.door;
  }
  if (w.zone === 'desk')
    return w.role === 'lead' ? 'At the lead desk' : w.desk ? `At desk ${w.desk}` : 'In the team walkway';
  return ZONE_LABEL[w.zone];
}

/**
 * The card for the worker you picked on the floor: who it is, why it is where it is, and what you
 * can do about it. A worker at your door brings its question, so you can answer without leaving.
 */
export function WorkerCard({
  w,
  office,
  now,
  following,
  called,
  onFollow,
  onClose,
}: {
  w: OfficeWorker;
  office: OfficeModel;
  now: Date;
  following: boolean;
  /** You called this worker in through your door. */
  called: boolean;
  onFollow: () => void;
  onClose: () => void;
}) {
  const sessionId = w.session?.id ?? w.task?.aoeSessionId ?? null;
  const mr = w.task?.mr ?? null;
  return (
    <section
      aria-labelledby="worker-card-name"
      data-worker-card={w.key}
      className="pointer-events-auto flex max-h-full w-[min(25rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-lg"
    >
      <header className="flex items-start gap-3 border-b border-border px-4 py-3">
        <span title={DRESS_CODE_LABEL[w.outfit.dressCode]} className="shrink-0">
          <Avatar outfit={w.outfit} className="size-12" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="worker-card-name" className="flex items-baseline gap-2 text-base font-semibold">
            <span className="truncate">{w.role === 'lead' ? `${w.project} lead` : w.name}</span>
            {w.id && (
              <span
                translate="no"
                className="shrink-0 font-mono text-[0.8125rem] font-normal text-muted-foreground"
              >
                {w.id}
              </span>
            )}
          </h2>
          <p className="line-clamp-2 text-sm text-muted-foreground">
            {w.role === 'lead' ? 'Control chat' : w.title}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Close"
          className="-mt-1 -mr-2 shrink-0"
        >
          <XIcon />
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Reason w={w} />
          {w.task && w.zone !== 'desk' && <StageBadge stage={w.task.stage} size="sm" />}
          <LiveStatus status={w.session?.status ?? 'missing'} unread={w.session?.unread} />
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Where</dt>
          <dd>{called ? 'In your office' : where(w, office)}</dd>
          {w.since && (
            <>
              <dt className="text-muted-foreground">Since</dt>
              <dd title={new Date(w.since).toLocaleString()}>{relativeTime(w.since, now)}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Wearing</dt>
          <dd>{DRESS_CODE_LABEL[w.outfit.dressCode]}</dd>
          {w.project && w.role === 'worker' && (
            <>
              <dt className="text-muted-foreground">Team</dt>
              <dd className="truncate">{w.project}</dd>
            </>
          )}
        </dl>

        {w.zone === 'door' && w.task && <TaskAsks task={w.task} session={w.session} />}
        {w.zone === 'door' && !w.task && w.role === 'worker' && w.session?.prompt && (
          <PromptCard session={w.session} />
        )}
        {w.zone === 'door' && w.role === 'lead' && (
          <div className="space-y-2">
            {(() => {
              const asks = w.items.filter((i) => i.kind === 'control_blocker' || i.kind === 'control_needs');
              return (
                asks.length > 0 && (
                  <ol aria-label="What the control chat has for you" className="space-y-1.5 text-sm">
                    {asks.map((i) => (
                      <li key={i.id} className="flex gap-2">
                        {i.kind === 'control_blocker' && (
                          <span className="shrink-0 rounded bg-st-red/12 px-1.5 text-xs leading-5 font-medium text-st-red">
                            Blocked
                          </span>
                        )}
                        <span className="min-w-0">{i.detail}</span>
                      </li>
                    ))}
                  </ol>
                )
              );
            })()}
            <p className="text-sm text-muted-foreground">{w.spot.reason}. Reply in the control chat.</p>
          </div>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        {w.task && (
          <Button asChild variant="outline" className="px-3">
            <Link href={w.href}>
              <KanbanIcon />
              Open task
            </Link>
          </Button>
        )}
        {sessionId && (
          <Button asChild variant="outline" className="px-3">
            <Link href={chatHref(sessionId)}>
              <ChatTeardropTextIcon />
              Open chat
            </Link>
          </Button>
        )}
        {mr && (
          <Button asChild variant="outline" className="px-3">
            <a href={mr.url} target="_blank" rel="noreferrer">
              <GitMergeIcon />
              MR !{mr.iid}
              <ArrowSquareOutIcon className="size-3.5 opacity-70" aria-hidden />
            </a>
          </Button>
        )}
        <Button
          variant={following ? 'outline' : 'ghost'}
          aria-pressed={following}
          onClick={onFollow}
          className={cn(
            'ml-auto px-3',
            following && 'border-primary/60 bg-primary/15 text-foreground hover:bg-primary/20',
          )}
          title="Keep the camera on this worker (F)"
        >
          <CrosshairSimpleIcon weight={following ? 'bold' : 'regular'} />
          Follow
        </Button>
      </footer>
    </section>
  );
}
