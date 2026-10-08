import { spawn } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { recordContext, recordUsage, writeFileAtomic, type Paths } from '@aoe-supercharge/core/node';
import { CliError } from './util/errors.ts';

/**
 * Fields of Claude Code's status line input that Supercharge reads. `recordContext` also keeps
 * `session_id`, `model.id` and the rest of `context_window` (window size, tokens, latest request).
 */
interface StatusInput {
  session_id?: string;
  model?: { id?: string; display_name?: string };
  context_window?: { used_percentage?: number | null };
  rate_limits?: {
    five_hour?: { used_percentage?: number };
    seven_day?: { used_percentage?: number };
  };
  workspace?: { current_dir?: string };
}

async function readStdin(): Promise<string> {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

interface StatusLineSetting {
  type?: string;
  command?: string;
  padding?: number;
}

/** Supercharge's own status line command (`'<node>' '<supercharge.mjs>' statusline`). */
const isOurs = (cmd: string | undefined) => !!cmd && /supercharge[^'"]*['"]? statusline$/.test(cmd.trim());

const settingsFile = (paths: Paths) => join(paths.claudeDir, 'settings.json');
/** Your own status line, kept aside while Supercharge's is in your settings (it still shows). */
const savedFile = (paths: Paths) => join(paths.configDir, 'claude-statusline.json');

/** Your own status line command, so Supercharge's never replaces what you see. */
async function userStatusLine(paths: Paths): Promise<string | null> {
  const saved = await readFile(savedFile(paths), 'utf8')
    .then((t) => (JSON.parse(t) as { previous?: StatusLineSetting | null }).previous ?? null)
    .catch(() => null);
  const fromSettings = await readFile(settingsFile(paths), 'utf8')
    .then((t) => (JSON.parse(t) as { statusLine?: StatusLineSetting }).statusLine ?? null)
    .catch(() => null);
  for (const s of [saved, fromSettings]) {
    const cmd = s?.type === 'command' ? s.command?.trim() : '';
    if (cmd && !isOurs(cmd)) return cmd;
  }
  return null;
}

async function readSettings(
  paths: Paths,
): Promise<{ raw: string | null; settings: Record<string, unknown> }> {
  const raw = await readFile(settingsFile(paths), 'utf8').catch(() => null);
  if (raw === null) return { raw, settings: {} };
  try {
    return { raw, settings: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    throw new CliError(
      `${settingsFile(paths)} is not valid JSON, so Supercharge left it alone.`,
      1,
      'Fix the file (or run claude once so it rewrites it), then try again.',
    );
  }
}

async function writeSettings(paths: Paths, raw: string | null, settings: Record<string, unknown>) {
  const file = settingsFile(paths);
  const mode = await stat(file).then(
    (st) => st.mode & 0o777,
    () => 0o600,
  );
  if (raw !== null) await writeFileAtomic(`${file}.supercharge-backup`, raw, mode);
  await writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`, mode);
}

/**
 * Put Supercharge's status line in your Claude Code settings, so every Claude Code session you run
 * (not only the ones Supercharge starts) records your 5-hour and weekly usage. A status line of your
 * own is kept aside and still shown. The file is backed up next to itself first.
 */
export async function connectStatusLine(
  paths: Paths,
  command: string,
): Promise<{ changed: boolean; keptYours: boolean; file: string }> {
  const { raw, settings } = await readSettings(paths);
  const cur = settings.statusLine as StatusLineSetting | undefined;
  if (cur?.type === 'command' && cur.command === command)
    return { changed: false, keptYours: false, file: settingsFile(paths) };
  const keptYours = !!cur && !isOurs(cur.command);
  if (keptYours) await writeFileAtomic(savedFile(paths), `${JSON.stringify({ previous: cur }, null, 2)}\n`);
  await writeSettings(paths, raw, { ...settings, statusLine: { type: 'command', command, padding: 0 } });
  return { changed: true, keptYours, file: settingsFile(paths) };
}

/** Take Supercharge's status line out of your settings again, putting yours back if you had one. */
export async function disconnectStatusLine(paths: Paths): Promise<{ changed: boolean; file: string }> {
  const { raw, settings } = await readSettings(paths);
  const cur = settings.statusLine as StatusLineSetting | undefined;
  if (!isOurs(cur?.command)) return { changed: false, file: settingsFile(paths) };
  const previous = await readFile(savedFile(paths), 'utf8')
    .then((t) => (JSON.parse(t) as { previous?: StatusLineSetting | null }).previous ?? null)
    .catch(() => null);
  const { statusLine: _ours, ...rest } = settings;
  await writeSettings(paths, raw, previous ? { ...rest, statusLine: previous } : rest);
  await rm(savedFile(paths), { force: true });
  return { changed: true, file: settingsFile(paths) };
}

/** Whether your Claude Code settings run Supercharge's status line (every session reports usage). */
export async function statusLineConnected(paths: Paths): Promise<boolean> {
  const { settings } = await readSettings(paths).catch(() => ({ settings: {} as Record<string, unknown> }));
  return isOurs((settings.statusLine as StatusLineSetting | undefined)?.command);
}

function runUserCommand(cmd: string, input: string, cwd: string | undefined): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', cmd], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const pct = (n: number | null | undefined) => (typeof n === 'number' ? `${Math.round(n)}%` : null);

/**
 * `claude --settings` points Supercharge sessions here (agent.statusLine). Claude Code pipes its
 * status JSON in after each update; the `rate_limits` in it are the only place your 5-hour and weekly
 * usage show up without your login token, so they are saved for `supercharge usage` and the
 * dashboard. Prints your own status line when you have one, otherwise a short one of ours.
 */
export async function statusLine(paths: Paths): Promise<string> {
  const raw = await readStdin();
  let input: StatusInput = {};
  try {
    input = JSON.parse(raw) as StatusInput;
  } catch {
    return '';
  }
  await Promise.all([
    recordUsage(paths, input.rate_limits).catch(() => false),
    recordContext(paths, input).catch(() => false),
  ]);

  const own = await userStatusLine(paths);
  if (own) return ((await runUserCommand(own, raw, input.workspace?.current_dir)) ?? '').replace(/\n$/, '');

  const parts = [
    input.model?.display_name ?? null,
    pct(input.context_window?.used_percentage) && `context ${pct(input.context_window?.used_percentage)}`,
    pct(input.rate_limits?.five_hour?.used_percentage) &&
      `5h ${pct(input.rate_limits?.five_hour?.used_percentage)}`,
    pct(input.rate_limits?.seven_day?.used_percentage) &&
      `week ${pct(input.rate_limits?.seven_day?.used_percentage)}`,
  ].filter(Boolean);
  return parts.join(' · ');
}
