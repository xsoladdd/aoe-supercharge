import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { userInfo } from 'node:os';
import { writeFileAtomic, type Paths } from '@aoe-supercharge/core/node';
import { run } from '../util/exec.ts';

export const SERVICE_LABEL = 'com.github.xsoladdd.aoe-supercharge';
export const SYSTEMD_UNIT = 'aoe-supercharge.service';

export interface ServiceSpec {
  nodePath: string;
  cliPath: string;
  pathEnv: string;
  logsDir: string;
  home: string;
}

export interface ServiceStatus {
  installed: boolean;
  loaded: boolean;
  file: string;
  detail: string;
}

export interface ServiceManager {
  kind: 'launchd' | 'systemd';
  file: string;
  render(spec: ServiceSpec): string;
  install(spec: ServiceSpec): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  uninstall(): Promise<void>;
  status(): Promise<ServiceStatus>;
  /** Command that restarts the service; used by POST /api/daemon/restart. */
  restartCommand(): [string, string[]];
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderLaunchdPlist(spec: ServiceSpec): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(spec.nodePath)}</string>
    <string>${xml(spec.cliPath)}</string>
    <string>daemon</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(spec.pathEnv)}</string>
    <key>HOME</key>
    <string>${xml(spec.home)}</string>
    <key>SUPERCHARGE_SERVICE</key>
    <string>launchd</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(join(spec.logsDir, 'launchd.out'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(spec.logsDir, 'launchd.out'))}</string>
</dict>
</plist>
`;
}

const sq = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`);

export function renderSystemdUnit(spec: ServiceSpec): string {
  return `[Unit]
Description=Agent of Empires: Supercharge dashboard daemon
After=default.target

[Service]
Type=simple
ExecStart=${sq(spec.nodePath)} ${sq(spec.cliPath)} daemon
Environment=${sq(`PATH=${spec.pathEnv}`)}
Environment=SUPERCHARGE_SERVICE=systemd
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=78

[Install]
WantedBy=default.target
`;
}

class LaunchdManager implements ServiceManager {
  kind = 'launchd' as const;
  file: string;
  private domain = `gui/${userInfo().uid}`;
  constructor(paths: Paths) {
    this.file = join(paths.launchAgentsDir, `${SERVICE_LABEL}.plist`);
  }
  render = renderLaunchdPlist;
  async install(spec: ServiceSpec) {
    await mkdir(spec.logsDir, { recursive: true });
    await writeFileAtomic(this.file, this.render(spec), 0o644);
  }
  private async loaded() {
    return (
      (await run('launchctl', ['print', `${this.domain}/${SERVICE_LABEL}`], { timeoutMs: 5000 })).code === 0
    );
  }
  async start() {
    if (await this.loaded())
      await run('launchctl', ['bootout', `${this.domain}/${SERVICE_LABEL}`], { timeoutMs: 15_000 });
    const r = await run('launchctl', ['bootstrap', this.domain, this.file], { timeoutMs: 15_000 });
    if (r.code !== 0) throw new Error(`launchctl bootstrap failed: ${(r.stderr || r.stdout).trim()}`);
  }
  async stop() {
    if (await this.loaded())
      await run('launchctl', ['bootout', `${this.domain}/${SERVICE_LABEL}`], { timeoutMs: 15_000 });
  }
  async restart() {
    const r = await run('launchctl', ['kickstart', '-k', `${this.domain}/${SERVICE_LABEL}`], {
      timeoutMs: 15_000,
    });
    if (r.code !== 0) await this.start();
  }
  async uninstall() {
    await this.stop();
    await rm(this.file, { force: true });
  }
  async status(): Promise<ServiceStatus> {
    const installed = existsSync(this.file);
    const loaded = await this.loaded();
    return {
      installed,
      loaded,
      file: this.file,
      detail: loaded ? 'loaded (launchd)' : installed ? 'installed, not loaded' : 'not installed',
    };
  }
  restartCommand(): [string, string[]] {
    return ['launchctl', ['kickstart', '-k', `${this.domain}/${SERVICE_LABEL}`]];
  }
}

class SystemdManager implements ServiceManager {
  kind = 'systemd' as const;
  file: string;
  constructor(paths: Paths) {
    this.file = join(paths.systemdUserDir, SYSTEMD_UNIT);
  }
  render = renderSystemdUnit;
  private ctl(...args: string[]) {
    return run('systemctl', ['--user', ...args], { timeoutMs: 20_000 });
  }
  async install(spec: ServiceSpec) {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFileAtomic(this.file, this.render(spec), 0o644);
    await this.ctl('daemon-reload');
  }
  async start() {
    const r = await this.ctl('enable', '--now', SYSTEMD_UNIT);
    if (r.code !== 0)
      throw new Error(`systemctl --user enable --now failed: ${(r.stderr || r.stdout).trim()}`);
    await this.ctl('restart', SYSTEMD_UNIT);
  }
  async stop() {
    await this.ctl('disable', '--now', SYSTEMD_UNIT);
  }
  async restart() {
    await this.ctl('restart', SYSTEMD_UNIT);
  }
  async uninstall() {
    await this.stop();
    await rm(this.file, { force: true });
    await this.ctl('daemon-reload');
  }
  async status(): Promise<ServiceStatus> {
    const installed = existsSync(this.file);
    const active = (await this.ctl('is-active', SYSTEMD_UNIT)).stdout.trim();
    return {
      installed,
      loaded: active === 'active',
      file: this.file,
      detail: `systemd: ${active || 'unknown'}`,
    };
  }
  restartCommand(): [string, string[]] {
    return ['systemctl', ['--user', 'restart', SYSTEMD_UNIT]];
  }
}

export function serviceManager(paths: Paths, platform: NodeJS.Platform = process.platform): ServiceManager {
  if (platform === 'darwin') return new LaunchdManager(paths);
  if (platform === 'linux') return new SystemdManager(paths);
  throw new Error(
    `Unsupported platform "${platform}". Supercharge runs on macOS and Linux (Windows: use WSL2).`,
  );
}

/** PATH for the service: directories of every tool we shell out to, plus sane system defaults. */
export async function servicePathEnv(
  toolPaths: (string | null)[],
  current = process.env.PATH ?? '',
): Promise<string> {
  const dirs = new Set<string>();
  for (const p of toolPaths) if (p) dirs.add(dirname(p));
  dirs.add(dirname(process.execPath));
  for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])
    dirs.add(d);
  for (const d of current.split(':')) if (d && !d.includes(' ')) dirs.add(d);
  return [...dirs].join(':');
}

export async function readServiceFile(m: ServiceManager): Promise<string | null> {
  try {
    return await readFile(m.file, 'utf8');
  } catch {
    return null;
  }
}
