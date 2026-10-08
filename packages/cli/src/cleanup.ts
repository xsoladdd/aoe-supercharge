import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { appendAudit } from '@aoe-supercharge/core/node';
import type { TaskRecord } from '@aoe-supercharge/core/shared';
import type { Ctx } from './context.ts';
import {
  dirtyPaths,
  fetchBranch,
  isAncestor,
  isCherried,
  revParse,
  unlandedCommits,
} from './util/git.ts';
import { CliError, EXIT } from './util/errors.ts';

/** How a finished task's work reached origin/<base>. */
export type LandedBy = 'ancestor' | 'cherry' | 'merged_pr';

export interface CleanupCheck {
  taskId: string;
  project: string;
  branch: string;
  ok: boolean;
  landedBy?: LandedBy;
  /** The commit the branch ended on. */
  head?: string;
  /** Why it was refused, and what to do about it. */
  reason?: string;
  hint?: string;
  /** Up to 5 paths with uncommitted changes, or commits not on the base branch. */
  detail?: string[];
}

const SHOWN = 5;

function refuse(
  t: TaskRecord,
  reason: string,
  hint: string,
  detail?: string[],
): CleanupCheck {
  return { taskId: t.id, project: t.project, branch: t.branch, ok: false, reason, hint, detail };
}

/**
 * Can this finished task's worker be cleaned up without losing work? Only when its work is on
 * origin/<base> (fetched first): the branch is an ancestor of it, every commit has an equivalent
 * patch there (cherry-picked or rebased), or the MR watcher recorded its pull request as merged and
 * the worktree holds nothing past that pull request's head (squash merges).
 *
 * Read-only apart from the fetch. The task is looked up in this project's ledger, so a session of
 * another project can never be reached through it.
 */
export async function checkCleanup(ctx: Ctx, project: string, taskId: string): Promise<CleanupCheck> {
  const task = await ctx.ledger.getTask(project, taskId);
  if (!task)
    throw new CliError(`No task ${taskId} in project ${project}.`, EXIT.usage, 'Check "supercharge task list".');
  const rec = await ctx.ledger.getProject(project);
  if (!rec) throw new CliError(`No project ${project}.`, EXIT.usage);

  if (task.stage !== 'done')
    return refuse(task, `${task.id} is ${task.stage}, not done.`, 'Clean up only after its work has been merged.');
  if (!task.aoeSessionId)
    return refuse(task, `${task.id} has no AoE session.`, 'There is nothing to clean up.');
  if ((await ctx.ledger.readLocks()).includes(task.aoeSessionId))
    return refuse(task, `Session ${task.aoeSessionId} is locked.`, 'Unlock it first.');

  const cwd = task.worktreePath && existsSync(task.worktreePath) ? task.worktreePath : rec.repoPath;
  const base = task.baseBranch;

  // The worktree first: a dirty one is the cheapest, and the most common, reason to stop.
  if (cwd === task.worktreePath) {
    const dirty = await dirtyPaths(cwd);
    if (dirty === null)
      return refuse(task, 'Could not read the worktree with git.', `Check ${cwd} by hand.`);
    if (dirty.length > 0)
      return refuse(
        task,
        `The worktree has uncommitted changes (${dirty.length} file${dirty.length === 1 ? '' : 's'}).`,
        'Commit and push them, or discard them, then clean up again.',
        dirty.slice(0, SHOWN),
      );
  }

  if (!(await fetchBranch(cwd, base)))
    return refuse(
      task,
      `Could not fetch origin/${base}.`,
      'Check the network and the remote, then try again. Nothing was removed.',
    );
  const onBase = `origin/${base}`;
  if (!(await revParse(cwd, onBase)))
    return refuse(task, `There is no ${onBase} to compare with.`, 'Is the base branch pushed to origin?');

  const head = (await revParse(cwd, `refs/heads/${task.branch}`)) ?? task.readyHead ?? null;
  if (!head)
    return refuse(task, `Branch ${task.branch} is gone and its last commit is not known.`, 'Check by hand.');

  if (await isAncestor(cwd, head, onBase)) return { ...ok(task), head, landedBy: 'ancestor' };
  if (await isCherried(cwd, onBase, head)) return { ...ok(task), head, landedBy: 'cherry' };

  // Squash merge: the pull request is merged, and nothing in the worktree is past its head.
  const prHead = task.mr?.state === 'merged' ? task.mr.headSha : null;
  if (prHead && (await revParse(cwd, prHead)) && (await isAncestor(cwd, head, prHead)))
    return { ...ok(task), head, landedBy: 'merged_pr' };

  const open = await unlandedCommits(cwd, onBase, head);
  const merged = task.mr?.state === 'merged';
  return refuse(
    task,
    `${open.length} commit${open.length === 1 ? '' : 's'} on ${task.branch} ${open.length === 1 ? 'is' : 'are'} not on ${onBase}` +
      (merged ? ', and the merged pull request does not cover them' : ', and no merged pull request covers them') +
      '.',
    merged
      ? 'Push them in a new pull request, or leave this worker as it is.'
      : 'Merge the work (or open a pull request) first. Nothing was removed.',
    open.slice(0, SHOWN),
  );
}

function ok(t: TaskRecord): CleanupCheck {
  return { taskId: t.id, project: t.project, branch: t.branch, ok: true };
}

export interface CleanupResult extends CleanupCheck {
  /** Set when the session, worktree and branch were removed. */
  removed: boolean;
}

/**
 * Remove a finished worker: its AoE session, worktree and branch (what
 * `aoe rm --purge --delete-worktree --delete-branch` does, without `--force`, so AoE also stops at
 * a dirty worktree). Checks again first; refuses with the same reasons as `checkCleanup`.
 */
export async function cleanupTask(
  ctx: Ctx,
  project: string,
  taskId: string,
  opts: { actor: 'cli' | 'ui'; dryRun?: boolean },
): Promise<CleanupResult> {
  const check = await checkCleanup(ctx, project, taskId);
  if (!check.ok || opts.dryRun) return { ...check, removed: false };
  const task = (await ctx.ledger.getTask(project, taskId))!;
  const id = task.aoeSessionId!;

  const res = await ctx.aoe.deleteSession(id, { deleteWorktree: true, deleteBranch: true });
  if (res.status !== 'deleted')
    throw new CliError(
      `AoE did not remove session ${id} (it said "${res.status}").`,
      EXIT.error,
      'Look at it in AoE; nothing in Supercharge was changed.',
    );
  await ctx.ledger.removeTask(project, taskId);
  await rm(join(ctx.paths.uploadsDir, id), { recursive: true, force: true });
  await appendAudit(ctx.paths, {
    actor: opts.actor,
    action: 'task_cleaned_up',
    project,
    taskId,
    sessionId: id,
    details: { branch: task.branch, head: check.head, landedBy: check.landedBy, worktree: task.worktreePath },
  });
  return { ...check, removed: true };
}

/** Every done task of a project, each checked on its own: one refusal never stops the others. */
export async function cleanupAllDone(
  ctx: Ctx,
  project: string,
  opts: { actor: 'cli' | 'ui'; dryRun?: boolean },
): Promise<CleanupResult[]> {
  const done = (await ctx.ledger.listTasks(project)).filter((t) => t.stage === 'done');
  const out: CleanupResult[] = [];
  for (const t of done) {
    try {
      out.push(await cleanupTask(ctx, project, t.id, opts));
    } catch (err) {
      out.push({ ...refuse(t, (err as Error).message, 'See the message above.'), removed: false });
    }
  }
  return out;
}
