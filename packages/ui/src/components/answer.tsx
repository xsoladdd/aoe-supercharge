import {
  CircleNotchIcon,
  ClipboardTextIcon,
  HandPalmIcon,
  PaperPlaneRightIcon,
  QuestionIcon,
  ShieldCheckIcon,
  TerminalWindowIcon,
  type Icon,
} from '@phosphor-icons/react';
import { ago, type SessionPrompt, type SessionView, type TaskRecord } from '@aoe-supercharge/core/shared';
import { lazy, Suspense, useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'wouter';
import { CommandLine } from '@/components/copy';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, getJson, sendJson } from '@/lib/api';
import { chatHref } from '@/lib/nav';
import { useNow } from '@/lib/theme';
import { cn } from '@/lib/utils';

// Markdown and highlighting load only when a plan is shown.
const ChatMarkdown = lazy(() =>
  import('@/components/chat/markdown').then((m) => ({ default: m.ChatMarkdown })),
);

const KIND: Record<SessionPrompt['kind'], { icon: Icon; title: string }> = {
  plan: { icon: ClipboardTextIcon, title: 'Plan ready for your approval' },
  permission: { icon: ShieldCheckIcon, title: 'Claude needs permission' },
  question: { icon: QuestionIcon, title: 'Claude is asking you' },
  menu: { icon: HandPalmIcon, title: 'Claude is waiting on you' },
};

interface AskQuestion {
  question?: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label?: string; description?: string }[];
}

interface PromptDetail {
  prompt: SessionPrompt | null;
  plan: string | null;
  questions: AskQuestion[] | null;
  /** Set when the questions came from the screen: every question's header, from the tab bar. */
  otherTabs?: string[];
}

/** The plan or questions behind a menu, fetched once per menu. */
function usePromptDetail(sessionId: string, prompt: SessionPrompt) {
  const [detail, setDetail] = useState<PromptDetail | null>(null);
  const needs = prompt.kind === 'plan' || prompt.kind === 'question';
  useEffect(() => {
    if (!needs) return;
    let live = true;
    setDetail(null);
    getJson<PromptDetail>(`/api/sessions/${encodeURIComponent(sessionId)}/prompt`)
      .then((d) => live && setDetail(d))
      .catch(() => live && setDetail({ prompt, plan: null, questions: null, otherTabs: [] }));
    return () => {
      live = false;
    };
    // One fetch per menu: the key changes when the menu does.
  }, [sessionId, prompt.key, needs]);
  return { detail, needs };
}

