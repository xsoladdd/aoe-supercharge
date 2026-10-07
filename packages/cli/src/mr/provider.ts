import type { MrState } from '@aoe-supercharge/core/shared';
import type { RemoteRef } from '../util/git.ts';

export interface MrRef {
  host: string;
  repo: string;
  iid: number;
  url: string;
}

/** An MR found for a branch, with the state the listing reported. */
export interface FoundMr extends MrRef {
  state: MrState['state'];
}

export interface MrCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

/** Provider seam (SPEC §11.1): GitLab via `glab`, GitHub via `gh`. */
export interface MrProvider {
  id: MrState['provider'];
  matches(remote: RemoteRef | null): boolean;
  parseUrl(url: string): MrRef | null;
  findOpenMrForBranch(remote: RemoteRef, branch: string): Promise<MrRef | null>;
  /** The branch's newest open MR, else its newest merged one; closed ones are ignored. */
  findMrForBranch(remote: RemoteRef, branch: string): Promise<FoundMr | null>;
  status(ref: MrRef): Promise<Omit<MrState, 'checkedAt' | 'error'>>;
  doctor(): Promise<MrCheck[]>;
}

/** Of the MRs listed for a branch, the newest open one, else the newest merged one. */
export function pickBranchMr(found: FoundMr[]): FoundMr | null {
  const newest = (state: MrState['state']) =>
    found.filter((m) => m.state === state).sort((a, b) => b.iid - a.iid)[0] ?? null;
  return newest('opened') ?? newest('merged');
}

/** A freshly found MR, before the watcher has checked it. */
export function toMrState(
  ref: MrRef,
  provider: MrState['provider'],
  state: MrState['state'] = 'opened',
): MrState {
  return {
    provider,
    host: ref.host,
    repo: ref.repo,
    iid: ref.iid,
    url: ref.url,
    state,
    draft: false,
    pipeline: null,
    unresolvedThreads: 0,
    detailedMergeStatus: null,
    checkedAt: null,
    error: null,
  };
}
