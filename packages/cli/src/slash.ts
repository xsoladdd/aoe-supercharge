import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { SlashCommand } from '@aoe-supercharge/core/shared';
import type { Paths } from '@aoe-supercharge/core/node';

const b = (
  name: string,
  description: string,
  extra: Partial<Pick<SlashCommand, 'argumentHint' | 'terminal'>> = {},
): SlashCommand => ({ name, description, kind: 'builtin', source: 'claude', ...extra });

/**
 * Claude Code's own commands that make sense from a chat, described mostly in its own words (from
 * Claude Code 2.1.285's command table). `terminal` ones open a full-screen view in the session:
 * answer those in the Terminal tab. Account, install and device commands are left out.
 */
export const BUILTIN_COMMANDS: SlashCommand[] = [
  b('clear', 'Start a new session with empty context; the previous one stays on disk'),
  b('compact', 'Free up context by summarizing the conversation so far', {
    argumentHint: '<optional custom summarization instructions>',
  }),
  b('context', 'Visualize current context usage as a colored grid', { terminal: true }),
  b('model', 'Set the AI model for Claude Code', { argumentHint: '<model>' }),
  b('effort', 'Set effort level for model usage', { argumentHint: 'low | medium | high | xhigh | max' }),
  b('fast', 'Toggle fast mode'),
  b('plan', 'Enable plan mode or view the current session plan'),
  b('usage', 'Show session cost, plan usage, and activity stats', { terminal: true }),
  b('status', 'Show Claude Code status including version, model, account and tools', { terminal: true }),
  b('autocompact', 'Set how full the context gets before auto-summarizing', { argumentHint: '<tokens>' }),
  b('recap', 'Generate a one-line session recap now'),
  b('btw', 'Ask a quick side question without interrupting the main conversation', {
    argumentHint: '<question>',
  }),
  b('goal', 'Set a goal Claude checks before stopping', { argumentHint: '<goal>' }),
  b('init', 'Initialize a new CLAUDE.md file with codebase documentation'),
  b('memory', 'Edit CLAUDE.md files and memory settings', { terminal: true }),
  b('add-dir', 'Add a new working directory', { argumentHint: '<path>' }),
  b('rename', 'Rename the current conversation', { argumentHint: '<name>' }),
  b('rewind', 'Restore the conversation or code to an earlier point', { terminal: true }),
  b('resume', 'Resume a previous conversation', { terminal: true }),
  b('branch', 'Create a branch of the current conversation at this point'),
  b('fork', 'Spawn a background agent that inherits the full conversation'),
  b('subtask', 'Send a subagent off with your full context; its result comes back here'),
  b('tasks', 'View and manage everything running in the background', { terminal: true }),
  b('export', 'Export the current conversation to a file or clipboard', { terminal: true }),
  b('copy', "Copy Claude's last response to clipboard (or /copy N for the Nth-latest)"),
  b('security-review', 'Complete a security review of the pending changes on the current branch'),
  b('output-style', 'List output styles or switch to one', { argumentHint: '[style]' }),
  b('focus', 'Toggle focus view: just your prompt, summary, and response'),
  b('brief', 'Toggle brief-only mode'),
  b('advisor', 'Let Claude consult a stronger model at key moments'),
  b('permissions', 'Manage allow and deny tool permission rules', { terminal: true }),
  b('mcp', 'Manage MCP servers', { terminal: true }),
  b('hooks', 'View hook configurations for tool events', { terminal: true }),
  b('skills', 'List available skills', { terminal: true }),
  b('plugin', 'Manage Claude Code plugins', { terminal: true }),
  b('reload-skills', 'Pick up skills added or changed on disk during this session'),
  b('reload-plugins', 'Activate pending plugin changes in the current session'),
  b('list-agents', 'List subagents, teammates, and other Claude sessions you can message'),
  b('config', 'Open settings', { terminal: true }),
  b('doctor', 'Check the health of your Claude Code installation', { terminal: true }),
  b('help', 'Show help and available commands', { terminal: true }),
  b('version', "Show this session's version"),
];

/** `key: value` lines of a markdown file's frontmatter; folded (`>`/`|`) values are joined up. */
export function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  let key: string | null = null;
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1]!;
      const v = kv[2]!.trim();
      out[key] = v === '>' || v === '|' || v === '>-' || v === '|-' ? '' : v.replace(/^(['"])(.*)\1$/, '$2');
    } else if (key && /^\s+\S/.test(line)) {
      out[key] = `${out[key] ? `${out[key]} ` : ''}${line.trim()}`;
    }
  }
  return out;
}

/** The first line of prose after the frontmatter, for commands without a description. */
function firstLine(text: string): string {
  const body = text.replace(/^---[\s\S]*?\n---\r?\n?/, '');
  return (
    body
      .split(/\r?\n/)
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find(Boolean) ?? ''
  );
}

const read = (f: string) => readFile(f, 'utf8').catch(() => null);

