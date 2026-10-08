import type { WatchNotice } from './watch.ts';

/** A conversation as the dashboard renders it, parsed from Claude Code's transcript. */
export type ChatBlock =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      /** One line: the command, file, pattern or URL the tool acted on. */
      summary: string;
      input: string;
      /** null while the tool is still running. */
      result: string | null;
      isError: boolean;
    }
  | {
      /** A command you ran in Claude Code's shell mode (`!`), from the dashboard or the terminal. */
      kind: 'shell';
      command: string;
      /** What it printed; null until it finishes. */
      stdout: string | null;
      stderr: string;
    }
  | {
      /** A `[WATCH]` line a watcher typed in about a worker: shown as a notice, not as yours. */
      kind: 'notice';
      notice: WatchNotice;
    };

export interface ChatMessage {
  id: string;
  /** `notice`: typed in by a watcher (Supercharge's or control-watch.sh), not by you. */
  role: 'user' | 'assistant' | 'notice';
  at: string;
  blocks: ChatBlock[];
  /** Typed while Claude was busy and taken in mid-turn: part of the reply already under way. */
  queued?: boolean;
}

/** Choices the dashboard offers for a running session (short enough for AoE to type as a command). */
/** Claude Code's model aliases; `opusplan` runs Opus in plan mode and Sonnet otherwise. */
export const MODEL_ALIASES = ['fable', 'opus', 'opusplan', 'sonnet', 'haiku', 'default'] as const;
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export interface ChatResponse {
  /** ok: transcript found · empty: no conversation yet · unavailable: Claude's transcript can't be read. */
  state: 'ok' | 'empty' | 'unavailable';
  version: string;
  title: string | null;
  messages: ChatMessage[];
  /** Messages dropped from the start to keep the payload small. */
  truncated: number;
  note: string | null;
  /** What the session last ran with: the model id and effort of its latest reply or /model, /effort. */
  model: string | null;
  effort: string | null;
  /** Tokens in the context at the latest reply: its input, cache writes and cache reads (as Claude Code counts them). */
  contextTokens: number | null;
  /** The Claude Code conversation this is (AoE's hook file), for figures kept per conversation. */
  claudeSessionId?: string | null;
  /** The latest reply's API request: its tokens and when it was written. */
  lastUsage?: { at: string; usage: RequestTokens } | null;
  /** The latest `/compact` (or auto-compact): when, and the tokens left after it. */
  compacted?: { at: string; tokens: number | null } | null;
  /** How full the context is, for the composer's meter (the chat route fills it in). */
  context?: ContextInfo | null;
  /** The Claude Code version that wrote the conversation's latest record. */
  claudeVersion?: string | null;
  /** A control chat only: the model Supercharge starts control chats on (agent.controlModel). */
  expectedModel?: string | null;
  /** The Claude Code installed now (`claude --version`), so the chat can tell a restart would update it. */
  installedClaude?: string | null;
}

/** Claude Code 2.1.284 added the 5.5 models; older builds resolve `opus` and `sonnet` to the 5.0 ones. */
export const MODELS_55_SINCE = [2, 1, 284] as const;

/** Whether a version ("2.1.285", or any text holding one) is at least `min`; null when there is none. */
export function versionAtLeast(version: string | null | undefined, min: readonly number[]): boolean | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!m) return null;
  const have = [Number(m[1]), Number(m[2]), Number(m[3])];
  const differs = have.findIndex((n, i) => n !== min[i]);
  return differs === -1 || have[differs]! > min[differs]!;
}

/**
 * Whether a session's model (a full id from its replies) is the one asked for (an alias or a full id).
 * Null when it cannot tell: no model yet, or `opusplan`, `default` and empty, which switch or defer.
 */
export function modelMatches(id: string | null, wanted: string | null | undefined): boolean | null {
  if (!id || !wanted || ['opusplan', 'default'].includes(wanted)) return null;
  // Opus Plan answers with Sonnet outside plan mode.
  if (id === 'opusplan') return false;
  if (/^[a-z]+$/.test(wanted)) return id.toLowerCase().includes(wanted);
  return id.startsWith(wanted);
}

const MAX_TEXT = 4000;

