import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  clip,
  modelFromDisplay,
  splitWatchNotices,
  toolSummary,
  type ChatBlock,
  type ChatMessage,
  type ChatResponse,
  type RequestTokens,
  type UsageEntry,
} from '@aoe-supercharge/core/shared';
import type { AoeCli } from './aoe/cli.ts';
import type { Ctx } from './context.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Command echoes and harness notes Claude Code records as user turns; they aren't things you typed. */
const NOT_TYPED =
  /^\s*(<(command-|local-command|system-reminder|bash-|task-notification|user-memory)|\[Request interrupted by user)/;
/**
 * A paste (every message the dashboard sends arrives as one) is recorded wrapped in
 * `<pasted_content id="…">` and `</pasted_content id="…">` (Claude Code 2.1.285). Shown as the text.
 */
const PASTED = /<pasted_content(?: id="[^"]*")?>\n?([\s\S]*?)\n?<\/pasted_content(?: id="[^"]*")?>/g;
const unwrapPasted = (text: string) => text.replace(PASTED, '$1');
const MAX_MESSAGES = 300;
// Terminal colour codes, which Claude Code leaves in command output.
const ANSI = /\x1b\[[0-9;]*m/g;
const FULL_INPUT = new Set(['ExitPlanMode', 'AskUserQuestion']);
/** Tool calls that change files: progress, for the office's runaway check. */
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

type ToolBlock = Extract<ChatBlock, { kind: 'tool' }>;
type ShellBlock = Extract<ChatBlock, { kind: 'shell' }>;

/**
 * Incremental parser for Claude Code's transcript JSONL (~/.claude/projects/<cwd>/<session>.jsonl,
 * Claude Code 2.1.x). Assistant turns are split across records sharing message.id; tool results
 * come back as user records and are attached to their tool call.
 */
export class TranscriptParser {
  messages: ChatMessage[] = [];
  title: string | null = null;
  model: string | null = null;
  effort: string | null = null;
  /** Tokens in the context at the latest reply (input, cache writes and reads, as Claude Code counts them). */
  contextTokens: number | null = null;
  /** The latest reply's API request, for the context popover. */
  lastUsage: { at: string; usage: RequestTokens } | null = null;
  /** The latest compaction: when, and the tokens it left. */
  compacted: { at: string; tokens: number | null } | null = null;
  /** The Claude Code version that wrote the latest message (each record carries it). */
  claudeVersion: string | null = null;
  /**
   * Token usage per reply (SPEC §14.5), once per `message.id`: the records of one reply repeat the
   * same usage. Sidechains (subagents) are left out with the rest of their records.
   */
  usage = new Map<string, UsageEntry>();
  /** When Claude last changed a file (an Edit or Write call): progress, for the runaway check. */
  lastEditAt: string | null = null;
  private assistantById = new Map<string, ChatMessage>();
  private toolById = new Map<string, ToolBlock>();
  /** A shell-mode command still waiting for its output. */
  private pendingShell: ShellBlock | null = null;
  /** Messages shown from a `queued_command`, so a user record repeating one isn't shown again. */
  private queuedTexts = new Set<string>();

  push(line: string): void {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') {
      this.title = rec.aiTitle;
      return;
    }
    if (rec.isSidechain === true) return;
    if (rec.type === 'system' && rec.subtype === 'compact_boundary' && typeof rec.timestamp === 'string') {
      const meta = rec.compactMetadata as { postTokens?: unknown } | undefined;
      this.compacted = {
        at: rec.timestamp,
        tokens: typeof meta?.postTokens === 'number' ? meta.postTokens : null,
      };
    }
    if ((rec.type === 'user' || rec.type === 'assistant') && typeof rec.version === 'string')
      this.claudeVersion = rec.version;
    const message = rec.message as { id?: string; content?: unknown; model?: unknown } | undefined;
    this.trackSettings(rec, message);
    if (rec.isMeta === true) return;
    const at = typeof rec.timestamp === 'string' ? rec.timestamp : new Date(0).toISOString();
    const uuid = typeof rec.uuid === 'string' ? rec.uuid : `${this.messages.length}`;
    if (rec.type === 'user' && message) this.user(message.content, uuid, at, rec.origin);
    if (rec.type === 'assistant' && message) this.assistant(message.content, message.id ?? uuid, at);
    if (rec.type === 'attachment') this.queued(rec.attachment, uuid, at);
  }

  /**
   * A message typed while Claude was busy, which it took in mid-turn: recorded as a `queued_command`
   * attachment rather than a user record (Claude Code 2.1.285). Shown like a typed one; should a user
   * record with the same words follow, that one is the same message and is not shown twice.
   */
  private queued(attachment: unknown, id: string, at: string) {
    const a = attachment as {
      type?: unknown;
      prompt?: unknown;
      commandMode?: unknown;
      origin?: unknown;
    } | null;
    if (a?.type !== 'queued_command' || (a.commandMode !== undefined && a.commandMode !== 'prompt')) return;
    if (typeof a.prompt !== 'string') return;
    const before = this.messages.length;
    this.user(a.prompt, id, at, a.origin);
    if (this.messages.length === before) return;
    for (const m of this.messages.slice(before)) m.queued = true;
    this.queuedTexts.add(unwrapPasted(a.prompt).trim());
  }

  /** Each reply records its model and effort; /model and /effort leave their output as a command echo. */
  private trackSettings(
    rec: Record<string, unknown>,
    message: { content?: unknown; model?: unknown } | undefined,
  ) {
    if (rec.type === 'assistant') {
      if (typeof message?.model === 'string' && !message.model.startsWith('<'))
        // A reply's id leaves out the `[1m]` a /model chose: keep it while the model is the same.
        this.model =
          this.model?.endsWith('[1m]') && this.model.slice(0, -4) === message.model
            ? this.model
            : message.model;
      const u = (message as { usage?: Record<string, unknown> } | undefined)?.usage;
      if (u) {
        const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
        const context = n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens');
        const total = context + n('output_tokens');
        if (context > 0) this.contextTokens = context;
        if (total > 0 && typeof rec.timestamp === 'string')
          this.lastUsage = {
            at: rec.timestamp,
            usage: {
              input: n('input_tokens'),
              cacheWrite: n('cache_creation_input_tokens'),
              cacheRead: n('cache_read_input_tokens'),
              output: n('output_tokens'),
            },
          };
        const id = (message as { id?: unknown }).id;
        if (total > 0 && typeof id === 'string') {
          // Split cache writes by TTL when Claude Code records it; otherwise count them as 5-minute writes.
          const cc = u.cache_creation as Record<string, unknown> | undefined;
          const w1h = typeof cc?.ephemeral_1h_input_tokens === 'number' ? cc.ephemeral_1h_input_tokens : 0;
          const writes = n('cache_creation_input_tokens');
          this.usage.set(id, {
            id,
            at: typeof rec.timestamp === 'string' ? rec.timestamp : new Date(0).toISOString(),
            model:
              typeof message?.model === 'string' && !message.model.startsWith('<')
                ? message.model
                : this.model,
            speed: typeof u.speed === 'string' ? u.speed : null,
            usage: {
              input: n('input_tokens'),
              cacheWrite5m: Math.max(0, writes - w1h),
              cacheWrite1h: Math.min(writes, w1h),
              cacheRead: n('cache_read_input_tokens'),
              output: n('output_tokens'),
            },
          });
        }
        const content = message?.content;
        if (Array.isArray(content) && typeof rec.timestamp === 'string')
          for (const b of content as Record<string, unknown>[])
            if (b.type === 'tool_use' && EDITS.has(String(b.name))) this.lastEditAt = rec.timestamp;
      }
      if (typeof rec.effort === 'string') this.effort = rec.effort;
      return;
    }
    // A command typed while Claude is busy is recorded as a system record instead of a user one.
    const echo =
      rec.type === 'user' && typeof message?.content === 'string'
        ? message.content
        : rec.type === 'system' && rec.subtype === 'local_command' && typeof rec.content === 'string'
          ? rec.content
          : null;
    if (echo === null) return;
    // Claude Code prints the model's display name in bold: "Set model to \x1b[1mOpus 5\x1b[22m and saved…".
    const out = (/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(echo)?.[1] ?? '').replace(
      ANSI,
      '',
    );
    const model =
      /(?:Set model to|Model set to)\s+(.+?)(?:\s+and saved as\b|\s+for this session only\b|\s+with\b|$)/m.exec(
        out,
      )?.[1];
    if (model) this.model = modelFromDisplay(model.replace(/^`(.*)`$/, '$1'));
    const effort = /(?:Set effort level to|Effort level set to)\s+`?([a-z]+)`?/.exec(out)?.[1];
    if (effort) this.effort = effort === 'auto' ? null : effort;
  }

  private user(content: unknown, id: string, at: string, origin: unknown) {
    const kind = (origin as { kind?: string } | undefined)?.kind;
    if (kind && kind !== 'human') return;
    if (typeof content === 'string') {
      if (this.shell(content, id, at)) return;
      if (!content.trim() || NOT_TYPED.test(content)) return;
      if (this.queuedTexts.delete(unwrapPasted(content).trim())) return;
      this.typed(unwrapPasted(content), id, at);
      return;
    }
    if (!Array.isArray(content)) return;
    const texts: string[] = [];
    for (const b of content as Record<string, unknown>[]) {
      if (b.type === 'tool_result') {
        const tool = this.toolById.get(String(b.tool_use_id));
        if (tool) {
          tool.result = clip(resultText(b.content));
          tool.isError = b.is_error === true;
        }
      } else if (b.type === 'text' && typeof b.text === 'string' && !NOT_TYPED.test(b.text)) {
        texts.push(unwrapPasted(b.text));
      } else if (b.type === 'image') {
        texts.push('*(image)*');
      }
    }
    if (texts.length) this.typed(texts.join('\n\n'), id, at);
  }

  /** A typed turn: each `[WATCH]` line in it is a notice of its own, the rest is what you wrote. */
  private typed(text: string, id: string, at: string) {
    const { notices, rest } = splitWatchNotices(text);
    notices.forEach((notice, i) =>
      this.messages.push({ id: `${id}:n${i}`, role: 'notice', at, blocks: [{ kind: 'notice', notice }] }),
    );
    if (!notices.length) this.messages.push({ id, role: 'user', at, blocks: [{ kind: 'text', text }] });
    else if (rest) this.messages.push({ id, role: 'user', at, blocks: [{ kind: 'text', text: rest }] });
  }

  /**
   * Shell mode (`!command`, Claude Code 2.1.285): one user record with `<bash-input>`, then one with
   * `<bash-stdout>` and `<bash-stderr>` once it finishes. True when the record was one of those.
   */
  private shell(content: string, id: string, at: string): boolean {
    const input = /^\s*<bash-input>([\s\S]*)<\/bash-input>\s*$/.exec(content);
    if (input) {
      const block: ShellBlock = { kind: 'shell', command: input[1]!, stdout: null, stderr: '' };
      this.pendingShell = block;
      this.messages.push({ id, role: 'user', at, blocks: [block] });
      return true;
    }
    const out = /^\s*<bash-stdout>([\s\S]*?)<\/bash-stdout>/.exec(content);
    if (!out) return false;
    if (this.pendingShell) {
      this.pendingShell.stdout = clip(out[1]!);
      this.pendingShell.stderr = clip(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/.exec(content)?.[1] ?? '');
      this.pendingShell = null;
    }
    return true;
  }

  private assistant(content: unknown, messageId: string, at: string) {
    if (!Array.isArray(content)) return;
    let msg = this.assistantById.get(messageId);
    if (!msg) {
      msg = { id: messageId, role: 'assistant', at, blocks: [] };
      this.assistantById.set(messageId, msg);
      this.messages.push(msg);
    }
    for (const b of content as Record<string, unknown>[]) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        const last = msg.blocks.at(-1);
        if (last?.kind === 'text') last.text += `\n\n${b.text}`;
        else msg.blocks.push({ kind: 'text', text: b.text });
      } else if (b.type === 'tool_use') {
        const tool: ToolBlock = {
          kind: 'tool',
          id: String(b.id),
          name: String(b.name ?? 'Tool'),
          summary: toolSummary(String(b.name ?? ''), b.input),
          // A plan or a question is shown in full when Claude asks for approval; other inputs are previews.
          input: clip(JSON.stringify(b.input ?? {}, null, 2), FULL_INPUT.has(String(b.name)) ? 60_000 : 4000),
          result: null,
          isError: false,
        };
        this.toolById.set(tool.id, tool);
        msg.blocks.push(tool);
      }
    }
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === 'object' && (c as { type?: string }).type === 'text'
          ? String((c as { text?: string }).text ?? '')
          : '*(non-text output)*',
      )
      .join('\n');
  }
  return '';
}

