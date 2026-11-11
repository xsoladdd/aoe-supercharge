import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ledger, resolvePaths } from '@aoe-supercharge/core/node';
import type { MrState, TaskRecord } from '@aoe-supercharge/core/shared';
import { project as projectRecord, task as taskRecord } from '../../core/test/office-fixtures.ts';
import { AoeError } from '../src/aoe/client.ts';
import { checkCleanup, cleanupAllDone, cleanupTask } from '../src/cleanup.ts';
import type { Ctx } from '../src/context.ts';
import { rollbackStart } from '../src/workflow.ts';
import { run } from '../src/util/exec.ts';

/**
 * Real git: a bare origin, a clone as the project's checkout, and a worktree per worker, as AoE makes
 * them. Only AoE is faked.
 */
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function g(cwd: string, ...args: string[]) {
  const r = await run('git', args, { cwd, timeoutMs: 20_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

async function setup(branch = 'sc/as-0001-t') {
  const root = await mkdtemp(join(tmpdir(), 'sc-cleanup-'));
  dirs.push(root);
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  const wt = join(root, 'wt');
  await g(root, 'init', '-q', '--bare', '-b', 'main', origin);
  await g(root, 'clone', '-q', origin, repo);
  for (const dir of [repo]) {
    await g(dir, 'config', 'user.email', 't@example.com');
    await g(dir, 'config', 'user.name', 'T');
    await g(dir, 'config', 'commit.gpgsign', 'false');
  }
  const commit = async (dir: string, file: string, text = `${file}\n`) => {
    await writeFile(join(dir, file), text);
    await g(dir, 'add', file);
    await g(dir, 'commit', '-q', '-m', file);
  };
  await commit(repo, 'a.txt');
  await g(repo, 'push', '-q', 'origin', 'main');
  await g(repo, 'worktree', 'add', '-q', '-b', branch, wt);
  await commit(wt, 'b.txt');
  await commit(wt, 'c.txt');
  const head = await g(wt, 'rev-parse', 'HEAD');
  // Main moves on, so a cherry-pick has another parent and never lands as the very same commit.
  await commit(repo, 'm.txt');
  await g(repo, 'push', '-q', 'origin', 'main');
  return { root, origin, repo, wt, branch, head, commit };
}

const mr = (over: Partial<MrState>): MrState => ({
  provider: 'github',
  host: 'github.com',
  repo: 'o/r',
  iid: 12,
  url: 'https://github.com/o/r/pull/12',
  state: 'merged',
  draft: false,
  pipeline: 'success',
  unresolvedThreads: 0,
  detailedMergeStatus: null,
  checkedAt: null,
  error: null,
  ...over,
});

async function world(over: Partial<TaskRecord> = {}, branch?: string) {
  const w = await setup(branch);
  const paths = resolvePaths({}, join(w.root, 'home'));
  const ledger = new Ledger(paths);
  await ledger.saveProject({ ...projectRecord('alpha', 'ctl'), repoPath: w.repo, idPrefix: 'AS' });
  const t = taskRecord('AS-0001', 'alpha', 'sess-1', {
    stage: 'done',
    branch: w.branch,
    worktreePath: w.wt,
    ...over,
  });
  await ledger.createTask(t);
  // AoE's sessions; deleting one removes its worktree, as AoE does (and leaves the branch to us).
  const sessions = [{ id: 'sess-1', archived_at: null as string | null, trashed_at: null }];
  const worktrees: Record<string, string> = { 'sess-1': w.wt };
  const listSessions = vi.fn(async () => sessions.map((x) => ({ ...x })));
  const deleteSession = vi.fn(async (id: string, _opts?: object) => {
    const i = sessions.findIndex((x) => x.id === id);
    if (i >= 0) sessions.splice(i, 1);
    // A folder git no longer reads as a worktree goes too.
    if (worktrees[id] && existsSync(worktrees[id]))
      await g(w.repo, 'worktree', 'remove', '--force', worktrees[id]).catch(() =>
        rm(worktrees[id]!, { recursive: true, force: true }),
      );
    return { status: 'deleted' };
  });
  const ctx = {
    ledger,
    paths,
    config: { aoe: { deleteTimeoutSeconds: 600 } },
    aoe: { deleteSession, listSessions, setArchived: vi.fn() },
  } as unknown as Ctx;
  return { ...w, ctx, ledger, paths, deleteSession, listSessions, sessions };
}

const DELETE = { deleteWorktree: true, deleteBranch: true, force: false, timeoutMs: 600_000 };

describe('checkCleanup: only when the work is on origin/main', () => {
  it('merged (merge commit): ok, as an ancestor', async () => {
    const w = await world();
    await g(w.repo, 'merge', '-q', '--no-ff', '--no-edit', w.branch);
    await g(w.repo, 'push', '-q', 'origin', 'main');
    const c = await checkCleanup(w.ctx, 'alpha', 'AS-0001');
    expect(c).toMatchObject({ ok: true, landedBy: 'ancestor', head: w.head });
  });

  it('merged only locally, not pushed: refused (origin is what counts)', async () => {
    const w = await world();
    await g(w.repo, 'merge', '-q', '--no-ff', '--no-edit', w.branch);
    const c = await checkCleanup(w.ctx, 'alpha', 'AS-0001');
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/not on origin\/main/);
  });

  it('landed as equivalent patches (cherry-picked, new shas): ok', async () => {
    const w = await world();
    await g(w.repo, 'cherry-pick', `${w.branch}~1`, w.branch);
    await g(w.repo, 'push', '-q', 'origin', 'main');
    const c = await checkCleanup(w.ctx, 'alpha', 'AS-0001');
    expect(c).toMatchObject({ ok: true, landedBy: 'cherry' });
  });

  it('only part of it cherry-picked: refused, and the missing commit is listed', async () => {
    const w = await world();
    await g(w.repo, 'cherry-pick', `${w.branch}~1`);
    await g(w.repo, 'push', '-q', 'origin', 'main');
    const c = await checkCleanup(w.ctx, 'alpha', 'AS-0001');
    expect(c.ok).toBe(false);
    expect(c.detail).toHaveLength(1);
    expect(c.detail![0]).toContain('c.txt');
  });

  it('squash-merged PR the watcher recorded as merged: ok', async () => {
    const w = await world({ mr: mr({}) });
    // The same content on main as one new commit: no ancestor, no equivalent patches.
    await g(w.repo, 'merge', '-q', '--squash', w.branch);
    await g(w.repo, 'commit', '-q', '-m', 'Squashed (#12)');
    await g(w.repo, 'push', '-q', 'origin', 'main');
    const task = (await w.ledger.getTask('alpha', 'AS-0001'))!;
    await w.ledger.updateTask('alpha', 'AS-0001', (t) => ({
      ...t,
      mr: mr({ headSha: w.head }),
      rev: task.rev,
    }));
    const c = await checkCleanup(w.ctx, 'alpha', 'AS-0001');
    expect(c).toMatchObject({ ok: true, landedBy: 'merged_pr' });
  });

  it('squash-merged PR, but the worktree has a commit past the PR head: refused', async () => {
    const w = await world();
    await g(w.repo, 'merge', '-q', '--squash', w.branch);
    await g(w.repo, 'commit', '-q', '-m', 'Squashed (#12)');
    await g(w.repo, 'push', '-q', 'origin', 'main');
    await w.ledger.updateTask('alpha', 'AS-0001', (t) => ({ ...t, mr: mr({ headSha: w.head }) }));
    await w.commit(w.wt, 'late.txt');
    const c = await checkCleanup(w.ctx, 'alpha', 'AS-0001');
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/merged pull request does not cover/);
    expect(c.detail?.[0]).toContain('late.txt');
  });

  it('a merged MR with no recorded head (an older record) is not trusted; the content decides', async () => {
    const w = await world({ mr: mr({}) });
    await g(w.repo, 'merge', '-q', '--squash', w.branch);
    await g(w.repo, 'commit', '-q', '-m', 'Squashed (#12)');
    await g(w.repo, 'push', '-q', 'origin', 'main');
    expect(await checkCleanup(w.ctx, 'alpha', 'AS-0001')).toMatchObject({ ok: true, landedBy: 'content' });
  });

  it('squash-merged with no pull request on record: ok, by content', async () => {
    const w = await world();
    await g(w.repo, 'merge', '-q', '--squash', w.branch);
    await g(w.repo, 'commit', '-q', '-m', 'Squashed');
    await g(w.repo, 'push', '-q', 'origin', 'main');
    expect(await checkCleanup(w.ctx, 'alpha', 'AS-0001')).toMatchObject({
      ok: true,
      landedBy: 'content',
      head: w.head,
    });
  });

  it('squash-merged, then a commit in the worktree that is not on main: refused', async () => {
    const w = await world();
    await g(w.repo, 'merge', '-q', '--squash', w.branch);
    await g(w.repo, 'commit', '-q', '-m', 'Squashed');
    await g(w.repo, 'push', '-q', 'origin', 'main');
    await w.commit(w.wt, 'late.txt');
    const c = await checkCleanup(w.ctx, 'alpha', 'AS-0001');
    expect(c.ok).toBe(false);
    expect(c.detail?.[0]).toContain('late.txt');
  });

  /** The branch goes to dev, more work on dev rewrites the same file, and dev is squashed into main. */
  async function squashedThroughDev() {
    const w = await world();
    await g(w.repo, 'checkout', '-q', '-b', 'dev', 'main~1');
    await g(w.repo, 'merge', '-q', '--ff-only', w.branch);
    await w.commit(w.repo, 'c.txt', 'c, rewritten by the next task\n');
    await g(w.repo, 'checkout', '-q', 'main');
    await g(w.repo, 'merge', '-q', '--squash', 'dev');
    await g(w.repo, 'commit', '-q', '-m', 'Release (#1)');
    await g(w.repo, 'push', '-q', 'origin', 'main', 'dev');
    return w;
  }

  it('squashed through origin/dev with other work on the same file: ok, by content', async () => {
    const w = await squashedThroughDev();
    expect(await checkCleanup(w.ctx, 'alpha', 'AS-0001')).toMatchObject({ ok: true, landedBy: 'content' });
  });

  it('squashed through dev, then reverted on main and synced back into dev: refused', async () => {
    const w = await squashedThroughDev();
    const sync = async () => {
      await g(w.repo, 'checkout', '-q', 'dev');
      await g(w.repo, 'merge', '-q', '--no-edit', 'main');
      await g(w.repo, 'checkout', '-q', 'main');
    };
    // dev takes main back after the release, as usual; only then does a later revert reach dev too.
    await sync();
    await g(w.repo, 'revert', '--no-edit', 'HEAD');
    await sync();
    await g(w.repo, 'push', '-q', 'origin', 'main', 'dev');
    expect(await g(w.repo, 'rev-parse', 'origin/main^{tree}')).toBe(
      await g(w.repo, 'rev-parse', 'origin/dev^{tree}'),
    );
    expect((await checkCleanup(w.ctx, 'alpha', 'AS-0001')).ok).toBe(false);
  });

  it('unmerged: refused, says why, lists the commits, removes nothing', async () => {
    const w = await world();
    const r = await cleanupTask(w.ctx, 'alpha', 'AS-0001', { actor: 'cli' });
    expect(r).toMatchObject({ ok: false, removed: false });
    expect(r.reason).toMatch(/2 commits on sc\/as-0001-t are not on origin\/main/);
    expect(r.hint).toMatch(/Merge the work/);
    expect(r.detail).toHaveLength(2);
    expect(w.deleteSession).not.toHaveBeenCalled();
    expect(await w.ledger.getTask('alpha', 'AS-0001')).not.toBeNull();
    expect(existsSync(w.wt)).toBe(true);
  });

  it('dirty worktree: refused even when merged (modified, then untracked)', async () => {
    const w = await world();
    await g(w.repo, 'merge', '-q', '--no-ff', '--no-edit', w.branch);
    await g(w.repo, 'push', '-q', 'origin', 'main');
    await writeFile(join(w.wt, 'b.txt'), 'edited\n');
    let c = await checkCleanup(w.ctx, 'alpha', 'AS-0001');
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/uncommitted changes \(1 file\)/);
    expect(c.detail).toEqual(['b.txt']);
    await g(w.wt, 'checkout', '--', 'b.txt');
    await writeFile(join(w.wt, 'scratch.txt'), 'x\n');
    c = await checkCleanup(w.ctx, 'alpha', 'AS-0001');
    expect(c.ok).toBe(false);
    expect(c.detail).toEqual(['scratch.txt']);
    const r = await cleanupTask(w.ctx, 'alpha', 'AS-0001', { actor: 'cli' });
    expect(r.removed).toBe(false);
    expect(w.deleteSession).not.toHaveBeenCalled();
  });

  it('not done, locked, or another project: refused', async () => {
    const w = await world({ stage: 'ready_for_review' });
    expect((await checkCleanup(w.ctx, 'alpha', 'AS-0001')).reason).toMatch(/not done or archived/);
    await w.ledger.updateTask('alpha', 'AS-0001', (t) => ({ ...t, stage: 'done' }));
    await w.ledger.setLocked(['sess-1'], true);
    expect((await checkCleanup(w.ctx, 'alpha', 'AS-0001')).reason).toMatch(/locked/);
    await expect(checkCleanup(w.ctx, 'beta', 'AS-0001')).rejects.toThrow(/No task AS-0001 in project beta/);
  });

  it('an origin that cannot be fetched: refused, nothing removed', async () => {
    const w = await world();
    await rm(w.origin, { recursive: true, force: true });
    const c = await checkCleanup(w.ctx, 'alpha', 'AS-0001');
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/Could not fetch/);
  });
});

