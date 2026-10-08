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
  FileIcon,
  PaperclipIcon,
  XIcon,
  SidebarSimpleIcon,
  BroomIcon,
  ArrowUUpLeftIcon,
  CpuIcon,
  ArrowClockwiseIcon,
} from '@phosphor-icons/react';
import {
  LIVE_STATUS_LABEL,
  MODEL_ALIASES,
  MODELS_55_SINCE,
  modelMatches,
  prettyModel,
  versionAtLeast,
  type ChatBlock,
  type ChatMessage,
  type ChatResponse,
  type SessionView,
  type Snapshot,
  contextWindow,
  splitAttachments,
  withAttachments,
} from '@aoe-supercharge/core/shared';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Link, useLocation, useSearch } from 'wouter';
import { hasAsk, PromptCard, TaskAsks } from '@/components/answer';
import { AnnotateDialog } from '@/components/chat/annotate';
import { ChatMarkdown } from '@/components/chat/markdown';
import { ModelMenu } from '@/components/chat/model-menu';
import { RunCommand } from '@/components/chat/run-command';
import { EarlierTerminals } from '@/components/chat/run-terminals';
import { NoticeRow } from '@/components/chat/notice';
import { useSlashMenu } from '@/components/chat/slash-menu';
import { ControlPanel } from '@/components/control-panel';
import { shortPath, ToolCall } from '@/components/chat/tool-call';
import { useChat } from '@/components/chat/use-chat';
import { useMarkRead } from '@/components/chat/use-mark-read';
import { CommandLine, copyText } from '@/components/copy';
import { Conversation, useSessionOutput } from '@/components/session-chat';
import { LiveStatus } from '@/components/status';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, sendJson, uploadFile } from '@/lib/api';
import { HeaderActions } from '@/lib/header-slot';
import { useSearchParam } from '@/lib/nav';
import { useRunTerminals } from '@/lib/run-terminals';
import { hasShellRuns, useShellRunVersion } from '@/lib/shell-runs';
import { cn } from '@/lib/utils';

type Tool = Extract<ChatBlock, { kind: 'tool' }>;
type Shell = Extract<ChatBlock, { kind: 'shell' }>;
type Notice = Extract<ChatBlock, { kind: 'notice' }>;
type Turn =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'shell'; id: string; run: Shell }
  | { kind: 'notices'; id: string; items: { id: string; at: string; notice: Notice['notice'] }[] }
  | { kind: 'assistant'; id: string; blocks: ChatBlock[] };
type Segment = { kind: 'text'; key: string; text: string } | { kind: 'tools'; key: string; tools: Tool[] };

interface Pending {
  key: number;
  /** The message, or `!command` for a command run in shell mode. */
  text: string;
  shell?: boolean;
  sentAt: number;
  /** Local previews of images sent with it, until the transcript has the message. */
  previews: string[];
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

/** What you typed: the text, or `!command` for shell mode (how a pending send finds its record). */
const userText = (m: ChatMessage) =>
  m.blocks.map((b) => (b.kind === 'text' ? b.text : b.kind === 'shell' ? `!${b.command}` : '')).join('\n\n');

/** Compared loosely: a paste can come back with its spacing or line ends changed. */
const loose = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Claude Code writes one record per API message; a reply to one prompt reads better as one turn. */
function toTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    const last = turns.at(-1);
    const run = m.blocks.find((b): b is Shell => b.kind === 'shell');
    if (m.role === 'notice') {
      // Notices in a row stack together.
      const group = last?.kind === 'notices' ? last : { kind: 'notices' as const, id: m.id, items: [] };
      if (group !== last) turns.push(group);
      for (const b of m.blocks)
        if (b.kind === 'notice') group.items.push({ id: m.id, at: m.at, notice: b.notice });
    } else if (m.role === 'user')
      turns.push(run ? { kind: 'shell', id: m.id, run } : { kind: 'user', id: m.id, text: userText(m) });
    else if (last?.kind === 'assistant') last.blocks.push(...m.blocks);
    else turns.push({ kind: 'assistant', id: m.id, blocks: [...m.blocks] });
  }
  return turns;
}

