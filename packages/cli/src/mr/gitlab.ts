import type { MrState, PipelineStatus } from '@aoe-supercharge/core/shared';
import { z } from 'zod';
import { run } from '../util/exec.ts';
import type { RemoteRef } from '../util/git.ts';
import { pickBranchMr, type FoundMr, type MrCheck, type MrProvider, type MrRef } from './provider.ts';

export type { FoundMr, MrCheck, MrProvider, MrRef } from './provider.ts';

const MrViewSchema = z.looseObject({
  iid: z.number(),
  state: z.enum(['opened', 'merged', 'closed', 'locked']),
  draft: z.boolean().nullish(),
  work_in_progress: z.boolean().nullish(),
  web_url: z.string(),
  detailed_merge_status: z.string().nullish(),
  sha: z.string().nullish(),
  head_pipeline: z.looseObject({ status: z.string() }).nullish(),
  pipeline: z.looseObject({ status: z.string() }).nullish(),
});

const BranchMrSchema = z.looseObject({
  iid: z.number(),
  web_url: z.string(),
  state: z.enum(['opened', 'merged', 'closed', 'locked']),
});

const DiscussionsSchema = z.array(
  z.looseObject({
    notes: z
      .array(z.looseObject({ resolvable: z.boolean().nullish(), resolved: z.boolean().nullish() }))
      .nullish(),
  }),
);

const PIPELINE: readonly PipelineStatus[] = [
  'created',
  'waiting_for_resource',
  'preparing',
  'pending',
  'running',
  'success',
  'failed',
  'canceled',
  'skipped',
  'manual',
  'scheduled',
];

export function toPipeline(status: string | null | undefined): PipelineStatus | null {
  return status && (PIPELINE as readonly string[]).includes(status) ? (status as PipelineStatus) : null;
}

/** Threads that block review: discussions with any resolvable note still unresolved (CodeRabbit posts these). */
export function countUnresolvedThreads(discussions: z.infer<typeof DiscussionsSchema>): number {
  return discussions.filter((d) => (d.notes ?? []).some((n) => n.resolvable && !n.resolved)).length;
}

export function parseMrView(
  json: unknown,
  ref: { host: string; repo: string },
): Omit<MrState, 'checkedAt' | 'error' | 'unresolvedThreads'> {
  const v = MrViewSchema.parse(json);
  return {
    provider: 'gitlab',
    host: ref.host,
    repo: ref.repo,
    iid: v.iid,
    url: v.web_url,
    state: v.state,
    draft: !!(v.draft ?? v.work_in_progress),
    pipeline: toPipeline(v.head_pipeline?.status ?? v.pipeline?.status),
    detailedMergeStatus: v.detailed_merge_status ?? null,
    ...(v.sha ? { headSha: v.sha } : {}),
  };
}

export class GlabError extends Error {}

/** GitLab via the glab CLI, including self-hosted hosts. JSON is read from stdout; glab's warnings go to stderr. */
export class GitLabProvider implements MrProvider {
  id = 'gitlab' as const;

  constructor(
    private glab: string,
    private hosts: string[],
    private env: NodeJS.ProcessEnv = process.env,
  ) {}

  private async json(args: string[]): Promise<unknown> {
    const r = await run(this.glab, args, {
      env: { ...this.env, NO_COLOR: '1', GLAB_NO_PROMPT: '1' },
      timeoutMs: 20_000,
    });
    if (r.error) throw new GlabError(`glab could not run: ${r.error.message}`);
    if (r.timedOut) throw new GlabError(`glab ${args[0]} timed out`);
    if (r.code !== 0)
      throw new GlabError(
        `glab ${args.slice(0, 2).join(' ')} failed: ${r.stderr.trim().split('\n').pop() ?? ''}`,
      );
    try {
      return JSON.parse(r.stdout);
    } catch {
      throw new GlabError(`glab ${args.slice(0, 2).join(' ')} returned non-JSON output`);
    }
  }

  matches(remote: RemoteRef | null): boolean {
    return !!remote && this.hosts.some((h) => h.split(':')[0] === remote.host);
  }

  parseUrl(url: string): MrRef | null {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/^\/(.+?)\/-\/merge_requests\/(\d+)/);
      if (!m) return null;
      return {
        host: u.hostname.toLowerCase(),
        repo: m[1]!,
        iid: Number(m[2]),
        url: `${u.origin}/${m[1]}/-/merge_requests/${m[2]}`,
      };
    } catch {
      return null;
    }
  }

  async findOpenMrForBranch(remote: RemoteRef, branch: string): Promise<MrRef | null> {
    const list = await this.json([
      'mr',
      'list',
      '-R',
      `https://${remote.host}/${remote.path}`,
      '--source-branch',
      branch,
      '-F',
      'json',
    ]);
    const first = Array.isArray(list)
      ? (list[0] as { iid?: number; web_url?: string } | undefined)
      : undefined;
    if (!first?.iid || !first.web_url) return null;
    return { host: remote.host, repo: remote.path, iid: first.iid, url: first.web_url };
  }

  async findMrForBranch(remote: RemoteRef, branch: string): Promise<FoundMr | null> {
    const list = await this.json([
      'mr',
      'list',
      '-R',
      `https://${remote.host}/${remote.path}`,
      '--source-branch',
      branch,
      '--all',
      '-F',
      'json',
    ]);
    const found = (Array.isArray(list) ? list : []).flatMap((m: unknown) => {
      const r = BranchMrSchema.safeParse(m);
      return r.success
        ? [
            {
              host: remote.host,
              repo: remote.path,
              iid: r.data.iid,
              url: r.data.web_url,
              state: r.data.state,
            },
          ]
        : [];
    });
    return pickBranchMr(found);
  }

  async status(ref: MrRef): Promise<Omit<MrState, 'checkedAt' | 'error'>> {
    const view = parseMrView(
      await this.json(['mr', 'view', String(ref.iid), '-R', `https://${ref.host}/${ref.repo}`, '-F', 'json']),
      ref,
    );
    const discussions = DiscussionsSchema.parse(
      await this.json([
        'api',
        '--hostname',
        ref.host,
        '--paginate',
        `projects/${encodeURIComponent(ref.repo)}/merge_requests/${ref.iid}/discussions?per_page=100`,
      ]),
    );
    return { ...view, unresolvedThreads: countUnresolvedThreads(discussions) };
  }

  async doctor(): Promise<MrCheck[]> {
    const which = await run(this.glab, ['version'], { env: this.env, timeoutMs: 10_000 });
    if (which.error || which.code !== 0) {
      return [
        {
          name: 'glab',
          ok: false,
          detail: 'glab is not installed',
          fix: 'brew install glab (see README#dependencies)',
        },
      ];
    }
    const out: MrCheck[] = [
      { name: 'glab', ok: true, detail: which.stdout.trim().split('\n')[0] ?? 'installed' },
    ];
    for (const host of this.hosts) {
      const r = await run(this.glab, ['auth', 'status', '--hostname', host], {
        env: this.env,
        timeoutMs: 15_000,
      });
      const text = `${r.stdout}\n${r.stderr}`;
      const ok = r.code === 0 && /Logged in/i.test(text);
      out.push({
        name: `glab auth ${host}`,
        ok,
        detail: ok ? 'logged in' : 'not logged in',
        fix: ok ? undefined : `glab auth login --hostname ${host}`,
      });
    }
    return out;
  }
}