/** Claude Code's project directory name for a working directory. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

interface Cached {
  file: string;
  offset: number;
  partial: string;
  parser: TranscriptParser;
  mtimeMs: number;
}

/**
 * Finds and incrementally reads the transcript for an AoE session. The Claude session id comes from
 * AoE's hook state (<hooksDir>/<aoe id>/session_id[.<launch id>], written by its SessionStart hook, so
 * it follows /clear at once), falling back to `aoe session show --json`.
 */
/** AoE's Claude hooks write each session's live Claude id under /tmp/aoe-hooks-<uid>/<id>/session_id. */
export function transcriptStore(ctx: Pick<Ctx, 'paths' | 'aoeCli' | 'env'>): TranscriptStore {
  return new TranscriptStore(
    ctx.paths.claudeDir,
    ctx.env.SUPERCHARGE_AOE_HOOKS_DIR || `/tmp/aoe-hooks-${process.getuid?.() ?? 0}`,
    ctx.aoeCli,
  );
}

export class TranscriptStore {
  private cache = new Map<string, Cached>();
  private idCache = new Map<string, { id: string | null; at: number }>();

  constructor(
    private claudeDir: string,
    private hooksDir: string,
    private aoeCli: AoeCli,
  ) {}

  /**
   * The Claude session id AoE's SessionStart hook wrote for this session. AoE 1.17 names the file per
   * launch (`session_id.<launch id>`; plain `session_id` before that) and rewrites it the moment Claude
   * starts a new conversation (/clear), so the most recently written one is the live conversation.
   */
  private async idFromHooks(aoeId: string): Promise<string | null> {
    const dir = join(this.hooksDir, aoeId);
    const names = (await readdir(dir).catch(() => [] as string[])).filter(
      (n) => n === 'session_id' || n.startsWith('session_id.'),
    );
    let best: { id: string; mtime: number } | null = null;
    for (const n of names) {
      const file = join(dir, n);
      const [text, st] = await Promise.all([
        readFile(file, 'utf8').catch(() => ''),
        stat(file).catch(() => null),
      ]);
      const id = text.trim();
      if (UUID.test(id) && st && (!best || st.mtimeMs > best.mtime)) best = { id, mtime: st.mtimeMs };
    }
    return best?.id ?? null;
  }