function toSegments(blocks: ChatBlock[]): Segment[] {
  const out: Segment[] = [];
  for (const b of blocks) {
    const last = out.at(-1);
    if (b.kind === 'shell' || b.kind === 'notice') continue;
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
        <span translate="no" className="min-w-0 flex-1 truncate text-[0.8125rem] text-muted-foreground">
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
          <span className="inline-flex shrink-0 items-center gap-1 text-[0.8125rem] text-st-red">
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
  turnId,
  blocks,
  running,
  cwd,
  onRun,
}: {
  turnId: string;
  blocks: ChatBlock[];
  running: boolean;
  cwd: string | null;
  onRun: (command: string, anchor?: string) => void;
}) {
  const segments = useMemo(() => toSegments(blocks), [blocks]);
  return (
    <div className="space-y-3">
      {segments.map((s) =>
        s.kind === 'text' ? (
          <ChatMarkdown key={s.key} text={s.text} onRun={onRun} anchorKey={`${turnId}:${s.key}`} />
        ) : (
          <ToolGroup key={s.key} tools={s.tools} running={running} cwd={cwd} />
        ),
      )}
    </div>
  );
});

function UserBubble({ text, note }: { text: string; note?: string }) {
  const { text: body, files } = useMemo(() => splitAttachments(text), [text]);
  const images = files.filter((f) => f.image && f.url);
  const others = files.filter((f) => !(f.image && f.url));
  return (
    <div className="flex flex-col items-end gap-1.5">
      {images.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
          {images.map((f) => (
            <a key={f.path} href={f.url!} target="_blank" rel="noreferrer" title={f.name}>
              <img
                src={f.url!}
                alt={f.name}
                loading="lazy"
                className="max-h-56 max-w-full rounded-xl border border-border object-contain"
              />
            </a>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <ul className="flex max-w-[85%] flex-wrap justify-end gap-2">
          {others.map((f) => (
            <li key={f.path}>
              <a
                href={f.url ?? undefined}
                className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm"
                title={f.path}
              >
                <FileIcon className="size-4 text-muted-foreground" />
                <span translate="no" className="max-w-56 truncate">
                  {f.name}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {body && (
        <div
          className={cn(
            'max-w-[85%] rounded-2xl rounded-br-md bg-raised px-4 py-2.5 text-[0.9375rem] leading-relaxed break-words whitespace-pre-wrap',
            note && 'text-muted-foreground',
          )}
        >
          {body}
        </div>
      )}
      {note && <span className="pr-1 text-[0.8125rem] text-muted-foreground">{note}</span>}
    </div>
  );
}

/** A command you ran in shell mode (`!`) and what it printed, on your side of the conversation. */
function ShellRun({
  command,
  stdout,
  stderr,
  note,
}: {
  command: string;
  stdout: string | null;
  stderr: string;
  note?: string;
}) {
  const out = stdout?.replace(/\n+$/, '') ?? '';
  const err = stderr.replace(/\n+$/, '');
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="w-full max-w-[85%] overflow-hidden rounded-2xl rounded-br-md border border-border bg-background">
        <div className="flex items-center gap-2 border-b border-border px-3.5 py-1.5 text-[0.8125rem] text-muted-foreground">
          <TerminalWindowIcon className="size-4" />
          You ran
        </div>
        <pre
          translate="no"
          className="overflow-x-auto px-3.5 py-2.5 font-mono text-[0.8125rem] leading-relaxed break-words whitespace-pre-wrap"
        >
          <span className="text-st-green select-none">! </span>
          {command}
        </pre>
        {stdout !== null && (
          <pre
            translate="no"
            aria-label="Output"
            className="max-h-80 overflow-auto border-t border-border px-3.5 py-2.5 font-mono text-[0.8125rem] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground"
          >
            {out}
            {out && err && '\n'}
            {err && <span className="text-st-red">{err}</span>}
            {!out && !err && '(no output)'}
          </pre>
        )}
      </div>
      {note && <span className="pr-1 text-[0.8125rem] text-muted-foreground">{note}</span>}
    </div>
  );
}

function Working() {
  return (
    <div className="flex items-center gap-2.5 text-[0.9375rem] text-muted-foreground" role="status">
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
        <p className="text-[0.9375rem] font-medium">Claude is waiting on you</p>
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
      <p className="mt-2 text-[0.9375rem] text-pretty text-muted-foreground">
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

/** Pick, paste or drop files here; images open in the mark-up editor before they are sent. */
interface PendingFile {
  id: number;
  name: string;
  blob: Blob;
  preview: string | null;
}

const isImage = (f: Blob) => /^image\/(png|jpe?g|gif|webp)$/.test(f.type);

/** How full the session's context is, as a small ring (like Claude Code's own meter). */
/** From here on every message resends a lot: Start fresh gets louder. */
const LONG_CHAT_TOKENS = 150_000;

/** Start fresh, next to the context meter: there whenever there is a conversation, louder once it is long. */
function FreshButton({ tokens, onClick }: { tokens: number | null; onClick: () => void }) {
  if (!tokens) return null;
  const long = tokens >= LONG_CHAT_TOKENS;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn('h-8 gap-1.5 px-2 text-xs', long ? 'text-st-yellow' : 'text-muted-foreground')}
      title="Clear this conversation (/clear). Long conversations use more of your limit with every message."
      onClick={onClick}
    >
      <BroomIcon className="size-4" />
      {long ? 'Long chat: start fresh' : 'Start fresh'}
    </Button>
  );
}

function ContextMeter({ tokens, model }: { tokens: number | null; model: string | null }) {
  if (!tokens) return null;
  const windowSize = contextWindow(model);
  const pct = Math.min(100, Math.round((tokens / windowSize) * 100));
  const color = pct >= 85 ? 'text-st-red' : pct >= 60 ? 'text-st-yellow' : 'text-muted-foreground';
  const r = 6.5;
  const c = 2 * Math.PI * r;
  return (
    <span
      className={cn('inline-flex h-8 items-center gap-1.5 px-1.5 text-xs tabular', color)}
      title={`${tokens.toLocaleString()} of ${windowSize.toLocaleString()} tokens in context`}
    >
      <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden>
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeWidth="2.5"
        />
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
          strokeLinecap="round"
        />
      </svg>
      <span>
        {pct}%<span className="sr-only"> of the context window used</span>
      </span>
    </span>
  );
}

/** "Working 12s" while Claude runs, like the terminal's own spinner line. */
function WorkingClock({ since }: { since: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = since ? Math.max(0, Math.round((now - Date.parse(since)) / 1000)) : null;
  const label = secs === null ? '' : secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return (
    <span className="inline-flex h-8 items-center gap-1.5 px-1.5 text-xs text-st-blue" role="status">
      <CircleNotchIcon className="size-3.5 animate-spin" />
      Working{label && <span className="tabular text-muted-foreground">{label}</span>}
    </span>
  );
}

/**
 * Claude-style message box. Images (pasted, dropped or picked) open in the mark-up editor first; other
 * files ride along as chips. Attachments are uploaded next to the session and sent as paths Claude
 * opens. Under the text: attach, model and effort, the context meter, and progress.
 */
function ChatComposer({
  session,
  label,
  value,
  onChange,
  onSent,
  inputRef,
  model,
  effort,
  contextTokens,
  onStartFresh,
}: {
  session: SessionView;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSent: (text: string, previews: string[]) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  model: string | null;
  effort: string | null;
  contextTokens: number | null;
  onStartFresh: () => void;
}) {
  const sessionId = session.id;
  const [caret, setCaret] = useState(0);
  const slash = useSlashMenu({ sessionId, value, caret, onChange, inputRef });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [editing, setEditing] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value, inputRef]);
  useEffect(() => () => files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview)), []);

  const addFile = (blob: Blob, name: string) =>
    setFiles((fs) => [
      ...fs,
      { id: ++seq.current, name, blob, preview: isImage(blob) ? URL.createObjectURL(blob) : null },
    ]);
  const take = (list: FileList | File[]) => {
    const all = [...list];
    const images = all.filter(isImage);
    for (const f of all.filter((f) => !isImage(f))) addFile(f, f.name || 'file');
    if (images.length) setEditing((q) => [...q, ...images]);
    setError(null);
  };

  const deliver = async (text: string, extra: { blob: Blob; name: string }[] = []) => {
    const outgoing = [...files.map((f) => ({ blob: f.blob, name: f.name })), ...extra];
    if (!text.trim() && !outgoing.length) {
      setError('Write a message first.');
      inputRef.current?.focus();
      return false;
    }
    setSending(true);
    setError(null);
    try {
      const saved = await Promise.all(outgoing.map((f) => uploadFile(sessionId, f.blob, f.name)));
      const message = withAttachments(
        text,
        saved.map((s) => s.path),
      );
      await sendJson('POST', `/api/sessions/${encodeURIComponent(sessionId)}/send`, { message });
      onChange('');
      onSent(
        message,
        saved.filter((s) => /\.(png|jpe?g|gif|webp)$/i.test(s.file)).map((s) => s.url),
      );
      setFiles([]);
      return true;
    } catch (e) {
      setError(
        `${e instanceof ApiError ? e.message : 'Could not send.'} Try again, or type in AoE directly.`,
      );
      toast.error('Message not sent');
      return false;
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void deliver(value);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        take(e.dataTransfer.files);
      }}
      className="mx-auto w-full max-w-3xl px-4 pb-3"
    >
      <div
        className={cn(
          'relative rounded-2xl border border-border-strong bg-card shadow-float transition-shadow focus-within:border-ring/70 focus-within:ring-3 focus-within:ring-ring/25',
          error && 'border-st-red/60',
          dragging && 'border-ring ring-3 ring-ring/30',
        )}
      >
        {slash.list}
        {files.length > 0 && (
          <ul aria-label="Attachments" className="flex flex-wrap gap-2 px-3 pt-3">
            {files.map((f) => (
              <li key={f.id} className="group/file relative">
                {f.preview ? (
                  <img
                    src={f.preview}
                    alt={f.name}
                    className="h-16 rounded-lg border border-border object-cover"
                  />
                ) : (
                  <span className="flex h-16 max-w-48 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm">
                    <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{f.name}</span>
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => {
                    if (f.preview) URL.revokeObjectURL(f.preview);
                    setFiles((fs) => fs.filter((x) => x.id !== f.id));
                  }}
                  className="absolute -top-2 -right-2 grid size-6 cursor-pointer place-items-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:text-foreground"
                >
                  <XIcon className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
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
          {...slash.inputProps}
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart);
            if (error) setError(null);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files];
            if (!pasted.length) return;
            e.preventDefault();
            take(pasted);
          }}
          onKeyDown={(e) => {
            if (slash.onKeyDown(e)) return;
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!sending) void deliver(value);
            }
          }}
          className="block max-h-60 min-h-11 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[0.9375rem] leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none"
        />
        <div className="flex items-center gap-1 px-2 pb-1.5">
          <input
            ref={picker}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              if (e.target.files) take(e.target.files);
              e.target.value = '';
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-8 text-muted-foreground"
            aria-label="Attach files"
            title="Attach files (or paste, or drop them here)"
            onClick={() => picker.current?.click()}
          >
            <PaperclipIcon className="size-4" />
          </Button>
          <ModelMenu sessionId={sessionId} model={model} effort={effort} disabled={!!session.prompt} />
          <ContextMeter tokens={contextTokens} model={model} />
          <FreshButton tokens={contextTokens} onClick={onStartFresh} />
          <span className="flex-1" />
          {session.status === 'working' && <WorkingClock since={session.statusSince} />}
          <button
            type="submit"
            aria-label={sending ? 'Sending' : 'Send message'}
            title="Send. Every message is recorded in the audit log."
            className={cn(
              'grid size-8 shrink-0 cursor-pointer place-items-center rounded-full bg-gradient-primary text-on-gradient shadow-[inset_0_1px_0_rgb(255_255_255/0.18)] transition hover:brightness-[0.94] active:scale-95',
              !value.trim() && !files.length && 'opacity-45',
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
      <p id="chat-help" className="sr-only">
        Enter sends, Shift+Enter adds a line. Paste or drop images to mark them up first. Sent into the AoE
        session as a prompt and recorded in the audit log.
      </p>
      {error && (
        <p id="chat-error" role="alert" className="mt-1.5 text-center text-sm text-st-red">
          {error}
        </p>
      )}
      <AnnotateDialog
        image={editing[0] ?? null}
        initialText={value}
        onClose={() => setEditing((q) => q.slice(1))}
        onSend={async (png, text) => {
          if (await deliver(text, [{ blob: png, name: 'screenshot.png' }])) setEditing((q) => q.slice(1));
        }}
        onAttach={(png, text) => {
          addFile(png, 'screenshot.png');
          onChange(text);
          setEditing((q) => q.slice(1));
        }}
      />
    </form>
  );
}

/** An archived session has no running Claude: say so, and offer to bring it back where it left off. */
function ArchivedNotice({ session }: { session: SessionView }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="mx-auto mb-3 flex w-full max-w-3xl flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <p className="text-[0.9375rem] text-muted-foreground">
        This session is archived: Claude is stopped, and its worktree and branch are kept. Unarchive it to
        pick up the conversation where it left off.
      </p>
      <Button
        size="sm"
        disabled={busy || session.locked}
        onClick={async () => {
          setBusy(true);
          try {
            const { results } = await sendJson<{ results: { ok: boolean; error?: string }[] }>(
              'POST',
              '/api/sessions/actions',
              { action: 'unarchive', ids: [session.id] },
            );
            if (results[0]?.ok) toast.success('Unarchived');
            else toast.error('Could not unarchive it', { description: results[0]?.error });
          } catch (e) {
            toast.error('Could not unarchive it', {
              description: e instanceof ApiError ? e.message : undefined,
            });
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <CircleNotchIcon className="animate-spin" /> : <ArrowUUpLeftIcon />}
        Unarchive
      </Button>
    </div>
  );
}

/**
 * A control chat that is not on the model Supercharge starts control chats on (agent.controlModel), or
 * that still runs an older Claude Code than the one installed. A control chat AoE started follows your
 * Claude Code default model, and a running chat keeps the Claude Code it started with.
 */
function ControlModelNotice({ session, chat }: { session: SessionView; chat: ChatResponse }) {
  const [ask, setAsk] = useState<'switch' | 'restart' | null>(null);
  const [busy, setBusy] = useState(false);
  const wanted = chat.expectedModel ?? null;
  const wrongModel = modelMatches(chat.model, wanted) === false;
  const oldClaude =
    versionAtLeast(chat.claudeVersion, MODELS_55_SINCE) === false &&
    versionAtLeast(chat.installedClaude, MODELS_55_SINCE) === true;
  if (!wrongModel && !oldClaude) return null;
  const alias = wanted && (MODEL_ALIASES as readonly string[]).includes(wanted) ? wanted : null;
  const name = alias ? alias.charAt(0).toUpperCase() + alias.slice(1) : wanted;
  const blocked = session.status === 'working' || session.locked;

  const act = async () => {
    setBusy(true);
    try {
      if (ask === 'switch') {
        await sendJson('POST', `/api/sessions/${encodeURIComponent(session.id)}/model`, { model: alias });
        toast.success(`Switching the control chat to ${name}`);
      } else {
        // Stop, then start: AoE relaunches Claude on the installed Claude Code and resumes the conversation.
        for (const action of ['stop', 'start'] as const) {
          const { results } = await sendJson<{ results: { ok: boolean; error?: string }[] }>(
            'POST',
            '/api/sessions/actions',
            { action, ids: [session.id] },
          );
          if (!results[0]?.ok) throw new Error(results[0]?.error ?? `Could not ${action} it`);
        }
        toast.success('Restarting the control chat', { description: 'It picks the conversation back up.' });
      }
      setAsk(null);
    } catch (e) {
      toast.error(ask === 'switch' ? 'Model not changed' : 'Could not restart it', {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mb-3 flex w-full max-w-3xl flex-wrap items-center justify-between gap-3 rounded-xl border border-st-yellow/40 bg-st-yellow/5 px-4 py-3">
      <p className="min-w-0 flex-1 text-[0.9375rem] text-muted-foreground">
        {wrongModel ? (
          <>
            The control chat is on <span className="text-foreground">{prettyModel(chat.model!)}</span>
            {chat.model === 'opusplan' && ', which answers with Sonnet outside plan mode'}. It plans and
            judges all the work, so Supercharge runs control chats on {name}.
          </>
        ) : (
          <>
            This chat still runs Claude Code {chat.claudeVersion}, where Opus means Opus 5. Restart it to move
            it to {chat.installedClaude} and the 5.5 models; it picks the conversation back up.
          </>
        )}
      </p>
      {wrongModel ? (
        alias && (
          <Button size="sm" disabled={blocked} onClick={() => setAsk('switch')}>
            <CpuIcon />
            Switch to {name}
          </Button>
        )
      ) : (
        <Button size="sm" disabled={blocked} onClick={() => setAsk('restart')}>
          <ArrowClockwiseIcon />
          Restart
        </Button>
      )}
      <AlertDialog open={ask !== null} onOpenChange={(o) => !o && setAsk(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {ask === 'switch' ? `Switch the control chat to ${name}?` : 'Restart the control chat?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {ask === 'switch'
                ? `Supercharge types /model ${alias} into it. Claude Code also saves ${name} as your default for new Claude Code sessions (in ~/.claude/settings.json), including outside Supercharge. That default is also what keeps this chat on ${name} when AoE restarts it.`
                : 'Supercharge stops it and starts it again through AoE. Claude comes back on the Claude Code installed now and resumes this conversation. Anything it is doing right now stops.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void act();
              }}
            >
              {busy && <CircleNotchIcon className="animate-spin" />}
              {ask === 'switch' ? `Switch to ${name}` : 'Restart'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Clear the conversation with /clear. Long conversations resend everything with each message, so a
 * fresh one per story keeps your usage down; Supercharge keeps the task, plan and stage either way.
 */
function StartFresh({
  session,
  role,
  open,
  onOpenChange,
}: {
  session: SessionView;
  role: Role;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const confirm = useRef<HTMLButtonElement>(null);
  const clear = async () => {
    setBusy(true);
    try {
      await sendJson('POST', `/api/sessions/${encodeURIComponent(session.id)}/send`, { message: '/clear' });
      toast.success('Started a fresh conversation');
      onOpenChange(false);
    } catch (e) {
      toast.error('Could not clear the conversation', {
        description: e instanceof ApiError ? e.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };
  const kept =
    role.kind === 'control'
      ? 'Your tasks, workers, plans and notes stay in Supercharge, and the control chat catches up from them when you next ask it something.'
      : role.kind === 'worker'
        ? `${role.taskId}'s brief, stage and approved plan stay in Supercharge; the worker reads them back with supercharge whoami.`
        : 'Nothing is kept for this session: it is not part of a Supercharge project.';
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        // Enter clears, Escape cancels; while it can't clear, Cancel keeps the focus.
        onOpenAutoFocus={(e) => {
          if (confirm.current?.disabled !== false) return;
          e.preventDefault();
          confirm.current.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Start a fresh conversation?</AlertDialogTitle>
          <AlertDialogDescription>
            Supercharge types /clear into this session. Claude forgets this conversation, so every message
            after that costs less of your limit. {kept}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            ref={confirm}
            disabled={busy || session.status === 'working' || session.locked}
            onClick={(e) => {
              e.preventDefault();
              void clear();
            }}
          >
            {busy ? <CircleNotchIcon className="animate-spin" /> : <BroomIcon />}
            {session.locked
              ? 'Locked: unlock it first'
              : session.status === 'working'
                ? 'Wait until Claude is done'
                : 'Clear conversation'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
  panel,
  onStartFresh,
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
  /** Control chats: the side panel's show/hide switch. */
  panel?: { open: boolean; toggle: () => void };
  onStartFresh: () => void;
}) {
  const attach = `aoe session attach ${session.id}`;
  return (
    <HeaderActions>
      {!embedded && (
        <span className="hidden max-w-56 truncate text-sm text-muted-foreground xl:block" title={title}>
          {title}
        </span>
      )}
      <LiveStatus status={session.status} unread={session.unread} className="max-sm:[&>span]:sr-only" />
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
              'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors',
              view === key
                ? 'bg-raised text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <I className="size-4" />
            <span className="max-sm:sr-only">{label}</span>
          </Link>
        ))}
      </nav>
      {rcUrl && (
        <Button variant="outline" size="icon-sm" asChild className="size-8">
          <a
            href={rcUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="Open on claude.ai"
            title="Open on claude.ai"
          >
            <ArrowSquareOutIcon />
          </a>
        </Button>
      )}
      {panel && (
        <Button
          variant={panel.open ? 'secondary' : 'outline'}
          size="sm"
          className="h-8"
          aria-pressed={panel.open}
          title={panel.open ? 'Hide the project panel' : 'Show the project panel: notes, plans and comments'}
          onClick={panel.toggle}
        >
          <SidebarSimpleIcon className="size-4 -scale-x-100" weight={panel.open ? 'fill' : 'regular'} />
          <span className="max-sm:sr-only">Panel</span>
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="size-8" aria-label="More session actions">
            <DotsThreeIcon weight="bold" className="size-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
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
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onStartFresh}>
            <BroomIcon />
            Start fresh (/clear)…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </HeaderActions>
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
        <p className="mt-2 text-[0.9375rem] text-muted-foreground">
          AoE has no live session{' '}
          <span translate="no" className="font-mono text-[0.8125rem]">
            {sessionId}
          </span>
          . It may have been removed or stopped.
        </p>
        <Link href="/" className="mt-4 inline-block text-[0.9375rem] underline">
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
  const [panelOpen, setPanelOpen] = usePanelOpen();
  const [fresh, setFresh] = useState(false);
  const role = useMemo(() => roleOf(snap, session.id), [snap, session.id]);
  const { chat, error, refresh } = useChat(session.id);
  useMarkRead(session.id, !!session.unread);
  const terminal = useSessionOutput(session.id, view === 'terminal' ? 2000 : 15_000);
  const [draft, setDraftState] = useState(() => drafts.get(session.id) ?? '');
  const setDraft = (v: string) => {
    drafts.set(session.id, v);
    setDraftState(v);
  };
  const [pending, setPending] = useState<Pending[]>([]);
  const [run, setRun] = useState<{ command: string; anchor?: string; open: boolean }>({
    command: '',
    open: false,
  });
  const askToRun = useCallback(
    (command: string, anchor?: string) => setRun({ command, anchor, open: true }),
    [],
  );
  useRunTerminals(session.id);
  // Run in control shell opens the side panel, whose Shell tab runs it.
  const shellRuns = useShellRunVersion();
  useEffect(() => {
    if (role.kind === 'control' && hasShellRuns(session.id)) setPanelOpen(true);
    // setPanelOpen is a new function each render; the run version is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellRuns, role.kind, session.id]);
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
              loose(userText(m)) === loose(x.text),
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
  const onSent = (text: string, previews: string[] = [], shell = false) => {
    stick.current = true;
    if (view === 'chat')
      setPending((p) => [...p, { key: Date.now(), text, sentAt: Date.now(), previews, shell }]);
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
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {!embedded && <h1 className="sr-only">{title}</h1>}
        <ChatHeader
          session={session}
          title={title}
          role={role}
          view={view}
          basePath={basePath}
          rcUrl={terminal.output?.rcUrl ?? null}
          aoeOrigin={snap.health.aoe.origin}
          embedded={embedded}
          panel={
            role.kind === 'control' ? { open: panelOpen, toggle: () => setPanelOpen(!panelOpen) } : undefined
          }
          onStartFresh={() => setFresh(true)}
        />
        <StartFresh session={session} role={role} open={fresh} onOpenChange={setFresh} />
        <RunCommand
          session={session}
          command={run.command}
          anchor={run.anchor}
          open={run.open}
          onOpenChange={(open) => setRun((r) => ({ ...r, open }))}
          onRan={(command) => onSent(`!${command}`, [], true)}
          controlShell={role.kind === 'control'}
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
              <div className="mx-auto max-w-3xl space-y-7 px-4 pt-5 pb-6">
                {error && !chat && (
                  <p role="alert" className="text-[0.9375rem] text-st-red">
                    {error} It retries by itself.
                  </p>
                )}
                {!chat && !error && <ThreadSkeleton />}
                {chat?.state === 'unavailable' && (
                  <p className="rounded-lg border border-border bg-card px-4 py-3 text-[0.9375rem] text-muted-foreground">
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
                  ) : t.kind === 'notices' ? (
                    <div key={t.id} className="space-y-1.5">
                      {t.items.map((n) => (
                        <NoticeRow key={n.id} notice={n.notice} at={n.at} sessions={snap.sessions} />
                      ))}
                    </div>
                  ) : t.kind === 'shell' ? (
                    <ShellRun
                      key={t.id}
                      command={t.run.command}
                      stdout={t.run.stdout}
                      stderr={t.run.stderr}
                    />
                  ) : (
                    <AssistantTurn
                      key={t.id}
                      turnId={t.id}
                      blocks={t.blocks}
                      running={running && t === lastTurn}
                      cwd={session.projectPath}
                      onRun={askToRun}
                    />
                  ),
                )}
                {pending.map((p) =>
                  p.shell ? (
                    <ShellRun key={p.key} command={p.text.slice(1)} stdout={null} stderr="" note="Running…" />
                  ) : (
                    <UserBubble
                      key={p.key}
                      text={p.text}
                      note={running ? 'Queued. Claude is busy' : 'Sent'}
                    />
                  ),
                )}
                {chat && <EarlierTerminals sessionId={session.id} />}
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
                      <p className="text-[0.9375rem] font-medium">AoE reports an error for this session</p>
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
          {session.archived ? (
            <ArchivedNotice session={session} />
          ) : session.prompt ? (
            // While a menu is open a typed message would pick its highlighted option, so answer it here instead.
            <div className="mx-auto max-h-[62dvh] w-full max-w-3xl overflow-y-auto overscroll-contain px-4 pb-3">
              <PromptCard session={session} onAnswered={onAnswered} />
            </div>
          ) : (
            <>
              {role.kind === 'control' && chat && <ControlModelNotice session={session} chat={chat} />}
              <ChatComposer
                session={session}
                label={`Message ${title}`}
                value={draft}
                onChange={setDraft}
                onSent={onSent}
                inputRef={inputRef}
                model={chat?.model ?? null}
                effort={chat?.effort ?? null}
                contextTokens={chat?.contextTokens ?? null}
                onStartFresh={() => setFresh(true)}
              />
            </>
          )}
        </div>
      </div>
      {role.kind === 'control' && panelOpen && (
        <SidePanel onClose={() => setPanelOpen(false)}>
          <ControlPanel snap={snap} project={role.project!} onHide={() => setPanelOpen(false)} />
        </SidePanel>
      )}
    </div>
  );
}

const PANEL_WIDTH_KEY = 'supercharge.panelWidth';
const PANEL_OPEN_KEY = 'supercharge.panelOpen';
const clampWidth = (w: number) =>
  Math.round(Math.min(Math.max(w, 300), Math.max(360, window.innerWidth * 0.6)));

/** Whether the control chat's side panel shows; remembered per browser, open by default on wide screens. */
function usePanelOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(PANEL_OPEN_KEY);
      if (stored !== null) return stored === '1';
    } catch {
      // fall through to the screen-size default
    }
    return window.matchMedia('(min-width: 1024px)').matches;
  });
  return [
    open,
    (v: boolean) => {
      setOpen(v);
      try {
        localStorage.setItem(PANEL_OPEN_KEY, v ? '1' : '0');
      } catch {
        // per-viewer convenience only
      }
    },
  ];
}

/** The resizable right column: drag its left edge (or focus it and use the arrow keys). */
function SidePanel({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const [width, setWidth] = useState(() => {
    try {
      return clampWidth(Number(localStorage.getItem(PANEL_WIDTH_KEY)) || 420);
    } catch {
      return 420;
    }
  });
  const persist = (w: number) => {
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(w));
    } catch {
      // per-viewer convenience only
    }
  };
  const drag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let last = startW;
    const move = (ev: PointerEvent) => {
      last = clampWidth(startW + (startX - ev.clientX));
      setWidth(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.removeProperty('cursor');
      persist(last);
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <aside
      aria-label="Project panel"
      style={{ '--panel-w': `${width}px` } as React.CSSProperties}
      onKeyDown={(e) => e.key === 'Escape' && window.innerWidth < 1024 && onClose()}
      className="relative flex min-h-0 shrink-0 flex-col border-l border-border bg-surface max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:w-[min(100vw,26rem)] max-lg:shadow-float lg:w-[var(--panel-w)]"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the panel"
        aria-valuenow={width}
        aria-valuemin={300}
        tabIndex={0}
        onPointerDown={drag}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          const next = clampWidth(width + (e.key === 'ArrowLeft' ? 24 : -24));
          setWidth(next);
          persist(next);
        }}
        className="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize transition-colors hover:bg-ring/30 focus-visible:bg-ring/40 focus-visible:outline-none lg:block"
      />
      {children}
    </aside>
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
