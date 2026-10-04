import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyStage,
  checkCompat,
  ConfigValidationError,
  ensureToken,
  Ledger,
  loadConfig,
  parseAoeVersion,
  patchConfig,
  resolvePaths,
  setConfigValue,
  writeFileAtomic,
  type Paths,
} from '@aoe-supercharge/core/node';
import type { TaskRecord } from '@aoe-supercharge/core/shared';

let paths: Paths;
beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), 'sc-core-'));
  paths = resolvePaths({ HOME: home }, home);
});

describe('paths', () => {
  it('follows XDG and respects overrides', () => {
    const p = resolvePaths({ HOME: '/h', XDG_CONFIG_HOME: '/c', CLAUDE_CONFIG_DIR: '/cl' }, '/h');
    expect(p.configFile).toBe('/c/supercharge/config.toml');
    expect(p.projectsDir).toBe('/h/.local/share/supercharge/projects');
    expect(p.logFile).toBe('/h/.local/state/supercharge/logs/daemon.log');
    expect(p.claudeSkillsDir).toBe('/cl/skills');
  });
});

describe('config', () => {
  it('defaults when missing', async () => {
    const c = await loadConfig(paths);
    expect(c.exists).toBe(false);
    expect(c.config.server.port).toBe(4280);
    expect(c.config.mr.gitlab.hosts).toEqual(['gitlab.com']);
    expect(c.config.remoteControl.enabled).toBe(false);
  });
  it('patches while preserving comments, and reports restart-required keys', async () => {
    const r = await patchConfig(paths, { poll: { mr: 30 }, server: { port: 4999 } });
    expect(r.changedKeys.sort()).toEqual(['poll.mr', 'server.port']);
    expect(r.restartRequired).toEqual(['server.port']);
    const text = await readFile(paths.configFile, 'utf8');
    expect(text).toMatch(/# Agent of Empires: Supercharge configuration/);
    expect(text).toMatch(/Add self-hosted GitLab hosts here/);
    expect((await loadConfig(paths)).config.poll.mr).toBe(30);
  });
  it('rejects invalid values with readable paths', async () => {
    await expect(patchConfig(paths, { server: { port: 80 } })).rejects.toBeInstanceOf(ConfigValidationError);
    await expect(patchConfig(paths, { poll: { mrr: 3 } })).rejects.toThrow(/poll/);
    await expect(patchConfig(paths, { agent: { extraArgs: ['--x; rm -rf /'] } })).rejects.toThrow(/shell/);
  });
  it('config set coerces numbers, booleans, lists and strings', async () => {
    await setConfigValue(paths, 'poll.mr', '45');
    await setConfigValue(paths, 'remoteControl.enabled', 'true');
    await setConfigValue(paths, 'mr.gitlab.hosts', 'gitlab.com,gitlab.example.com');
    await setConfigValue(paths, 'tasks.branchPrefix', 'feature/');
    const c = (await loadConfig(paths)).config;
    expect(c.poll.mr).toBe(45);
    expect(c.remoteControl.enabled).toBe(true);
    expect(c.mr.gitlab.hosts).toEqual(['gitlab.com', 'gitlab.example.com']);
    expect(c.tasks.branchPrefix).toBe('feature/');
  });
  it('reports a TOML syntax error instead of throwing', async () => {
    await writeFileAtomic(paths.configFile, '[server\nport = ');
    const c = await loadConfig(paths);
    expect(c.errors[0]).toMatch(/config.toml/);
  });
});

describe('token', () => {
  it('creates a 0600 token once and reuses it', async () => {
    const a = await ensureToken(paths);
    const b = await ensureToken(paths);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect((await stat(paths.tokenFile)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.configDir)).mode & 0o777).toBe(0o700);
  });
});