/** A folder's entries, symlinks followed (skills are often linked in from a checkout). */
async function ls(d: string): Promise<{ name: string; dir: boolean; file: boolean }[]> {
  const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
  return Promise.all(
    entries.map(async (e) => {
      if (!e.isSymbolicLink()) return { name: e.name, dir: e.isDirectory(), file: e.isFile() };
      const st = await stat(join(d, e.name)).catch(() => null);
      return { name: e.name, dir: !!st?.isDirectory(), file: !!st?.isFile() };
    }),
  );
}

/** Every SKILL.md under a skills folder, including grouped ones (skills/<group>/<skill>/SKILL.md). */
async function skillsIn(dir: string, depth = 3): Promise<string[]> {
  const found: string[] = [];
  for (const e of await ls(dir)) {
    if (!e.dir || e.name.startsWith('.')) continue;
    const sub = join(dir, e.name);
    if ((await read(join(sub, 'SKILL.md'))) !== null) found.push(join(sub, 'SKILL.md'));
    else if (depth > 1) found.push(...(await skillsIn(sub, depth - 1)));
  }
  return found;
}

async function skillCommands(
  dir: string,
  source: SlashCommand['source'],
  prefix = '',
): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  for (const file of await skillsIn(dir)) {
    const text = (await read(file)) ?? '';
    const fm = frontmatter(text);
    if (fm['user-invocable'] === 'false') continue;
    out.push({
      name: `${prefix}${fm.name || basename(dirname(file))}`,
      description: fm.description || firstLine(text),
      kind: 'skill',
      source,
      ...(fm['argument-hint'] ? { argumentHint: fm['argument-hint'] } : {}),
    });
  }
  return out;
}

async function fileCommands(
  dir: string,
  source: SlashCommand['source'],
  prefix = '',
): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  for (const e of await ls(dir)) {
    if (!e.file || !e.name.endsWith('.md')) continue;
    const text = (await read(join(dir, e.name))) ?? '';
    const fm = frontmatter(text);
    out.push({
      name: `${prefix}${e.name.slice(0, -3)}`,
      description: fm.description || firstLine(text),
      kind: 'command',
      source,
      ...(fm['argument-hint'] ? { argumentHint: fm['argument-hint'] } : {}),
    });
  }
  return out;
}

interface InstalledPlugins {
  plugins?: Record<string, { scope?: string; projectPath?: string; installPath?: string }[]>;
}

/** Plugins installed for everyone, or for this project (or a folder above it). */
async function pluginCommands(paths: Paths, cwd: string | null): Promise<SlashCommand[]> {
  const text = await read(join(paths.claudeDir, 'plugins', 'installed_plugins.json'));
  if (!text) return [];
  let data: InstalledPlugins;
  try {
    data = JSON.parse(text) as InstalledPlugins;
  } catch {
    return [];
  }
  const out: SlashCommand[] = [];
  for (const [key, installs] of Object.entries(data.plugins ?? {})) {
    const install = installs.find(
      (i) =>
        i.scope === 'user' ||
        (!!cwd && !!i.projectPath && `${resolve(cwd)}/`.startsWith(`${resolve(i.projectPath)}/`)),
    );
    if (!install?.installPath) continue;
    const manifest = await read(join(install.installPath, '.claude-plugin', 'plugin.json'));
    let name = key.split('@')[0]!;
    try {
      name = (JSON.parse(manifest ?? '{}') as { name?: string }).name || name;
    } catch {
      // keep the name from the install key
    }
    out.push(
      ...(await fileCommands(join(install.installPath, 'commands'), 'plugin', `${name}:`)),
      ...(await skillCommands(join(install.installPath, 'skills'), 'plugin', `${name}:`)),
    );
  }
  return out;
}

/** The session's folder and the ones above it, up to (not including) your home folder. */
function projectDirs(cwd: string | null, home: string): string[] {
  if (!cwd) return [];
  const dirs: string[] = [];
  let d = resolve(cwd);
  while (d !== resolve(home) && d !== dirname(d)) {
    dirs.push(d);
    d = dirname(d);
  }
  return dirs;
}

/**
 * What a session can run with "/": Claude Code's commands, then your skills and commands (from the
 * session's project and ~/.claude), then plugins'. Among yours the first of a name wins (a project's
 * shadows a personal one); one named like a built-in is listed next to it, labelled.
 */
export async function listSlashCommands(paths: Paths, cwd: string | null): Promise<SlashCommand[]> {
  const project = (
    await Promise.all(
      projectDirs(cwd, paths.home).map(async (d) => [
        ...(await skillCommands(join(d, '.claude', 'skills'), 'project')),
        ...(await fileCommands(join(d, '.claude', 'commands'), 'project')),
      ]),
    )
  ).flat();
  const all = [
    ...BUILTIN_COMMANDS,
    ...project,
    ...(await skillCommands(join(paths.claudeDir, 'skills'), 'user')),
    ...(await fileCommands(join(paths.claudeDir, 'commands'), 'user')),
    ...(await pluginCommands(paths, cwd)),
  ];
  const seen = new Set<string>();
  return all.filter((c) => {
    const key = c.kind === 'builtin' ? `/${c.name}` : c.name;
    return !seen.has(key) && !!seen.add(key);
  });
}
