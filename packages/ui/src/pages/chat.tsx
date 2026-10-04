import {
  ArrowDownIcon,
  ArrowSquareOutIcon,
  ArrowUpIcon,
  ChatTeardropTextIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  CopyIcon,
  DotsThreeIcon,
  HandPalmIcon,
  StackIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
  XCircleIcon,
} from '@phosphor-icons/react';
import {
  LIVE_STATUS_LABEL,
  type ChatBlock,
  type ChatMessage,
  type SessionView,
  type Snapshot,
} from '@aoe-supercharge/core/shared';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Link, useLocation, useSearch } from 'wouter';
import { hasAsk, PromptCard, TaskAsks } from '@/components/answer';
import { ChatMarkdown } from '@/components/chat/markdown';
import { shortPath, ToolCall } from '@/components/chat/tool-call';
import { useChat } from '@/components/chat/use-chat';
import { CommandLine, copyText } from '@/components/copy';
import { Conversation, useSessionOutput } from '@/components/session-chat';
import { LiveStatus } from '@/components/status';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, sendJson } from '@/lib/api';
import { useSearchParam } from '@/lib/nav';
import { cn } from '@/lib/utils';

type Tool = Extract<ChatBlock, { kind: 'tool' }>;
type Turn =
  { kind: 'user'; id: string; text: string } | { kind: 'assistant'; id: string; blocks: ChatBlock[] };
type Segment = { kind: 'text'; key: string; text: string } | { kind: 'tools'; key: string; tools: Tool[] };

interface Pending {
  key: number;
  text: string;
  sentAt: number;
}

/** What the session is to Supercharge, for the header and the empty state. */
interface Role {
  kind: 'control' | 'worker' | 'other';
  project: string | null;
  taskId: string | null;
  taskTitle: string | null;
}

function roleOf(snap: Snapshot, id: string): Role {
  const project = snap.projects.find((p) => p.controlSessionId === id);
  if (project) return { kind: 'control', project: project.name, taskId: null, taskTitle: null };
  const task = snap.tasks.find((t) => t.aoeSessionId === id);
  if (task) return { kind: 'worker', project: task.project, taskId: task.id, taskTitle: task.title };
  return { kind: 'other', project: null, taskId: null, taskTitle: null };
}

const userText = (m: ChatMessage) => m.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('\n\n');

/** Claude Code writes one record per API message; a reply to one prompt reads better as one turn. */
function toTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    const last = turns.at(-1);
    if (m.role === 'user') turns.push({ kind: 'user', id: m.id, text: userText(m) });
    else if (last?.kind === 'assistant') last.blocks.push(...m.blocks);
    else turns.push({ kind: 'assistant', id: m.id, blocks: [...m.blocks] });
  }
  return turns;
}

function toSegments(blocks: ChatBlock[]): Segment[] {
  const out: Segment[] = [];
  for (const b of blocks) {
    const last = out.at(-1);
    if (b.kind === 'text') out.push({ kind: 'text', key: `t${out.length}`, text: b.text });
    else if (last?.kind === 'tools') last.tools.push(b);
    else out.push({ kind: 'tools', key: b.id, tools: [b] });
  }
  return out;
}

