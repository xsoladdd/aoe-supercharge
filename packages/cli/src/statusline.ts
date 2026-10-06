import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recordUsage, type Paths } from '@aoe-supercharge/core/node';

/** Fields of Claude Code's status line input that Supercharge reads. */
interface StatusInput {
  model?: { display_name?: string };
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

/** Your own status line command from ~/.claude/settings.json, so Supercharge's does not replace it. */
async function userStatusLine(paths: Paths): Promise<string | null> {
  try {
    const settings = JSON.parse(await readFile(join(paths.claudeDir, 'settings.json'), 'utf8')) as {
      statusLine?: { type?: string; command?: string };
    };
    const cmd = settings.statusLine?.type === 'command' ? settings.statusLine.command?.trim() : '';
    return cmd && !cmd.includes(' statusline') ? cmd : null;
  } catch {
    return null;
  }
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
  await recordUsage(paths, input.rate_limits).catch(() => false);

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
