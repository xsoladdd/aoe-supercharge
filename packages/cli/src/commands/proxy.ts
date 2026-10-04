import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeFileAtomic, writeJsonAtomic } from '@aoe-supercharge/core/node';
import type { Ctx } from '../context.ts';
import { CliError } from '../util/errors.ts';
import { run, which } from '../util/exec.ts';
import { c, confirm, out, sym } from '../util/term.ts';

const stateFile = (ctx: Ctx) => join(ctx.paths.stateDir, 'proxy.json');
const caddyFile = (ctx: Ctx) => join(ctx.paths.configDir, 'Caddyfile');

export function renderCaddyfile(hostname: string, port: number): string {
  return `# Managed by Agent of Empires: Supercharge ("supercharge proxy disable" removes it).
{
\tadmin localhost:2019
\tauto_https off
}

http://${hostname} {
\tbind 127.0.0.1 ::1
\treverse_proxy 127.0.0.1:${port}
}
`;
}

export async function proxyEnabled(ctx: Ctx): Promise<boolean> {
  return !!(await readJson<{ enabled: boolean }>(stateFile(ctx)))?.enabled;
}

async function caddyRunning(caddy: string): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:2019/config/', { signal: AbortSignal.timeout(1500) });
    return res.ok && !!caddy;
  } catch {
    return false;
  }
}

/** Start or reload Caddy with our Caddyfile. Used by `proxy enable` and on daemon boot when enabled. */
export async function applyProxy(ctx: Ctx): Promise<void> {
  const caddy = await which('caddy', ctx.env);
  if (!caddy)
    throw new CliError(
      'Caddy is not installed.',
      1,
      'brew install caddy  (Linux: see https://caddyserver.com/docs/install)',
    );
  const file = caddyFile(ctx);
  await writeFileAtomic(file, renderCaddyfile(ctx.config.server.hostname, ctx.config.server.port));
  const args = (await caddyRunning(caddy))
    ? ['reload', '--config', file, '--adapter', 'caddyfile']
    : ['start', '--config', file, '--adapter', 'caddyfile'];
  const r = await run(caddy, args, { env: ctx.env, timeoutMs: 30_000 });
  if (r.code !== 0) {
    throw new CliError(
      `caddy ${args[0]} failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`,
      1,
      process.platform === 'linux'
        ? 'Binding port 80 needs privileges: sudo setcap cap_net_bind_service=+ep $(command -v caddy)'
        : 'Check that nothing else listens on port 80.',
    );
  }
}

export async function proxyCommand(
  ctx: Ctx,
  action: 'enable' | 'disable' | 'status',
  yes: boolean,
): Promise<void> {
  const caddy = await which('caddy', ctx.env);
  if (action === 'status') {
    const enabled = await proxyEnabled(ctx);
    const running = caddy ? await caddyRunning(caddy) : false;
    out(
      `${enabled ? sym.ok : sym.info} proxy ${enabled ? 'enabled' : 'disabled'}${enabled ? `, caddy ${running ? 'running' : 'not running'}` : ''}`,
    );
    if (enabled) out(`  http://${ctx.config.server.hostname} → 127.0.0.1:${ctx.config.server.port}`);
    return;
  }
  if (action === 'disable') {
    if (caddy && (await caddyRunning(caddy))) await run(caddy, ['stop'], { env: ctx.env, timeoutMs: 20_000 });
    await rm(caddyFile(ctx), { force: true });
    await writeJsonAtomic(stateFile(ctx), { enabled: false });
    out(
      `${sym.ok} Proxy disabled. The dashboard stays on http://${ctx.config.server.hostname}:${ctx.config.server.port}`,
    );
    return;
  }
  out(c.bold('This will:'));
  if (!caddy)
    out(
      `  1. Install Caddy: ${process.platform === 'darwin' ? 'brew install caddy' : 'see https://caddyserver.com/docs/install'}`,
    );
  out(`  ${caddy ? 1 : 2}. Write ${caddyFile(ctx)}`);
  out(
    `  ${caddy ? 2 : 3}. Run Caddy on port 80 (127.0.0.1 only), proxying http://${ctx.config.server.hostname} → 127.0.0.1:${ctx.config.server.port}`,
  );
  out(c.dim('  Port 80 can need admin rights (Linux). Nothing is exposed beyond this machine.'));
  if (!yes && !(await confirm('Continue?'))) {
    out('Nothing changed.');
    return;
  }
  if (!caddy) {
    if (process.platform !== 'darwin')
      throw new CliError(
        'Install Caddy first, then re-run "supercharge proxy enable".',
        1,
        'https://caddyserver.com/docs/install',
      );
    const r = await run('brew', ['install', 'caddy'], { env: ctx.env, timeoutMs: 600_000 });
    if (r.code !== 0) throw new CliError(`brew install caddy failed: ${r.stderr.trim()}`);
  }
  await applyProxy(ctx);
  await writeJsonAtomic(stateFile(ctx), { enabled: true });
  out(`${sym.ok} Proxy enabled: http://${ctx.config.server.hostname}`);
}