/** Three or more calls in a row fold into one row, like Claude's own UI. */
function ToolGroup({ tools, running, cwd }: { tools: Tool[]; running: boolean; cwd: string | null }) {
  if (tools.length <= 2)
    return (
      <div className="space-y-1.5">
        {tools.map((t) => (
          <ToolCall key={t.id} tool={t} running={running} cwd={cwd} />
        ))}
      </div>
    );
  const pending = running && tools.some((t) => t.result === null);
  const failed = tools.filter((t) => t.isError).length;
  const names = [...new Set(tools.map((t) => t.name))];
  const latest = tools.at(-1)!;
  return (
    <details className="group/tools rounded-lg border border-border bg-card/60 open:bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-lg px-3 py-2 text-sm select-none hover:bg-raised/70 [&::-webkit-details-marker]:hidden">
        <StackIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">{tools.length} tool calls</span>
        <span translate="no" className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
          {pending ? (
            <span className="font-mono">
              {latest.name} {shortPath(latest.summary, cwd)}
            </span>
          ) : (
            names.join(', ')
          )}
        </span>
        {pending ? (
          <CircleNotchIcon
            className="size-4 shrink-0 animate-spin text-st-blue"
            aria-hidden={false}
            role="img"
            aria-label="Running"
          />
        ) : failed ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[13px] text-st-red">
            <XCircleIcon weight="fill" className="size-4" />
            {failed} failed
          </span>
        ) : (
          <CheckCircleIcon
            weight="fill"
            className="size-4 shrink-0 text-st-green"
            aria-hidden={false}
            role="img"
            aria-label="All done"
          />
        )}
      </summary>
      <div className="space-y-1.5 border-t border-border p-2">
        {tools.map((t) => (
          <ToolCall key={t.id} tool={t} running={running} cwd={cwd} />
        ))}
      </div>
    </details>
  );
}

const AssistantTurn = memo(function AssistantTurn({
  blocks,
  running,
  cwd,
}: {
  blocks: ChatBlock[];
  running: boolean;
  cwd: string | null;
}) {
  const segments = useMemo(() => toSegments(blocks), [blocks]);
  return (
    <div className="space-y-3">
      {segments.map((s) =>
        s.kind === 'text' ? (
          <ChatMarkdown key={s.key} text={s.text} />
        ) : (
          <ToolGroup key={s.key} tools={s.tools} running={running} cwd={cwd} />
        ),
      )}
    </div>
  );
});

function UserBubble({ text, note }: { text: string; note?: string }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div
        className={cn(
          'max-w-[85%] rounded-2xl rounded-br-md bg-raised px-4 py-2.5 text-[15px] leading-relaxed break-words whitespace-pre-wrap',
          note && 'text-muted-foreground',
        )}
      >
        {text}
      </div>
      {note && <span className="pr-1 text-[13px] text-muted-foreground">{note}</span>}
    </div>
  );
}

function Working() {
  return (
    <div className="flex items-center gap-2.5 text-[15px] text-muted-foreground" role="status">
      <span className="flex gap-1" aria-hidden>
        {[0, 150, 300].map((d) => (
          <span
            key={d}
            className="size-1.5 animate-pulse rounded-full bg-st-blue"
            style={{ animationDelay: `${d}ms` }}
          />
        ))}
      </span>
      Claude is working…
    </div>
  );
}

function WaitingCallout({ terminalHref }: { terminalHref: string }) {
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border border-st-yellow/40 bg-st-yellow/8 px-4 py-3">
      <HandPalmIcon weight="fill" className="mt-0.5 size-5 shrink-0 text-st-yellow" />
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium">Claude is waiting on you</p>
        <p className="text-sm text-muted-foreground">
          If it is showing a menu, like a permission prompt or a plan to approve, answer it in the terminal.
        </p>
      </div>
      <Button variant="secondary" size="sm" asChild>
        <Link href={terminalHref}>
          <TerminalWindowIcon />
          Show terminal
        </Link>
      </Button>
    </div>
  );
}

const SUGGESTIONS: Record<Role['kind'], string[]> = {
  control: [
    'Give me a status update on every task.',
    'What needs my attention right now?',
    'Start a new task: ',
  ],
  worker: ['Where are you at?', 'Show me your plan.', 'What is blocking you?'],
  other: ['Summarise what you have done so far.', 'What are you working on?'],
};

function EmptyState({
  role,
  note,
  onPick,
}: {
  role: Role;
  note: string | null;
  onPick: (s: string) => void;
}) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center px-4 py-16 text-center">
      <span className="grid size-12 place-items-center rounded-xl bg-raised">
        <ChatTeardropTextIcon className="size-6" />
      </span>
      <h2 className="mt-4 text-xl font-semibold">
        {role.kind === 'control' ? `Talk to the ${role.project} control chat` : 'Start the conversation'}
      </h2>
      <p className="mt-2 text-[15px] text-pretty text-muted-foreground">
        {note ?? 'No messages yet.'}{' '}
        {role.kind === 'control' && 'It plans work and starts a worker for each task.'}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {SUGGESTIONS[role.kind].map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="cursor-pointer rounded-full border border-border bg-card px-3.5 py-1.5 text-sm text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
          >
            {s.trim()}
          </button>
        ))}
      </div>
    </div>
  );
}

function ThreadSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading the conversation">
      <div className="flex justify-end">
        <Skeleton className="h-11 w-2/5 rounded-2xl" />
      </div>
      <div className="space-y-2.5">
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="mt-3 h-10 w-full rounded-lg" />
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-11 w-1/3 rounded-2xl" />
      </div>
    </div>
  );
}

const drafts = new Map<string, string>();

/** Claude-style message box: grows with the text, Enter sends, Shift+Enter adds a line. */
function ChatComposer({
  sessionId,
  label,
  value,
  onChange,
  onSent,
  inputRef,
}: {
  sessionId: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSent: (text: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value, inputRef]);

  const send = async () => {
    const text = value;
    if (!text.trim()) {
      setError('Write a message first.');
      inputRef.current?.focus();
      return;
    }
    setSending(true);
    setError(null);
    try {
      await sendJson('POST', `/api/sessions/${encodeURIComponent(sessionId)}/send`, { message: text });
      onChange('');
      onSent(text);
    } catch (e) {
      setError(
        `${e instanceof ApiError ? e.message : 'Could not send.'} Try again, or type in AoE directly.`,
      );
      toast.error('Message not sent');
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
      className="mx-auto w-full max-w-3xl px-4 pb-4"
    >
      <div
        className={cn(
          'rounded-2xl border border-border-strong bg-card shadow-float transition-shadow focus-within:border-ring/70 focus-within:ring-3 focus-within:ring-ring/25',
          error && 'border-st-red/60',
        )}
      >
        <label htmlFor="chat-input" className="sr-only">
          {label}
        </label>
        <textarea
          id="chat-input"
          ref={inputRef}
          name="message"
          rows={1}
          autoComplete="off"
          spellCheck
          value={value}
          placeholder="Reply to Claude…"
          aria-invalid={!!error || undefined}
          aria-describedby={error ? 'chat-error' : 'chat-help'}
          onChange={(e) => {
            onChange(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!sending) void send();
            }
          }}
          className="block max-h-60 min-h-12 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none"
        />
        <div className="flex items-center justify-between gap-3 px-3 pb-2.5 pl-4">
          <span id="chat-help" className="truncate text-[13px] text-muted-foreground">
            Enter to send, Shift+Enter for a new line
          </span>
          <button
            type="submit"
            aria-label={sending ? 'Sending' : 'Send message'}
            className={cn(
              'grid size-9 shrink-0 cursor-pointer place-items-center rounded-full bg-gradient-primary text-on-gradient shadow-[inset_0_1px_0_rgb(255_255_255/0.18)] transition hover:brightness-[0.94] active:scale-95',
              !value.trim() && 'opacity-45',
            )}
          >
            {sending ? (
              <CircleNotchIcon className="size-4 animate-spin" />
            ) : (
              <ArrowUpIcon weight="bold" className="size-4" />
            )}
          </button>
        </div>
      </div>
      {error ? (
        <p id="chat-error" role="alert" className="mt-2 text-center text-sm text-st-red">
          {error}
        </p>
      ) : (
        <p className="mt-2 text-center text-[13px] text-muted-foreground">
          Sent into the AoE session as a prompt. Every message is recorded in the audit log.
        </p>
      )}
    </form>
  );
}

