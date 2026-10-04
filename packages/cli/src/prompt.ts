import {
  parseTerminalMenu,
  promptKind,
  type ParsedMenu,
  type SessionPrompt,
} from '@aoe-supercharge/core/shared';
import type { Ctx } from './context.ts';
import type { TranscriptStore } from './transcript.ts';

/** The menu on a session's screen right now, straight from AoE (null when there is none or AoE fails). */
export async function menuOnScreen(ctx: Pick<Ctx, 'aoe'>, sessionId: string): Promise<ParsedMenu | null> {
  try {
    return parseTerminalMenu((await ctx.aoe.output(sessionId, 60)).content);
  } catch {
    return null;
  }
}

/**
 * Reads what a waiting session is asking: the menu from its pane, and from its transcript the tool
 * call it is about (so a plan approval is told apart from a permission prompt).
 */
export class PromptReader {
  constructor(
    private ctx: Pick<Ctx, 'aoe'>,
    private transcripts: TranscriptStore | null,
  ) {}

  async read(sessionId: string, cwd: string | null): Promise<SessionPrompt | null> {
    const menu = await menuOnScreen(this.ctx, sessionId);
    if (!menu) return null;
    const pending = this.transcripts
      ? await this.transcripts.pendingTool(sessionId, cwd).catch(() => null)
      : null;
    const kind = promptKind(pending?.name ?? null, menu);
    return {
      key: menu.key,
      kind,
      question: menu.question,
      options: menu.options,
      tool: pending ? { name: pending.name, summary: pending.summary } : null,
      answerable: kind !== 'question',
    };
  }
}
