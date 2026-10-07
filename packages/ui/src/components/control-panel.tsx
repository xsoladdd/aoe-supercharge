import {
  CaretDoubleRightIcon,
  CaretRightIcon,
  ChatCenteredTextIcon,
  CheckCircleIcon,
  ClipboardTextIcon,
  NotePencilIcon,
  TerminalIcon,
  type Icon,
} from '@phosphor-icons/react';
import {
  relativeTime,
  type NeedsYouItem,
  type PlanComment,
  type SessionView,
  type Snapshot,
  type TaskRecord,
} from '@aoe-supercharge/core/shared';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import { KIND } from '@/components/needs-you';
import { CommentablePlan, CommentList, useComments } from '@/components/plan-comments';
import { StageBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { getJson, sendJson } from '@/lib/api';
import { useNudgeFlash } from '@/lib/nudge';
import { hasShellRuns, useShellRunVersion } from '@/lib/shell-runs';
import { useNow } from '@/lib/theme';
import { cn } from '@/lib/utils';

type Tab = 'plans' | 'comments' | 'notes' | 'shell';

// xterm.js loads only when the Shell tab opens.
const ShellTerminal = lazy(() => import('@/components/chat/shell-terminal'));

/** What needs you in this project, at a glance; pulses when something new arrives. */
function StatusBrief({
  project,
  items,
  tasks,
}: {
  project: string;
  items: NeedsYouItem[];
  tasks: TaskRecord[];
}) {
  const now = useNow();
  const flash = useNudgeFlash((i) => i.project === project);
  const active = tasks.filter((t) => t.stage !== 'done');
  const blocked = active.filter((t) => t.stage === 'blocked').length;
  const ready = active.filter((t) => t.stage === 'ready_for_review').length;
  const jump = (taskId: string | null) => {
    const card = taskId ? document.getElementById(`ask-${taskId}`) : null;
    const log = card?.closest<HTMLElement>('[role=log]');
    if (!card || !log) return false;
    // Scroll the conversation only; scrollIntoView would also move the page's clipped containers.
    const offset = card.getBoundingClientRect().top - log.getBoundingClientRect().top;
    log.scrollTo({ top: log.scrollTop + offset - 16, behavior: 'smooth' });
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 700);
    return true;
  };
  return (
    <section
      aria-labelledby="brief-heading"
      className={cn(
        'border-b border-border px-4 py-3 transition-colors',
        items.length && 'bg-st-yellow/6',
        flash && 'nudge',
      )}
    >
      <div className="flex items-center gap-2">
        <h2 id="brief-heading" className="text-sm font-semibold">
          {items.length ? 'Needs you' : 'All clear'}
        </h2>
        {items.length > 0 && (
          <span className="tabular rounded-full bg-st-yellow/15 px-1.5 text-xs font-semibold text-st-yellow">
            {items.length}
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {active.length} active{blocked ? `, ${blocked} blocked` : ''}
          {ready ? `, ${ready} ready for review` : ''}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
          <CheckCircleIcon weight="fill" className="size-4 text-st-green" />
          Nothing is waiting on you.
        </p>
      ) : (
        <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
          {items.map((item) => {
            const { icon: I, label, color } = KIND[item.kind];
            const href = item.taskId ? `/p/${item.project}/t/${item.taskId}` : null;
            const body = (
              <>
                <I weight="fill" className={cn('mt-0.5 size-4 shrink-0', color)} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className={cn('text-xs font-medium', color)}>{label}</span>
                    <span className="truncate text-[0.8125rem]">{item.title}</span>
                  </span>
                  <span className="line-clamp-1 text-xs text-muted-foreground">{item.detail}</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {relativeTime(item.since, now)}
                </span>
              </>
            );
            return (
              <li key={item.id}>
                {href ? (
                  <Link
                    href={href}
                    onClick={(e) => {
                      // An answer card for it is right here in the chat: go there instead of leaving.
                      if (jump(item.taskId)) e.preventDefault();
                    }}
                    className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-raised"
                  >
                    {body}
                  </Link>
                ) : (
                  <div className="flex items-start gap-2 px-2 py-1.5">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The plan to comment on: the one waiting for approval if there is one, else the saved plan. */
function usePlanText(task: TaskRecord, session: SessionView | null) {
  const pending = session?.prompt?.kind === 'plan';
  const [text, setText] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setText(undefined);
    const load = pending
      ? getJson<{ plan: string | null }>(`/api/sessions/${encodeURIComponent(session!.id)}/prompt`).then(
          (r) => r.plan,
        )
      : getJson<{ plan: string | null }>(
          `/api/tasks/${encodeURIComponent(task.project)}/${encodeURIComponent(task.id)}`,
        ).then((r) => r.plan);
    load.then((p) => live && setText(p ?? null)).catch(() => live && setText(null));
    return () => {
      live = false;
    };
  }, [task.project, task.id, task.plan?.sha256, pending, session?.prompt?.key]);
  return { text, pending };
}

function PlanCard({ task, session }: { task: TaskRecord; session: SessionView | null }) {
  const { text, pending } = usePlanText(task, session);
  const { comments, add, remove, send } = useComments(task.project, task.id);
  const open = (comments ?? []).filter((c) => !c.sentAt).length;
  return (
    <details open={pending || open > 0} className="group/plan rounded-xl border border-border bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 select-none [&::-webkit-details-marker]:hidden">
        <CaretRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/plan:rotate-90" />
        {task.name && <span className="shrink-0 text-sm font-semibold">{task.name}</span>}
        <span translate="no" className="font-mono text-xs text-muted-foreground">
          {task.id}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{task.title}</span>
        {pending && (
          <span className="tint shrink-0 rounded-full px-1.5 text-xs font-semibold text-st-yellow">
            To approve
          </span>
        )}
        {open > 0 && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {open} {open === 1 ? 'comment' : 'comments'}
          </span>
        )}
      </summary>
      <div className="space-y-3 border-t border-border px-3 pt-2 pb-3">
        <div className="flex items-center gap-2">
          <StageBadge stage={task.stage} size="sm" />
          <Link
            href={`/p/${task.project}/t/${task.id}/plan`}
            className="text-xs text-muted-foreground underline"
          >
            Open the plan
          </Link>
        </div>
        {text === undefined ? (
          <Skeleton className="h-24 w-full" />
        ) : text ? (
          <CommentablePlan
            markdown={text}
            comments={comments ?? []}
            onAdd={add}
            className="text-[0.875rem]"
          />
        ) : (
          <p className="text-sm text-muted-foreground">No plan yet.</p>
        )}
        {text && <CommentList comments={comments} onDelete={remove} onSend={send} target={task.id} />}
      </div>
    </details>
  );
}

function CommentsTab({ tasks }: { tasks: TaskRecord[] }) {
  const [byTask, setByTask] = useState<{ taskId: string; comments: PlanComment[] }[] | null>(null);
  const project = tasks[0]?.project;
  useEffect(() => {
    if (!project) return setByTask([]);
    let live = true;
    const load = () =>
      getJson<{ tasks: { taskId: string; comments: PlanComment[] }[] }>(
        `/api/projects/${encodeURIComponent(project)}/comments`,
      ).then((r) => live && setByTask(r.tasks));
    void load();
    window.addEventListener('supercharge:comments', load);
    return () => {
      live = false;
      window.removeEventListener('supercharge:comments', load);
    };
  }, [project]);
  if (byTask === null) return <Skeleton className="h-24 w-full" />;
  const withOpen = byTask.filter((t) => t.comments.some((c) => !c.sentAt));
  if (!withOpen.length)
    return (
      <p className="text-sm text-muted-foreground">
        No unsent comments. Select text in a plan (Plans tab) to comment on it.
      </p>
    );
  return (
    <div className="space-y-4">
      {withOpen.map(({ taskId }) => {
        const task = tasks.find((t) => t.id === taskId);
        return task ? <TaskComments key={taskId} task={task} /> : null;
      })}
    </div>
  );
}

function TaskComments({ task }: { task: TaskRecord }) {
  const { comments, remove, send } = useComments(task.project, task.id);
  return (
    <section className="space-y-2">
      <h3 className="flex items-baseline gap-2 text-sm">
        {task.name && <span className="shrink-0 font-semibold">{task.name}</span>}
        <span translate="no" className="font-mono text-xs text-muted-foreground">
          {task.id}
        </span>
        <span className="truncate font-medium">{task.title}</span>
      </h3>
      <CommentList comments={comments} onDelete={remove} onSend={send} target={task.id} />
    </section>
  );
}

/** Your scratch notes for the project, saved as you type (to notes.md next to the project's ledger). */
function NotesTab({ project }: { project: string }) {
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<'saved' | 'saving' | 'error'>('saved');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    getJson<{ text: string }>(`/api/projects/${encodeURIComponent(project)}/notes`)
      .then((r) => setText(r.text))
      .catch(() => setText(''));
  }, [project]);
  const save = (v: string) => {
    setState('saving');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      sendJson('PUT', `/api/projects/${encodeURIComponent(project)}/notes`, { text: v })
        .then(() => setState('saved'))
        .catch(() => setState('error'));
    }, 700);
  };
  if (text === null) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="flex h-full min-h-64 flex-col gap-1.5">
      <label htmlFor="project-notes" className="sr-only">
        Notes for {project}
      </label>
      <textarea
        id="project-notes"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          save(e.target.value);
        }}
        placeholder="Drafts, answers to come back to, things to compare…"
        className="min-h-0 w-full flex-1 resize-none rounded-lg border border-input bg-background p-3 font-mono text-[0.8125rem] leading-relaxed placeholder:font-sans placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none"
      />
      <span
        className={cn('text-xs', state === 'error' ? 'text-st-red' : 'text-muted-foreground')}
        role="status"
      >
        {state === 'saving' ? 'Saving…' : state === 'error' ? 'Not saved. Check the daemon.' : 'Saved'}
      </span>
    </div>
  );
}