function ChatHeader({
  session,
  title,
  role,
  view,
  basePath,
  rcUrl,
  aoeOrigin,
  embedded,
}: {
  session: SessionView;
  title: string;
  role: Role;
  view: 'chat' | 'terminal';
  basePath: string;
  rcUrl: string | null;
  aoeOrigin: string | null;
  /** Inside the task page, which already shows the title. */
  embedded: boolean;
}) {
  const context =
    role.kind === 'control' ? (
      <>
        Control chat for{' '}
        <Link
          href={`/p/${role.project}`}
          className="text-foreground underline decoration-border-strong underline-offset-3 hover:decoration-current"
        >
          {role.project}
        </Link>
      </>
    ) : role.kind === 'worker' ? (
      <>
        Worker for{' '}
        <Link
          href={`/p/${role.project}/t/${role.taskId}`}
          translate="no"
          className="font-mono text-foreground underline decoration-border-strong underline-offset-3 hover:decoration-current"
        >
          {role.taskId}
        </Link>
      </>
    ) : (
      <span translate="no" className="font-mono text-[13px]">
        {session.id}
      </span>
    );
  const attach = `aoe session attach ${session.id}`;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3 lg:px-6">
      {embedded ? (
        <div className="min-w-0 flex-1">
          <LiveStatus status={session.status} unread={session.unread} />
        </div>
      ) : (
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[17px] leading-snug font-semibold" title={title}>
            {title}
          </h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <LiveStatus status={session.status} unread={session.unread} />
            <span className="min-w-0 truncate">{context}</span>
          </div>
        </div>
      )}
      <nav aria-label="View" className="flex rounded-lg border border-border bg-background p-0.5">
        {(
          [
            ['chat', 'Chat', ChatTeardropTextIcon, basePath],
            ['terminal', 'Terminal', TerminalWindowIcon, `${basePath}?view=terminal`],
          ] as const
        ).map(([key, label, I, href]) => (
          <Link
            key={key}
            href={href}
            aria-current={view === key ? 'page' : undefined}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors',
              view === key
                ? 'bg-raised text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <I className="size-4" />
            {label}
          </Link>
        ))}
      </nav>
      {rcUrl && (
        <Button variant="outline" size="sm" asChild className="max-sm:hidden">
          <a href={rcUrl} target="_blank" rel="noreferrer">
            <ArrowSquareOutIcon />
            Open on claude.ai
          </a>
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="More session actions">
            <DotsThreeIcon weight="bold" className="size-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          {rcUrl && (
            <DropdownMenuItem asChild className="sm:hidden">
              <a href={rcUrl} target="_blank" rel="noreferrer">
                <ArrowSquareOutIcon />
                Open on claude.ai
              </a>
            </DropdownMenuItem>
          )}
          {aoeOrigin && (
            <DropdownMenuItem asChild>
              <a href={aoeOrigin} target="_blank" rel="noreferrer">
                <ArrowSquareOutIcon />
                Open in AoE
              </a>
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={async () => {
              if (await copyText(attach)) toast.success('Copied', { description: attach });
            }}
          >
            <CopyIcon />
            Copy attach command
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={async () => {
              if (await copyText(session.id)) toast.success('Copied the session id');
            }}
          >
            <CopyIcon />
            Copy session id
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** The chat for one AoE session: Claude's transcript rendered like Claude, with the raw terminal one click away. */
export function ChatPage({ snap, sessionId }: { snap: Snapshot; sessionId: string }) {
  const session = snap.sessions.find((s) => s.id === sessionId) ?? null;
  if (!session)
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <WarningCircleIcon className="mx-auto size-8 text-st-red" />
        <h1 className="mt-3 text-xl font-semibold">Session not found</h1>
        <p className="mt-2 text-[15px] text-muted-foreground">
          AoE has no live session{' '}
          <span translate="no" className="font-mono text-[13px]">
            {sessionId}
          </span>
          . It may have been removed or stopped.
        </p>
        <Link href="/" className="mt-4 inline-block text-[15px] underline">
          Back to the overview
        </Link>
      </div>
    );
  return <WorkerRedirect snap={snap} session={session} />;
}

/** A worker's chat lives on its task page (Chat tab); everything else stays here. */
function WorkerRedirect({ snap, session }: { snap: Snapshot; session: SessionView }) {
  const task = snap.tasks.find((t) => t.aoeSessionId === session.id);
  const [, navigate] = useLocation();
  const search = useSearch();
  useEffect(() => {
    if (task)
      navigate(`/p/${task.project}/t/${task.id}/chat${search ? `?${search}` : ''}`, { replace: true });
  }, [task, search, navigate]);
  if (task) return null;
  return <SessionChat key={session.id} snap={snap} session={session} />;
}

export function SessionChat({
  snap,
  session,
  basePath = `/chat/${encodeURIComponent(session.id)}`,
  embedded = false,
}: {
  snap: Snapshot;
  session: SessionView;
  basePath?: string;
  embedded?: boolean;
}) {
  const view = useSearchParam('view') === 'terminal' ? 'terminal' : 'chat';
  const role = useMemo(() => roleOf(snap, session.id), [snap, session.id]);
  const { chat, error, refresh } = useChat(session.id);
  const terminal = useSessionOutput(session.id, view === 'terminal' ? 2000 : 15_000);
  const [draft, setDraftState] = useState(() => drafts.get(session.id) ?? '');
  const setDraft = (v: string) => {
    drafts.set(session.id, v);
    setDraftState(v);
  };
  const [pending, setPending] = useState<Pending[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const turns = useMemo(() => toTurns(chat?.messages ?? []), [chat]);
  const title = chat?.title || (role.kind === 'worker' ? role.taskTitle : null) || session.title;
  const running = session.status === 'working';

  // A sent message shows straight away and is swapped for the real one once it reaches the transcript.
  useEffect(() => {
    if (!chat) return;
    setPending((p) =>
      p.filter(
        (x) =>
          Date.now() - x.sentAt < 10 * 60_000 &&
          !chat.messages.some(
            (m) =>
              m.role === 'user' &&
              Date.parse(m.at) >= x.sentAt - 15_000 &&
              userText(m).trim() === x.text.trim(),
          ),
      ),
    );
  }, [chat]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns, pending, running, view, snap.tasks, snap.sessions]);

  useEffect(() => {
    if (window.matchMedia('(pointer: fine)').matches) inputRef.current?.focus();
  }, []);

  const onAnswered = () => {
    stick.current = true;
    refresh();
    terminal.refresh();
  };
  const onSent = (text: string) => {
    stick.current = true;
    if (view === 'chat') setPending((p) => [...p, { key: Date.now(), text, sentAt: Date.now() }]);
    refresh();
    terminal.refresh();
  };
  const pick = (s: string) => {
    setDraft(s);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      el?.focus();
      el?.setSelectionRange(s.length, s.length);
    });
  };
  const jump = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const lastTurn = turns.at(-1);
  const empty = chat && turns.length === 0 && pending.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatHeader
        session={session}
        title={title}
        role={role}
        view={view}
        basePath={basePath}
        rcUrl={terminal.output?.rcUrl ?? null}
        aoeOrigin={snap.health.aoe.origin}
        embedded={embedded}
      />

      {view === 'terminal' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pt-4 lg:px-6">
          <Conversation
            content={terminal.output?.content ?? null}
            error={terminal.error}
            className="min-h-0 flex-1"
          />
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer select-none hover:text-foreground">
              Attach in a terminal instead
            </summary>
            <CommandLine command={`aoe session attach ${session.id}`} className="mt-2 max-w-xl" />
          </details>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          <div
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget;
              const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              stick.current = near;
              if (near !== atBottom) setAtBottom(near);
            }}
            role="log"
            aria-label={`Conversation with ${title}`}
            // Focusable so keyboard users can scroll the conversation.
            tabIndex={0}
            className="h-full overflow-y-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
          >
            <div className="mx-auto max-w-3xl space-y-7 px-4 pt-6 pb-10">
              {error && !chat && (
                <p role="alert" className="text-[15px] text-st-red">
                  {error} It retries by itself.
                </p>
              )}
              {!chat && !error && <ThreadSkeleton />}
              {chat?.state === 'unavailable' && (
                <p className="rounded-lg border border-border bg-card px-4 py-3 text-[15px] text-muted-foreground">
                  {chat.note}{' '}
                  <Link href={`${basePath}?view=terminal`} className="text-foreground underline">
                    Show terminal
                  </Link>
                </p>
              )}
              {empty && chat.state !== 'unavailable' && (
                <EmptyState role={role} note={chat.note} onPick={pick} />
              )}
              {!!chat?.truncated && (
                <p className="text-center text-sm text-muted-foreground">
                  {chat.truncated} earlier messages are not shown here. Attach in AoE for the full history.
                </p>
              )}
              {turns.map((t) =>
                t.kind === 'user' ? (
                  <UserBubble key={t.id} text={t.text} />
                ) : (
                  <AssistantTurn
                    key={t.id}
                    blocks={t.blocks}
                    running={running && t === lastTurn}
                    cwd={session.projectPath}
                  />
                ),
              )}
              {pending.map((p) => (
                <UserBubble key={p.key} text={p.text} note={running ? 'Queued. Claude is busy' : 'Sent'} />
              ))}
              {running && <Working />}
              {role.kind === 'control' && <WorkerAsks snap={snap} project={role.project!} />}
              {session.status === 'waiting' && !session.prompt && (
                <WaitingCallout terminalHref={`${basePath}?view=terminal`} />
              )}
              {session.status === 'error' && (
                <div
                  role="alert"
                  className="flex items-start gap-3 rounded-xl border border-st-red/40 bg-st-red/8 px-4 py-3"
                >
                  <WarningCircleIcon weight="fill" className="mt-0.5 size-5 shrink-0 text-st-red" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-medium">AoE reports an error for this session</p>
                    <p className="text-sm break-words text-muted-foreground">
                      {session.lastError ?? 'No details from AoE.'} The terminal shows what the session last
                      printed.
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" asChild>
                    <Link href={`${basePath}?view=terminal`}>
                      <TerminalWindowIcon />
                      Show terminal
                    </Link>
                  </Button>
                </div>
              )}
              {session.status === 'stopped' && (
                <p className="text-center text-sm text-muted-foreground">
                  This session is {LIVE_STATUS_LABEL.stopped.toLowerCase()}. Sending a message starts it
                  again.
                </p>
              )}
            </div>
          </div>
          {!atBottom && (
            <button
              type="button"
              onClick={jump}
              className="absolute bottom-3 left-1/2 inline-flex h-9 -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border border-border-strong bg-card px-3.5 text-sm shadow-float hover:bg-raised"
            >
              <ArrowDownIcon className="size-4" />
              Jump to latest
            </button>
          )}
        </div>
      )}

      <div className={cn(view === 'terminal' && 'pt-3')}>
        {session.prompt ? (
          // While a menu is open a typed message would pick its highlighted option, so answer it here instead.
          <div className="mx-auto max-h-[62dvh] w-full max-w-3xl overflow-y-auto overscroll-contain px-4 pb-4">
            <PromptCard session={session} onAnswered={onAnswered} />
          </div>
        ) : (
          <ChatComposer
            sessionId={session.id}
            label={`Message ${title}`}
            value={draft}
            onChange={setDraft}
            onSent={onSent}
            inputRef={inputRef}
          />
        )}
      </div>
    </div>
  );
}

/**
 * In a control chat, what its workers are waiting on you for, as answer cards at the end of the
 * conversation: the parent is where you manage its children, so their questions are asked here.
 */
function WorkerAsks({ snap, project }: { snap: Snapshot; project: string }) {
  const asks = snap.tasks
    .filter((t) => t.project === project && t.stage !== 'done')
    .map((t) => ({ task: t, session: snap.sessions.find((s) => s.id === t.aoeSessionId) ?? null }))
    .filter(({ task, session }) => hasAsk(task, session));
  if (!asks.length) return null;
  return (
    <section aria-labelledby="worker-asks" className="space-y-4">
      <h2 id="worker-asks" className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
        <HandPalmIcon weight="fill" className="size-4 text-st-yellow" />
        {asks.length === 1 ? 'A worker is asking you' : `${asks.length} workers are asking you`}
      </h2>
      {asks.map(({ task, session }) => (
        <TaskAsks key={task.id} task={task} session={session} showTask />
      ))}
    </section>
  );
}
