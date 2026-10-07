import type { NoteRecord } from '@aoe-supercharge/core/shared';
import type { Ctx } from './context.ts';
import { CliError, EXIT } from './util/errors.ts';
import { mainCheckout } from './util/git.ts';

export interface ScopeOpts {
  project?: string;
  global?: boolean;
}

/**
 * Which notes a command means: `--global`, `--project <name>`, else the project of the folder you are
 * in (a worker's worktree counts), else the project whose control chat started this AoE session.
 */
export async function noteScope(ctx: Ctx, cwd: string, o: ScopeOpts): Promise<string | null> {
  if (o.global) return null;
  if (o.project) {
    if (!(await ctx.ledger.getProject(o.project)))
      throw new CliError(
        `Unknown project "${o.project}".`,
        EXIT.usage,
        'See your projects with: supercharge status',
      );
    return o.project;
  }
  const repo = await mainCheckout(cwd);
  const here = repo ? await ctx.ledger.findProjectByRepo(repo) : null;
  if (here) return here.name;
  const session = ctx.env.AOE_INSTANCE_ID;
  if (session) {
    const lead = (await ctx.ledger.listProjects()).find(
      (p) => p.controlSessionId === session || !!p.crew?.[session],
    );
    if (lead) return lead.name;
    const task = await ctx.ledger.findTaskBySession(session);
    if (task) return task.project;
  }
  throw new CliError(
    'This folder is not in a Supercharge project.',
    EXIT.usage,
    'Save it as a global note with --global, or name the project with --project <name>.',
  );
}

/** Claude's own shell (Claude Code sets CLAUDECODE=1), or you at a terminal. */
export function noteAuthor(ctx: Ctx): Pick<NoteRecord, 'by' | 'sessionId'> {
  return {
    by: ctx.env.CLAUDECODE === '1' ? 'claude' : 'you',
    sessionId: ctx.env.AOE_INSTANCE_ID || null,
  };
}

export async function findNote(ctx: Ctx, id: string): Promise<NoteRecord> {
  const note = (await ctx.notes.all()).find((n) => n.id === id.trim().toLowerCase());
  if (!note)
    throw new CliError(`No note with id "${id}".`, EXIT.usage, 'See the ids with: supercharge notes');
  return note;
}

/**
 * Notes as you would write them on a board: per project (global last), todos with their boxes first,
 * then notes, each with its id to tick or archive it by.
 */
export function formatNotes(notes: NoteRecord[]): string[] {
  const scopes = [...new Set(notes.map((n) => n.project))].sort((a, b) =>
    a === null ? 1 : b === null ? -1 : a.localeCompare(b),
  );
  const lines: string[] = [];
  for (const scope of scopes) {
    const mine = notes.filter((n) => n.project === scope);
    if (lines.length) lines.push('');
    lines.push(scope ?? 'Global');
    const todos = mine.filter((n) => n.kind === 'todo');
    const plain = mine.filter((n) => n.kind === 'note');
    const text = (n: NoteRecord) => n.text.replace(/\s*\n\s*/g, ' / ');
    if (todos.length) {
      lines.push('  To do');
      for (const n of todos) lines.push(`    [${n.done ? 'x' : ' '}] ${n.id}  ${text(n)}`);
    }
    if (plain.length) {
      lines.push('  Notes');
      for (const n of plain) lines.push(`    -   ${n.id}  ${text(n)}`);
    }
  }
  return lines;
}
