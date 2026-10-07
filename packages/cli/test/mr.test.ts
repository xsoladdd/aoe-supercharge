import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '@aoe-supercharge/core/node';
import { mrLabel, type MrState, type TaskRecord } from '@aoe-supercharge/core/shared';
import { project, session, task } from '../../core/test/office-fixtures.ts';
import { MISS_RECHECK_MS, MrDiscovery, type DiscoveryGit } from '../src/daemon/mr-discovery.ts';
import { MrWatcher } from '../src/daemon/mr-watcher.ts';
import { Store } from '../src/daemon/store.ts';
import { GitHubProvider, parseGhPr, rollupToPipeline, toMrStateName } from '../src/mr/github.ts';
import { GitLabProvider } from '../src/mr/gitlab.ts';
import { mrProviders, MrProviders, pickBranchMr, type FoundMr, type MrProvider } from '../src/mr/index.ts';

const SHIMS = join(import.meta.dirname, '../../fake-aoe/bin');

const graphql = (pr: Record<string, unknown>) => ({ data: { repository: { pullRequest: pr } } });
const pr = (over: Record<string, unknown> = {}) => ({
  number: 7,
  url: 'https://github.com/o/r/pull/7',
  state: 'OPEN',
  isDraft: false,
  mergeStateStatus: 'CLEAN',
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }] },
  ...over,
});

describe('GitHub provider parsing', () => {
  const gh = new GitHubProvider('gh', ['github.com', 'github.example.com']);
  it('parses PR URLs on github.com and GitHub Enterprise', () => {
    expect(gh.parseUrl('https://github.com/xsoladdd/aoe-supercharge/pull/12')).toEqual({
      host: 'github.com',
      repo: 'xsoladdd/aoe-supercharge',
      iid: 12,
      url: 'https://github.com/xsoladdd/aoe-supercharge/pull/12',
    });
    expect(gh.parseUrl('https://GitHub.Example.com/o/r/pull/3/files?w=1#x')?.url).toBe(
      'https://github.example.com/o/r/pull/3',
    );
  });
  it('rejects GitLab MRs, issues and junk', () => {
    expect(gh.parseUrl('https://gitlab.com/g/r/-/merge_requests/4')).toBeNull();
    expect(gh.parseUrl('https://github.com/o/r/issues/4')).toBeNull();
    expect(gh.parseUrl('https://github.com/o/r/pull/x')).toBeNull();
    expect(gh.parseUrl('not a url')).toBeNull();
  });
  it('matches configured hosts only', () => {
    expect(gh.matches({ host: 'github.com', path: 'o/r' })).toBe(true);
    expect(gh.matches({ host: 'gitlab.com', path: 'o/r' })).toBe(false);
    expect(gh.matches(null)).toBe(false);
  });
  it('maps PR states and the check rollup', () => {
    expect(toMrStateName('OPEN')).toBe('opened');
    expect(toMrStateName('MERGED')).toBe('merged');
    expect(toMrStateName('CLOSED')).toBe('closed');
    expect(rollupToPipeline('SUCCESS')).toBe('success');
    expect(rollupToPipeline('FAILURE')).toBe('failed');
    expect(rollupToPipeline('ERROR')).toBe('failed');
    expect(rollupToPipeline('PENDING')).toBe('running');
    expect(rollupToPipeline('EXPECTED')).toBe('pending');
    expect(rollupToPipeline(null)).toBeNull();
  });
  it('maps the GraphQL view: draft, pipeline, unresolved threads', () => {
    const ref = { host: 'github.com', repo: 'o/r' };
    expect(parseGhPr(graphql(pr()), ref)).toEqual({
      provider: 'github',
      host: 'github.com',
      repo: 'o/r',
      iid: 7,
      url: 'https://github.com/o/r/pull/7',
      state: 'opened',
      draft: false,
      pipeline: 'success',
      unresolvedThreads: 1,
      detailedMergeStatus: 'CLEAN',
    });
    const bare = parseGhPr(graphql(pr({ isDraft: true, commits: { nodes: [] }, reviewThreads: null })), ref);
    expect(bare).toMatchObject({ draft: true, pipeline: null, unresolvedThreads: 0 });
    expect(() => parseGhPr({ data: { repository: { pullRequest: null } } }, ref)).toThrow(/no pull request/);
  });
  it('labels MRs the way their host does', () => {
    expect(mrLabel({ provider: 'github', iid: 7 })).toBe('#7');
    expect(mrLabel({ provider: 'gitlab', iid: 7 })).toBe('!7');
  });
});