const TABS: { key: Tab; label: string; icon: Icon }[] = [
  { key: 'notes', label: 'Notes', icon: NotePencilIcon },
  { key: 'plans', label: 'Plans', icon: ClipboardTextIcon },
  { key: 'comments', label: 'Comments', icon: ChatCenteredTextIcon },
  { key: 'shell', label: 'Shell', icon: TerminalIcon },
];

/** The control chat's side panel: what needs you, then the active plans, your comments and notes. */
export function ControlPanel({
  snap,
  project,
  onHide,
}: {
  snap: Snapshot;
  project: string;
  /** Close the panel (the chat header's Panel button opens it again). */
  onHide?: () => void;
}) {
  // Every control chat opens on your notes.
  const [tab, setTab] = useState<Tab>('notes');
  // The control chat's own shell: Run in terminal sends commands there.
  const controlId = snap.projects.find((p) => p.name === project)?.controlSessionId ?? null;
  const runs = useShellRunVersion();
  useEffect(() => {
    if (controlId && hasShellRuns(controlId)) setTab('shell');
  }, [runs, controlId]);
  const tasks = useMemo(() => snap.tasks.filter((t) => t.project === project), [snap.tasks, project]);
  const active = tasks.filter((t) => t.stage !== 'done');
  const items = snap.needsYou.filter((i) => i.project === project);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StatusBrief project={project} items={items} tasks={tasks} />
      <div className="flex items-stretch border-b border-border px-2">
        <div role="tablist" aria-label="Panel" className="flex min-w-0 gap-1">
          {TABS.filter((t) => t.key !== 'shell' || controlId).map(({ key, label, icon: I }) => (
            <button
              key={key}
              type="button"
              role="tab"
              id={`panel-tab-${key}`}
              aria-selected={tab === key}
              aria-controls={`panel-${key}`}
              onClick={() => setTab(key)}
              className={cn(
                '-mb-px inline-flex h-9 cursor-pointer items-center gap-1.5 border-b-2 px-2 text-sm font-medium transition-colors',
                tab === key
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <I className="size-4" />
              {label}
            </button>
          ))}
        </div>
        {onHide && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="my-auto ml-auto size-7 text-muted-foreground"
            aria-label="Hide the panel"
            title="Hide the panel"
            onClick={onHide}
          >
            <CaretDoubleRightIcon className="size-4" />
          </Button>
        )}
      </div>
      <div
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`panel-tab-${tab}`}
        tabIndex={tab === 'shell' ? -1 : 0}
        className={cn(
          'min-h-0 flex-1',
          tab === 'shell' ? 'flex flex-col' : 'overflow-y-auto overscroll-contain p-3',
        )}
      >
        {tab === 'shell' && controlId && (
          <Suspense fallback={<p className="p-3 text-sm text-muted-foreground">Opening the terminal…</p>}>
            <ShellTerminal sessionId={controlId} />
          </Suspense>
        )}
        {tab === 'plans' &&
          (active.length ? (
            <div className="space-y-2">
              {active.map((t) => (
                <PlanCard
                  key={t.id}
                  task={t}
                  session={snap.sessions.find((s) => s.id === t.aoeSessionId) ?? null}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No active tasks. Ask the control chat to start one.
            </p>
          ))}
        {tab === 'comments' && <CommentsTab tasks={active} />}
        {tab === 'notes' && <NotesTab project={project} />}
      </div>
    </div>
  );
}
