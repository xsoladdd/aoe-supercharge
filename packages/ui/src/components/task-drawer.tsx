import {
  ArrowSquareOutIcon,
  ChatTeardropTextIcon,
  PaperPlaneTiltIcon,
  QuestionIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { ago, STAGE_LABEL, type SessionView, type TaskRecord } from '@aoe-supercharge/core/shared';
import { toast } from 'sonner';
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
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Link } from 'wouter';
import { ApiError, getJson, sendJson } from '@/lib/api';
import { chatHref } from '@/lib/nav';
import { useNow } from '@/lib/theme';
import { cn } from '@/lib/utils';

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('border-t border-border px-6 py-5', className)}>
      <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Plan({ project, task }: { project: string; task: TaskRecord }) {
  const [plan, setPlan] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    getJson<{ plan: string | null }>(
      `/api/tasks/${encodeURIComponent(project)}/${encodeURIComponent(task.id)}`,
    )
      .then((r) => live && setPlan(r.plan))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [project, task.id, task.plan?.sha256]);
  if (error)
    return (
      <p role="alert" className="text-[15px] text-st-red">
        Could not load the plan: {error}. Close and reopen the task to retry.
      </p>
    );
  if (plan === undefined)
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
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
    <div className="prose-sc text-[15px] leading-relaxed">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {plan}
      </Markdown>
    </div>
  );
}

function Reply({ task }: { task: TaskRecord }) {
  const [message, setMessage] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        { message, confirm: true },
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
      <Label htmlFor="reply" className="text-[15px]">
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
        rows={3}
        aria-invalid={!!error || undefined}
        aria-describedby={error ? 'reply-error' : 'reply-help'}
        className="text-[15px]"
      />
      <p id="reply-help" className="text-sm text-muted-foreground">
        Sent into the worker’s AoE session as a prompt. Every reply is recorded in the audit log.
      </p>
      {error && (
        <p id="reply-error" className="text-sm text-st-red" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button variant="secondary" disabled={sending} onClick={ask}>
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

export function TaskDrawer({
  task,
  session,
  aoeOrigin,
  open,
  onOpenChange,
}: {
  task: TaskRecord | null;
  session: SessionView | null;
  aoeOrigin: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const now = useNow();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto overscroll-contain rounded-l-xl p-0 sm:max-w-[40rem]">
        {task && (
          <>
            <SheetHeader className="gap-2 px-6 pt-6 pb-5">
              <div className="flex items-center gap-2 pr-8">
                <span translate="no" className="font-mono text-[14px] text-muted-foreground">
                  {task.id}
                </span>
                <StageBadge stage={task.stage} size="sm" />
              </div>
              <SheetTitle className="text-[22px] leading-snug font-semibold text-balance break-words">
                {task.title}
              </SheetTitle>
              <SheetDescription translate="no" className="font-mono text-[13px] break-all">
                {task.branch} from {task.baseBranch}
              </SheetDescription>
              <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2">
                <StageStepper stage={task.stage} blockedFrom={task.blockedFrom} />
                <LiveStatus status={session?.status ?? 'missing'} unread={session?.unread} />
              </div>
            </SheetHeader>

            {task.openQuestion && !task.openQuestion.answeredAt && (
              <section className="mx-6 mb-5 rounded-lg border border-st-red/40 bg-st-red/8 px-4 py-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-st-red">
                  <QuestionIcon weight="fill" className="size-4" aria-hidden />
                  Open question, asked {ago(task.openQuestion.askedAt, now)}
                </div>
                <p className="mt-1 text-[15px] break-words">{task.openQuestion.text}</p>
              </section>
            )}

            <Section title="Live session">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button variant="gradient" asChild>
                  <Link href={chatHref(task.aoeSessionId)}>
                    <ChatTeardropTextIcon weight="bold" />
                    Open chat
                  </Link>
                </Button>
                <Link
                  href={chatHref(task.aoeSessionId, 'terminal')}
                  className="inline-flex items-center gap-1.5 text-[15px] text-muted-foreground hover:text-foreground hover:underline"
                >
                  <TerminalWindowIcon className="size-4" />
                  Terminal
                </Link>
              </div>
            </Section>

            <Section title="Merge request">
              <MrBadge mr={task.mr} />
              {task.mr?.error && (
                <p className="mt-2 text-sm text-st-orange">Last check failed: {task.mr.error}</p>
              )}
              {task.mr?.checkedAt && (
                <p className="mt-1 text-sm text-muted-foreground">Checked {ago(task.mr.checkedAt, now)}</p>
              )}
            </Section>

            <Section title={task.plan ? `Plan (${task.plan.status})` : 'Plan'}>
              <Plan project={task.project} task={task} />
            </Section>

            {task.brief && (
              <Section title="Brief">
                <p className="text-[15px] break-words whitespace-pre-wrap">{task.brief}</p>
              </Section>
            )}

            <Section title="Stage history">
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
            </Section>

            <Section title="Session">
              <div className="space-y-2">
                <CommandLine command={`aoe session attach ${task.aoeSessionId}`} />
                {aoeOrigin && (
                  <Button variant="outline" asChild>
                    <a href={aoeOrigin} target="_blank" rel="noreferrer">
                      <ArrowSquareOutIcon />
                      Open in AoE
                    </a>
                  </Button>
                )}
                <p translate="no" className="font-mono text-[13px] break-all text-muted-foreground">
                  {task.worktreePath}
                </p>
              </div>
            </Section>

            {task.stage !== 'done' && (
              <Section title="Reply">
                <Reply task={task} />
              </Section>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