describe('provider choice', () => {
  const providers = mrProviders(defaultConfig(), process.env);
  it('picks by remote host', () => {
    expect(providers.forRemote({ host: 'github.com', path: 'o/r' })?.id).toBe('github');
    expect(providers.forRemote({ host: 'gitlab.com', path: 'g/r' })?.id).toBe('gitlab');
    expect(providers.forRemote({ host: 'bitbucket.org', path: 'a/b' })).toBeNull();
  });
  it('picks by MR URL, and by the provider an MR was recorded with', () => {
    expect(providers.forUrl('https://github.com/o/r/pull/1')?.provider.id).toBe('github');
    expect(providers.forUrl('https://gitlab.example.com/g/r/-/merge_requests/1')?.provider.id).toBe('gitlab');
    expect(providers.forUrl('https://example.com/nope')).toBeNull();
    expect(providers.forMr({ provider: 'github' }).id).toBe('github');
    expect(providers.forMr({ provider: 'gitlab' }).id).toBe('gitlab');
  });
  it('a branch MR: newest open, else newest merged; closed never', () => {
    const f = (iid: number, state: FoundMr['state']): FoundMr => ({
      host: 'h',
      repo: 'r',
      iid,
      url: `u${iid}`,
      state,
    });
    expect(pickBranchMr([f(1, 'opened'), f(5, 'merged'), f(3, 'opened')])?.iid).toBe(3);
    expect(pickBranchMr([f(1, 'merged'), f(4, 'merged'), f(9, 'closed')])?.iid).toBe(4);
    expect(pickBranchMr([f(9, 'closed')])).toBeNull();
  });
});

