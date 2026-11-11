import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { appendAudit } from '@aoe-supercharge/core/node';
import type { TaskRecord } from '@aoe-supercharge/core/shared';
import { AoeError } from './aoe/client.ts';
import type { Ctx } from './context.ts';
import {
  dirtyEntries,
  fetchBranch,
  isAncestor,
  isCherried,
  isContentMerged,
  onlyDeletions,
  revParse,
  unlandedCommits,
} from './util/git.ts';
import { CliError, EXIT } from './util/errors.ts';
import { run } from './util/exec.ts';
import { unarchiving } from './workflow.ts';

/** How a finished task's work reached origin/<base>; `discarded` when `--discard` drops it instead. */
export type LandedBy = 'ancestor' | 'cherry' | 'merged_pr' | 'content' | 'discarded';

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
  /** With `--discard`: every commit not on the base branch, which cleaning up drops. */
  discarded?: string[];
  /** A clean-up AoE already began: the worktree's deleted files are its doing, not work. */
  resumed?: boolean;
}

const SHOWN = 5;

function refuse(t: TaskRecord, reason: string, hint: string, detail?: string[]): CleanupCheck {
  return { taskId: t.id, project: t.project, branch: t.branch, ok: false, reason, hint, detail };
}

/** Whether AoE has the session archived; null when AoE can't be asked. */
async function archivedInAoe(ctx: Ctx, sessionId: string): Promise<boolean | null> {
  const all = await ctx.aoe.listSessions('all').catch(() => null);
  if (!all) return null;
  const s = all.find((x) => x.id === sessionId);
  return !!s?.archived_at && !s.trashed_at;
}

/**
 * The commit the task's work ended on, even when its branch is gone: the local branch, the worktree's
 * HEAD (so commits only there are never missed), the head reported ready to merge, the merged pull
 * request's head (fetched by its pull or merge-request ref when it isn't here), then origin/<branch>.
 */
async function workHead(cwd: string, task: TaskRecord, worktree: string | null): Promise<string | null> {
  const local = await revParse(cwd, `refs/heads/${task.branch}`);
  if (local) return local;
  const atWorktree = worktree ? await revParse(worktree, 'HEAD') : null;
  if (atWorktree) return atWorktree;
  if (task.readyHead) return task.readyHead;
  const mr = task.mr?.state === 'merged' ? task.mr : null;
  if (mr?.headSha) {
    if (await revParse(cwd, mr.headSha)) return mr.headSha;
    const ref = mr.provider === 'github' ? `refs/pull/${mr.iid}/head` : `refs/merge-requests/${mr.iid}/head`;
    if ((await fetchBranch(cwd, ref)) && (await revParse(cwd, mr.headSha))) return mr.headSha;
  }
  await fetchBranch(cwd, task.branch);
  return revParse(cwd, `refs/remotes/origin/${task.branch}`);
}

/**
 * Can this finished task's worker be cleaned up without losing work? Only when its work is on
 * origin/<base> (fetched first): the branch is an ancestor of it, every commit has an equivalent
 * patch there (cherry-picked or rebased), the MR watcher recorded its pull request as merged and the
 * worktree holds nothing past that pull request's head, or merging the branch (or a pushed branch that
 * contains it, such as origin/dev) would change nothing there (squash merges). With `discard`, commits
 * that aren't there are listed and dropped instead of refused.
 *
 * Finished means done, or archived in AoE without reaching done (stopped early): the same checks apply,
 * so an archived task with work that didn't land is still refused.
 *
 * Read-only apart from the fetches. The task is looked up in this project's ledger, so a session of
 * another project can never be reached through it.
 */
