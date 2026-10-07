import type { MrState, PipelineStatus } from '@aoe-supercharge/core/shared';
import { z } from 'zod';
import { run } from '../util/exec.ts';
import type { RemoteRef } from '../util/git.ts';
import { pickBranchMr, type FoundMr, type MrCheck, type MrProvider, type MrRef } from './provider.ts';

const PR_STATE: Record<string, MrState['state']> = { OPEN: 'opened', MERGED: 'merged', CLOSED: 'closed' };

/** `gh` reports OPEN | MERGED | CLOSED; GitLab's names are the ones Supercharge keeps. */
export function toMrStateName(state: string): MrState['state'] {
  return PR_STATE[state.toUpperCase()] ?? 'closed';
}

/**
 * The head commit's combined check state as a pipeline status: GitHub has no pipeline, but its check
 * rollup (check runs and commit statuses together) plays the same part.
 */
export function rollupToPipeline(state: string | null | undefined): PipelineStatus | null {
  switch (state?.toUpperCase()) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
      return 'failed';
    case 'PENDING':
      return 'running';
    case 'EXPECTED':
      return 'pending';
    default:
      return null;
  }
}

const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number url state isDraft mergeStateStatus
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      reviewThreads(first: 100) { nodes { isResolved } }
    }
  }
}`;

const PrSchema = z.looseObject({
  number: z.number(),
  url: z.string(),
  state: z.string(),
  isDraft: z.boolean().nullish(),
  mergeStateStatus: z.string().nullish(),
  commits: z
    .looseObject({
      nodes: z
        .array(
          z.looseObject({
            commit: z.looseObject({ statusCheckRollup: z.looseObject({ state: z.string() }).nullish() }),
          }),
        )
        .nullish(),
    })
    .nullish(),
  reviewThreads: z
    .looseObject({ nodes: z.array(z.looseObject({ isResolved: z.boolean() })).nullish() })
    .nullish(),
});

const GraphqlSchema = z.looseObject({
  data: z.looseObject({
    repository: z.looseObject({ pullRequest: PrSchema.nullish() }).nullish(),
  }),
});

/** Maps `gh api graphql` output for one pull request (see PR_QUERY). */
export function parseGhPr(
  json: unknown,
  ref: { host: string; repo: string },
): Omit<MrState, 'checkedAt' | 'error'> {
  const pr = GraphqlSchema.parse(json).data.repository?.pullRequest;
  if (!pr) throw new GhError(`gh: no pull request in ${ref.repo}`);
  const rollup = pr.commits?.nodes?.at(-1)?.commit.statusCheckRollup?.state;
  return {
    provider: 'github',
    host: ref.host,
    repo: ref.repo,
    iid: pr.number,
    url: pr.url,
    state: toMrStateName(pr.state),
    draft: !!pr.isDraft,
    pipeline: rollupToPipeline(rollup),
    unresolvedThreads: (pr.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved).length,
    detailedMergeStatus: pr.mergeStateStatus ?? null,
  };
}

const PrListSchema = z.array(z.looseObject({ number: z.number(), url: z.string(), state: z.string() }));

export class GhError extends Error {}

/** GitHub (and GitHub Enterprise hosts) via the gh CLI. Read-only: lists, views and GraphQL queries. */
export class GitHubProvider implements MrProvider {
  id = 'github' as const;

  constructor(
    private gh: string,
    private hosts: string[],
    private env: NodeJS.ProcessEnv = process.env,
  ) {}

  private async json(args: string[]): Promise<unknown> {
    const r = await run(this.gh, args, {
      env: { ...this.env, NO_COLOR: '1', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      timeoutMs: 20_000,
    });
    if (r.error) throw new GhError(`gh could not run: ${r.error.message}`);
    if (r.timedOut) throw new GhError(`gh ${args[0]} timed out`);
    if (r.code !== 0)
      throw new GhError(
        `gh ${args.slice(0, 2).join(' ')} failed: ${r.stderr.trim().split('\n').pop() ?? ''}`,
      );
    try {
      return JSON.parse(r.stdout);
    } catch {
      throw new GhError(`gh ${args.slice(0, 2).join(' ')} returned non-JSON output`);
    }
  }

  matches(remote: RemoteRef | null): boolean {
    return !!remote && this.hosts.some((h) => h.split(':')[0] === remote.host);
  }

  parseUrl(url: string): MrRef | null {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/);
      if (!m) return null;
      return {
        host: u.hostname.toLowerCase(),
        repo: m[1]!,
        iid: Number(m[2]),
        url: `${u.origin}/${m[1]}/pull/${m[2]}`,
      };
    } catch {
      return null;
    }
  }

  private async list(remote: RemoteRef, branch: string): Promise<FoundMr[]> {
    const list = PrListSchema.parse(
      await this.json([
        'pr',
        'list',
        '-R',
        `${remote.host}/${remote.path}`,
        '--head',
        branch,
        '--state',
        'all',
        '--json',
        'number,url,state',
        '--limit',
        '20',
      ]),
    );
    return list.map((p) => ({
      host: remote.host,
      repo: remote.path,
      iid: p.number,
      url: p.url,
      state: toMrStateName(p.state),
    }));
  }

  async findOpenMrForBranch(remote: RemoteRef, branch: string): Promise<MrRef | null> {
    const open = (await this.list(remote, branch)).filter((m) => m.state === 'opened');
    const pick = open.sort((a, b) => b.iid - a.iid)[0];
    return pick ? { host: pick.host, repo: pick.repo, iid: pick.iid, url: pick.url } : null;
  }

  async findMrForBranch(remote: RemoteRef, branch: string): Promise<FoundMr | null> {
    return pickBranchMr(await this.list(remote, branch));
  }

  async status(ref: MrRef): Promise<Omit<MrState, 'checkedAt' | 'error'>> {
    const [owner, name] = ref.repo.split('/');
    const json = await this.json([
      'api',
      'graphql',
      '--hostname',
      ref.host,
      '-f',
      `query=${PR_QUERY}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-F',
      `number=${ref.iid}`,
    ]);
    return parseGhPr(json, ref);
  }

  async doctor(): Promise<MrCheck[]> {
    const which = await run(this.gh, ['--version'], { env: this.env, timeoutMs: 10_000 });
    if (which.error || which.code !== 0) {
      return [
        {
          name: 'gh',
          ok: false,
          detail: 'gh is not installed (only needed for GitHub repositories)',
          fix: 'brew install gh (see README#dependencies)',
        },
      ];
    }
    const out: MrCheck[] = [
      { name: 'gh', ok: true, detail: which.stdout.trim().split('\n')[0] ?? 'installed' },
    ];
    for (const host of this.hosts) {
      const r = await run(this.gh, ['auth', 'status', '--hostname', host], {
        env: this.env,
        timeoutMs: 15_000,
      });
      const text = `${r.stdout}\n${r.stderr}`;
      const ok = r.code === 0 && /Logged in/i.test(text);
      out.push({
        name: `gh auth ${host}`,
        ok,
        detail: ok ? 'logged in' : 'not logged in',
        fix: ok ? undefined : `gh auth login --hostname ${host}`,
      });
    }
    return out;
  }
}