/** A radio list of answers that reads like Claude's own menus: number, label, hint. */
function Choices({
  name,
  options,
  value,
  onChange,
  label,
}: {
  name: string;
  options: { value: string; label: string; hint?: string | null; n?: number }[];
  value: string | null;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="space-y-1.5">
      {options.map((o, i) => {
        const checked = value === o.value;
        return (
          <label
            key={o.value}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors',
              checked
                ? 'border-ring/70 bg-accent ring-2 ring-ring/25'
                : 'border-border bg-background hover:border-border-strong',
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={checked}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            <span
              aria-hidden
              className={cn(
                'mt-px grid size-6 shrink-0 place-items-center rounded-md border font-mono text-[13px]',
                checked
                  ? 'border-transparent bg-gradient-primary text-on-gradient'
                  : 'border-border text-muted-foreground',
              )}
            >
              {o.n ?? i + 1}
            </span>
            <span className="min-w-0">
              <span className="block text-[15px] leading-snug">{o.label}</span>
              {o.hint && <span className="mt-0.5 block text-sm text-muted-foreground">{o.hint}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

function CardShell({
  icon: I,
  title,
  context,
  children,
  className,
}: {
  icon: Icon;
  title: string;
  context?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-xl border border-st-yellow/45 bg-card shadow-float', className)}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-st-yellow/12 text-st-yellow">
          <I weight="fill" className="size-[18px]" />
        </span>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {context && <span className="min-w-0 text-sm text-muted-foreground">{context}</span>}
      </header>
      <div className="space-y-4 px-4 py-4">{children}</div>
    </section>
  );
}

/**
 * Claude's own multiple-choice questions (AskUserQuestion), all tabs at once: radios for one answer,
 * checkboxes for several, and "Something else" for your own words. Sent as one message after
 * Supercharge closes the question in the terminal.
 */
function AskForm({
  session,
  toolId,
  questions,
  tabs,
  onAnswered,
}: {
  session: SessionView;
  toolId: string;
  questions: AskQuestion[];
  /** When Claude asked several questions but only the one on screen could be read. */
  tabs: string[];
  onAnswered?: () => void;
}) {
  const id = useId();
  const [note, setNote] = useState('');
  const partial = tabs.length > 1;
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []));
  const [other, setOther] = useState<string[]>(() => questions.map(() => ''));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (qi: number, label: string, multi: boolean) => {
    setError(null);
    setPicked((all) =>
      all.map((p, i) =>
        i !== qi ? p : multi ? (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]) : [label],
      ),
    );
  };

  const send = async () => {
    const missing = questions.findIndex((_, i) => !picked[i]!.length && !other[i]!.trim());
    if (missing >= 0) {
      setError(`Answer every question, or write something else for it (question ${missing + 1} is empty).`);
      return;
    }
    setSending(true);
    setError(null);
    try {
      await sendJson('POST', `/api/sessions/${encodeURIComponent(session.id)}/answer-questions`, {
        toolId,
        answers: questions.map((q, i) => ({
          question: q.question ?? '',
          picked: picked[i],
          other: other[i],
        })),
        note: [
          partial
            ? `You asked ${tabs.length} questions (${tabs.join(', ')}). I could only see the one above, so ask me the others again.`
            : '',
          note.trim(),
        ]
          .filter(Boolean)
          .join('\n\n'),
      });
      toast.success('Answers sent');
      onAnswered?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not send the answers.');
      toast.error('Answers not sent');
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
      className="space-y-5"
    >
      {questions.map((q, qi) => {
        const multi = !!q.multiSelect;
        return (
          <fieldset key={qi} className="space-y-2">
            <legend className="mb-2 flex flex-wrap items-center gap-2">
              {q.header && (
                <span className="rounded-full bg-raised px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {q.header}
                </span>
              )}
              <span className="text-[15px] font-medium">{q.question}</span>
              {multi && <span className="text-sm text-muted-foreground">Pick any</span>}
            </legend>
            <div className="space-y-1.5">
              {(q.options ?? []).map((o, oi) => {
                const label = o.label ?? `Option ${oi + 1}`;
                const checked = picked[qi]!.includes(label);
                return (
                  <label
                    key={oi}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                      checked
                        ? 'border-ring/70 bg-accent ring-2 ring-ring/25'
                        : 'border-border bg-background hover:border-border-strong',
                    )}
                  >
                    <input
                      type={multi ? 'checkbox' : 'radio'}
                      name={`ask-${id}-${qi}`}
                      checked={checked}
                      onChange={() => toggle(qi, label, multi)}
                      className="mt-1 size-4 shrink-0 accent-[var(--primary)]"
                    />
                    <span className="min-w-0">
                      <span className="block text-[15px] leading-snug">{label}</span>
                      {o.description && (
                        <span className="mt-0.5 block text-sm text-muted-foreground">{o.description}</span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
            <label htmlFor={`ask-${id}-${qi}-other`} className="sr-only">
              Something else for: {q.question}
            </label>
            <input
              id={`ask-${id}-${qi}-other`}
              name={`other-${qi}`}
              autoComplete="off"
              value={other[qi]}
              onChange={(e) => {
                const v = e.target.value;
                setError(null);
                setOther((all) => all.map((x, i) => (i === qi ? v : x)));
              }}
              placeholder="Something else…"
              className="block h-10 w-full rounded-lg border border-input bg-background px-3 text-[15px] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none"
            />
          </fieldset>
        );
      })}
      {partial && (
        <p className="rounded-lg bg-raised px-3 py-2 text-sm text-muted-foreground">
          Claude asked {tabs.length} questions ({tabs.join(', ')}) and its terminal shows one at a time. This
          answers the one shown; Claude asks the others again after it reads your answer.
        </p>
      )}
      <div className="space-y-1.5">
        <label htmlFor={`ask-${id}-note`} className="text-sm font-medium">
          Anything else for Claude? <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <textarea
          id={`ask-${id}-note`}
          name="note"
          rows={2}
          autoComplete="off"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="block w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-[15px] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none"
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-st-red">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Supercharge closes the question in Claude’s terminal and sends your answers as a message. Audited.
        </p>
        <Button type="submit" variant="gradient" disabled={sending}>
          {sending ? <CircleNotchIcon className="animate-spin" /> : <PaperPlaneRightIcon weight="fill" />}
          {sending ? 'Sending…' : questions.length > 1 ? 'Send answers' : 'Send answer'}
        </Button>
      </div>
    </form>
  );
}

/**
 * Answer the menu a waiting session shows (plan approval, permission) the way the Claude app does:
 * pick an option, optionally tell Claude why, send. The daemon only delivers it while that exact menu
 * is still on screen.
 */
export function PromptCard({
  session,
  context,
  className,
  onAnswered,
}: {
  session: SessionView;
  context?: React.ReactNode;
  className?: string;
  onAnswered?: () => void;
}) {
  const prompt = session.prompt!;
  const { icon, title } = KIND[prompt.kind];
  const { detail, needs } = usePromptDetail(session.id, prompt);
  const [choice, setChoice] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const id = useId();
  useEffect(() => {
    setChoice(null);
    setText('');
    setError(null);
  }, [prompt.key]);

  const option = prompt.options.find((o) => String(o.n) === choice) ?? null;
  const send = async () => {
    if (!option) {
      setError('Pick an option first.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      await sendJson('POST', `/api/sessions/${encodeURIComponent(session.id)}/answer`, {
        key: prompt.key,
        option: option.n,
        text: option.feedback ? text : undefined,
      });
      toast.success('Answer sent', { description: `${option.n}. ${option.label}` });
      onAnswered?.();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Could not send the answer.';
      setError(msg);
      toast.error('Answer not sent');
    } finally {
      setSending(false);
    }
  };

  const terminal = (
    <Button variant="outline" size="sm" asChild>
      <Link href={chatHref(session.id, 'terminal')}>
        <TerminalWindowIcon />
        Show terminal
      </Link>
    </Button>
  );

  return (
    <CardShell icon={icon} title={title} context={context} className={className}>
      {prompt.tool && prompt.kind === 'permission' && (
        <div className="rounded-lg border border-border bg-background px-3 py-2">
          <div className="text-sm text-muted-foreground">{prompt.tool.name}</div>
          <code translate="no" className="block font-mono text-[13px] break-all">
            {prompt.tool.summary || '(no details)'}
          </code>
        </div>
      )}

      {prompt.kind === 'plan' &&
        (needs && !detail ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : detail?.plan ? (
          <div>
            <div className="relative">
              <div
                className={cn(
                  'overflow-hidden rounded-lg border border-border bg-background px-4 py-3',
                  !planOpen && 'max-h-72',
                )}
              >
                <Suspense fallback={<Skeleton className="h-24 w-full" />}>
                  <ChatMarkdown text={detail.plan} />
                </Suspense>
              </div>
              {!planOpen && (
                <div className="pointer-events-none absolute inset-x-px bottom-px h-16 rounded-b-lg bg-gradient-to-t from-background to-transparent" />
              )}
            </div>
            <button
              type="button"
              onClick={() => setPlanOpen((o) => !o)}
              aria-expanded={planOpen}
              className="mt-2 cursor-pointer text-sm text-muted-foreground underline underline-offset-3 hover:text-foreground"
            >
              {planOpen ? 'Show less of the plan' : 'Show the whole plan'}
            </button>
          </div>
        ) : null)}

      {prompt.kind === 'question' ? (
        needs && !detail ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : detail?.questions?.length ? (
          <AskForm
            session={session}
            toolId={prompt.key}
            questions={detail.questions}
            tabs={detail.otherTabs ?? []}
            onAnswered={onAnswered}
          />
        ) : (
          <>
            <p className="text-[15px]">{prompt.question}</p>
            <p className="text-sm text-muted-foreground">
              Could not read these questions from the conversation, so answer them in the terminal.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {terminal}
              <CommandLine command={`aoe session attach ${session.id}`} className="min-w-0 flex-1" />
            </div>
          </>
        )
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="space-y-3"
        >
          {prompt.question && <p className="text-[15px] font-medium">{prompt.question}</p>}
          <Choices
            name={`answer-${id}`}
            label={prompt.question || title}
            value={choice}
            onChange={(v) => {
              setChoice(v);
              setError(null);
            }}
            options={prompt.options.map((o) => ({
              value: String(o.n),
              n: o.n,
              label: o.label,
              hint: o.hint,
            }))}
          />
          {option?.feedback && (
            <div className="space-y-1.5">
              <label htmlFor={`feedback-${id}`} className="text-sm font-medium">
                What should Claude do instead?{' '}
                <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <textarea
                id={`feedback-${id}`}
                name="feedback"
                rows={3}
                autoComplete="off"
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="block w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-[15px] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none"
                placeholder="Tell Claude what to change…"
              />
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-st-red">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Sent as the option’s number, like typing it in the terminal. Recorded in the audit log.
            </p>
            <div className="flex items-center gap-2">
              {terminal}
              <Button type="submit" variant="gradient" disabled={sending}>
                {sending ? (
                  <CircleNotchIcon className="animate-spin" />
                ) : (
                  <PaperPlaneRightIcon weight="fill" />
                )}
                {sending ? 'Sending…' : 'Send answer'}
              </Button>
            </div>
          </div>
        </form>
      )}
    </CardShell>
  );
}

/** A question a worker asked with `supercharge ask`: pick a suggested answer or write one. */
export function QuestionCard({
  task,
  context,
  className,
  onAnswered,
}: {
  task: TaskRecord;
  context?: React.ReactNode;
  className?: string;
  onAnswered?: () => void;
}) {
  const now = useNow();
  const q = task.openQuestion!;
  const options = q.options ?? [];
  const OWN = '__own__';
  const [choice, setChoice] = useState<string | null>(options.length ? null : OWN);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const message = choice === OWN ? text.trim() : (choice ?? '');

  const send = async () => {
    if (!message) {
      setError(choice === OWN ? 'Write your answer first.' : 'Pick an answer first.');
      return;
    }
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
      toast.success(`Answer sent to ${task.id}`, { description: 'Recorded in the audit log.' });
      onAnswered?.();
    } catch (e) {
      setError(`${e instanceof ApiError ? e.message : 'Could not send the answer.'} Try again.`);
    } finally {
      setSending(false);
    }
  };

  return (
    <CardShell
      icon={QuestionIcon}
      title={`${task.id} asks`}
      context={context ?? `${ago(q.askedAt, now)}, the worker is blocked until you answer`}
      className={className}
    >
      <p className="text-[15px] font-medium break-words whitespace-pre-wrap">{q.text}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="space-y-3"
      >
        {options.length > 0 && (
          <Choices
            name={`question-${id}`}
            label={q.text}
            value={choice}
            onChange={(v) => {
              setChoice(v);
              setError(null);
            }}
            options={[
              ...options.map((o) => ({ value: o, label: o })),
              { value: OWN, label: 'Write my own answer' },
            ]}
          />
        )}
        {choice === OWN && (
          <div className="space-y-1.5">
            <label htmlFor={`own-${id}`} className={cn('text-sm font-medium', !options.length && 'sr-only')}>
              Your answer
            </label>
            <textarea
              id={`own-${id}`}
              name="answer"
              rows={3}
              autoComplete="off"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                if (error) setError(null);
              }}
              placeholder="Your answer…"
              className="block w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-[15px] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none"
            />
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-st-red">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Sent into the worker’s session as a prompt. Audited.
          </p>
          <Button type="submit" variant="gradient" disabled={sending}>
            {sending ? <CircleNotchIcon className="animate-spin" /> : <PaperPlaneRightIcon weight="fill" />}
            {sending ? 'Sending…' : 'Send answer'}
          </Button>
        </div>
      </form>
    </CardShell>
  );
}

/** Everything a task's worker is waiting on you for, newest kind first. */
export function TaskAsks({
  task,
  session,
  onAnswered,
  showTask = false,
}: {
  task: TaskRecord;
  session: SessionView | null;
  onAnswered?: () => void;
  /** In a control chat: say which worker is asking, with a link to its task. */
  showTask?: boolean;
}) {
  const open = task.openQuestion && !task.openQuestion.answeredAt;
  if (!open && !session?.prompt) return null;
  const who = showTask ? (
    <Link
      href={`/p/${task.project}/t/${task.id}`}
      className="underline underline-offset-3 hover:text-foreground"
    >
      <span translate="no" className="font-mono">
        {task.id}
      </span>{' '}
      {task.title}
    </Link>
  ) : undefined;
  return (
    <div className="space-y-4">
      {session?.prompt && <PromptCard session={session} onAnswered={onAnswered} context={who} />}
      {open && (
        <QuestionCard
          task={task}
          onAnswered={onAnswered}
          // The card's title already names the task id.
          context={
            showTask ? (
              <Link
                href={`/p/${task.project}/t/${task.id}`}
                className="underline underline-offset-3 hover:text-foreground"
              >
                {task.title}
              </Link>
            ) : undefined
          }
        />
      )}
    </div>
  );
}

export function hasAsk(task: TaskRecord, session: SessionView | null | undefined): boolean {
  return !!(task.openQuestion && !task.openQuestion.answeredAt) || !!session?.prompt;
}
