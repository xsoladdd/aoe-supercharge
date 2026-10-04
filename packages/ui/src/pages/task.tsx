import {
  ArrowSquareOutIcon,
  ChatTeardropTextIcon,
  ClipboardTextIcon,
  InfoIcon,
  PaperPlaneTiltIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
  type Icon,
} from '@phosphor-icons/react';
import {
  ago,
  STAGE_LABEL,
  type SessionView,
  type Snapshot,
  type TaskRecord,
} from '@aoe-supercharge/core/shared';
import { lazy, Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'wouter';
import { hasAsk, PromptCard, TaskAsks } from '@/components/answer';
import { CommandLine } from '@/components/copy';
import { LiveStatus, MrBadge, StageBadge, StageStepper, STAGE_META } from '@/components/status';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, getJson, sendJson } from '@/lib/api';
import { useNow } from '@/lib/theme';
import { cn } from '@/lib/utils';

// The chat (markdown, highlighting) loads with the Chat tab or the Plan tab, not with the overview.
const SessionChat = lazy(() => import('@/pages/chat').then((m) => ({ default: m.SessionChat })));
const ChatMarkdown = lazy(() =>
  import('@/components/chat/markdown').then((m) => ({ default: m.ChatMarkdown })),
);

export type TaskTab = 'overview' | 'chat' | 'plan';

function Card({
  title,
  children,
  className,
  action,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}) {
  return (
    <section className={cn('rounded-xl border border-border bg-card', className)}>
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
        <h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
        {action}
      </div>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

/** The brief is markdown (the control chat writes it); long ones open collapsed. */
function Brief({ text }: { text: string }) {
  const long = text.split('\n').length > 14 || text.length > 900;
  const [open, setOpen] = useState(!long);
  return (
    <div>
      <div className="relative">
        <div className={cn('overflow-hidden', !open && 'max-h-64')}>
          <Suspense fallback={<p className="text-[15px] whitespace-pre-wrap">{text}</p>}>
            <ChatMarkdown text={text} className="text-[15px] leading-relaxed" />
          </Suspense>
        </div>
        {!open && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-card to-transparent" />
        )}
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="mt-1.5 cursor-pointer text-sm text-muted-foreground underline underline-offset-3 hover:text-foreground"
        >
          {open ? 'Show less' : 'Show the whole brief'}
        </button>
      )}
    </div>
  );
}

function usePlan(task: TaskRecord) {
  const [plan, setPlan] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    getJson<{ plan: string | null }>(
      `/api/tasks/${encodeURIComponent(task.project)}/${encodeURIComponent(task.id)}`,
    )
      .then((r) => live && setPlan(r.plan))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [task.project, task.id, task.plan?.sha256]);
  return { plan, error };
}

