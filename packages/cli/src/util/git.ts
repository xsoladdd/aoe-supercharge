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

export { parseRemote, type RemoteRef } from '@aoe-supercharge/core/shared';

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
 * Has `head` landed on `base`? True when `head` is an ancestor of `base` (fast-forward or merge), when
 * every commit of `head` not on `base` has an equivalent patch there (cherry-picked or rebased, the
 * patch-id match `git cherry` and `git range-diff` use), or when its changes are all on `base` already
 * (squash merges, `isContentMerged`).
 */
export async function hasLanded(cwd: string, base: string, head: string): Promise<boolean> {
  return (
    (await isAncestor(cwd, head, base)) ||
    (await isCherried(cwd, base, head)) ||
    (await isContentMerged(cwd, base, head))
  );
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

/**
 * Merging `head` into `base` would change nothing: its changes are all there already (a squash merge,
 * where one commit holds them). Also tried for each pushed branch that contains `head` (`origin/dev` when
 * dev is squashed into main), as long as that branch still changes every file `head` changed, which a
 * revert there would undo. A conflict, any difference, or git before 2.38 (no `merge-tree --write-tree`)
 * is not landed.
 */
export async function isContentMerged(cwd: string, base: string, head: string): Promise<boolean> {
  const tree = await git(cwd, ['rev-parse', '--verify', '--quiet', `${base}^{tree}`]);
  const fork = await git(cwd, ['merge-base', base, head]);
  if (!tree || !fork) return false;
  const changed = async (tip: string) =>
    (await git(cwd, ['diff', '--name-only', '--no-renames', fork, tip]))?.split('\n').filter(Boolean);
  const holders = await git(cwd, [
    'for-each-ref',
    '--contains',
    head,
    '--format=%(objectname)',
    'refs/remotes',
  ]);
  for (const tip of new Set([head, ...(holders ?? '').split('\n').filter(Boolean)])) {
    const merged = await git(cwd, ['merge-tree', '--write-tree', '--no-messages', base, tip]);
    if (merged?.split('\n')[0] !== tree) continue;
    if (tip === head) return true;
    // shortcut: a revert of part of a file that other work also changed goes unnoticed; compare hunks if that bites.
    const theirs = new Set(await changed(tip));
    if ((await changed(head))?.every((p) => theirs.has(p))) return true;
  }
  return false;
}
