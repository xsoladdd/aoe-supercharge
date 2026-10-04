import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '@aoe-supercharge/core/node';
import type { MrState, NeedsYouItem, TaskRecord } from '@aoe-supercharge/core/shared';
import {
  AoeAboutSchema,
  AoeCliListSchema,
  AoeSessionsResponseSchema,
  AoeStatusCountsSchema,
} from '../src/aoe/schemas.ts';
import { parseUpdateCheck, releaseAsset } from '../src/commands/aoe-upgrade.ts';
import { renderCaddyfile } from '../src/commands/proxy.ts';
import { MrWatcher } from '../src/daemon/mr-watcher.ts';
import { countUnresolvedThreads, GitLabProvider, parseMrView } from '../src/mr/gitlab.ts';
import { Notifier } from '../src/notify.ts';
import { renderLaunchdPlist, renderSystemdUnit } from '../src/service/index.ts';
import { removeManagedBlock, upsertManagedBlock } from '../src/skills.ts';
import { parseRemote } from '../src/util/git.ts';
import { redact } from '../src/util/logger.ts';
import { modelArgs } from '../src/workflow.ts';

const FIXTURES = join(import.meta.dirname, '../../../fixtures/aoe');

describe('offline contract: recorded AoE fixtures match the client schemas', () => {
  for (const version of readdirSync(FIXTURES)) {
    const f = (name: string) => JSON.parse(readFileSync(join(FIXTURES, version, name), 'utf8'));
    it(`${version}: GET /api/sessions`, () => {
      const r = AoeSessionsResponseSchema.parse(f('GET_api_sessions.json'));
      expect(r.sessions.length).toBeGreaterThan(0);
      expect(r.sessions.every((s) => !('parent_session_id' in s))).toBe(true); // SPEC §1.2: no parent in REST
    });
    it(`${version}: GET /api/about`, () =>
      expect(AoeAboutSchema.parse(f('GET_api_about.json')).version).toBe(version));
    it(`${version}: aoe list --json carries parent links and worktrees`, () => {
      const list = AoeCliListSchema.parse(f('cli_list_json.json'));
      expect(list.some((e) => e.parent_session_id)).toBe(true);
      expect(list.some((e) => e.worktree?.branch)).toBe(true);
    });
    it(`${version}: aoe status --json`, () =>
      expect(AoeStatusCountsSchema.parse(f('cli_status_json.json')).total).toBeGreaterThan(0));
  }
});

describe('git remotes', () => {
  it.each([
    ['git@gitlab.com:group/sub/repo.git', 'gitlab.com', 'group/sub/repo'],
    ['https://gitlab.example.com/group/repo.git', 'gitlab.example.com', 'group/repo'],
    ['ssh://git@gitlab.example.com:2222/group/repo.git', 'gitlab.example.com', 'group/repo'],
  ])('%s', (url, host, path) => expect(parseRemote(url)).toEqual({ host, path }));
});

describe('GitLab provider parsing (glab 1.94 shapes)', () => {
  const provider = new GitLabProvider('glab', ['gitlab.com', 'gitlab.example.com']);
  it('parses MR URLs, including subgroups', () => {
    expect(provider.parseUrl('https://gitlab.example.com/group/sub/repo/-/merge_requests/42')).toEqual({
      host: 'gitlab.example.com',
      repo: 'group/sub/repo',
      iid: 42,
      url: 'https://gitlab.example.com/group/sub/repo/-/merge_requests/42',
    });
    expect(provider.parseUrl('https://example.com/not-an-mr')).toBeNull();
  });
  it('matches configured hosts only', () => {
    expect(provider.matches({ host: 'gitlab.example.com', path: 'a/b' })).toBe(true);
    expect(provider.matches({ host: 'github.com', path: 'a/b' })).toBe(false);
  });
  it('maps mr view JSON', () => {
    const v = parseMrView(
      {
        iid: 3988,
        state: 'opened',
        draft: false,
        web_url: 'https://gitlab.com/g/r/-/merge_requests/3988',
        detailed_merge_status: 'mergeable',
        head_pipeline: { status: 'success' },
      },
      { host: 'gitlab.com', repo: 'g/r' },
    );
    expect(v.pipeline).toBe('success');
    expect(v.state).toBe('opened');
  });
  it('counts unresolved threads per discussion, ignoring system notes', () => {
    expect(
      countUnresolvedThreads([
        { notes: [{ resolvable: false, resolved: null }] },
        {
          notes: [
            { resolvable: true, resolved: false },
            { resolvable: true, resolved: false },
          ],
        },
        { notes: [{ resolvable: true, resolved: true }] },
        { notes: [{ resolvable: true, resolved: false }] },
      ]),
    ).toBe(2);
  });
});

function mrTask(stage: TaskRecord['stage']): TaskRecord {
  return {
    schema: 1,
    rev: 1,
    id: 'NW-0001',
    project: 'nw',
    title: 't',
    brief: '',
    branch: 'sc/nw-0001-t',
    baseBranch: 'main',
    worktreePath: '/w',
    aoeSessionId: 's',
    parentSessionId: 'c',
    stage,
    blockedFrom: null,
    openQuestion: null,
    plan: { status: 'approved', savedAt: 'x', sha256: 'y' },
    mr: null,
    createdAt: 'x',
    updatedAt: 'x',
    history: [],
  };
}
const mr = (p: Partial<MrState>): MrState => ({
  provider: 'gitlab',
  host: 'gitlab.com',
  repo: 'g/r',
  iid: 1,
  url: 'u',
  state: 'opened',
  draft: false,
  pipeline: 'running',
  unresolvedThreads: 0,
  detailedMergeStatus: null,
  checkedAt: 'now',
  error: null,
  ...p,
});

