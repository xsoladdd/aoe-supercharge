import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultConfig, resolvePaths } from '@aoe-supercharge/core/node';
import type { MrState, NeedsYouItem, TaskRecord } from '@aoe-supercharge/core/shared';
import {
  AoeAboutSchema,
  AoeCliListSchema,
  AoeSessionsResponseSchema,
  AoeStatusCountsSchema,
} from '../src/aoe/schemas.ts';
import { parseUpdateCheck, releaseAsset } from '../src/commands/aoe-upgrade.ts';
import { claudeModelsCheck } from '../src/commands/doctor.ts';
import { connectStatusLine, disconnectStatusLine, statusLineConnected } from '../src/statusline.ts';
import { renderCaddyfile } from '../src/commands/proxy.ts';
import { landedOn, markLanded } from '../src/daemon/branch-watcher.ts';
import { MrWatcher } from '../src/daemon/mr-watcher.ts';
import { CostWatcher, OfficeWatcher, WeatherWatcher } from '../src/daemon/office.ts';
import { at, project, session as view, T0, task as taskRecord } from '../../core/test/office-fixtures.ts';
import { Store } from '../src/daemon/store.ts';
import { countUnresolvedThreads, GitLabProvider, parseMrView } from '../src/mr/gitlab.ts';
import { Notifier } from '../src/notify.ts';
import { renderLaunchdPlist, renderSystemdUnit } from '../src/service/index.ts';
import { removeManagedBlock, upsertManagedBlock } from '../src/skills.ts';
import { parseRemote } from '../src/util/git.ts';
import { run } from '../src/util/exec.ts';
import { redact } from '../src/util/logger.ts';
import { controlPick, modelArgs, setSessionModel, workerModel } from '../src/workflow.ts';

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

