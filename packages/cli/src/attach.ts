import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run, type RunResult } from './util/exec.ts';

/** What you type to attach to a session in your own terminal. Ids are hex and profiles `[A-Za-z0-9_-]`. */
export function attachCommand(id: string, profile: string): string {
  return `aoe session attach -p ${profile} ${id}`;
}

export type TerminalApp = 'iTerm2' | 'Terminal';

/**
 * Each app's script takes the command as `item 1 of argv`, never interpolated. iTerm2 types it into a new
 * tab's login shell (so `aoe` is on PATH and you keep a shell after detaching), or a new window when none
 * is open.
 */
const SCRIPTS: Record<TerminalApp, string[]> = {
  iTerm2: [
    'on run argv',
    'tell application "iTerm"',
    'if (count of windows) = 0 then',
    'set w to (create window with default profile)',
    'else',
    'set w to current window',
    'tell w to create tab with default profile',
    'end if',
    'tell current session of w to write text (item 1 of argv)',
    'activate',
    'end tell',
    'end run',
  ],
  Terminal: [
    'on run argv',
    'tell application "Terminal"',
    'do script (item 1 of argv)',
    'activate',
    'end tell',
    'end run',
  ],
};

/** iTerm2 when it is installed, else Terminal.app. */
export function terminalApp(exists: (path: string) => boolean = existsSync): TerminalApp {
  return ['/Applications/iTerm.app', join(homedir(), 'Applications/iTerm.app')].some(exists)
    ? 'iTerm2'
    : 'Terminal';
}

export function osascriptArgs(app: TerminalApp, command: string): string[] {
  return [...SCRIPTS[app].flatMap((line) => ['-e', line]), command];
}

/**
 * Open a new tab in your terminal app running `command` (macOS only). The first time, macOS asks whether
 * the daemon may control the app (Automation); a refusal comes back as an error here.
 */
export async function openInTerminal(
  command: string,
  opts: {
    platform?: NodeJS.Platform;
    app?: TerminalApp;
    exec?: (cmd: string, args: string[]) => Promise<RunResult>;
  } = {},
): Promise<{ opened: true; app: TerminalApp } | { opened: false; message: string }> {
  if ((opts.platform ?? process.platform) !== 'darwin')
    return { opened: false, message: 'Opening a terminal tab works on macOS only.' };
  const app = opts.app ?? terminalApp();
  const exec = opts.exec ?? ((cmd, args) => run(cmd, args, { timeoutMs: 30_000 }));
  const r = await exec('osascript', osascriptArgs(app, command));
  if (r.code === 0) return { opened: true, app };
  const why = r.stderr.trim() || r.error?.message || 'osascript failed';
  // -1743: you have not allowed the daemon to control the app (System Settings → Privacy & Security → Automation).
  return {
    opened: false,
    message: /-1743/.test(why)
      ? `Supercharge is not allowed to control ${app}. Allow it in System Settings → Privacy & Security → Automation.`
      : `Could not open ${app}: ${why}`,
  };
}

/** A tmux client attached to an AoE session's window, at that window's size. */
export interface TmuxWindow {
  name: string;
  attached: boolean;
  cols: number;
  rows: number;
}

/**
 * Find a session's tmux session in `tmux list-sessions -F '#{session_name}\t#{session_attached}\t
 * #{window_width}\t#{window_height}'`. AoE 1.17.2 to 1.21.0 names it `aoe_<title>_<first 8 of id>`
 * (`Session::generate_name`, src/tmux/session.rs).
 */
export function findTmuxWindow(listing: string, id: string): TmuxWindow | null {
  const suffix = `_${id.slice(0, 8)}`;
  for (const line of listing.split('\n')) {
    const [name, attached, cols, rows] = line.split('\t');
    if (!name?.startsWith('aoe_') || !name.endsWith(suffix)) continue;
    return { name, attached: Number(attached) > 0, cols: Number(cols) || 0, rows: Number(rows) || 0 };
  }
  return null;
}

/** The session's tmux window, or null when tmux can't be read (then nobody is taken to be attached). */
export async function tmuxWindow(id: string): Promise<TmuxWindow | null> {
  const r = await run(
    'tmux',
    ['list-sessions', '-F', '#{session_name}\t#{session_attached}\t#{window_width}\t#{window_height}'],
    { timeoutMs: 5000 },
  );
  return r.code === 0 ? findTmuxWindow(r.stdout, id) : null;
}

/**
 * A resize from the dashboard switches the window to a fixed size; give it back to the attached terminal,
 * as AoE's TUI does before it attaches (`reset_size_to_latest_client`).
 */
export async function followAttachedClient(name: string): Promise<void> {
  await run('tmux', ['set-option', '-t', name, 'window-size', 'latest'], { timeoutMs: 5000 });
}