  private async claudeSessionId(aoeId: string): Promise<string | null> {
    const fromHook = await this.idFromHooks(aoeId);
    if (fromHook) return fromHook;
    const cached = this.idCache.get(aoeId);
    if (cached && Date.now() - cached.at < 5_000) return cached.id;
    const id = await this.aoeCli.agentSessionId(aoeId).catch(() => null);
    const valid = id && UUID.test(id) ? id : null;
    this.idCache.set(aoeId, { id: valid, at: Date.now() });
    return valid;
  }

  private async findFile(claudeId: string, cwd: string | null): Promise<string | null> {
    const projects = join(this.claudeDir, 'projects');
    if (cwd) {
      const direct = join(projects, encodeProjectDir(cwd), `${claudeId}.jsonl`);
      if (
        await stat(direct).then(
          () => true,
          () => false,
        )
      )
        return direct;
    }
    for (const dir of await readdir(projects).catch(() => [] as string[])) {
      const f = join(projects, dir, `${claudeId}.jsonl`);
      if (
        await stat(f).then(
          () => true,
          () => false,
        )
      )
        return f;
    }
    return null;
  }

  /**
   * The token usage of the session's live conversation, reply by reply, and when it last changed a
   * file. Reads what is new in the transcript first (the same incremental read as the chat view).
   */
  async usage(
    aoeId: string,
    cwd: string | null,
  ): Promise<{ entries: UsageEntry[]; lastEditAt: string | null }> {
    const chat = await this.read(aoeId, cwd);
    const c = this.cache.get(aoeId);
    if (!c || chat.version === 'none' || chat.version.startsWith('nofile:'))
      return { entries: [], lastEditAt: null };
    return { entries: [...c.parser.usage.values()], lastEditAt: c.parser.lastEditAt };
  }