describe('providers through the fake CLIs', () => {
  let dir: string;
  const env = () => ({ ...process.env, FAKE_GH_DIR: dir, FAKE_GLAB_DIR: dir });
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sc-mr-'));
    await writeFile(
      join(dir, 'pr-list.json'),
      JSON.stringify([
        { number: 5, url: 'https://github.com/o/r/pull/5', state: 'CLOSED', headRefName: 'feat' },
        { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', headRefName: 'feat' },
        { number: 2, url: 'https://github.com/o/r/pull/2', state: 'MERGED', headRefName: 'old' },
      ]),
    );
    await writeFile(join(dir, 'pr-7.json'), JSON.stringify(graphql(pr())));
    await writeFile(
      join(dir, 'mr-list.json'),
      JSON.stringify([
        {
          iid: 1986,
          web_url: 'https://gitlab.com/g/r/-/merge_requests/1986',
          state: 'opened',
          source_branch: 'fix',
        },
        {
          iid: 1900,
          web_url: 'https://gitlab.com/g/r/-/merge_requests/1900',
          state: 'merged',
          source_branch: 'fix',
        },
      ]),
    );
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('GitHub: finds the branch PR and reads its status', async () => {
    const gh = new GitHubProvider(join(SHIMS, 'gh'), ['github.com'], env());
    const remote = { host: 'github.com', path: 'o/r' };
    expect(await gh.findMrForBranch(remote, 'feat')).toMatchObject({ iid: 7, state: 'opened' });
    expect(await gh.findMrForBranch(remote, 'old')).toMatchObject({ iid: 2, state: 'merged' });
    expect(await gh.findOpenMrForBranch(remote, 'old')).toBeNull();
    expect(await gh.findMrForBranch(remote, 'none')).toBeNull();
    const ref = gh.parseUrl('https://github.com/o/r/pull/7')!;
    expect(await gh.status(ref)).toMatchObject({
      provider: 'github',
      pipeline: 'success',
      unresolvedThreads: 1,
    });
    await expect(gh.status({ ...ref, iid: 99 })).rejects.toThrow(/gh api graphql failed/);
    expect((await gh.doctor()).map((c) => [c.name, c.ok])).toEqual([
      ['gh', true],
      ['gh auth github.com', true],
    ]);
  });
  it('GitHub: a missing gh is reported, not thrown', async () => {
    const gh = new GitHubProvider(join(dir, 'no-such-gh'), ['github.com'], env());
    expect(await gh.doctor()).toEqual([expect.objectContaining({ name: 'gh', ok: false })]);
  });
  it('GitLab: finds the newest open MR for a branch', async () => {
    const glab = new GitLabProvider(join(SHIMS, 'glab'), ['gitlab.com'], env());
    expect(await glab.findMrForBranch({ host: 'gitlab.com', path: 'g/r' }, 'fix')).toMatchObject({
      iid: 1986,
      state: 'opened',
      url: 'https://gitlab.com/g/r/-/merge_requests/1986',
    });
  });
});

// ── branch discovery ─────────────────────────────────────────────────────────

const mrState = (over: Partial<MrState> = {}): Omit<MrState, 'checkedAt' | 'error'> => ({
  provider: 'gitlab',
  host: 'gitlab.com',
  repo: 'g/r',
  iid: 1986,
  url: 'https://gitlab.com/g/r/-/merge_requests/1986',
  state: 'opened',
  draft: false,
  pipeline: 'running',
  unresolvedThreads: 0,
  detailedMergeStatus: null,
  ...over,
});

function harness(opts: { found?: Record<string, FoundMr['state']>; gitBranch?: string | null } = {}) {
  const store = new Store({ daemon: {}, aoe: {}, config: {} } as never, { waitingDebounceSeconds: () => 0 });
  store.projects = [{ ...project('alpha', 'ctl'), remoteUrl: 'git@gitlab.com:g/r.git' }];
  const found = opts.found ?? {};
  const provider: MrProvider = {
    id: 'gitlab',
    matches: (r) => r?.host === 'gitlab.com',
    parseUrl: () => null,
    findOpenMrForBranch: async () => null,
    findMrForBranch: vi.fn(async (_remote, branch: string) =>
      found[branch]
        ? { host: 'gitlab.com', repo: 'g/r', iid: 1986, url: `https://x/${branch}`, state: found[branch]! }
        : null,
    ),
    status: vi.fn(async () => mrState()),
    doctor: async () => [],
  };
  const git: DiscoveryGit = {
    currentBranch: vi.fn(async () => opts.gitBranch ?? null),
    defaultBranch: async () => 'dev',
    remoteUrl: async () => null,
  };
  const ledger = {
    updateTask: vi.fn(async (_p: string, id: string, fn: (t: TaskRecord) => TaskRecord) => {
      store.tasks = store.tasks.map((t) => (t.id === id ? fn(t) : t));
    }),
  };
  let now = 1_000_000;
  const discovery = new MrDiscovery(
    { ledger, logger: { warn() {} } } as never,
    store,
    () => new MrProviders([provider]),
    git,
    () => now,
  );
  return { store, provider, git, ledger, discovery, tick: (ms: number) => (now += ms) };
}

describe('MR discovery by branch (SPEC §11.3)', () => {
  it("finds a crew session's MR from its branch and refreshes it while open", async () => {
    const h = harness({ found: { 'bugfix/idea-512': 'opened' } });
    h.store.sessions = [session('vivian', 'idle', { parentId: 'ctl', branch: 'bugfix/idea-512' })];
    await h.discovery.pollOnce();
    expect(h.store.sessionMrs.vivian).toMatchObject({ iid: 1986, pipeline: 'running', error: null });
    expect(h.provider.findMrForBranch).toHaveBeenCalledWith(
      { host: 'gitlab.com', path: 'g/r' },
      'bugfix/idea-512',
    );
    await h.discovery.pollOnce();
    expect(h.provider.findMrForBranch).toHaveBeenCalledTimes(1);
    expect(h.provider.status).toHaveBeenCalledTimes(2);
  });

  it("asks git for the branch when AoE has none (a plain path, not AoE's worktree)", async () => {
    const h = harness({ found: { 'from-git': 'opened' }, gitBranch: 'from-git' });
    h.store.sessions = [session('s1', 'idle', { parentId: 'ctl', projectPath: '/w/s1' })];
    await h.discovery.pollOnce();
    expect(h.git.currentBranch).toHaveBeenCalledWith('/w/s1');
    expect(h.store.sessionMrs.s1?.iid).toBe(1986);
  });

  it('skips the default branch, sessions with no branch, and other projects’ sessions', async () => {
    const h = harness({ found: { dev: 'opened' } });
    h.store.sessions = [
      session('a', 'idle', { parentId: 'ctl', branch: 'dev' }),
      session('b', 'idle', { parentId: 'ctl' }),
      session('c', 'idle', { parentId: 'elsewhere', branch: 'x' }),
    ];
    await h.discovery.pollOnce();
    expect(h.provider.findMrForBranch).not.toHaveBeenCalled();
    expect(h.store.sessionMrs).toEqual({});
  });

  it('looks a branch with no MR up again only after a while', async () => {
    const h = harness();
    h.store.sessions = [session('s1', 'idle', { parentId: 'ctl', branch: 'feat' })];
    await h.discovery.pollOnce();
    h.tick(60_000);
    await h.discovery.pollOnce();
    expect(h.provider.findMrForBranch).toHaveBeenCalledTimes(1);
    h.tick(MISS_RECHECK_MS);
    await h.discovery.pollOnce();
    expect(h.provider.findMrForBranch).toHaveBeenCalledTimes(2);
  });

  it('a merged MR is final; a new branch is looked up afresh; gone sessions are dropped', async () => {
    const h = harness({ found: { old: 'merged', next: 'opened' } });
    h.store.sessions = [session('s1', 'stopped', { parentId: 'ctl', branch: 'old' })];
    await h.discovery.pollOnce();
    await h.discovery.pollOnce();
    expect(h.store.sessionMrs.s1?.state).toBe('merged');
    expect(h.provider.findMrForBranch).toHaveBeenCalledTimes(1);
    expect(h.provider.status).not.toHaveBeenCalled();
    h.store.sessions = [session('s1', 'idle', { parentId: 'ctl', branch: 'next' })];
    await h.discovery.pollOnce();
    expect(h.provider.findMrForBranch).toHaveBeenLastCalledWith(expect.anything(), 'next');
    expect(h.store.sessionMrs.s1?.state).toBe('opened');
    h.store.sessions = [];
    await h.discovery.pollOnce();
    expect(h.store.sessionMrs).toEqual({});
  });

  it('raises an idle task whose worker opened an MR without saying so; leaves busy ones alone', async () => {
    const h = harness({ found: { 'sc/XX-0001': 'opened', 'sc/XX-0002': 'opened', 'sc/XX-0003': 'opened' } });
    h.store.sessions = [session('w1', 'idle'), session('w2', 'working'), session('w3', 'idle')];
    h.store.tasks = [
      task('XX-0001', 'alpha', 'w1', { stage: 'verifying' }),
      task('XX-0002', 'alpha', 'w2', { stage: 'implementing' }),
      task('XX-0003', 'alpha', 'w3', { stage: 'planning' }),
    ];
    await h.discovery.pollOnce();
    const [t1, t2, t3] = h.store.tasks;
    expect(t1).toMatchObject({ stage: 'mr_raised', mr: { iid: 1986, state: 'opened' } });
    expect(t1!.history.at(-1)).toMatchObject({ by: 'daemon', note: 'Found MR !1986 for the branch' });
    expect(t2).toMatchObject({ stage: 'implementing', mr: null });
    expect(t3).toMatchObject({ stage: 'planning', mr: null });
    // Tasks never show up as session MRs.
    expect(h.store.sessionMrs).toEqual({});
  });

  it('reports a rate limit so the watcher backs off', async () => {
    const h = harness();
    (h.provider.findMrForBranch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('HTTP 429'));
    h.store.sessions = [session('s1', 'idle', { parentId: 'ctl', branch: 'feat' })];
    expect(await h.discovery.pollOnce()).toEqual(['rate_limited']);
  });

  it('the watcher runs discovery in its round and doubles its backoff on a rate limit', async () => {
    const h = harness();
    (h.provider.findMrForBranch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('API rate limit exceeded'),
    );
    h.store.sessions = [session('s1', 'idle', { parentId: 'ctl', branch: 'feat' })];
    const ctx = { config: defaultConfig(), logger: { warn() {} }, ledger: h.ledger } as never;
    const w = new MrWatcher(ctx, h.store, () => new MrProviders([h.provider]));
    (w as unknown as { discovery: MrDiscovery }).discovery.pollOnce = () => h.discovery.pollOnce();
    await w.pollOnce();
    expect((w as unknown as { backoff: number }).backoff).toBe(2);
  });
});