describe('compat', () => {
  const shipped = { aoe: { range: '>=1.17.2 <1.18.0', tested: ['1.17.2'] } };
  it('parses aoe --version', () => expect(parseAoeVersion('aoe 1.17.2\n')).toBe('1.17.2'));
  it('accepts in-range and locally verified versions only', () => {
    expect(checkCompat('1.17.2', shipped, { verified: [] }).ok).toBe(true);
    const out = checkCompat('1.18.0', shipped, { verified: [] });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/outside the tested range/);
    expect(out.fix).toMatch(/supercharge aoe upgrade/);
    expect(checkCompat('1.18.0', shipped, { verified: [{ version: '1.18.0', verifiedAt: 'x' }] }).ok).toBe(
      true,
    );
    expect(checkCompat(null, shipped, { verified: [] }).ok).toBe(false);
  });
});

function newTask(id: string): TaskRecord {
  const at = new Date().toISOString();
  return {
    schema: 1,
    rev: 0,
    id,
    project: 'demo',
    title: 'T',
    brief: '',
    branch: `sc/${id.toLowerCase()}`,
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    aoeSessionId: 'abc',
    parentSessionId: 'ctrl',
    stage: 'planning',
    blockedFrom: null,
    openQuestion: null,
    plan: null,
    mr: null,
    createdAt: at,
    updatedAt: at,
    history: [],
  };
}

describe('ledger', () => {
  async function setup() {
    const ledger = new Ledger(paths);
    const at = new Date().toISOString();
    await ledger.saveProject({
      schema: 1,
      name: 'demo',
      repoPath: '/repo',
      remoteUrl: null,
      controlSessionId: 'ctrl',
      idPrefix: 'DE',
      nextTaskSeq: 1,
      installMode: 'user',
      createdAt: at,
      updatedAt: at,
    });
    return ledger;
  }

  it('allocates unique sequential ids under contention', async () => {
    const ledger = await setup();
    const ids = await Promise.all(Array.from({ length: 12 }, () => ledger.allocateTaskId('demo')));
    expect(new Set(ids).size).toBe(12);
    expect(ids.sort()[0]).toBe('DE-0001');
  });

  it('20 parallel writers never lose an update', async () => {
    const ledger = await setup();
    await ledger.createTask(newTask('DE-0001'));
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        ledger.updateTask('demo', 'DE-0001', (t) => ({ ...t, brief: `${t.brief}${i},` })),
      ),
    );
    const t = await ledger.getTask('demo', 'DE-0001');
    expect(t?.rev).toBe(20);
    expect(t?.brief.split(',').filter(Boolean)).toHaveLength(20);
  });

  it('a crashed temp file never replaces the last good record', async () => {
    const ledger = await setup();
    await ledger.createTask(newTask('DE-0002'));
    await writeFile(`${ledger.taskFile('demo', 'DE-0002')}.999.dead.tmp`, '{"torn":');
    expect((await ledger.getTask('demo', 'DE-0002'))?.id).toBe('DE-0002');
  });

  it('applyStage tracks blockedFrom and answers the question on unblock', () => {
    let t = newTask('DE-0003');
    t = applyStage(t, 'implementing', 'worker', null);
    t = {
      ...applyStage(t, 'blocked', 'worker', 'q?'),
      openQuestion: { text: 'q?', askedAt: 'x', answeredAt: null },
    };
    expect(t.blockedFrom).toBe('implementing');
    t = applyStage(t, 'implementing', 'worker', null);
    expect(t.blockedFrom).toBeNull();
    expect(t.openQuestion?.answeredAt).not.toBeNull();
    expect(t.history.map((h) => h.to)).toEqual(['implementing', 'blocked', 'implementing']);
  });

  it('finds tasks by branch and session', async () => {
    const ledger = await setup();
    await ledger.createTask(newTask('DE-0004'));
    expect((await ledger.findTaskByBranch('demo', 'sc/de-0004'))?.id).toBe('DE-0004');
    expect((await ledger.findTaskBySession('abc'))?.id).toBe('DE-0004');
    expect(await ledger.findProjectByRepo('/repo')).not.toBeNull();
  });
});
