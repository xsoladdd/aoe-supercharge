import {
  ArrowSquareOutIcon,
  ChatTeardropTextIcon,
  CircleNotchIcon,
  CrosshairSimpleIcon,
  GitMergeIcon,
  KanbanIcon,
  PaperPlaneRightIcon,
  PhoneCallIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'wouter';
import {
  DRESS_CODE_LABEL,
  formatTokens,
  formatUsd,
  isRelayed,
  relativeTime,
  ZONE_LABEL,
  mrLabel,
} from '@aoe-supercharge/core/shared';
import { CostLine, ESTIMATE_NOTE } from '@/components/office/cost';
import { GoHome, RestoreButton } from '@/components/office/go-home';
import { DismissReply, hrefFor } from '@/components/needs-you';
import { PromptCard, TaskAsks } from '@/components/answer';
import { Avatar } from '@/components/office/avatar';
import { Reason } from '@/components/office/roster';
import { LiveStatus, StageBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, sendJson } from '@/lib/api';
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
 * Write to a team's control chat from its card on the floor, as from its chat: typed into its AoE
 * session and recorded in the audit log. Picking the lead puts you straight in the box.
 */
function LeadMessage({ sessionId, project }: { sessionId: string; project: string }) {
  const id = useId();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (!text.trim()) {
      setError('Write a message first.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      await sendJson('POST', `/api/sessions/${encodeURIComponent(sessionId)}/send`, { message: text });
      setText('');
      toast.success(`Sent to the ${project} control chat`, { description: 'Recorded in the audit log.' });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not send. Try again, or write in the chat.');
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      className="space-y-2"
    >
      <label htmlFor={`${id}-text`} className="text-sm font-medium">
        Message the control chat
      </label>
      <Textarea
        id={`${id}-text`}
        // You picked the lead to talk to it.
        autoFocus
        rows={2}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder="What should the team do next?"
        aria-invalid={!!error}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
        className="max-h-40"
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-st-red">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          Enter sends, Shift+Enter adds a line
        </p>
        <Button type="submit" size="sm" disabled={sending} className="px-3">
          {sending ? <CircleNotchIcon className="animate-spin" /> : <PaperPlaneRightIcon />}
          Send
        </Button>
      </div>
    </form>
  );
}

/**
 * What a lead is on the phone about: what it listed for workers who wait at your door themselves.
 * Each points to its worker; they clear once that worker has nothing waiting on you.
 */
function Calls({
  w,
  office,
  onPick,
}: {
  w: OfficeWorker;
  office: OfficeModel;
  onPick?: (key: string) => void;
}) {
  const calls = w.items.filter(isRelayed);
  if (!calls.length) return null;
  return (
    <div className="space-y-2" data-calls={calls.length}>
      <h3 className="flex items-center gap-1.5 text-sm font-medium">
        <PhoneCallIcon weight="bold" className="size-4 text-st-cyan" aria-hidden />
        Calling for your workers
      </h3>
      <ul className="space-y-2 text-sm">
        {calls.map((i) => {
          const sid = i.relay?.sessionId;
          const worker = office.everyone.find((x) => x.session?.id === sid || x.task?.aoeSessionId === sid);
          const who = i.relay?.label ?? i.title;
          return (
            <li key={i.id} className="flex items-start gap-2">
              <span className="min-w-0 flex-1 break-words">{i.detail}</span>
              {worker && onPick ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 px-2.5"
                  aria-label={`Show ${who}, ${where(worker, office).toLowerCase()}`}
                  onClick={() => onPick(worker.key)}
                >
                  {worker.name}
                </Button>
              ) : (
                <Button asChild size="sm" variant="outline" className="shrink-0 px-2.5">
                  <Link href={hrefFor(i)} aria-label={`Open ${who}`}>
                    {i.relay?.name ?? who}
                  </Link>
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-sm text-muted-foreground">
        They wait at your door themselves. Each clears once its worker has nothing waiting on you.
      </p>
    </div>
  );
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
  onPick,
}: {
  w: OfficeWorker;
  office: OfficeModel;
  now: Date;
  following: boolean;
  /** You called this worker in through your door. */
  called: boolean;
  onFollow: () => void;
  onClose: () => void;
  /** Pick another character: a worker a lead is calling for. */
  onPick?: (key: string) => void;
}) {
  const sessionId = w.session?.id ?? w.task?.aoeSessionId ?? null;
  const mr = w.mr;
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
          {w.cost && w.cost.total.tokens > 0 && (
            <>
              <dt className="text-muted-foreground">Spent</dt>
              <dd>
                <CostLine w={w} />
                <span className="block text-[0.8125rem] text-muted-foreground" title={ESTIMATE_NOTE}>
                  Today{' '}
                  {w.cost.today.usd === null
                    ? `${formatTokens(w.cost.today.tokens)} tokens`
                    : formatUsd(w.cost.today.usd)}
                  {' · '}last hour{' '}
                  {w.cost.lastHour.usd === null
                    ? `${formatTokens(w.cost.lastHour.tokens)} tokens`
                    : formatUsd(w.cost.lastHour.usd)}
                  {w.cost.model ? ` · ${w.cost.model}` : ''} (estimate)
                </span>
              </dd>
            </>
          )}
        </dl>

        {w.zone === 'pantry' && <GoHome w={w} now={now} className="rounded-lg border border-border p-3" />}
        {w.items
          .filter((i) => i.kind === 'control_replied')
          .map((i) => (
            <div
              key={i.id}
              className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1">Replied {relativeTime(i.since, now)}, not yet read.</span>
              <DismissReply item={i} />
            </div>
          ))}
        {w.zone === 'archived' && (
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              Sent home from the office. Its session, worktree and history are untouched; it comes back by
              itself on starting work again or needing you.
            </p>
            <RestoreButton w={w} />
          </div>
        )}
        {w.zone === 'door' && w.task && <TaskAsks task={w.task} session={w.session} />}
        {w.zone === 'door' && !w.task && w.role === 'worker' && w.session?.prompt && (
          <PromptCard session={w.session} />
        )}
        {w.role === 'lead' && <Calls w={w} office={office} onPick={onPick} />}
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
            <p className="text-sm text-muted-foreground">
              {w.spot.reason}. Reply below, or in the control chat.
            </p>
          </div>
        )}
        {w.role === 'lead' && w.session && <LeadMessage sessionId={w.session.id} project={w.project} />}
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
              MR {mrLabel(mr)}
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
