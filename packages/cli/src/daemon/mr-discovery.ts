import { applyStage } from '@aoe-supercharge/core/node';
import {
  mrLabel,
  spawnedSessions,
  type MrState,
  type ProjectRecord,
  type SessionView,
  type TaskRecord,
} from '@aoe-supercharge/core/shared';
import type { Ctx } from '../context.ts';
import { toMrState, type MrProviders } from '../mr/index.ts';
import { currentBranch, defaultBranch, parseRemote, remoteUrl, type RemoteRef } from '../util/git.ts';
import type { Store } from './store.ts';

/** A branch with no MR is looked up again at most this often. */
export const MISS_RECHECK_MS = 5 * 60_000;

/** Stages in which a task's worker may have opened an MR without reporting `mr_raised`. */
const FALLBACK_STAGES = new Set<TaskRecord['stage']>(['implementing', 'verifying']);

export type CheckResult = 'ok' | 'error' | 'rate_limited';

interface Entry {
  branch: string;
  mr: MrState | null;
  /** When the branch was last looked up (ms). */
  lookedAt: number;
}

export interface DiscoveryGit {
  currentBranch(cwd: string): Promise<string | null>;
  defaultBranch(cwd: string): Promise<string>;
  remoteUrl(cwd: string): Promise<string | null>;
}

const realGit: DiscoveryGit = { currentBranch, defaultBranch, remoteUrl };

type Candidate =
  | { kind: 'session'; key: string; project: ProjectRecord; session: SessionView }
  | { kind: 'task'; key: string; project: ProjectRecord; task: TaskRecord };

const outcome = (err: unknown): CheckResult =>
  /429|rate.?limit/i.test((err as Error).message) ? 'rate_limited' : 'error';

/**
 * Finds MRs by branch (SPEC §11.4) for the crew a control chat started straight through AoE, which have
 * no task, and for tasks whose worker opened an MR without reporting `mr_raised`. Driven by the MR
 * watcher's loop, so it shares its cadence and backoff. What it finds on a session is observed, not
 * owned: it lives in the daemon's memory (`Snapshot.sessionMrs`), never in the ledger.
 */
export class MrDiscovery {
  private cache = new Map<string, Entry>();

  constructor(
    private ctx: Pick<Ctx, 'ledger' | 'logger'>,
    private store: Store,
    private providers: () => MrProviders,
    private git: DiscoveryGit = realGit,
    private now: () => number = Date.now,
  ) {}

  private candidates(): Candidate[] {
    const out: Candidate[] = [];
    const live = new Map(this.store.sessions.map((s) => [s.id, s]));
    for (const project of this.store.projects) {
      for (const session of spawnedSessions(this.store, project.controlSessionId))
        out.push({ kind: 'session', key: session.id, project, session });
      for (const task of this.store.tasks) {
        if (task.project !== project.name || task.mr || !FALLBACK_STAGES.has(task.stage)) continue;
        const status = live.get(task.aoeSessionId)?.status;
        // A worker still at it may be about to report the MR itself.
        if (status !== 'idle' && status !== 'stopped') continue;
        out.push({ kind: 'task', key: `task:${project.name}/${task.id}`, project, task });
      }
    }
    return out;
  }

  async pollOnce(): Promise<CheckResult[]> {
    const candidates = this.candidates();
    const keep = new Set(candidates.map((c) => c.key));
    for (const key of this.cache.keys()) if (!keep.has(key)) this.cache.delete(key);

    const remotes = new Map<string, Promise<{ remote: RemoteRef | null; main: string | null }>>();
    const projectInfo = (p: ProjectRecord) => {
      if (!remotes.has(p.name))
        remotes.set(
          p.name,
          (async () => ({
            remote: parseRemote(p.remoteUrl ?? (await this.git.remoteUrl(p.repoPath))),
            main: await this.git.defaultBranch(p.repoPath).catch(() => null),
          }))(),
        );
      return remotes.get(p.name)!;
    };

    const results: CheckResult[] = [];
    for (let i = 0; i < candidates.length; i += 2) {
      const batch = candidates.slice(i, i + 2);
      results.push(...(await Promise.all(batch.map((c) => this.check(c, projectInfo)))));
    }
    this.publish();
    return results;
  }

  private async branchOf(c: Candidate): Promise<string | null> {
    if (c.kind === 'task') return c.task.branch || null;
    if (c.session.branch) return c.session.branch;
    // Not a worktree AoE made (`aoe add` on a plain path): ask git where the folder is.
    return c.session.projectPath ? this.git.currentBranch(c.session.projectPath).catch(() => null) : null;
  }

  private async check(
    c: Candidate,
    projectInfo: (p: ProjectRecord) => Promise<{ remote: RemoteRef | null; main: string | null }>,
  ): Promise<CheckResult> {
    const branch = await this.branchOf(c);
    const { remote, main } = await projectInfo(c.project);
    const provider = this.providers().forRemote(remote);
    if (
      !branch ||
      !remote ||
      !provider ||
      branch === main ||
      (c.kind === 'task' && branch === c.task.baseBranch)
    ) {
      this.cache.delete(c.key);
      return 'ok';
    }
    let entry = this.cache.get(c.key);
    if (entry && entry.branch !== branch) entry = undefined;
    const now = this.now();

    // A session's open MR is refreshed every poll, like a task's; merged and closed ones are final.
    if (entry?.mr) {
      if (c.kind === 'task' || entry.mr.state !== 'opened') return 'ok';
      return this.refresh(c.key, entry);
    }
    if (entry && now - entry.lookedAt < MISS_RECHECK_MS) return 'ok';

    try {
      const found = await provider.findMrForBranch(remote, branch);
      const mr = found ? toMrState(found, provider.id, found.state) : null;
      entry = { branch, mr, lookedAt: now };
      this.cache.set(c.key, entry);
      if (!mr) return 'ok';
      if (c.kind === 'task') {
        await this.raise(c.task, mr);
        return 'ok';
      }
      return mr.state === 'opened' ? this.refresh(c.key, entry) : 'ok';
    } catch (err) {
      this.ctx.logger.warn('mr lookup failed', { key: c.key, branch, err: (err as Error).message });
      this.cache.set(c.key, { branch, mr: entry?.mr ?? null, lookedAt: now });
      return outcome(err);
    }
  }

  private async refresh(key: string, entry: Entry): Promise<CheckResult> {
    const mr = entry.mr!;
    const at = new Date(this.now()).toISOString();
    try {
      const status = await this.providers().forMr(mr).status(mr);
      this.cache.set(key, { ...entry, mr: { ...status, checkedAt: at, error: null } });
      return 'ok';
    } catch (err) {
      const message = (err as Error).message;
      this.ctx.logger.warn('mr check failed', { key, err: message });
      this.cache.set(key, { ...entry, mr: { ...mr, checkedAt: at, error: message } });
      return outcome(err);
    }
  }

  /** The worker opened an MR but never said so: raise it, as after an adoption, and let the watcher take over. */
  private async raise(task: TaskRecord, mr: MrState) {
    await this.ctx.ledger.updateTask(task.project, task.id, (cur) =>
      cur.mr || !FALLBACK_STAGES.has(cur.stage)
        ? cur
        : { ...applyStage(cur, 'mr_raised', 'daemon', `Found MR ${mrLabel(mr)} for the branch`), mr },
    );
  }

  private publish() {
    const out: Record<string, MrState> = {};
    for (const [key, e] of this.cache) if (e.mr && !key.startsWith('task:')) out[key] = e.mr;
    this.store.setSessionMrs(out);
  }
}