export function clip(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

/** One-line description of what a tool call acted on. */
export function toolSummary(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pick = (...keys: string[]) =>
    keys.map((k) => i[k]).find((v) => typeof v === 'string' && v.trim()) as string | undefined;
  const command = pick('command');
  const path = command ? undefined : pick('file_path', 'notebook_path', 'path');
  const value =
    command ??
    path ??
    pick('pattern', 'query') ??
    pick('url') ??
    pick('description', 'prompt', 'subject') ??
    Object.values(i).find((v) => typeof v === 'string');
  // A path is kept whole (deep worktrees run long), so the chat can show it relative to the session's
  // folder and the file name is never what gets cut.
  return (typeof value === 'string' ? value : name)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, path ? 2000 : 200);
}

/** "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5"; anything else as is. */
/**
 * A model as Claude Code names it after /model ("Opus 5", "Sonnet 5.5 (1M)", "Opus in plan mode, else
 * Sonnet") as an id, so it reads like the ids replies record. Anything else stays as written.
 */
export function modelFromDisplay(name: string): string {
  const text = name.trim();
  if (/^Opus in plan mode\b/i.test(text)) return 'opusplan';
  const m = /^(Opus|Sonnet|Haiku|Fable)\s+(\d+(?:\.\d+)?)(\s*\(1M\))?$/i.exec(text);
  if (!m) return text;
  return `claude-${m[1]!.toLowerCase()}-${m[2]!.replace('.', '-')}${m[3] ? '[1m]' : ''}`;
}

export function prettyModel(id: string): string {
  // Claude Code's own name for it; it answers with Opus only in plan mode.
  if (id === 'opusplan') return 'Opus Plan';
  const m = /^claude-([a-z]+)-([\d-]+?)(?:-\d{8})?(\[1m\])?$/.exec(id);
  if (!m) return id;
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return `${family} ${m[2]!.split('-').join('.')}${m[3] ? ' (1M)' : ''}`;
}

/**
 * Context window for a model id: 1M for the long-context variants, else 200k. Transcript replies don't
 * always carry `[1m]`, so more tokens in use than 200k holds means the window is 1M.
 */
export function contextWindow(model: string | null, used: number | null = null): number {
  if (model && /\[1m\]|1m$/i.test(model)) return 1_000_000;
  return used !== null && used > 200_000 ? 1_000_000 : 200_000;
}

