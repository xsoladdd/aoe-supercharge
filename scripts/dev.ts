/**
 * `npm run dev`: run Supercharge straight from source, nothing installed.
 *   - daemon from TypeScript (tsx watch: restarts when backend code changes), real config and data
 *   - dashboard on Vite with hot reload at http://localhost:5180, proxying /api and /auth
 * Only one daemon may own your data at a time, so this refuses to start while the installed
 * service is running (stop it with `supercharge stop`, bring it back with `supercharge start`).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig, resolvePaths } from '../packages/core/src/node/index.ts';

const ROOT = join(import.meta.dirname, '..');
const UI_PORT = Number(process.env.SUPERCHARGE_DEV_UI_PORT ?? 5180);
const config = (await loadConfig(resolvePaths())).config;
const daemonUrl = `http://127.0.0.1:${config.server.port}`;
const tsx = join(ROOT, 'node_modules/.bin/tsx');
const cli = join(ROOT, 'packages/cli/src/index.ts');

const up = async () => {
  try {
    return (await fetch(`${daemonUrl}/healthz`, { signal: AbortSignal.timeout(800) })).ok;
  } catch {
    return false;
  }
};

if (await up()) {
  process.stderr.write(
    `\nA Supercharge daemon is already running on ${daemonUrl} (probably the installed service).\n` +
      `Stop it first so only one daemon owns your data:\n\n  supercharge stop\n\n` +
      `Bring it back later with: supercharge start\n\n`,
  );
  process.exit(1);
}

const children: ChildProcess[] = [];
const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  children.push(child);
  return child;
};

// Supervised by tsx watch rather than our own supervisor (which re-execs plain node).
run(tsx, ['watch', '--clear-screen=false', '--include', 'packages/core/src', cli, 'daemon'], {
  SUPERCHARGE_SUPERVISED: '1',
  SUPERCHARGE_LOG_STDERR: '1',
});
run('npm', ['run', 'dev', '-w', '@aoe-supercharge/ui', '--', '--port', String(UI_PORT), '--strictPort'], {
  SUPERCHARGE_DEV_DAEMON: daemonUrl,
});

for (let i = 0; i < 120 && !(await up()); i++) await new Promise((r) => setTimeout(r, 250));
const signIn = await new Promise<string>((resolve) => {
  const p = spawn(tsx, [cli, 'open', '--print'], { cwd: ROOT });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.on('close', () => resolve(out.trim()));
});
const devUrl = signIn
  ? `http://localhost:${UI_PORT}${new URL(signIn).pathname}${new URL(signIn).search}`
  : '';
process.stdout.write(
  `\n  Supercharge dev\n  Dashboard (hot reload): http://localhost:${UI_PORT}\n` +
    (devUrl ? `  Sign in (one-time, 60s): ${devUrl}\n` : '') +
    `  New sign-in link: npx tsx packages/cli/src/index.ts open --print  (then use port ${UI_PORT})\n\n`,
);

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
