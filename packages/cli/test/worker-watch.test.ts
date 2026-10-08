import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, readWatchLog, resolvePaths, watchCaptureDir } from '@aoe-supercharge/core/node';
import { parseWatchLine, type ChatMessage, type SessionView } from '@aoe-supercharge/core/shared';
import { project, session, task } from '../../core/test/office-fixtures.ts';
import { Store } from '../src/daemon/store.ts';
import { WorkerWatch } from '../src/daemon/worker-watch.ts';
import { MenuOpenError } from '../src/workflow.ts';

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

describe('WorkerWatch: notices for a control chat', () => {
  let home: string;
  let store: Store;
  let ctx: {
    config: ReturnType<typeof defaultConfig>;
    logger: object;
    paths: ReturnType<typeof resolvePaths>;
  };
  let sent: { id: string; message: string }[];
  let refuse: boolean;
  let clock: number;
  let replies: Record<string, ChatMessage[]>;
  let footer: string;
  let captures: string[];

  const make = () =>
    new WorkerWatch(
      ctx as never,
      store,
      { read: async (id: string) => ({ messages: replies[id] ?? [] }) as never },
      {
        send: async (id, message) => {
          if (refuse) throw new MenuOpenError('menu open', 'answer it');
          sent.push({ id, message });
        },
        capture: async (id) => {
          captures.push(id);
          return `pane of ${id}\n❯ \n  Sonnet 5.5\n  ${footer}\n`;
        },
        now: () => new Date(clock),
      },
    );
  const sessions = (...list: SessionView[]) => {
    store.sessions = list;
    store.recomputeNeedsYou();
  };
  /** One pass, a minute later than the last, after a fresh AoE poll. */
  const tick = async (w: WorkerWatch) => {
    clock += 60_000;
    store.health.aoe.lastPollAt = new Date(clock).toISOString();
    await w.tick();
  };
  const ctl = (status: SessionView['status'] = 'idle', extra: Partial<SessionView> = {}) =>
    session('ctl', status, { title: 'alpha control', statusSince: ago(5), ...extra });
  const s1 = (status: SessionView['status'], extra: Partial<SessionView> = {}) =>
    session('s1', status, { title: 'AS-0001 Do a thing', statusSince: ago(1), ...extra });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sc-watch-'));
    ctx = {
      config: defaultConfig(),
      logger: { warn() {}, info() {} },
      paths: resolvePaths({ HOME: home }, home),
    };
    store = new Store({ daemon: {}, aoe: { state: 'ok' }, config: {} } as never, {
      waitingDebounceSeconds: () => 20,
    });
    store.sessionsLoaded = true;
    store.ledgerLoaded = true;
    store.projects = [{ ...project('alpha', 'ctl'), crew: { crew1: 'Norbert' } }];
    store.tasks = [task('AS-0001', 'alpha', 's1')];
    sent = [];
    refuse = false;
    clock = Date.now();
    replies = {};
    footer = '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents';
    captures = [];
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('takes what is there at the start as told, then tells each new event once', async () => {
    sessions(ctl(), s1('error'));
    const w = make();
    await tick(w);
    expect(sent).toEqual([]);
    sessions(ctl(), s1('working'));
    await tick(w);
    sessions(ctl(), s1('error', { lastError: 'tmux died' }));
    await tick(w);
    await tick(w);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.id).toBe('ctl');
    const n = parseWatchLine(sent[0]!.message)!;
    expect(n).toMatchObject({
      worker: 'AS-0001 Do a thing',
      status: 'error',
      kind: 'error',
      name: 'Gareth',
      project: 'alpha',
      task: 'AS-0001',
      session: 's1',
      detail: 'tmux died',
    });
    // The control chat can read what the worker's pane showed.
    expect(n.log!.startsWith(watchCaptureDir(ctx.paths as never))).toBe(true);
    expect(await readFile(n.log!, 'utf8')).toContain('pane of s1');
    const log = await readWatchLog(ctx.paths as never, 'alpha');
    expect(log.map((e) => [e.kind, e.state])).toEqual([['error', 'sent']]);
    expect(store.watch.alpha).toMatchObject({ enabled: true, watching: 1, pending: 0, held: null });
  });

  it('holds notices while the control chat is busy and sends them together once it is free', async () => {
    sessions(
      ctl('working'),
      s1('working'),
      session('crew1', 'working', { title: 'fix-1989-ci', parentId: 'ctl' }),
    );
    const w = make();
    await tick(w);
    replies.crew1 = [
      {
        id: 'm1',
        role: 'assistant',
        at: ago(1),
        blocks: [{ kind: 'text', text: 'QUESTION: staging or prod?' }],
      },
    ];
    sessions(
      ctl('working'),
      s1('error'),
      session('crew1', 'idle', { title: 'fix-1989-ci', parentId: 'ctl', statusSince: ago(1) }),
    );
    await tick(w);
    expect(sent).toEqual([]);
    expect(store.watch.alpha!.pending).toBe(2);
    sessions(ctl('idle'), s1('error'), session('crew1', 'idle', { title: 'fix-1989-ci', parentId: 'ctl' }));
    await tick(w);
    expect(sent).toHaveLength(1);
    const lines = sent[0]!.message.split('\n').map((l) => parseWatchLine(l)!);
    expect(lines.map((l) => [l.worker, l.kind, l.detail])).toEqual([
      ['AS-0001 Do a thing', 'error', 'AoE reports an error for this session'],
      ['fix-1989-ci', 'question', 'staging or prod?'],
    ]);
    expect(lines[1]).toMatchObject({ name: 'Norbert', task: null, session: 'crew1' });
  });

  it('types no more until AoE has been polled since the last send', async () => {
    const crew = (status: SessionView['status']) =>
      session('crew1', status, { parentId: 'ctl', statusSince: ago(1) });
    sessions(ctl(), s1('working'), crew('working'));
    const w = make();
    await tick(w);
    sessions(ctl(), s1('error'), crew('working'));
    await tick(w);
    expect(sent).toHaveLength(1);
    sessions(ctl(), s1('error'), crew('error'));
    clock += 60_000;
    await w.tick();
    expect(sent).toHaveLength(1);
    await tick(w);
    expect(sent.map((x) => parseWatchLine(x.message)!.session)).toEqual(['s1', 'crew1']);
  });

  it('tries again after a menu was open in the control chat', async () => {
    sessions(ctl(), s1('working'));
    const w = make();
    await tick(w);
    sessions(ctl(), s1('error'));
    refuse = true;
    await tick(w);
    expect(store.watch.alpha!.pending).toBe(1);
    refuse = false;
    await tick(w);
    expect(sent).toHaveLength(1);
    expect(store.watch.alpha!.pending).toBe(0);
  });

  it('remembers what it told across a restart', async () => {
    sessions(ctl(), s1('working'));
    await tick(make());
    sessions(ctl(), s1('idle', { statusSince: ago(20) }));
    await tick(make());
    expect(sent.map((s) => parseWatchLine(s.message)!.kind)).toEqual(['stalled']);
    // A new daemon: the idle time restarts, the stall stands.
    sessions(ctl(), s1('idle', { statusSince: ago(16) }));
    await tick(make());
    expect(sent).toHaveLength(1);
  });

  it('does not call a worker stalled while its background shells run, then once after they end', async () => {
    footer = '⏵⏵ auto mode on · 2 shells · ← for agents';
    sessions(ctl(), s1('working'));
    const w = make();
    await tick(w);
    sessions(ctl(), s1('idle', { statusSince: ago(20) }));
    await tick(w);
    await tick(w);
    expect(sent).toEqual([]);
    // The shells end: 15 minutes of idling from then on is a stall, not before.
    footer = '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents';
    clock += 10 * 60_000;
    await tick(w);
    expect(sent).toEqual([]);
    clock += 6 * 60_000;
    await tick(w);
    expect(sent.map((x) => parseWatchLine(x.message)!.kind)).toEqual(['stalled']);
    // Told once: its pane isn't read for stalls again.
    const reads = captures.length;
    await tick(w);
    await tick(w);
    expect(sent).toHaveLength(1);
    expect(captures).toHaveLength(reads);
  });

  it('reads panes only for workers that would be called stalled', async () => {
    sessions(ctl(), s1('working'));
    const w = make();
    await tick(w);
    sessions(ctl(), s1('idle', { statusSince: ago(5) }));
    await tick(w);
    expect(captures).toEqual([]);
  });

  it('tells nothing for a project with the watch off, and drops what was waiting', async () => {
    sessions(ctl('working'), s1('working'));
    const w = make();
    await tick(w);
    sessions(ctl('working'), s1('error'));
    await tick(w);
    expect(store.watch.alpha!.pending).toBe(1);
    ctx.config.projects.alpha = { watch: false };
    sessions(ctl('idle'), s1('error'));
    await tick(w);
    expect(sent).toEqual([]);
    expect(store.watch.alpha).toMatchObject({ enabled: false, pending: 0 });
    expect((await readWatchLog(ctx.paths as never, 'alpha')).map((e) => e.state)).toEqual(['dropped']);
    // Turned back on: what is waiting then is taken as told.
    ctx.config.projects.alpha = { watch: true };
    await tick(w);
    expect(sent).toEqual([]);
  });

  it('says why notices cannot reach an archived control chat', async () => {
    sessions(ctl('idle', { archived: true }), s1('working'));
    const w = make();
    await tick(w);
    expect(store.watch.alpha!.held).toBe('The control chat is archived');
    expect(existsSync(join(home, '.local/state/supercharge/watch/book.json'))).toBe(true);
  });
});
