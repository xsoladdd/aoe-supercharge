import { Ledger, type Paths } from '@aoe-supercharge/core/node';

/** `aoe` as the command itself (also quoted, or by its path), not a name like aoe-supercharge. */
const AOE = String.raw`(?:^|[\s;&|(/"'\x60])aoe\s`;

/** What a control chat never runs itself: it gives the user the command instead (control skill §5.1). */
const FORBIDDEN: [RegExp, string][] = [
  [
    /\btask\s+cleanup\b(?![^;&|\n]*--dry-run)/,
    '`supercharge task cleanup` (only `--dry-run` is yours to run)',
  ],
  [new RegExp(`${AOE}[^;&|\\n]*?\\b(?:rm|remove)(?:\\s|$)`), '`aoe remove`'],
  [
    new RegExp(`${AOE}[^;&|\\n]*?\\bsession\\s+(?:archive|empty-trash)\\b`),
    '`aoe session archive` or `empty-trash`',
  ],
];

/** The forbidden command `command` runs, if any. Matches anywhere, so wrapping it (`bash -c "…"`) doesn't help. */
export function controlForbidden(command: string): string | null {
  return FORBIDDEN.find(([re]) => re.test(command))?.[1] ?? null;
}

async function isControlSession(paths: Paths, id: string | undefined): Promise<boolean> {
  if (!id) return false;
  const ledger = new Ledger(paths);
  if ((await ledger.getGeneral()).controlSessionId === id) return true;
  return (await ledger.listProjects()).some((p) => p.controlSessionId === id);
}

/**
 * `supercharge guard`, a PreToolUse hook on Bash (claudeSettingsArgs): why the control chat may not run this
 * hook input's command, or null. Workers and General chats are never stopped, so they can still grep for these.
 */
export async function guard(
  paths: Paths,
  input: string,
  sessionId: string | undefined,
): Promise<string | null> {
  const command = (JSON.parse(input) as { tool_input?: { command?: unknown } }).tool_input?.command;
  const what = typeof command === 'string' ? controlForbidden(command) : null;
  if (!what || !(await isControlSession(paths, sessionId))) return null;
  return `Supercharge: the control chat never runs ${what} itself. Give the user the command in a bash block instead; the dashboard's Run button runs it as them.`;
}
