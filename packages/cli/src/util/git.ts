import { basename, dirname, resolve } from 'node:path';
import { run } from './exec.ts';

async function git(cwd: string, args: string[]): Promise<string | null> {
  const r = await run('git', args, { cwd, timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Absolute path of the main checkout, even when called from a linked worktree. */
export async function mainCheckout(cwd: string): Promise<string | null> {
  const common = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return null;
  return basename(common) === '.git' ? dirname(common) : resolve(common);
}

export const toplevel = (cwd: string) => git(cwd, ['rev-parse', '--show-toplevel']);

export async function currentBranch(cwd: string): Promise<string | null> {
  const b = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return b && b !== 'HEAD' ? b : null;
}

export const remoteUrl = (cwd: string, remote = 'origin') => git(cwd, ['remote', 'get-url', remote]);

export async function defaultBranch(cwd: string): Promise<string> {
  const ref = await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (ref) return ref.replace(/^origin\//, '');
  for (const b of ['main', 'master', 'develop']) {
    if (await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])) return b;
  }
  return (await currentBranch(cwd)) ?? 'main';
}

export interface RemoteRef {
  host: string;
  path: string;
}

/** git@host:group/repo.git | https://host/group/repo(.git) | ssh://git@host:22/group/repo.git → {host, path} */
export function parseRemote(url: string | null): RemoteRef | null {
  if (!url) return null;
  const scp = url.match(/^[\w.-]+@([^:/]+):(.+?)(?:\.git)?\/?$/);
  if (scp) return { host: scp[1]!.toLowerCase(), path: scp[2]! };
  try {
    const u = new URL(url);
    const path = u.pathname
      .replace(/^\/+/, '')
      .replace(/\.git\/?$/, '')
      .replace(/\/$/, '');
    return path ? { host: u.hostname.toLowerCase(), path } : null;
  } catch {
    return null;
  }
}