  /** The tool call Claude is waiting on: the last call of the latest reply, if it has no result yet. */
  async pendingTool(aoeId: string, cwd: string | null): Promise<ToolBlock | null> {
    const chat = await this.read(aoeId, cwd);
    const last = chat.messages.at(-1);
    if (last?.role !== 'assistant') return null;
    const tool = last.blocks.at(-1);
    return tool?.kind === 'tool' && tool.result === null ? tool : null;
  }

  async read(aoeId: string, cwd: string | null): Promise<ChatResponse> {
    const claudeId = await this.claudeSessionId(aoeId);
    if (!claudeId) {
      return {
        state: 'empty',
        version: 'none',
        title: null,
        messages: [],
        truncated: 0,
        note: 'No conversation yet. Send a message to start one.',
        model: null,
        effort: null,
        contextTokens: null,
      };
    }
    const file = await this.findFile(claudeId, cwd);
    if (!file) {
      return {
        state: 'empty',
        version: `nofile:${claudeId}`,
        title: null,
        messages: [],
        truncated: 0,
        note: 'No conversation yet. Send a message to start one.',
        model: null,
        effort: null,
        contextTokens: null,
      };
    }
    let c = this.cache.get(aoeId);
    if (!c || c.file !== file) {
      c = { file, offset: 0, partial: '', parser: new TranscriptParser(), mtimeMs: 0 };
      this.cache.set(aoeId, c);
    }
    const st = await stat(file);
    if (st.size < c.offset) Object.assign(c, { offset: 0, partial: '', parser: new TranscriptParser() });
    if (st.size > c.offset) {
      const fh = await open(file, 'r');
      try {
        const buf = Buffer.alloc(st.size - c.offset);
        await fh.read(buf, 0, buf.length, c.offset);
        c.offset = st.size;
        const text = c.partial + buf.toString('utf8');
        const lines = text.split('\n');
        c.partial = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) c.parser.push(l);
      } finally {
        await fh.close();
      }
    }
    const all = c.parser.messages.filter((m) => m.blocks.length > 0);
    const messages = all.slice(-MAX_MESSAGES);
    return {
      state: all.length ? 'ok' : 'empty',
      version: `${claudeId}:${c.offset}`,
      title: c.parser.title,
      messages,
      truncated: all.length - messages.length,
      note: all.length ? null : 'No messages yet. Send one below.',
      model: c.parser.model,
      effort: c.parser.effort,
      contextTokens: c.parser.contextTokens,
      claudeVersion: c.parser.claudeVersion,
      claudeSessionId: claudeId,
      lastUsage: c.parser.lastUsage,
      compacted: c.parser.compacted,
    };
  }
}