/** One API request's tokens. Input, cache writes and cache reads are what fills the context. */
export interface RequestTokens {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export const contextOf = (t: RequestTokens) => t.input + t.cacheWrite + t.cacheRead;

/**
 * What Claude Code's status line last said about a conversation's context (its `context_window`),
 * saved per conversation by `supercharge statusline`.
 */
export interface StatusContext {
  /** Claude Code's session id: the conversation. */
  sessionId: string;
  at: string;
  model: { id: string | null; name: string | null };
  /** `context_window_size`: the window for the model in use. */
  window: number | null;
  /** `total_input_tokens`: input, cache writes and cache reads in the context now. */
  used: number | null;
  /** `used_percentage`. */
  percent: number | null;
  /** `current_usage`: the latest request. */
  current: RequestTokens | null;
}

/** How full a session's context is, for the composer's meter and its popover. */
export interface ContextInfo {
  /** Tokens in the context: input, cache writes and cache reads (output is not counted). */
  used: number;
  /** The model's context window. */
  window: number;
  /** used / window, 0-100, rounded. */
  percent: number;
  /** `claude`: Claude Code's own figures, from its status line · `estimate`: worked out from the transcript. */
  source: 'claude' | 'estimate';
  /** When the figures were taken. */
  at: string | null;
  /** The model id, and Claude Code's name for it when it told us. */
  model: string | null;
  modelName: string | null;
  /** The latest API request's tokens. */
  lastRequest: RequestTokens | null;
  /** The auto-compact window Supercharge started this session with; null: Claude Code's own setting. */
  autoCompactWindow: number | null;
  /** Compacted since the latest reply: `used` is what the compaction left, until Claude replies again. */
  compacted: boolean;
}

/** A model id without the 1M suffix or date, to tell whether two ids are the same model. */
const baseModel = (id: string | null) => (id ?? '').replace(/\[1m\]$/i, '').replace(/-\d{8}$/, '');

/**
 * The context figures to show: Claude Code's (from its status line) when they are as new as the latest
 * reply, else an estimate from the transcript. After a compaction, what it left.
 */
export function contextInfo(
  chat: Pick<ChatResponse, 'model' | 'contextTokens' | 'lastUsage' | 'compacted'>,
  status: StatusContext | null,
  autoCompactWindow: number | null,
): ContextInfo | null {
  const replyAt = chat.lastUsage ? Date.parse(chat.lastUsage.at) : 0;
  const sameModel = status && (!chat.model || baseModel(status.model.id) === baseModel(chat.model));
  // The status line runs just after a reply is written; one older than the reply is about an earlier one.
  const fresh = status && status.used !== null && sameModel && Date.parse(status.at) >= replyAt - 1_000;
  const compactedAt = chat.compacted ? Date.parse(chat.compacted.at) : 0;
  const compacted =
    !!chat.compacted && compactedAt > replyAt && (!fresh || compactedAt > Date.parse(status!.at));
  let used: number | null;
  if (compacted) used = chat.compacted!.tokens;
  else if (fresh) used = status!.used;
  else used = chat.lastUsage ? contextOf(chat.lastUsage.usage) : chat.contextTokens;
  if (!used) return null;
  const model = chat.model ?? status?.model.id ?? null;
  const window = (sameModel && status?.window) || contextWindow(status?.model.id ?? model, used);
  return {
    used,
    window,
    percent: Math.min(100, Math.max(0, Math.round((used / window) * 100))),
    source: fresh && !compacted ? 'claude' : 'estimate',
    at: compacted ? chat.compacted!.at : fresh ? status!.at : (chat.lastUsage?.at ?? null),
    model,
    modelName: sameModel ? status!.model.name : null,
    lastRequest: fresh && status!.current ? status!.current : (chat.lastUsage?.usage ?? null),
    autoCompactWindow,
    compacted,
  };
}

/**
 * Attachments ride in the message as `Attached: <path>` lines, which Claude reads with its file tool
 * (images included). The dashboard turns them back into thumbnails.
 */
export const ATTACHMENT_LINE = /^Attached: (\/\S+)$/;

export function withAttachments(text: string, paths: string[]): string {
  const lines = paths.map((p) => `Attached: ${p}`);
  return [text.trim(), lines.join('\n')].filter(Boolean).join('\n\n');
}

export interface Attachment {
  path: string;
  name: string;
  /** Dashboard URL, for files in Supercharge's uploads folder. */
  url: string | null;
  image: boolean;
}

export function splitAttachments(text: string): { text: string; files: Attachment[] } {
  const files: Attachment[] = [];
  const kept = text.split('\n').filter((line) => {
    const m = ATTACHMENT_LINE.exec(line.trim());
    if (!m) return true;
    const path = m[1]!;
    const up = /\/uploads\/([A-Za-z0-9_-]+)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(path);
    const name = path.split('/').pop() ?? path;
    files.push({
      path,
      name: name.replace(/^\d{8}T\d{6}-[0-9a-f]{4}-/, ''),
      url: up ? `/api/uploads/${up[1]}/${up[2]}` : null,
      image: /\.(png|jpe?g|gif|webp)$/i.test(path),
    });
    return false;
  });
  return { text: kept.join('\n').trim(), files };
}

/** Something you can run in a session by typing "/" (the chat composer completes these). */
export interface SlashCommand {
  /** Without the slash: "compact", "smart-plan", "mcp-server-dev:build-mcp-app". */
  name: string;
  description: string;
  kind: 'builtin' | 'skill' | 'command';
  /** Claude Code itself, your ~/.claude, the session's project, or a plugin. */
  source: 'claude' | 'user' | 'project' | 'plugin';
  argumentHint?: string;
  /** Opens a full-screen view in the session; answer it from the Terminal tab. */
  terminal?: boolean;
}

const SHELL_LANGUAGES = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'shell-session']);

/**
 * The command a shell-tagged block runs, or null for any other block. In a console transcript (first
 * line `$ cmd`) only the `$ ` lines are commands, the rest is their output.
 */
export function runnableCommand(language: string | null, code: string): string | null {
  if (!language || !SHELL_LANGUAGES.has(language.toLowerCase()) || !code.trim()) return null;
  const lines = code.split('\n');
  if (!/^\$ /.test(lines.find((l) => l.trim()) ?? '')) return code;
  return lines
    .filter((l) => /^\$ /.test(l))
    .map((l) => l.slice(2))
    .join('\n');
}

/**
 * The command in inline code written the way Claude Code's shell mode takes it, `! aoe remove x`, or
 * null for any other inline code.
 */
export function inlineCommand(code: string): string | null {
  // A command starts with a word, a path or a quote; `!=` and `!==` are operators.
  const m = /^!\s*([\w./~$"'][^\n]*)$/.exec(code.trim());
  return m ? m[1]!.trim() : null;
}