describe('cleanupTask', () => {
  it('removes the AoE session with worktree and branch, the task, and audits it', async () => {
    const w = await world();
    await g(w.repo, 'merge', '-q', '--no-ff', '--no-edit', w.branch);
    await g(w.repo, 'push', '-q', 'origin', 'main');
    const dry = await cleanupTask(w.ctx, 'alpha', 'AS-0001', { actor: 'cli', dryRun: true });
    expect(dry).toMatchObject({ ok: true, removed: false });
    expect(w.deleteSession).not.toHaveBeenCalled();

    const r = await cleanupTask(w.ctx, 'alpha', 'AS-0001', { actor: 'ui' });
    expect(r).toMatchObject({ ok: true, removed: true, landedBy: 'ancestor' });
    expect(w.deleteSession).toHaveBeenCalledWith('sess-1', DELETE);
    expect(await w.ledger.getTask('alpha', 'AS-0001')).toBeNull();
    // AoE's own `branch -d` refuses a branch it can't see merged; cleanup deletes it after its check.
    expect(r.branchDeleted).toBe(true);
    expect(await g(w.repo, 'branch', '--list', w.branch)).toBe('');
    const audit = (await readFile(w.paths.auditFile, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(audit.at(-1)).toMatchObject({
      actor: 'ui',
      action: 'task_cleaned_up',
      project: 'alpha',
      taskId: 'AS-0001',
      sessionId: 'sess-1',
      details: { branch: w.branch, head: w.head, landedBy: 'ancestor', branchDeleted: true },
    });
  });

  it('AoE keeping the session is an error and leaves the task alone', async () => {
    const w = await world();
    await g(w.repo, 'merge', '-q', '--no-ff', '--no-edit', w.branch);
    await g(w.repo, 'push', '-q', 'origin', 'main');
    w.deleteSession.mockResolvedValueOnce({ status: 'kept' });
    await expect(cleanupTask(w.ctx, 'alpha', 'AS-0001', { actor: 'cli' })).rejects.toThrow(/did not remove/);
    expect(await w.ledger.getTask('alpha', 'AS-0001')).toMatchObject({ cleanup: null });
  });

  it('--all-done cleans the merged ones and skips the rest, with reasons', async () => {
    const w = await world();
    await g(w.repo, 'merge', '-q', '--no-ff', '--no-edit', w.branch);
    await g(w.repo, 'push', '-q', 'origin', 'main');
    // A second done task whose branch holds work that is not on main, and an unfinished one.
    await g(w.repo, 'worktree', 'add', '-q', '-b', 'sc/as-0002-u', join(w.root, 'wt2'));
    await w.commit(join(w.root, 'wt2'), 'u.txt');
    await w.ledger.createTask(
      taskRecord('AS-0002', 'alpha', 'sess-2', {
        stage: 'done',
        branch: 'sc/as-0002-u',
        worktreePath: join(w.root, 'wt2'),
      }),
    );
    await w.ledger.createTask(taskRecord('AS-0003', 'alpha', 'sess-3', { stage: 'implementing' }));
    const rs = await cleanupAllDone(w.ctx, 'alpha', { actor: 'cli' });
    expect(rs.map((r) => [r.taskId, r.removed])).toEqual([
      ['AS-0001', true],
      ['AS-0002', false],
    ]);
    expect(w.deleteSession).toHaveBeenCalledTimes(1);
    expect(await w.ledger.getTask('alpha', 'AS-0003')).not.toBeNull();
  });
});

describe('cleanup: a branch that is gone, an archived task, a slow delete', () => {
  const merge = async (w: Awaited<ReturnType<typeof world>>) => {
    await g(w.repo, 'merge', '-q', '--no-ff', '--no-edit', w.branch);
    await g(w.repo, 'push', '-q', 'origin', 'main');
  };
  /** The worktree and the local branch both gone, as after a cleanup by hand. */
  const dropBranch = async (w: Awaited<ReturnType<typeof world>>) => {
    await g(w.repo, 'worktree', 'remove', '--force', w.wt);
    await g(w.repo, 'branch', '-D', w.branch);
  };

  it('branch gone: the worktree HEAD still counts, so commits only there are never lost', async () => {
    const w = await world();
    await g(w.wt, 'checkout', '-q', '--detach');
    await g(w.repo, 'branch', '-D', w.branch);
    const c = await checkCleanup(w.ctx, 'alpha', 'AS-0001');
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/2 commits .* are not on origin\/main/);
  });

  it("branch gone: the merged pull request's head, then origin/<branch>, say what it was", async () => {
    const w = await world({ mr: mr({ headSha: undefined }) });
    await g(w.repo, 'merge', '-q', '--squash', w.branch);
    await g(w.repo, 'commit', '-q', '-m', 'Squashed (#12)');
    await g(w.repo, 'push', '-q', 'origin', 'main');
    await dropBranch(w);
    expect((await checkCleanup(w.ctx, 'alpha', 'AS-0001')).reason).toMatch(
      /is gone and its last commit is not known/,
    );
    await w.ledger.updateTask('alpha', 'AS-0001', (t) => ({ ...t, mr: mr({ headSha: w.head }) }));
    expect(await checkCleanup(w.ctx, 'alpha', 'AS-0001')).toMatchObject({
      ok: true,
      landedBy: 'merged_pr',
      head: w.head,
    });

    const v = await world();
    await g(v.wt, 'push', '-q', 'origin', v.branch);
    await merge(v);
    await dropBranch(v);
    expect(await checkCleanup(v.ctx, 'alpha', 'AS-0001')).toMatchObject({
      ok: true,
      landedBy: 'ancestor',
      head: v.head,
    });
    // Pushed but never merged: refused, with what is missing.
    const u = await world();
    await g(u.wt, 'push', '-q', 'origin', u.branch);
    await dropBranch(u);
    expect((await checkCleanup(u.ctx, 'alpha', 'AS-0001')).reason).toMatch(
      /2 commits .* are not on origin\/main/,
    );
  }, 60_000);

  it('an archived task that never reached done: the same checks, and an active one is still refused', async () => {
    const w = await world({ stage: 'implementing' });
    await merge(w);
    expect((await checkCleanup(w.ctx, 'alpha', 'AS-0001')).reason).toMatch(/not done or archived/);
    w.sessions[0]!.archived_at = '2026-11-10T10:00:00Z';
    expect(await checkCleanup(w.ctx, 'alpha', 'AS-0001')).toMatchObject({ ok: true, landedBy: 'ancestor' });
    expect(
      (await cleanupAllDone(w.ctx, 'alpha', { actor: 'cli' })).map((r) => [r.taskId, r.removed]),
    ).toEqual([['AS-0001', true]]);
    // Archived with work that never landed: refused all the same.
    const u = await world({ stage: 'planning' });
    u.sessions[0]!.archived_at = '2026-11-10T10:00:00Z';
    expect(await checkCleanup(u.ctx, 'alpha', 'AS-0001')).toMatchObject({ ok: false });
  });

  it('a delete that runs out of time is still under way: marked, and the next run finishes it', async () => {
    const w = await world();
    await merge(w);
    w.deleteSession.mockRejectedValueOnce(new AoeError('slow', 'unreachable', undefined, undefined, true));
    const r = await cleanupTask(w.ctx, 'alpha', 'AS-0001', { actor: 'cli' });
    expect(r).toMatchObject({ ok: true, removed: false, pending: true });
    expect(r.reason).toMatch(/still deleting/);
    expect((await w.ledger.getTask('alpha', 'AS-0001'))!.cleanup).toMatchObject({
      head: w.head,
      landedBy: 'ancestor',
    });

    // AoE got part of the way: tracked files deleted. That is not uncommitted work now.
    await rm(join(w.wt, 'b.txt'));
    expect(await checkCleanup(w.ctx, 'alpha', 'AS-0001')).toMatchObject({ ok: true, resumed: true });
    // A change or a new file is, all the same.
    await writeFile(join(w.wt, 'c.txt'), 'edited\n');
    expect((await checkCleanup(w.ctx, 'alpha', 'AS-0001')).reason).toMatch(/uncommitted changes/);
    await g(w.wt, 'checkout', '--', 'c.txt');
    // ...and git no longer reading the folder (AoE took its .git link): also AoE's doing.
    await rm(join(w.wt, '.git'));
    expect(await checkCleanup(w.ctx, 'alpha', 'AS-0001')).toMatchObject({ ok: true, resumed: true });
    await g(w.repo, 'worktree', 'prune');
    const done = await cleanupTask(w.ctx, 'alpha', 'AS-0001', { actor: 'cli' });
    expect(done).toMatchObject({ removed: true, branchDeleted: true });
    expect(w.deleteSession).toHaveBeenLastCalledWith('sess-1', { ...DELETE, force: true });
    expect(done.kept).toEqual([]);
  });

  it('without that mark, deleted files and an unreadable worktree are refused', async () => {
    const w = await world();
    await merge(w);
    await rm(join(w.wt, 'b.txt'));
    expect((await checkCleanup(w.ctx, 'alpha', 'AS-0001')).reason).toMatch(/uncommitted changes/);
    await g(w.wt, 'checkout', '--', 'b.txt');
    await rm(join(w.wt, '.git'));
    expect((await checkCleanup(w.ctx, 'alpha', 'AS-0001')).reason).toMatch(/Could not read the worktree/);
  });

  it('a session AoE finished deleting since: only Supercharge’s part is left', async () => {
    const w = await world();
    await merge(w);
    w.deleteSession.mockRejectedValueOnce(new AoeError('slow', 'unreachable', undefined, undefined, true));
    await cleanupTask(w.ctx, 'alpha', 'AS-0001', { actor: 'cli' });
    w.sessions.splice(0);
    await g(w.repo, 'worktree', 'remove', '--force', w.wt);
    const r = await cleanupTask(w.ctx, 'alpha', 'AS-0001', { actor: 'cli' });
    expect(r).toMatchObject({ removed: true, branchDeleted: true });
    expect(w.deleteSession).toHaveBeenCalledTimes(1);
    expect(await w.ledger.getTask('alpha', 'AS-0001')).toBeNull();
  });

  it('keeps a branch that moved past the commit it checked', async () => {
    const w = await world();
    await merge(w);
    w.deleteSession.mockImplementationOnce(async () => {
      w.sessions.splice(0);
      await g(w.repo, 'worktree', 'remove', '--force', w.wt);
      await g(w.repo, 'branch', '-f', w.branch, 'origin/main');
      return { status: 'deleted' };
    });
    const r = await cleanupTask(w.ctx, 'alpha', 'AS-0001', { actor: 'cli' });
    expect(r).toMatchObject({ removed: true, branchDeleted: false });
    expect(r.kept).toEqual([expect.stringMatching(/moved past the commit/)]);
    expect(await g(w.repo, 'branch', '--list', w.branch)).toContain(w.branch.split('/').at(-1));
  });

  it('--discard drops commits that never landed, lists them, and audits every one', async () => {
    const w = await world();
    const dry = await cleanupTask(w.ctx, 'alpha', 'AS-0001', { actor: 'cli', discard: true, dryRun: true });
    expect(dry).toMatchObject({ ok: true, removed: false, landedBy: 'discarded' });
    expect(dry.discarded).toEqual([expect.stringContaining('c.txt'), expect.stringContaining('b.txt')]);
    // Never past a dirty worktree.
    await writeFile(join(w.wt, 'notes.md'), 'x\n');
    expect((await cleanupTask(w.ctx, 'alpha', 'AS-0001', { actor: 'cli', discard: true })).ok).toBe(false);
    await rm(join(w.wt, 'notes.md'));
    const r = await cleanupTask(w.ctx, 'alpha', 'AS-0001', { actor: 'cli', discard: true });
    expect(r).toMatchObject({ removed: true, branchDeleted: true });
    const audit = (await readFile(w.paths.auditFile, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(audit.at(-1)).toMatchObject({
      action: 'task_cleaned_up',
      details: { landedBy: 'discarded', discarded: dry.discarded },
    });
  });
});

describe('rollbackStart: undoes only what a failed task new made', () => {
  /** A start of AS-0002 that got as far as its prompt file and `git worktree add -b`. */
  async function failedStart(withCommit = false) {
    const w = await world();
    const branch = 'sc/as-0002-new';
    const wt2 = join(w.root, 'wt2');
    await g(w.repo, 'worktree', 'add', '-q', '-b', branch, wt2, 'main');
    if (withCommit) await w.commit(wt2, 'd.txt');
    await mkdir(w.ledger.taskDir('alpha', 'AS-0002'), { recursive: true });
    await writeFile(w.ledger.sessionPromptFile('alpha', 'AS-0002'), 'prompt');
    const made = { project: 'alpha', id: 'AS-0002', repo: w.repo, branch, baseBranch: 'main' };
    return { ...w, wt2, made };
  }
  const branches = (repo: string) => g(repo, 'branch', '--list');

  it('removes the session, the new branch and its worktree, and the task dir; nothing else', async () => {
    const w = await failedStart();
    const r = await rollbackStart(w.ctx, { ...w.made, branchExisted: false, sessionId: 'sess-2' });
    expect(r.kept).toEqual([]);
    expect(w.deleteSession).toHaveBeenCalledExactlyOnceWith('sess-2', {
      deleteWorktree: true,
      deleteBranch: false,
    });
    expect(existsSync(w.wt2)).toBe(false);
    expect(await branches(w.repo)).not.toMatch(/as-0002/);
    expect(existsSync(w.ledger.taskDir('alpha', 'AS-0002'))).toBe(false);
    // AS-0001's worktree, branch and task are untouched.
    expect(existsSync(w.wt)).toBe(true);
    expect(await branches(w.repo)).toContain(w.branch);
    expect(await w.ledger.getTask('alpha', 'AS-0001')).not.toBeNull();
  });

  it('keeps a new branch (and its worktree) that already has a commit', async () => {
    const w = await failedStart(true);
    const r = await rollbackStart(w.ctx, { ...w.made, branchExisted: false, sessionId: null });
    expect(r.kept).toEqual([
      expect.stringMatching(/^branch sc\/as-0002-new and its worktree \(it has commits/),
    ]);
    expect(existsSync(w.wt2)).toBe(true);
    expect(await branches(w.repo)).toMatch(/as-0002/);
    expect(w.deleteSession).not.toHaveBeenCalled();
  });

  it('never touches a branch that was there before the start, even with no commits', async () => {
    const w = await failedStart();
    const r = await rollbackStart(w.ctx, { ...w.made, branchExisted: true, sessionId: null });
    expect(r.removed).toEqual(['task dir AS-0002']);
    expect(existsSync(w.wt2)).toBe(true);
    expect(await branches(w.repo)).toMatch(/as-0002/);
    expect(w.deleteSession).not.toHaveBeenCalled();
  });

  it('leaves a task dir that holds a task.json', async () => {
    const w = await failedStart();
    await rollbackStart(w.ctx, { ...w.made, id: 'AS-0001', branchExisted: true, sessionId: null });
    expect(await w.ledger.getTask('alpha', 'AS-0001')).not.toBeNull();
  });
});
