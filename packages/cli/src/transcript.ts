import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  clip,
  toolSummary,
  type ChatBlock,
  type ChatMessage,
  type ChatResponse,
} from '@aoe-supercharge/core/shared';
import type { AoeCli } from './aoe/cli.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Command echoes and harness notes Claude Code records as user turns; they aren't things you typed. */
const NOT_TYPED =
  /^\s*(<(command-|local-command|system-reminder|bash-|task-notification|user-memory)|\[Request interrupted by user)/;
const MAX_MESSAGES = 300;
const FULL_INPUT = new Set(['ExitPlanMode', 'AskUserQuestion']);

type ToolBlock = Extract<ChatBlock, { kind: 'tool' }>;

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
  private assistantById = new Map<string, ChatMessage>();
  private toolById = new Map<string, ToolBlock>();

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
    const message = rec.message as { id?: string; content?: unknown; model?: unknown } | undefined;
    this.trackSettings(rec, message);
    if (rec.isMeta === true) return;
    const at = typeof rec.timestamp === 'string' ? rec.timestamp : new Date(0).toISOString();
    const uuid = typeof rec.uuid === 'string' ? rec.uuid : `${this.messages.length}`;
    if (rec.type === 'user' && message) this.user(message.content, uuid, at, rec.origin);
    if (rec.type === 'assistant' && message) this.assistant(message.content, message.id ?? uuid, at);
  }

  /** Each reply records its model and effort; /model and /effort leave their output as a command echo. */
  private trackSettings(
    rec: Record<string, unknown>,
    message: { content?: unknown; model?: unknown } | undefined,
  ) {
    if (rec.type === 'assistant') {
      if (typeof message?.model === 'string' && !message.model.startsWith('<')) this.model = message.model;
      if (typeof rec.effort === 'string') this.effort = rec.effort;
      return;
    }
    if (rec.type !== 'user' || typeof message?.content !== 'string') return;
    const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(message.content)?.[1] ?? '';
    const model = /(?:Set model to|Model set to)\s+`?([A-Za-z0-9._[\]-]+)`?/.exec(out)?.[1];
    if (model) this.model = model;
    const effort = /(?:Set effort level to|Effort level set to)\s+`?([a-z]+)`?/.exec(out)?.[1];
    if (effort) this.effort = effort === 'auto' ? null : effort;
  }

  private user(content: unknown, id: string, at: string, origin: unknown) {
    const kind = (origin as { kind?: string } | undefined)?.kind;
    if (kind && kind !== 'human') return;
    if (typeof content === 'string') {
      if (!content.trim() || NOT_TYPED.test(content)) return;
      this.messages.push({ id, role: 'user', at, blocks: [{ kind: 'text', text: content }] });
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
        texts.push(b.text);
      } else if (b.type === 'image') {
        texts.push('*(image)*');
      }
    }
    if (texts.length)
      this.messages.push({ id, role: 'user', at, blocks: [{ kind: 'text', text: texts.join('\n\n') }] });
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
 * AoE's hook state (<hooksDir>/<aoe id>/session_id, written by its SessionStart hook, so it follows
 * /clear), falling back to `aoe session show --json`.
 */
export class TranscriptStore {
  private cache = new Map<string, Cached>();
  private idCache = new Map<string, { id: string | null; at: number }>();

  constructor(
    private claudeDir: string,
    private hooksDir: string,
    private aoeCli: AoeCli,
  ) {}

  private async claudeSessionId(aoeId: string): Promise<string | null> {
    const fromHook = (
      await readFile(join(this.hooksDir, aoeId, 'session_id'), 'utf8').catch(() => '')
    ).trim();
    if (UUID.test(fromHook)) return fromHook;
    const cached = this.idCache.get(aoeId);
    if (cached && Date.now() - cached.at < 30_000) return cached.id;
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
    };
  }
}