describe('branch landing without an MR (SPEC §11.3)', () => {
  async function repo() {
    const dir = await mkdtemp(join(tmpdir(), 'sc-land-'));
    const g = async (...args: string[]) => {
      const r = await run('git', args, { cwd: dir, timeoutMs: 10_000 });
      if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    await g('init', '-q', '-b', 'main');
    await g('config', 'user.email', 't@example.com');
    await g('config', 'user.name', 'T');
    await g('config', 'commit.gpgsign', 'false');
    const commit = async (file: string, text: string) => {
      await writeFile(join(dir, file), text);
      await g('add', file);
      await g('commit', '-q', '-m', file);
    };
    await commit('a.txt', 'a\n');
    await g('checkout', '-q', '-b', 'sc/nw-0001-t');
    await commit('b.txt', 'b\n');
    await commit('c.txt', 'c\n');
    await g('checkout', '-q', 'main');
    await commit('m.txt', 'main moved on\n');
    return { dir, g };
  }
  const ready = (p: Partial<TaskRecord> = {}) => ({ ...mrTask('ready_for_review'), ...p });

  it('not merged yet: stays put', async () => {
    const { dir } = await repo();
    expect(await landedOn(dir, ready())).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
  it('fast-forwarded or merged onto main: landed', async () => {
    const { dir, g } = await repo();
    await g('merge', '-q', '--no-edit', 'sc/nw-0001-t');
    expect(await landedOn(dir, ready())).toBe('main');
    await rm(dir, { recursive: true, force: true });
  });
  it('cherry-picked (same patches, new shas): landed; only part of it: not yet', async () => {
    const { dir, g } = await repo();
    await g('cherry-pick', 'sc/nw-0001-t~1');
    expect(await landedOn(dir, ready())).toBeNull();
    await g('cherry-pick', 'sc/nw-0001-t');
    expect(await landedOn(dir, ready())).toBe('main');
    await rm(dir, { recursive: true, force: true });
  });
  it('falls back to the recorded head once the branch is deleted', async () => {
    const { dir, g } = await repo();
    const head = await g('rev-parse', 'sc/nw-0001-t');
    await g('merge', '-q', '--no-edit', 'sc/nw-0001-t');
    await g('branch', '-q', '-D', 'sc/nw-0001-t');
    expect(await landedOn(dir, ready())).toBeNull();
    expect(await landedOn(dir, ready({ readyHead: head }))).toBe('main');
    await rm(dir, { recursive: true, force: true });
  });
  it('markLanded moves only a branch-ready task to done, as the daemon', () => {
    const t = markLanded(ready(), 'main');
    expect(t.stage).toBe('done');
    expect(t.history.at(-1)).toMatchObject({ by: 'daemon', note: 'Branch landed on main' });
    expect(markLanded(ready({ mr: mr({}) }), 'main').stage).toBe('ready_for_review');
    expect(markLanded(mrTask('implementing'), 'main').stage).toBe('implementing');
  });
});

describe('office cost meters (CostWatcher)', () => {
  const session = (id: string, status: 'working' | 'idle') => ({
    id,
    title: id,
    status,
    tool: 'claude',
    projectPath: `/w/${id}`,
    parentId: null,
  });
  const worker = (id: string, status: 'working' | 'idle', role = 'worker') => ({
    key: `p/${id}`,
    role,
    project: 'p',
    name: `Worker ${id}`,
    session: session(id, status),
    task: null,
  });

  it('puts each session on the floor in the snapshot, flags runaways, and notifies once per runaway', async () => {
    const config = defaultConfig();
    config.office.runaway = { sessionTokens: 1000, usdPerHour: 0, stallMinutes: 0 };
    const ctx = { config, logger: { warn() {} } } as never;
    const store = new Store({ daemon: {}, aoe: {}, config: {} } as never, {
      waitingDebounceSeconds: () => 0,
    });
    const office = { model: { everyone: [worker('a', 'working'), worker('b', 'idle')] } } as never;
    const at = new Date().toISOString();
    let big = 500;
    const transcripts = {
      usage: async (id: string) => ({
        entries: [
          {
            id: `${id}-1`,
            at,
            model: 'claude-opus-5-5',
            speed: null,
            usage: {
              input: id === 'a' ? big : 10,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
              cacheRead: 0,
              output: 0,
            },
          },
        ],
        lastEditAt: null,
      }),
    };
    const alerts: string[] = [];
    const w = new CostWatcher(ctx, store, office, transcripts, async (_t, body) => alerts.push(body));
    // Nobody over the limit yet; the first look arms the notifications.
    await w.tick();
    expect(Object.keys(store.costs).sort()).toEqual(['a', 'b']);
    expect(store.costs.a!.total).toEqual({ tokens: 500, usd: 0.002 });
    big = 5000;
    await w.tick();
    expect(store.costs.a!.runaway).toEqual(['tokens']);
    expect(alerts).toEqual(['Worker a: Over the token limit']);
    await w.tick();
    expect(alerts).toHaveLength(1);
  });

  it('never flags a control chat as a runaway, nor notifies for it', async () => {
    const config = defaultConfig();
    config.office.runaway = { sessionTokens: 1000, usdPerHour: 0, stallMinutes: 0 };
    const ctx = { config, logger: { warn() {} } } as never;
    const store = new Store({ daemon: {}, aoe: {}, config: {} } as never, {
      waitingDebounceSeconds: () => 0,
    });
    const office = {
      model: { everyone: [worker('lead', 'working', 'lead'), worker('a', 'working')] },
    } as never;
    const at = new Date().toISOString();
    let tokens = 10;
    const transcripts = {
      usage: async (id: string) => ({
        entries: [
          {
            id: `${id}-1`,
            at,
            model: 'claude-opus-5-5',
            speed: null,
            usage: { input: tokens, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
          },
        ],
        lastEditAt: null,
      }),
    };
    const alerts: string[] = [];
    const w = new CostWatcher(ctx, store, office, transcripts, async (_t, body) => alerts.push(body));
    await w.tick();
    tokens = 5000;
    await w.tick();
    expect(store.costs.lead!.total.tokens).toBe(5000);
    expect(store.costs.lead!.runaway).toEqual([]);
    expect(store.costs.a!.runaway).toEqual(['tokens']);
    expect(alerts).toEqual(['Worker a: Over the token limit']);
  });
});

describe('office idle timeout (OfficeWatcher)', () => {
  it('sends a worker idle past autoArchiveMinutes home, and clears the mark when it works again', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sc-office-'));
    try {
      const config = defaultConfig();
      config.office.idle = { promptMinutes: 30, autoArchiveMinutes: 60 };
      const logger = { info() {}, warn() {} };
      const ctx = { config, logger, paths: resolvePaths({ HOME: home }, home) } as never;
      const store = new Store({ daemon: {}, aoe: {}, config: {} } as never, {
        waitingDebounceSeconds: () => 0,
      });
      store.projects = [project('alpha', 'ctl')];
      store.tasks = [taskRecord('XX-0001', 'alpha', 's1'), taskRecord('XX-0002', 'alpha', 's2', { desk: 2 })];
      store.sessions = [
        view('ctl', 'idle'),
        view('s1', 'idle', { statusSince: at(-90) }),
        view('s2', 'idle', { statusSince: at(-45) }),
      ];
      store.ledgerLoaded = store.sessionsLoaded = true;
      let now = new Date(T0);
      const w = new OfficeWatcher(ctx, store, () => now);
      await w.reloadMarks();
      expect(store.office.idle).toEqual({ promptMinutes: 30, autoArchiveMinutes: 60 });
      await w.tick();
      // Idle 90 minutes: sent home; idle 45: only asked.
      expect(Object.keys(store.office.marks)).toEqual(['alpha/XX-0001']);
      expect(store.office.marks['alpha/XX-0001']?.archivedAt).toBe(now.toISOString());
      await w.tick();
      expect(w.model?.archived.map((x) => x.key)).toEqual(['alpha/XX-0001']);
      expect(w.model?.pantry.map((x) => x.key)).toEqual(['alpha/XX-0002']);
      expect(w.model?.pantry[0]?.idle.prompt).toBe(true);
      // The mark is on disk, in the office's own state.
      const file = JSON.parse(
        await readFile(join(home, '.local/share/supercharge/office/office.json'), 'utf8'),
      );
      expect(file.marks['alpha/XX-0001'].archivedAt).toBe(now.toISOString());

      // It starts working again: back on the floor, and the mark is cleared.
      now = new Date(T0 + 60_000);
      store.sessions = store.sessions.map((s) => (s.id === 's1' ? { ...s, status: 'working' } : s));
      await w.tick();
      expect(store.office.marks['alpha/XX-0001']?.archivedAt ?? null).toBeNull();
      await w.tick();
      expect(w.model?.everyone.find((x) => x.key === 'alpha/XX-0001')?.zone).toBe('desk');
      w.stop();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('office kitchen (OfficeWatcher)', () => {
  it('records the cook at the stove, the plate it serves to the pantry, and the plate being cleared', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sc-kitchen-'));
    try {
      const config = defaultConfig();
      const ctx = {
        config,
        logger: { info() {}, warn() {} },
        paths: resolvePaths({ HOME: home }, home),
      } as never;
      const store = new Store({ daemon: {}, aoe: {}, config: {} } as never, {
        waitingDebounceSeconds: () => 0,
      });
      const planned = { at: at(-30), from: null, to: 'planning' as const, by: 'worker' as const, note: null };
      store.projects = [project('alpha', 'ctl')];
      store.tasks = [
        taskRecord('XX-0001', 'alpha', 's1', {
          name: 'Ada',
          title: 'Soup',
          stage: 'planning',
          history: [planned],
        }),
        taskRecord('XX-0002', 'alpha', 's2', { name: 'Bo', desk: 2 }),
      ];
      store.sessions = [
        view('ctl', 'idle'),
        view('s1', 'working'),
        view('s2', 'idle', { statusSince: at(-20) }),
      ];
      store.ledgerLoaded = store.sessionsLoaded = true;
      let now = new Date(T0);
      const w = new OfficeWatcher(ctx, store, () => now);
      await w.reloadMarks();
      await w.tick();
      expect(w.model?.kitchen.map((x) => [x.key, x.spot.prop])).toEqual([['alpha/XX-0001', 'pot']]);

      // The plan is approved: Ada heads to her desk, and Bo, idle in the pantry, gets the plate.
      now = new Date(T0 + 1000);
      const approved = {
        ...planned,
        at: now.toISOString(),
        from: 'planning' as const,
        to: 'implementing' as const,
      };
      store.tasks = store.tasks.map((t) =>
        t.id === 'XX-0001' ? { ...t, stage: 'implementing', history: [planned, approved] } : t,
      );
      const served = await w.tick();
      const moves = served.flatMap((r) =>
        r.type === 'move' ? [[r.key, r.zone, r.prop, r.meal?.title ?? null]] : [],
      );
      expect(moves).toEqual([
        ['alpha/XX-0001', 'desk', null, null],
        ['alpha/XX-0002', 'pantry', 'plate', 'Soup'],
      ]);

      // About a minute later the plate is cleared: back to coffee.
      now = new Date(T0 + 1000 + 60_000);
      const cleared = await w.tick();
      expect(cleared.flatMap((r) => (r.type === 'move' ? [[r.key, r.prop]] : []))).toEqual([
        ['alpha/XX-0002', 'mug'],
      ]);
      w.stop();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('office weather (WeatherWatcher)', () => {
  const reading = { temperature_2m: 3.2, weather_code: 71, is_day: 0 };
  const make = () => {
    const config = defaultConfig();
    config.office.weather.enabled = true;
    const ctx = { config, logger: { warn() {}, info() {} } } as never;
    const store = new Store({ daemon: {}, aoe: {}, config: {} } as never, {
      waitingDebounceSeconds: () => 0,
    });
    let now = new Date(T0);
    let ok = true;
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (!ok) throw new Error('offline');
      return new Response(
        JSON.stringify({ current: { time: '2026-10-06T14:00', interval: 900, ...reading } }),
      );
    }) as unknown as typeof fetch;
    const w = new WeatherWatcher(ctx, store, fetchImpl, () => now, 'http://weather.test');
    return {
      w,
      store,
      config,
      urls,
      fail: () => (ok = false),
      later: (min: number) => (now = new Date(T0 + min * 60_000)),
    };
  };

  it('fetches the weather at home into the snapshot', async () => {
    const { w, store, urls } = make();
    await w.tick();
    expect(store.office.weather).toEqual({
      tempC: 3.2,
      code: 71,
      isDay: false,
      at: '2026-10-06T14:00',
      fetchedAt: new Date(T0).toISOString(),
    });
    expect(urls[0]).toBe(
      'http://weather.test/v1/forecast?latitude=59.33&longitude=18.07&current=temperature_2m%2Cweather_code%2Cis_day&timezone=Europe%2FStockholm',
    );
  });

  it('keeps the last reading through a failure for up to an hour, then shows the clock alone', async () => {
    const { w, store, fail, later } = make();
    await w.tick();
    fail();
    later(30);
    await w.tick();
    expect(store.office.weather?.tempC).toBe(3.2);
    later(61);
    await w.tick();
    expect(store.office.weather).toBeNull();
  });

  it('is off by default, and turning it off clears it', async () => {
    expect(defaultConfig().office.weather.enabled).toBe(false);
    const { w, store, config } = make();
    await w.tick();
    config.office.weather.enabled = false;
    w.reload();
    expect(store.office.weather).toBeNull();
    w.stop();
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
  it("does not notify what a control chat passes on: the worker's own item already did", async () => {
    const send = vi.fn(async (_title: string, _body: string) => true);
    const n = new Notifier(() => defaultConfig(), send);
    n.arm([]);
    await n.onNeedsYou([item('q', 'question'), item('r', 'control_relayed')]);
    expect(send.mock.calls.map((c) => c[0])).toEqual(['Question from a worker']);
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
  it('workers that start in plan mode always plan with Opus', () => {
    expect(workerModel('sonnet', 'plan')).toBe('opusplan');
    expect(workerModel('claude-sonnet-5-5', 'plan')).toBe('opusplan');
    expect(workerModel(null, 'plan')).toBe('opusplan');
    expect(workerModel('opus', 'plan')).toBe('opus');
    expect(workerModel('opusplan', 'plan')).toBe('opusplan');
    expect(workerModel('fable', 'plan')).toBe('fable');
    // Without a plan step there is nothing to plan with Opus.
    expect(workerModel('sonnet', 'auto')).toBe('sonnet');
    expect(workerModel(null, 'acceptEdits')).toBeNull();
  });
  it('adds --model / --effort only when set (session-only launch flags)', () => {
    const c = defaultConfig();
    expect(modelArgs(c)).toEqual([]);
    c.agent.model = 'opus';
    c.agent.effort = 'high';
    expect(modelArgs(c)).toEqual(['--model', 'opus', '--effort', 'high']);
  });
  it("prefers the task's own model and effort over config", () => {
    const c = defaultConfig();
    c.agent.model = 'opus';
    expect(modelArgs(c, { model: 'sonnet' })).toEqual(['--model', 'sonnet']);
    expect(modelArgs(c, { model: 'sonnet', effort: 'medium' })).toEqual([
      '--model',
      'sonnet',
      '--effort',
      'medium',
    ]);
    expect(modelArgs(c, { effort: 'auto' })).toEqual(['--model', 'opus']);
  });
  it('control chats start on Opus at xhigh, whatever the worker fallbacks say', () => {
    const c = defaultConfig();
    expect(modelArgs(c, controlPick(c))).toEqual(['--model', 'opus', '--effort', 'xhigh']);
    c.agent.model = 'sonnet';
    c.agent.effort = 'low';
    expect(modelArgs(c, controlPick(c))).toEqual(['--model', 'opus', '--effort', 'xhigh']);
    c.agent.controlEffort = 'max';
    c.agent.controlModel = 'claude-opus-5-5';
    expect(modelArgs(c, controlPick(c))).toEqual(['--model', 'claude-opus-5-5', '--effort', 'max']);
  });
  it('an empty control model means no --model, not the worker fallback', () => {
    const c = defaultConfig();
    c.agent.model = 'sonnet';
    c.agent.controlModel = '';
    expect(modelArgs(c, controlPick(c))).toEqual(['--effort', 'xhigh']);
  });
  it('a control chat refuses /model and /effort changes except back to its own model', async () => {
    const c = defaultConfig();
    const sent: string[] = [];
    const ctx = {
      config: c,
      ledger: { listProjects: async () => [{ name: 'p', controlSessionId: 'ctl' }] },
      aoeCli: { send: async (_id: string, m: string) => void sent.push(m) },
      aoe: { send: async (_id: string, m: string) => void sent.push(m) },
      paths: resolvePaths({}, tmpdir()),
    } as never;
    await expect(setSessionModel(ctx, { sessionId: 'ctl', effort: 'low', actor: 'ui' })).rejects.toThrow(
      /locked to opus at xhigh effort/,
    );
    await expect(setSessionModel(ctx, { sessionId: 'ctl', model: 'sonnet', actor: 'ui' })).rejects.toThrow(
      /locked/,
    );
    expect(sent).toEqual([]);
  });
});

describe('doctor: Claude Code knows the 5.5 models', () => {
  it('warns below 2.1.284, where opus and sonnet still mean the 5.0 models', () => {
    expect(claudeModelsCheck('2.1.236 (Claude Code)')).toMatchObject({ status: 'warn' });
    expect(claudeModelsCheck('2.1.283 (Claude Code)')).toMatchObject({ status: 'warn' });
    expect(claudeModelsCheck('2.1.284 (Claude Code)')).toMatchObject({ status: 'ok' });
    expect(claudeModelsCheck('2.2.0 (Claude Code)')).toMatchObject({ status: 'ok' });
    expect(claudeModelsCheck('3.0.1')).toMatchObject({ status: 'ok' });
    expect(claudeModelsCheck('unknown')).toBeNull();
  });
});

describe('usage --connect: Supercharge status line in your Claude Code settings', () => {
  it('keeps your other settings and your own status line, backs up, and undoes cleanly', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sc-statusline-'));
    try {
      const paths = resolvePaths({ HOME: home }, home);
      const file = join(paths.claudeDir, 'settings.json');
      const mine = { type: 'command', command: '~/bin/my-status.sh' };
      await mkdir(paths.claudeDir, { recursive: true });
      await writeFile(file, JSON.stringify({ model: 'opus', statusLine: mine }));
      const cmd = "'/usr/bin/node' '/opt/sc/dist/supercharge.mjs' statusline";
      expect(await connectStatusLine(paths, cmd)).toMatchObject({ changed: true, keptYours: true });
      const after = JSON.parse(await readFile(file, 'utf8'));
      expect(after).toEqual({ model: 'opus', statusLine: { type: 'command', command: cmd, padding: 0 } });
      expect(JSON.parse(await readFile(`${file}.supercharge-backup`, 'utf8')).statusLine).toEqual(mine);
      expect(await statusLineConnected(paths)).toBe(true);
      expect((await connectStatusLine(paths, cmd)).changed).toBe(false);
      expect((await disconnectStatusLine(paths)).changed).toBe(true);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ model: 'opus', statusLine: mine });
      expect(await statusLineConnected(paths)).toBe(false);
      expect((await disconnectStatusLine(paths)).changed).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('slash commands for the chat composer', () => {
  it("lists Claude Code's commands, your and the project's skills and commands, and plugin skills", async () => {
    const { listSlashCommands, frontmatter } = await import('../src/slash.ts');
    const { symlink } = await import('node:fs/promises');
    const home = await mkdtemp(join(tmpdir(), 'sc-slash-'));
    try {
      const paths = resolvePaths({ HOME: home }, home);
      const md = (fm: string, body = '# Title\n') => `---\n${fm}\n---\n\n${body}`;
      const put = async (file: string, text: string) => {
        await mkdir(join(file, '..'), { recursive: true });
        await writeFile(file, text);
      };
      // A personal skill linked in from elsewhere, and one hidden from the menu.
      await put(join(home, 'elsewhere/smart-plan/SKILL.md'), md('name: smart-plan\ndescription: Plan first'));
      await mkdir(join(paths.claudeDir, 'skills'), { recursive: true });
      await symlink(join(home, 'elsewhere/smart-plan'), join(paths.claudeDir, 'skills/smart-plan'));
      await put(
        join(paths.claudeDir, 'skills/quiet/SKILL.md'),
        md('name: quiet\ndescription: x\nuser-invocable: false'),
      );
      // The project: a grouped skill and a command named like a built-in.
      const repo = join(home, 'code/app');
      await put(
        join(repo, '.claude/skills/planning/plan-feature/SKILL.md'),
        md('name: plan-feature\ndescription: >\n  Plan a\n  feature'),
      );
      await put(
        join(repo, '.claude/commands/compact.md'),
        md('description: Our compact\nargument-hint: <why>'),
      );
      // A plugin installed for everyone.
      const plugin = join(paths.claudeDir, 'plugins/cache/mkt/tools/1.0');
      await put(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'tools' }));
      await put(join(plugin, 'skills/build/SKILL.md'), md('name: build\ndescription: Build it'));
      await put(
        join(paths.claudeDir, 'plugins/installed_plugins.json'),
        JSON.stringify({ version: 2, plugins: { 'tools@mkt': [{ scope: 'user', installPath: plugin }] } }),
      );

      const cmds = await listSlashCommands(paths, join(repo, 'src'));
      const find = (name: string, kind?: string) =>
        cmds.find((c) => c.name === name && (!kind || c.kind === kind));
      expect(find('clear', 'builtin')).toMatchObject({ source: 'claude' });
      expect(find('smart-plan')).toMatchObject({ kind: 'skill', source: 'user', description: 'Plan first' });
      expect(find('quiet')).toBeUndefined();
      expect(find('plan-feature')).toMatchObject({ source: 'project', description: 'Plan a feature' });
      expect(find('compact', 'command')).toMatchObject({ source: 'project', argumentHint: '<why>' });
      expect(find('compact', 'builtin')).toBeDefined();
      expect(find('tools:build')).toMatchObject({ kind: 'skill', source: 'plugin' });
      expect(frontmatter('no frontmatter')).toEqual({});
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