function SavedPlan({ task }: { task: TaskRecord }) {
  const { plan, error } = usePlan(task);
  if (error)
    return (
      <p role="alert" className="text-[15px] text-st-red">
        Could not load the plan: {error}. Reload the page to retry.
      </p>
    );
  if (plan === undefined)
    return (
      <div className="space-y-2">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  if (!plan)
    return (
      <p className="text-[15px] text-muted-foreground">
        No plan saved yet. The worker saves it with{' '}
        <code className="font-mono text-[13px]">supercharge plan</code> once you approve it.
      </p>
    );
  return (
    <Suspense fallback={<Skeleton className="h-24 w-full" />}>
      <ChatMarkdown text={plan} />
    </Suspense>
  );
}

/** A free-form message to the worker, confirmed before it is sent. */
function Reply({ task, session }: { task: TaskRecord; session: SessionView | null }) {
  const [message, setMessage] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuOpen = !!session?.prompt;
  const ask = () => {
    if (!message.trim()) {
      setError('Write a message first.');
      document.getElementById('reply')?.focus();
      return;
    }
    setError(null);
    setConfirming(true);
  };
  const send = async () => {
    setSending(true);
    setError(null);
    try {
      await sendJson(
        'POST',
        `/api/tasks/${encodeURIComponent(task.project)}/${encodeURIComponent(task.id)}/reply`,
        {
          message,
          confirm: true,
        },
      );
      toast.success(`Sent to ${task.id}`, { description: 'Recorded in the audit log.' });
      setMessage('');
    } catch (e) {
      setError(
        `${e instanceof ApiError ? e.message : 'Could not send the reply.'} Try again, or reply in the AoE session directly.`,
      );
    } finally {
      setSending(false);
      setConfirming(false);
    }
  };
  return (
    <div className="space-y-2">
      <Label htmlFor="reply" className="sr-only">
        Message to the worker
      </Label>
      <Textarea
        id="reply"
        name="reply"
        autoComplete="off"
        value={message}
        onChange={(e) => {
          setMessage(e.target.value);
          if (error) setError(null);
        }}
        rows={2}
        aria-invalid={!!error || undefined}
        aria-describedby={error ? 'reply-error' : 'reply-help'}
        className="text-[15px]"
      />
      {error && (
        <p id="reply-error" className="text-sm text-st-red" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-start justify-between gap-3">
        <p id="reply-help" className="text-sm text-muted-foreground">
          {menuOpen
            ? 'The worker is showing a menu. Answer it above first; a message now would pick its highlighted option.'
            : 'Sent into the worker’s session as a prompt. Audited.'}
        </p>
        <Button variant="secondary" size="sm" disabled={sending || menuOpen} onClick={ask}>
          <PaperPlaneTiltIcon />
          Send reply
        </Button>
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send this to {task.id}?</AlertDialogTitle>
            <AlertDialogDescription>
              The worker receives it as a prompt in its AoE session.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <blockquote className="rounded-md border border-border bg-raised px-3 py-2 text-[15px] whitespace-pre-wrap">
            {message}
          </blockquote>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={send} disabled={sending}>
              {sending ? 'Sending…' : 'Send reply'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Overview({
  task,
  session,
  aoeOrigin,
}: {
  task: TaskRecord;
  session: SessionView | null;
  aoeOrigin: string | null;
}) {
  const now = useNow();
  const base = `/p/${task.project}/t/${task.id}`;
  return (
    <div className="grid gap-4 px-5 py-4 lg:px-7 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-4">
        <TaskAsks task={task} session={session} />

        <Card title="Brief">
          {task.brief ? (
            <Brief text={task.brief} />
          ) : (
            <p className="text-[15px] text-muted-foreground">
              No brief. The title is all the worker was given.
            </p>
          )}
        </Card>

        {task.stage !== 'done' && (
          <Card title="Message to the worker">
            <Reply task={task} session={session} />
          </Card>
        )}

        <Card title="Stage history">
          <ol className="relative space-y-3 border-l border-border pl-5">
            {[...task.history].reverse().map((h, i) => {
              const { icon: I, color } = STAGE_META[h.to];
              return (
                <li key={`${h.at}-${i}`} className="relative">
                  <span className="absolute top-0.5 -left-[1.95rem] grid size-5 place-items-center rounded-full bg-card">
                    <I weight="bold" className={cn('size-4', color)} aria-hidden />
                  </span>
                  <div className="flex flex-wrap items-baseline gap-x-2 text-[15px]">
                    <span className="font-medium">{STAGE_LABEL[h.to]}</span>
                    <span className="text-sm text-muted-foreground">
                      by {h.by}, {ago(h.at, now)}
                    </span>
                  </div>
                  {h.note && <p className="text-sm text-muted-foreground">{h.note}</p>}
                </li>
              );
            })}
          </ol>
        </Card>
      </div>

      <aside className="min-w-0 space-y-4" aria-label="Task details">
        <Card title="Progress">
          {/* Label column on the left keeps each fact on one line. */}
          <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-3 text-[15px]">
            <dt className="text-sm text-muted-foreground">Stage</dt>
            <dd className="space-y-1.5">
              <StageBadge stage={task.stage} size="sm" />
              <StageStepper stage={task.stage} blockedFrom={task.blockedFrom} />
            </dd>
            <dt className="text-sm text-muted-foreground">Session</dt>
            <dd className="flex flex-wrap items-center gap-x-2">
              <LiveStatus status={session?.status ?? 'missing'} unread={session?.unread} />
              {session?.statusSince && (
                <span className="text-sm text-muted-foreground">{ago(session.statusSince, now)}</span>
              )}
            </dd>
            <dt className="text-sm text-muted-foreground">Merge request</dt>
            <dd>
              <MrBadge mr={task.mr} />
              {task.mr?.error && (
                <p className="mt-1 text-sm text-st-orange">Last check failed: {task.mr.error}</p>
              )}
              {task.mr?.checkedAt && (
                <p className="mt-0.5 text-sm text-muted-foreground">Checked {ago(task.mr.checkedAt, now)}</p>
              )}
            </dd>
            <dt className="text-sm text-muted-foreground">Plan</dt>
            <dd>
              {task.plan ? (
                <Link href={`${base}/plan`} className="underline underline-offset-3">
                  {task.plan.status === 'approved' ? 'Approved' : 'Draft'}, {ago(task.plan.savedAt, now)}
                </Link>
              ) : (
                <span className="text-muted-foreground">Not saved yet</span>
              )}
            </dd>
          </dl>
        </Card>

        <Card title="Session">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" asChild>
                <Link href={`${base}/chat`}>
                  <ChatTeardropTextIcon />
                  Open chat
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link href={`${base}/chat?view=terminal`}>
                  <TerminalWindowIcon />
                  Terminal
                </Link>
              </Button>
              {aoeOrigin && (
                <Button variant="outline" size="icon-sm" asChild>
                  <a
                    href={aoeOrigin}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open in AoE"
                    title="Open in AoE"
                  >
                    <ArrowSquareOutIcon />
                  </a>
                </Button>
              )}
            </div>
            <CommandLine command={`aoe session attach ${task.aoeSessionId}`} />
            <p translate="no" className="font-mono text-[13px] break-all text-muted-foreground">
              {task.worktreePath}
            </p>
          </div>
        </Card>
      </aside>
    </div>
  );
}

function PlanTab({ task, session }: { task: TaskRecord; session: SessionView | null }) {
  const pending = session?.prompt?.kind === 'plan';
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-5 py-6 lg:px-7">
      {pending && <PromptCard session={session!} context="A new plan from the worker" />}
      <section aria-labelledby="saved-plan">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="saved-plan" className="text-base font-semibold">
            {task.plan?.status === 'draft' ? 'Draft plan' : 'Saved plan'}
          </h2>
          {task.plan && <span className="text-sm text-muted-foreground">Saved with supercharge plan</span>}
        </div>
        <div className="rounded-xl border border-border bg-card px-5 py-4">
          <SavedPlan task={task} />
        </div>
      </section>
    </div>
  );
}

const TABS: { key: TaskTab; label: string; icon: Icon; suffix: string }[] = [
  { key: 'overview', label: 'Overview', icon: InfoIcon, suffix: '' },
  { key: 'chat', label: 'Chat', icon: ChatTeardropTextIcon, suffix: '/chat' },
  { key: 'plan', label: 'Plan', icon: ClipboardTextIcon, suffix: '/plan' },
];

/** One task as a page: details and anything it asks you (Overview), its chat, and its plan. */
export function TaskPage({
  snap,
  project,
  taskId,
  tab,
}: {
  snap: Snapshot;
  project: string;
  taskId: string;
  tab: TaskTab;
}) {
  const task = snap.tasks.find((t) => t.project === project && t.id === taskId) ?? null;
  if (!task)
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <WarningCircleIcon className="mx-auto size-8 text-st-red" />
        <h1 className="mt-3 text-xl font-semibold">Task not found</h1>
        <p className="mt-2 text-[15px] text-muted-foreground">
          There is no task {taskId} in {project}.{' '}
          <Link href={`/p/${project}`} className="underline">
            Back to the project
          </Link>
          .
        </p>
      </div>
    );
  const session = snap.sessions.find((s) => s.id === task.aoeSessionId) ?? null;
  const base = `/p/${task.project}/t/${task.id}`;
  const asks = hasAsk(task, session);

  return (
    <div className={cn('flex flex-col', tab === 'chat' && 'h-full min-h-0')}>
      {/* One compact row that stays under the top bar, so the tabs are always in reach. */}
      <header className="sticky top-14 z-[5] flex flex-wrap items-end gap-x-4 border-b border-border bg-surface/95 px-5 pt-2 backdrop-blur lg:px-7">
        <div className="flex min-w-0 flex-1 items-center gap-x-2.5 pb-2.5">
          <span translate="no" className="shrink-0 font-mono text-[13px] text-muted-foreground">
            {task.id}
          </span>
          <h1 className="min-w-0 truncate text-[17px] leading-snug font-semibold" title={task.title}>
            {task.title}
          </h1>
          <StageBadge stage={task.stage} size="sm" />
          {tab !== 'chat' && (
            <LiveStatus
              status={session?.status ?? 'missing'}
              unread={session?.unread}
              className="max-md:hidden"
            />
          )}
        </div>
        <nav aria-label="Task" className="-mb-px flex gap-1">
          {TABS.map(({ key, label, icon: I, suffix }) => (
            <Link
              key={key}
              href={`${base}${suffix}`}
              aria-current={tab === key ? 'page' : undefined}
              className={cn(
                'inline-flex h-10 items-center gap-2 border-b-2 px-2.5 text-[15px] font-medium transition-colors',
                tab === key
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <I className="size-4" />
              {label}
              {key === 'overview' && asks && (
                <span className="tint rounded-full px-1.5 text-xs font-semibold text-st-yellow">
                  Needs you
                </span>
              )}
              {key === 'plan' && session?.prompt?.kind === 'plan' && (
                <span className="tint rounded-full px-1.5 text-xs font-semibold text-st-yellow">New</span>
              )}
            </Link>
          ))}
        </nav>
      </header>

      {tab === 'overview' && <Overview task={task} session={session} aoeOrigin={snap.health.aoe.origin} />}
      {tab === 'plan' && <PlanTab task={task} session={session} />}
      {tab === 'chat' &&
        (session ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <Suspense fallback={<Skeleton className="m-6 h-40" />}>
              <SessionChat snap={snap} session={session} basePath={`${base}/chat`} embedded />
            </Suspense>
          </div>
        ) : (
          <p className="px-5 py-6 text-[15px] text-muted-foreground lg:px-7">
            The worker’s AoE session no longer exists, so there is no chat to show.
          </p>
        ))}
    </div>
  );
}
