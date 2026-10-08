import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ledger, resolvePaths } from '@aoe-supercharge/core/node';
import type { MrState, TaskRecord } from '@aoe-supercharge/core/shared';
import { project as projectRecord, task as taskRecord } from '../../core/test/office-fixtures.ts';
import { checkCleanup, cleanupAllDone, cleanupTask } from '../src/cleanup.ts';
import type { Ctx } from '../src/context.ts';
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
  const deleteSession = vi.fn(async () => ({ status: 'deleted' }));
  const ctx = { ledger, paths, aoe: { deleteSession } } as unknown as Ctx;
  return { ...w, ctx, ledger, paths, deleteSession };
}

describe('checkCleanup: only when the work is on origin/main', () => {
  it('merged (fast-forward): ok, as an ancestor', async () => {
    const w = await world();
    await g(w.repo, 'merge', '-q', '--ff-only', w.branch);
    await g(w.repo, 'push', '-q', 'origin', 'main');
    const c = await checkCleanup(w.ctx, 'alpha', 'AS-0001');
    expect(c).toMatchObject({ ok: true, landedBy: 'ancestor', head: w.head });
  });

  it('merged only locally, not pushed: refused (origin is what counts)', async () => {
    const w = await world();
    await g(w.repo, 'merge', '-q', '--ff-only', w.branch);
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

  it('a merged MR with no recorded head (an older record) does not count as landed', async () => {
    const w = await world({ mr: mr({}) });
    await g(w.repo, 'merge', '-q', '--squash', w.branch);
    await g(w.repo, 'commit', '-q', '-m', 'Squashed (#12)');
    await g(w.repo, 'push', '-q', 'origin', 'main');
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
    await g(w.repo, 'merge', '-q', '--ff-only', w.branch);
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
    expect((await checkCleanup(w.ctx, 'alpha', 'AS-0001')).reason).toMatch(/not done/);
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
    await g(w.repo, 'merge', '-q', '--ff-only', w.branch);
    await g(w.repo, 'push', '-q', 'origin', 'main');
    const dry = await cleanupTask(w.ctx, 'alpha', 'AS-0001', { actor: 'cli', dryRun: true });
    expect(dry).toMatchObject({ ok: true, removed: false });
    expect(w.deleteSession).not.toHaveBeenCalled();

    const r = await cleanupTask(w.ctx, 'alpha', 'AS-0001', { actor: 'ui' });
    expect(r).toMatchObject({ ok: true, removed: true, landedBy: 'ancestor' });
    expect(w.deleteSession).toHaveBeenCalledWith('sess-1', { deleteWorktree: true, deleteBranch: true });
    expect(await w.ledger.getTask('alpha', 'AS-0001')).toBeNull();
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
      details: { branch: w.branch, head: w.head, landedBy: 'ancestor' },
    });
  });

  it('AoE keeping the session is an error and leaves the task alone', async () => {
    const w = await world();
    await g(w.repo, 'merge', '-q', '--ff-only', w.branch);
    await g(w.repo, 'push', '-q', 'origin', 'main');
    w.deleteSession.mockResolvedValueOnce({ status: 'kept' });
    await expect(cleanupTask(w.ctx, 'alpha', 'AS-0001', { actor: 'cli' })).rejects.toThrow(/did not remove/);
    expect(await w.ledger.getTask('alpha', 'AS-0001')).not.toBeNull();
  });

  it('--all-done cleans the merged ones and skips the rest, with reasons', async () => {
    const w = await world();
    await g(w.repo, 'merge', '-q', '--ff-only', w.branch);
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
