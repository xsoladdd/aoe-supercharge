import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { checkCompat, readLocalCompat } from '@aoe-supercharge/core/node';
import { SHIPPED_COMPAT, VERSION, type Ctx } from '../context.ts';
import { readServiceFile, serviceManager } from '../service/index.ts';
import { skillsStatus } from '../skills.ts';
import { daemonHealth } from '../util/daemon-client.ts';
import { run, which } from '../util/exec.ts';
import { c, out, sym } from '../util/term.ts';
import { mrProvider } from '../workflow.ts';

export interface Check {
  group: string;
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

async function version(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  const r = await run(bin, args, { env, timeoutMs: 10_000 });
  if (r.code !== 0) return null;
  return (r.stdout || r.stderr).trim().split('\n')[0] ?? null;
}

/** Mirrors AoE's app-dir precedence (src/session/mod.rs): XDG dir if present, else ~/.agent-of-empires. */
export function aoeAppDir(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'agent-of-empires');
  const legacy = join(home, '.agent-of-empires');
  if (existsSync(xdg)) return xdg;
  if (existsSync(legacy)) return legacy;
  return env.XDG_CONFIG_HOME || process.platform === 'linux' ? xdg : legacy;
}

/** Claude Code 2.1.284 added Sonnet 5.5; older builds resolve `opus` and `sonnet` to the 5.0 models. */
export const MODELS_55_SINCE = [2, 1, 284] as const;

export function claudeModelsCheck(versionLine: string): Check | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(versionLine);
  if (!m) return null;
  const have = [Number(m[1]), Number(m[2]), Number(m[3])];
  const older = have.findIndex((n, i) => n !== MODELS_55_SINCE[i]);
  const ok = older === -1 || have[older]! > MODELS_55_SINCE[older]!;
  const since = MODELS_55_SINCE.join('.');
  return {
    group: 'Tools',
    name: 'Claude models',
    status: ok ? 'ok' : 'warn',
    detail: ok
      ? 'opus and sonnet start Opus 5.5 and Sonnet 5.5'
      : `Claude Code ${have.join('.')} is older than ${since}: opus and sonnet start Opus 5 and Sonnet 5, not 5.5`,
    fix: ok ? undefined : 'Update Claude Code (Homebrew: brew upgrade claude-code), then start new sessions.',
  };
}