describe('MR watcher transitions (daemon actor)', () => {
  const ctx = { config: defaultConfig() } as never;
  const w = new MrWatcher(ctx, {} as never, () => ({}) as never);
  it('mr_raised → watching_mr on the first poll', () => {
    expect(w.advance(mrTask('mr_raised'), mr({})).stage).toBe('watching_mr');
  });
  it('goes straight to ready_for_review when already green', () => {
    const t = w.advance(mrTask('mr_raised'), mr({ pipeline: 'success' }));
    expect(t.stage).toBe('ready_for_review');
    expect(t.history.map((h) => h.to)).toEqual(['watching_mr', 'ready_for_review']);
  });
  it('drops back to watching_mr when a new thread opens', () => {
    const t = w.advance(mrTask('ready_for_review'), mr({ pipeline: 'success', unresolvedThreads: 1 }));
    expect(t.stage).toBe('watching_mr');
    expect(t.history.at(-1)?.note).toMatch(/1 open thread/);
  });
  it('merged → done; closed leaves the stage alone', () => {
    expect(w.advance(mrTask('watching_mr'), mr({ state: 'merged' })).stage).toBe('done');
    expect(w.advance(mrTask('watching_mr'), mr({ state: 'closed' })).stage).toBe('watching_mr');
  });
  it('ignores tasks outside MR stages but still records MR state', () => {
    const t = w.advance(mrTask('implementing'), mr({ pipeline: 'failed' }));
    expect(t.stage).toBe('implementing');
    expect(t.mr?.pipeline).toBe('failed');
  });
});

describe('Notifier', () => {
  const item = (id: string, kind: NeedsYouItem['kind']): NeedsYouItem => ({
    id,
    kind,
    project: 'p',
    taskId: null,
    sessionId: null,
    title: 't',
    detail: 'd',
    since: 'x',
  });
  it('does not replay items that existed at startup, and honours toggles', async () => {
    const config = defaultConfig();
    config.notifications.aoeWaiting = false;
    const send = vi.fn(async (_title: string, _body: string) => true);
    const n = new Notifier(() => config, send);
    n.arm([item('a', 'question')]);
    await n.onNeedsYou([item('a', 'question'), item('b', 'mr_ready'), item('c', 'approval')]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe('Ready for review');
    await n.onNeedsYou([item('b', 'mr_ready')]);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('service files', () => {
  const spec = {
    nodePath: '/Users/me/.nvm/versions/node/v24.14.0/bin/node',
    cliPath: '/opt/sc/dist/supercharge.mjs',
    pathEnv: '/opt/homebrew/bin:/usr/bin',
    logsDir: '/Users/me/.local/state/supercharge/logs',
    home: '/Users/me',
  };
  it('renders a launchd plist', () => expect(renderLaunchdPlist(spec)).toMatchSnapshot());
  it('renders a systemd user unit', () => expect(renderSystemdUnit(spec)).toMatchSnapshot());
  it('renders the Caddyfile bound to loopback', () =>
    expect(renderCaddyfile('supercharge.localhost', 4280)).toMatch(/bind 127\.0\.0\.1 ::1/));
});

describe('CLAUDE.md managed block (--commit)', () => {
  it('inserts, replaces in place, and removes cleanly', () => {
    const a = upsertManagedBlock('# Project\n\nNotes.\n', 'v1 body');
    expect(a).toMatch(/<!-- supercharge:begin v1 -->\nv1 body\n<!-- supercharge:end -->/);
    const b = upsertManagedBlock(a, 'v2 body');
    expect(b.match(/supercharge:begin/g)).toHaveLength(1);
    expect(b).toMatch(/v2 body/);
    expect(removeManagedBlock(b).trim()).toBe('# Project\n\nNotes.');
  });
});

describe('logger redaction', () => {
  it('never writes tokens', () => {
    const tok = 'a'.repeat(64);
    expect(
      JSON.stringify(
        redact({ msg: `url ?token=${tok}`, authorization: 'Bearer x', nested: { aoeToken: 'y' } }),
      ),
    ).not.toMatch(/a{64}|Bearer x|"y"/);
  });
});

describe('aoe upgrade helpers', () => {
  it('parses aoe update --check', () => {
    expect(parseUpdateCheck('current: 1.17.2\nlatest:  1.18.0\navailable: true\n')).toEqual({
      current: '1.17.2',
      latest: '1.18.0',
    });
  });
  it('maps platform to the release asset', () => {
    expect(releaseAsset('darwin', 'arm64')).toBe('aoe-darwin-arm64.tar.gz');
    expect(releaseAsset('linux', 'x64')).toBe('aoe-linux-amd64.tar.gz');
  });
});

describe('model and effort for new sessions', () => {
  it('adds --model / --effort only when set (session-only launch flags)', () => {
    const c = defaultConfig();
    expect(modelArgs(c)).toEqual([]);
    c.agent.model = 'opus';
    c.agent.effort = 'high';
    expect(modelArgs(c)).toEqual(['--model', 'opus', '--effort', 'high']);
  });
});
