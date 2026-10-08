import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Paths {
  home: string;
  configDir: string;
  configFile: string;
  tokenFile: string;
  dataDir: string;
  projectsDir: string;
  /** Notes and todos (SPEC §14.6): `<project>.json` per project and `_global.json`. */
  notesDir: string;
  rolesDir: string;
  /** The office's own state (SPEC §14.5): who is archived, kept or snoozed. */
  officeDir: string;
  stateDir: string;
  /** The office history, one JSON-lines file per UTC day (SPEC §14.5). */
  historyDir: string;
  /** Files you attach in a chat, one folder per session; Claude reads them from here (never the repo). */
  uploadsDir: string;
  /** Your last reported 5-hour and weekly Claude usage, written by Supercharge's status line. */
  usageFile: string;
  /** Claude Code settings Supercharge passes to the sessions it starts (`claude --settings`). */
  claudeSettingsFile: string;
  logsDir: string;
  logFile: string;
  auditFile: string;
  compatLocalFile: string;
  daemonStateFile: string;
  /** The terminals a chat's Run opened, so they reconnect after a reload or a daemon restart. */
  runTerminalsFile: string;
  localFixturesDir: string;
  claudeDir: string;
  claudeSkillsDir: string;
  launchAgentsDir: string;
  systemdUserDir: string;
}

/** XDG layout on both macOS and Linux (SPEC §6). `$XDG_*` and `$CLAUDE_CONFIG_DIR` are respected. */
export function resolvePaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = env.HOME ?? homedir(),
): Paths {
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config');
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const stateHome = env.XDG_STATE_HOME || join(home, '.local', 'state');
  const configDir = join(configHome, 'supercharge');
  const dataDir = join(dataHome, 'supercharge');
  const stateDir = join(stateHome, 'supercharge');
  const logsDir = join(stateDir, 'logs');
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  return {
    home,
    configDir,
    configFile: join(configDir, 'config.toml'),
    tokenFile: join(configDir, 'auth.token'),
    dataDir,
    projectsDir: join(dataDir, 'projects'),
    notesDir: join(dataDir, 'notes'),
    rolesDir: join(dataDir, 'agent', 'claude-code', 'roles'),
    officeDir: join(dataDir, 'office'),
    stateDir,
    historyDir: join(stateDir, 'history'),
    uploadsDir: join(stateDir, 'uploads'),
    usageFile: join(stateDir, 'usage.json'),
    claudeSettingsFile: join(stateDir, 'claude-settings.json'),
    logsDir,
    logFile: join(logsDir, 'daemon.log'),
    auditFile: join(stateDir, 'audit.jsonl'),
    compatLocalFile: join(stateDir, 'compat.local.json'),
    daemonStateFile: join(stateDir, 'daemon.json'),
    runTerminalsFile: join(stateDir, 'terminals.json'),
    localFixturesDir: join(stateDir, 'fixtures'),
    claudeDir,
    claudeSkillsDir: join(claudeDir, 'skills'),
    launchAgentsDir: join(home, 'Library', 'LaunchAgents'),
    systemdUserDir: join(configHome, 'systemd', 'user'),
  };
}