export async function runDoctor(ctx: Ctx): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const env = ctx.env;

  // Platform + runtime
  const platformOk = process.platform === 'darwin' || process.platform === 'linux';
  add({
    group: 'System',
    name: 'Platform',
    status: platformOk ? 'ok' : 'fail',
    detail: `${process.platform} ${process.arch}`,
    fix: platformOk ? undefined : 'Use macOS or Linux (Windows: WSL2).',
  });
  const major = Number(process.versions.node.split('.')[0]);
  add({
    group: 'System',
    name: 'Node',
    status: major >= 24 ? 'ok' : 'fail',
    detail: `v${process.versions.node}`,
    fix: major >= 24 ? undefined : 'Install Node 24 LTS (see README#dependencies).',
  });

  for (const [bin, args, fix] of [
    ['git', ['--version'], 'brew install git  (Linux: apt/dnf/pacman install git)'],
    ['tmux', ['-V'], 'brew install tmux  (Linux: apt/dnf/pacman install tmux)'],
    ['claude', ['--version'], 'Install Claude Code: https://docs.claude.com/claude-code'],
  ] as const) {
    const v = await version(bin, [...args], env);
    add({
      group: 'Tools',
      name: bin,
      status: v ? 'ok' : 'fail',
      detail: v ?? 'not found',
      fix: v ? undefined : fix,
    });
    if (bin === 'claude' && v) {
      const models = claudeModelsCheck(v);
      if (models) add(models);
    }
  }

  // AoE
  const installed = await ctx.aoeCli.version();
  const local = await readLocalCompat(ctx.paths);
  const compat = checkCompat(installed, SHIPPED_COMPAT, local);
  add({
    group: 'Agent of Empires',
    name: 'aoe installed',
    status: compat.ok ? 'ok' : 'fail',
    detail: installed
      ? `${installed} (tested range ${compat.range}${compat.verifiedLocally ? ', verified locally' : ''})`
      : 'not found',
    fix: compat.fix ?? undefined,
  });
  if (installed) {
    // A fresh AoE refuses to launch agents until its hook paths are acknowledged in the TUI.
    const appDir = aoeAppDir(ctx.env, ctx.paths.home);
    const state = await readFile(join(appDir, 'state.toml'), 'utf8').catch(() => '');
    const acked = /^\s*has_acknowledged_agent_hooks\s*=\s*true/m.test(state);
    add({
      group: 'Agent of Empires',
      name: 'hook consent',
      status: acked ? 'ok' : 'warn',
      detail: acked ? 'agent hook paths acknowledged' : 'not acknowledged yet; new sessions will not launch',
      fix: acked ? undefined : 'Run "aoe" once and approve the agent hook paths it asks about.',
    });
    const running = await ctx.aoeCli.serveRunning();
    add({
      group: 'Agent of Empires',
      name: 'aoe serve',
      status: running ? 'ok' : 'warn',
      detail: running ? 'running' : 'not running',
      fix: running
        ? undefined
        : 'aoe serve --daemon  (the Supercharge daemon also starts it when aoe.autoStart is on)',
    });
    if (running) {
      try {
        const disc = await ctx.aoe.discover();
        add({
          group: 'Agent of Empires',
          name: 'aoe token',
          status: disc.hasToken ? 'ok' : 'warn',
          detail: disc.hasToken ? 'readable (kept server-side)' : 'no token (auth disabled?)',
        });
        const about = await ctx.aoe.about();
        const serveCompat = checkCompat(about.version, SHIPPED_COMPAT, local);
        const mismatch = about.version !== installed;
        add({
          group: 'Agent of Empires',
          name: 'aoe API',
          status: !serveCompat.ok ? 'fail' : mismatch ? 'warn' : 'ok',
          detail: `reachable at ${disc.origin}, daemon reports ${about.version}${mismatch ? ` but the binary is ${installed}` : ''}`,
          fix: !serveCompat.ok
            ? (serveCompat.fix ?? undefined)
            : mismatch
              ? 'Restart it so the daemon matches the binary: aoe serve --restart'
              : undefined,
        });
      } catch (e) {
        add({
          group: 'Agent of Empires',
          name: 'aoe API',
          status: 'fail',
          detail: (e as Error).message,
          fix: 'aoe serve --restart',
        });
      }
    }
  }

  // GitLab
  for (const chk of await mrProvider(ctx.config, env).doctor()) {
    add({
      group: 'GitLab',
      name: chk.name,
      status: chk.ok ? 'ok' : chk.name === 'glab' ? 'fail' : 'warn',
      detail: chk.detail,
      fix: chk.fix,
    });
  }

  // Config + permissions
  add({
    group: 'Supercharge',
    name: 'config',
    status: ctx.configErrors.length ? 'fail' : 'ok',
    detail: ctx.configErrors.length
      ? ctx.configErrors.join('; ')
      : ctx.configExists
        ? ctx.paths.configFile
        : `${ctx.paths.configFile} (not created yet; defaults apply)`,
    fix: ctx.configErrors.length ? 'supercharge config edit' : undefined,
  });
  const mode = async (p: string) => {
    try {
      return (await stat(p)).mode & 0o777;
    } catch {
      return null;
    }
  };
  const dirMode = await mode(ctx.paths.configDir);
  const tokMode = await mode(ctx.paths.tokenFile);
  const permsOk = (dirMode === null || dirMode === 0o700) && (tokMode === null || tokMode === 0o600);
  add({
    group: 'Supercharge',
    name: 'permissions',
    status: permsOk ? 'ok' : 'fail',
    detail: `config dir ${dirMode === null ? 'missing' : dirMode.toString(8)}, token ${tokMode === null ? 'not created yet' : tokMode.toString(8)}`,
    fix: permsOk ? undefined : `chmod 700 ${ctx.paths.configDir} && chmod 600 ${ctx.paths.tokenFile}`,
  });

  // Service
  try {
    const svc = serviceManager(ctx.paths);
    const st = await svc.status();
    add({
      group: 'Supercharge',
      name: 'service',
      status: st.loaded ? 'ok' : 'warn',
      detail: `${st.detail} (${st.file})`,
      fix: st.loaded ? undefined : 'supercharge start',
    });
    const file = await readServiceFile(svc);
    const nodePath = file?.match(
      svc.kind === 'launchd'
        ? /<string>([^<]+)<\/string>\s*<string>[^<]*supercharge[^<]*<\/string>/
        : /^ExecStart=("?)([^"\s]+)\1/m,
    )?.[svc.kind === 'launchd' ? 1 : 2];
    if (nodePath) {
      const exists = await stat(nodePath).then(
        () => true,
        () => false,
      );
      add({
        group: 'Supercharge',
        name: 'service node',
        status: exists ? 'ok' : 'fail',
        detail: nodePath,
        fix: exists
          ? undefined
          : 'The pinned node binary is gone (nvm switch?). Run "supercharge start" to re-pin it.',
      });
    }
  } catch (e) {
    add({ group: 'Supercharge', name: 'service', status: 'fail', detail: (e as Error).message });
  }
  const health = await daemonHealth(ctx);
  add({
    group: 'Supercharge',
    name: 'daemon',
    status: health ? 'ok' : 'warn',
    detail: health
      ? `listening on 127.0.0.1:${ctx.config.server.port} (v${health.version})`
      : `not reachable on 127.0.0.1:${ctx.config.server.port}`,
    fix: health ? undefined : 'supercharge start  (or "supercharge logs" to see why it stopped)',
  });
  if (health && health.version !== VERSION) {
    add({
      group: 'Supercharge',
      name: 'daemon version',
      status: 'warn',
      detail: `daemon ${health.version}, CLI ${VERSION}`,
      fix: 'supercharge restart',
    });
  }
  try {
    const addrs = await lookup(ctx.config.server.hostname, { all: true });
    const loop = addrs.every((a) => a.address === '127.0.0.1' || a.address === '::1');
    add({
      group: 'Supercharge',
      name: 'hostname',
      status: loop ? 'ok' : 'fail',
      detail: `${ctx.config.server.hostname} → ${addrs.map((a) => a.address).join(', ')}`,
      fix: loop ? undefined : 'Use a *.localhost hostname (server.hostname).',
    });
  } catch {
    add({
      group: 'Supercharge',
      name: 'hostname',
      status: 'warn',
      detail: `${ctx.config.server.hostname} does not resolve on this system (browsers still map *.localhost to loopback)`,
      fix: 'Use http://127.0.0.1:<port> if your browser cannot open it.',
    });
  }

  const notifier = process.platform === 'darwin' ? 'osascript' : 'notify-send';
  const hasNotifier = !!(await which(notifier, env));
  add({
    group: 'Supercharge',
    name: 'notifications',
    status: hasNotifier ? 'ok' : 'warn',
    detail: hasNotifier ? notifier : `${notifier} not found`,
    fix: hasNotifier ? undefined : 'Linux: install libnotify (notify-send).',
  });

  if (ctx.config.remoteControl.enabled) {
    const help = await run('claude', ['--help'], { env, timeoutMs: 15_000 });
    const supported = help.stdout.includes('--remote-control');
    add({
      group: 'Supercharge',
      name: 'remote control',
      status: supported ? 'ok' : 'fail',
      detail: supported
        ? 'claude supports --remote-control'
        : 'this Claude Code has no --remote-control flag',
      fix: supported ? undefined : 'Update Claude Code, or set remoteControl.enabled = false.',
    });
  }

  for (const s of await skillsStatus(ctx.paths, VERSION)) {
    const status =
      s.state === 'current' ? 'ok' : s.state === 'missing' || s.state === 'outdated' ? 'warn' : 'warn';
    const fix =
      s.state === 'missing' || s.state === 'outdated'
        ? 'supercharge start (installs them)'
        : s.state === 'user-modified'
          ? `You edited ${s.dir}; Supercharge will not overwrite it. Delete it to get the managed version.`
          : s.state === 'user-owned'
            ? `${s.dir} exists without a Supercharge marker and is left alone.`
            : undefined;
    add({ group: 'Skills', name: s.name, status, detail: s.state, fix });
  }
  return checks;
}

export function printDoctor(checks: Check[]) {
  let group = '';
  for (const ch of checks) {
    if (ch.group !== group) {
      group = ch.group;
      out(`\n${c.bold(group)}`);
    }
    const s = ch.status === 'ok' ? sym.ok : ch.status === 'warn' ? sym.warn : sym.fail;
    out(`  ${s} ${ch.name.padEnd(16)} ${ch.detail}`);
    if (ch.fix && ch.status !== 'ok') out(`    ${c.dim('fix:')} ${ch.fix}`);
  }
  const fails = checks.filter((x) => x.status === 'fail').length;
  const warns = checks.filter((x) => x.status === 'warn').length;
  out(
    `\n${fails ? `${sym.fail} ${fails} problem(s)` : `${sym.ok} No problems`}${warns ? `, ${warns} warning(s)` : ''}`,
  );
}
