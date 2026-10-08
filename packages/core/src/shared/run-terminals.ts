/**
 * A terminal of its own that a chat's Run opened, shown under the command it ran. It is one of AoE's
 * extra paired terminals for the chat's session (a tmux shell in the session's folder), so it outlives a
 * page reload and keeps its output until you close it.
 */
export interface RunTerminal {
  id: string;
  sessionId: string;
  /** AoE's paired-terminal index. */
  index: number;
  command: string;
  /** Where the command sits in the chat: `<turn id>:<segment key>:<markdown offset>`. */
  anchor: string;
  createdAt: string;
  /** The command has been typed into it. */
  ran: boolean;
}

/** AoE 1.17.2 keeps paired terminals 0 to 31 for each session (`MAX_TERMINAL_INDEX`, src/server/pane.rs). */
export const MAX_TERMINAL_INDEX = 31;

/**
 * The control chat's Shell tab. AoE won't close terminal 0, which its TUI shares, so the Shell tab has
 * one of Supercharge's own, which Restart can close and open again.
 */
export const CONTROL_SHELL_INDEX = 31;

/**
 * The terminal index for a new run: the highest free one below the control shell's. AoE's own web view
 * numbers its extra terminal tabs up from 1, so counting down keeps out of its way. Null when all are taken.
 */
export function pickTerminalIndex(used: Iterable<number>): number | null {
  const taken = new Set(used);
  for (let i = CONTROL_SHELL_INDEX - 1; i >= 1; i--) if (!taken.has(i)) return i;
  return null;
}