export async function checkCleanup(
  ctx: Ctx,
  project: string,
  taskId: string,
  opts: { discard?: boolean } = {},
): Promise<CleanupCheck> {
  const task = await ctx.ledger.getTask(project, taskId);
  if (!task)
    throw new CliError(
      `No task ${taskId} in project ${project}.`,
      EXIT.usage,
      'Check "supercharge task list".',
    );
  const rec = await ctx.ledger.getProject(project);
  if (!rec) throw new CliError(`No project ${project}.`, EXIT.usage);

  // A clean-up already under way passed this before; its session may be gone from AoE by now.
  if (task.stage !== 'done' && !task.cleanup) {
    const archived = task.aoeSessionId ? await archivedInAoe(ctx, task.aoeSessionId) : false;
    if (archived === null)
      return refuse(
        task,
        `${task.id} is ${task.stage}, and AoE could not say whether its session is archived.`,
        'Check that AoE is running, then try again.',
      );
    if (!archived)
      return refuse(
        task,
        `${task.id} is ${task.stage}, not done or archived.`,
        'Clean up only after its work has been merged, or archive a worker that stopped early first.',
      );
  }
  if (!task.aoeSessionId)
    return refuse(task, `${task.id} has no AoE session.`, 'There is nothing to clean up.');
  if ((await ctx.ledger.readLocks()).includes(task.aoeSessionId))
    return refuse(task, `Session ${task.aoeSessionId} is locked.`, 'Unlock it first.');

  const worktree = task.worktreePath && existsSync(task.worktreePath) ? task.worktreePath : null;
  let cwd = worktree ?? rec.repoPath;
  const base = task.baseBranch;
  // An earlier clean-up got as far as AoE, which may have deleted part of the worktree before it ran
  // out of time: its deletions (or a folder git no longer reads) are that, not work.
  let resumed = false;

  // The worktree first: a dirty one is the cheapest, and the most common, reason to stop.
  if (worktree) {
    const dirty = await dirtyEntries(worktree);
    if (dirty === null) {
      if (!task.cleanup)
        return refuse(task, 'Could not read the worktree with git.', `Check ${worktree} by hand.`);
      resumed = true;
      cwd = rec.repoPath;
    } else if (dirty.length > 0) {
      if (!task.cleanup || !onlyDeletions(dirty))
        return refuse(
          task,
          `The worktree has uncommitted changes (${dirty.length} file${dirty.length === 1 ? '' : 's'}).`,
          'Commit and push them, or discard them, then clean up again.',
          dirty.slice(0, SHOWN).map((e) => e.path),
        );
      resumed = true;
    }
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

  const head =
    (await workHead(cwd, task, worktree && cwd === worktree ? worktree : null)) ?? task.cleanup?.head;
  if (!head)
    return refuse(task, `Branch ${task.branch} is gone and its last commit is not known.`, 'Check by hand.');
  const landed = (landedBy: LandedBy): CleanupCheck => ({ ...ok(task), head, landedBy, resumed });

  if (await isAncestor(cwd, head, onBase)) return landed('ancestor');
  if (await isCherried(cwd, onBase, head)) return landed('cherry');

  // Squash merge: the pull request is merged, and nothing in the worktree is past its head.
  const prHead = task.mr?.state === 'merged' ? task.mr.headSha : null;
  if (prHead && (await revParse(cwd, prHead)) && (await isAncestor(cwd, head, prHead)))
    return landed('merged_pr');
  if (await isContentMerged(cwd, onBase, head)) return landed('content');

  const open = await unlandedCommits(cwd, onBase, head);
  if (opts.discard) return { ...landed('discarded'), discarded: open, detail: open.slice(0, SHOWN) };
  const merged = task.mr?.state === 'merged';
  return refuse(
    task,
    `${open.length} commit${open.length === 1 ? '' : 's'} on ${task.branch} ${open.length === 1 ? 'is' : 'are'} not on ${onBase}` +
      (merged
        ? ', and the merged pull request does not cover them'
        : ', and no merged pull request covers them') +
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
  /** AoE is still deleting the session: Supercharge finishes the clean-up once it is gone. */
  pending?: boolean;
  /** The branch, deleted by Supercharge itself once AoE was done (AoE's `branch -d` refuses squash merges). */
  branchDeleted?: boolean;
  /** What was left behind, and why. */
  kept?: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits (up to `ms`) until AoE no longer lists the session at all. */
async function goneFromAoe(ctx: Ctx, sessionId: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    const all = await ctx.aoe.listSessions('all').catch(() => null);
    if (all && !all.some((s) => s.id === sessionId)) return true;
    if (Date.now() >= until) return false;
    await sleep(1_000);
  }
}

/**
 * Remove a finished worker: its AoE session, worktree and branch (what
 * `aoe rm --purge --delete-worktree --delete-branch` does, without `--force`, so AoE also stops at
 * a dirty worktree). Checks again first; refuses with the same reasons as `checkCleanup`.
 *
 * The task is marked first (`cleanup`), so a delete that runs out of `aoe.deleteTimeoutSeconds` is
 * reported as still under way, not as a failure: AoE keeps deleting, and the daemon (or the next run)
 * finishes Supercharge's part once the session is gone.
 */
export async function cleanupTask(
  ctx: Ctx,
  project: string,
  taskId: string,
  opts: { actor: 'cli' | 'ui'; dryRun?: boolean; discard?: boolean },
): Promise<CleanupResult> {
  const check = await checkCleanup(ctx, project, taskId, { discard: opts.discard });
  if (!check.ok || opts.dryRun) return { ...check, removed: false };
  const id = (await ctx.ledger.getTask(project, taskId))!.aoeSessionId;
  const task = await ctx.ledger.updateTask(project, taskId, (t) => ({
    ...t,
    cleanup: {
      startedAt: t.cleanup?.startedAt ?? new Date().toISOString(),
      head: check.head!,
      landedBy: check.landedBy!,
      ...(check.discarded ? { discarded: check.discarded } : {}),
    },
  }));
  const secs = ctx.config.aoe.deleteTimeoutSeconds;
  const stillDeleting = (): CleanupResult => ({
    ...check,
    removed: false,
    pending: true,
    reason: `AoE is still deleting session ${id} (a large worktree can take minutes).`,
    hint: 'Nothing is lost: the checks passed. Supercharge finishes the clean-up once AoE is done; "task cleanup" again does it too.',
  });

  // Already gone (a delete that ran out of time and finished since): only Supercharge's part is left.
  if ((await ctx.aoe.listSessions('all')).some((s) => s.id === id)) {
    let res;
    try {
      res = await unarchiving(ctx, id, () =>
        ctx.aoe.deleteSession(id, {
          deleteWorktree: true,
          deleteBranch: true,
          // Only what AoE's own earlier delete left: deleted files, or a folder git no longer reads.
          force: !!check.resumed,
          timeoutMs: secs * 1000,
        }),
      );
    } catch (err) {
      if (err instanceof AoeError && err.timedOut) return stillDeleting();
      throw err;
    }
    if (res.status !== 'deleted') {
      await ctx.ledger.updateTask(project, taskId, (t) => ({ ...t, cleanup: null }));
      throw new CliError(
        `AoE did not remove session ${id} (it said "${res.status}"${res.messages?.length ? `: ${res.messages.join(' ')}` : ''}).`,
        EXIT.error,
        'Look at it in AoE; nothing in Supercharge was changed.',
      );
    }
    // Finishing while AoE still lists it would have the daemon restore the task from removed/.
    if (!(await goneFromAoe(ctx, id, 60_000))) return stillDeleting();
  }
  const done = await finishCleanup(ctx, task, opts.actor);
  return { ...check, removed: true, ...done };
}

/**
 * Supercharge's part of a clean-up, once AoE no longer has the session: the task moves to removed/,
 * the branch goes if it still points at the commit that was checked (AoE's `branch -d` refuses a
 * squash-merged one), the session's uploads go, and the audit log says so. Run by `cleanupTask`, and by
 * the daemon when a delete that ran out of time has finished. Does nothing if the task already left.
 */
export async function finishCleanup(
  ctx: Ctx,
  task: TaskRecord,
  actor: 'cli' | 'ui' | 'daemon',
): Promise<{ branchDeleted: boolean; kept: string[] }> {
  const kept: string[] = [];
  if (!(await ctx.ledger.removeTask(task.project, task.id))) return { branchDeleted: false, kept };
  const id = task.aoeSessionId;
  const head = task.cleanup?.head ?? null;
  const repo = (await ctx.ledger.getProject(task.project))?.repoPath;
  let branchDeleted = false;
  const tip = repo ? await revParse(repo, `refs/heads/${task.branch}`) : null;
  if (repo && tip && tip === head) {
    const r = await run('git', ['branch', '-D', task.branch], { cwd: repo, timeoutMs: 10_000 });
    if (r.code === 0) branchDeleted = true;
    else kept.push(`branch ${task.branch}: ${r.stderr.trim() || 'git would not delete it'}`);
  } else if (tip) kept.push(`branch ${task.branch}: it moved past the commit that was checked`);
  if (task.worktreePath && existsSync(task.worktreePath))
    kept.push(`folder ${task.worktreePath}: AoE left it behind`);
  await rm(join(ctx.paths.uploadsDir, id), { recursive: true, force: true });
  await appendAudit(ctx.paths, {
    actor,
    action: 'task_cleaned_up',
    project: task.project,
    taskId: task.id,
    sessionId: id,
    details: {
      branch: task.branch,
      head,
      landedBy: task.cleanup?.landedBy,
      worktree: task.worktreePath,
      branchDeleted,
      ...(kept.length ? { kept } : {}),
      ...(task.cleanup?.discarded ? { discarded: task.cleanup.discarded } : {}),
    },
  });
  return { branchDeleted, kept };
}

/**
 * Every finished task of a project (done, or archived in AoE without reaching done), each checked on
 * its own: one refusal never stops the others.
 */
export async function cleanupAllDone(
  ctx: Ctx,
  project: string,
  opts: { actor: 'cli' | 'ui'; dryRun?: boolean },
): Promise<CleanupResult[]> {
  const sessions = await ctx.aoe.listSessions('all').catch(() => []);
  const archived = new Set(sessions.filter((s) => s.archived_at && !s.trashed_at).map((s) => s.id));
  const finished = (await ctx.ledger.listTasks(project)).filter(
    (t) => t.stage === 'done' || archived.has(t.aoeSessionId),
  );
  const out: CleanupResult[] = [];
  for (const t of finished) {
    try {
      out.push(await cleanupTask(ctx, project, t.id, opts));
    } catch (err) {
      out.push({ ...refuse(t, (err as Error).message, 'See the message above.'), removed: false });
    }
  }
  return out;
}
