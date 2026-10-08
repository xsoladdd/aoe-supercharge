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

// ── branch landing (no-MR flow) ──────────────────────────────────────────────

/** Commit sha of a ref, or null if it doesn't exist. */
export const revParse = (cwd: string, ref: string) =>
  git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);

/** Number of commits on `head` that are not on `base`, or null if either ref is missing. */
export async function commitsAhead(cwd: string, base: string, head: string): Promise<number | null> {
  const n = await git(cwd, ['rev-list', '--count', `${base}..${head}`]);
  return n === null ? null : Number(n);
}

/**
 * Has `head` landed on `base`? True when `head` is an ancestor of `base` (fast-forward or merge),
 * or when every commit of `head` not on `base` has an equivalent patch there (cherry-picked or
 * rebased, the patch-id match `git cherry` and `git range-diff` use).
 */
export async function hasLanded(cwd: string, base: string, head: string): Promise<boolean> {
  const r = await run('git', ['merge-base', '--is-ancestor', head, base], { cwd, timeoutMs: 10_000 });
  if (r.code === 0) return true;
  if (r.code !== 1) return false;
  const cherry = await git(cwd, ['cherry', base, head]);
  if (cherry === null) return false;
  const lines = cherry.split('\n').filter(Boolean);
  return lines.length > 0 && lines.every((l) => l.startsWith('-'));
}

// ── cleanup checks ───────────────────────────────────────────────────────────

/** `git fetch origin <branch>`: the one place Supercharge reaches the network for git. False when it fails. */
export async function fetchBranch(cwd: string, branch: string, remote = 'origin'): Promise<boolean> {
  const r = await run('git', ['fetch', '--quiet', remote, branch], { cwd, timeoutMs: 60_000 });
  return r.code === 0;
}

/** Paths with uncommitted changes, untracked files included; null when git cannot say. */
export async function dirtyPaths(cwd: string): Promise<string[] | null> {
  // Not through git(): its trim() would eat the leading space of " M path".
  const r = await run('git', ['status', '--porcelain'], { cwd, timeoutMs: 10_000 });
  return r.code === 0
    ? r.stdout
        .split('\n')
        .filter(Boolean)
        .map((l) => l.slice(3))
    : null;
}

/** `head` is `base` or reachable from it (fast-forward or merge commit). */
export async function isAncestor(cwd: string, head: string, base: string): Promise<boolean> {
  const r = await run('git', ['merge-base', '--is-ancestor', head, base], { cwd, timeoutMs: 10_000 });
  return r.code === 0;
}

/** Every commit of `head` not on `base` has an equivalent patch there (cherry-picked or rebased). */
export async function isCherried(cwd: string, base: string, head: string): Promise<boolean> {
  const cherry = await git(cwd, ['cherry', base, head]);
  if (cherry === null) return false;
  const lines = cherry.split('\n').filter(Boolean);
  return lines.length > 0 && lines.every((l) => l.startsWith('-'));
}

/** One-line subjects of the commits on `head` that are not on `base` (ones with an equivalent patch there left out), newest first. */
export async function unlandedCommits(cwd: string, base: string, head: string): Promise<string[]> {
  const out = await git(cwd, [
    'log',
    '--oneline',
    '--no-decorate',
    '--right-only',
    '--cherry-pick',
    `${base}...${head}`,
  ]);
  return out ? out.split('\n').filter(Boolean) : [];
}
