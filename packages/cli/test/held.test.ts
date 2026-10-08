import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, readHeld, resolvePaths, writeHeld } from '@aoe-supercharge/core/node';
import { heldReason, type SessionView } from '@aoe-supercharge/core/shared';
import { project, session, task } from '../../core/test/office-fixtures.ts';
import { HeldBusyError, HeldMessages, RESTARTED_WHILE_SENDING } from '../src/daemon/held.ts';
import { Store } from '../src/daemon/store.ts';
import { WorkerWatch } from '../src/daemon/worker-watch.ts';
import { MenuOpenError, paneInterrupted } from '../src/workflow.ts';

describe('HeldMessages: messages held while Claude is busy', () => {
  let home: string;
  let store: Store;
  let ctx: {
    config: ReturnType<typeof defaultConfig>;
    logger: object;
    paths: ReturnType<typeof resolvePaths>;
  };
  let sent: { id: string; message: string; project: string | null; taskId: string | null }[];
  let fail: Error | null;
  let clock: number;

  const make = () =>
    new HeldMessages(ctx as never, store, {
      send: async (s, message, proj, taskId) => {
        if (fail) throw fail;
        sent.push({ id: s.id, message, project: proj, taskId });
        store.noteTyped(s.id, clock);
      },
      now: () => new Date(clock),
    });
  const sessions = (...list: SessionView[]) => {
    store.sessions = list;
    store.recomputeNeedsYou();
  };
  /** A pass a minute later, after an AoE poll whose list was taken then. */
  const tick = async (h: HeldMessages) => {
    clock += 60_000;
    store.sessionsListedAt = clock;
    await h.tick();
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sc-held-'));
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
    store.projects = [project('alpha', 'ctl')];
    store.tasks = [task('AS-0001', 'alpha', 's1')];
    sent = [];
    fail = null;
    clock = Date.now();
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('holds while Claude works and types it in once Claude is free, then forgets it', async () => {
    sessions(session('s1', 'working'));
    const h = make();
    const m = await h.hold('s1', 'fix the typo\n\nAttached: /u/s1/a.png');
    await tick(h);
    expect(sent).toEqual([]);
    expect(store.held.s1!.map((x) => x.id)).toEqual([m.id]);
    sessions(session('s1', 'idle'));
    await tick(h);
    expect(sent).toEqual([
      { id: 's1', message: 'fix the typo\n\nAttached: /u/s1/a.png', project: 'alpha', taskId: 'AS-0001' },
    ]);
    expect(store.held.s1).toBeUndefined();
    expect(await readHeld(ctx.paths)).toEqual({});
  });

  it('types several one at a time, each once Claude is free again, in order', async () => {
    sessions(session('s1', 'working'));
    const h = make();
    await h.hold('s1', 'one');
    await h.hold('s1', 'two');
    sessions(session('s1', 'idle'));
    await tick(h);
    expect(sent.map((s) => s.message)).toEqual(['one']);
    // The list from before the typing still says idle: not until AoE is asked again.
    await h.tick();
    expect(sent.map((s) => s.message)).toEqual(['one']);
    sessions(session('s1', 'working'));
    await tick(h);
    expect(sent.map((s) => s.message)).toEqual(['one']);
    sessions(session('s1', 'idle'));
    await tick(h);
    expect(sent.map((s) => s.message)).toEqual(['one', 'two']);
  });

  it('waits while a menu is open, and after a refusal tries again', async () => {
    sessions(session('s1', 'waiting', { prompt: { kind: 'permission' } as never }));
    const h = make();
    await h.hold('s1', 'hello');
    await tick(h);
    expect(sent).toEqual([]);
    sessions(session('s1', 'idle'));
    fail = new MenuOpenError('menu open', 'answer it');
    await tick(h);
    expect(store.held.s1![0]).toMatchObject({ state: 'held', error: null });
    fail = null;
    await tick(h);
    expect(sent.map((s) => s.message)).toEqual(['hello']);
  });

  it('never types a failed one again by itself: it and the line behind it wait for Retry', async () => {
    sessions(session('s1', 'idle'));
    const h = make();
    const a = await h.hold('s1', 'a');
    await h.hold('s1', 'b');
    fail = new Error('Could not deliver the message: timeout.');
    await tick(h);
    expect(store.held.s1!.map((x) => x.state)).toEqual(['failed', 'held']);
    expect(store.held.s1![0]!.error).toMatch(/timeout\. It may have gone in anyway/);
    fail = null;
    await tick(h);
    await tick(h);
    expect(sent).toEqual([]);
    await h.retry('s1', a.id);
    await tick(h);
    expect(sent.map((s) => s.message)).toEqual(['a']);
  });

  it('cancels, or hands back for editing, but not while typing it', async () => {
    sessions(session('s1', 'working'));
    const h = make();
    const a = await h.hold('s1', 'a');
    const b = await h.hold('s1', 'b');
    expect(await h.remove('s1', a.id)).toMatchObject({ message: 'a' });
    expect(await h.remove('s1', a.id)).toBeNull();
    expect(h.list('s1').map((x) => x.id)).toEqual([b.id]);
    await writeHeld(ctx.paths, { s1: [{ ...b, state: 'sending' }] });
    const again = new HeldMessages(ctx as never, store, { now: () => new Date(clock) });
    await again.load();
    // A restart while typing it: shown as failed, not typed again.
    expect(again.list('s1')[0]).toMatchObject({ state: 'failed', error: RESTARTED_WHILE_SENDING });
    // Held messages last across a restart.
    const h2 = make();
    await h2.load();
    await h2.hold('s1', 'c');
    expect((await readHeld(ctx.paths)).s1!.map((x) => x.message)).toEqual(['b', 'c']);
  });

  it('refuses to cancel one being typed right now', async () => {
    sessions(session('s1', 'idle'));
    let release!: () => void;
    const h = new HeldMessages(ctx as never, store, {
      send: () => new Promise<void>((r) => (release = r)),
      now: () => new Date(clock),
    });
    const a = await h.hold('s1', 'a');
    clock += 60_000;
    store.sessionsListedAt = clock;
    const pass = h.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.list('s1')[0]!.state).toBe('sending');
    await expect(h.remove('s1', a.id)).rejects.toBeInstanceOf(HeldBusyError);
    // An interrupt that could not stop Claude goes in front, but behind the one being typed.
    const front = await h.hold('s1', 'urgent', { front: true });
    expect(h.list('s1').map((x) => x.message)).toEqual(['a', 'urgent']);
    release();
    await pass;
    expect(h.list('s1').map((x) => x.id)).toEqual([front.id]);
  });

  it("doesn't beat a new worker's first message", async () => {
    store.tasks = [task('AS-0001', 'alpha', 's1', { stage: 'planning', kickoffAt: null })];
    sessions(session('s1', 'idle'));
    const h = make();
    await h.hold('s1', 'hi');
    await tick(h);
    expect(sent).toEqual([]);
    store.tasks = [
      task('AS-0001', 'alpha', 's1', {
        kickoffAt: new Date(clock).toISOString(),
        kickoffSeenAt: new Date(clock).toISOString(),
      }),
    ];
    await tick(h);
    expect(sent.map((s) => s.message)).toEqual(['hi']);
  });

  it('waits while the session is archived, rather than bringing it back', async () => {
    sessions(session('s1', 'idle', { archived: true }));
    const h = make();
    await h.hold('s1', 'later');
    await tick(h);
    expect(sent).toEqual([]);
    sessions(session('s1', 'idle'));
    await tick(h);
    expect(sent.map((s) => s.message)).toEqual(['later']);
  });

  it('fails a held /clear on a locked session', async () => {
    sessions(session('s1', 'idle', { locked: true }));
    const h = make();
    await h.hold('s1', '/clear');
    await tick(h);
    expect(sent).toEqual([]);
    expect(h.list('s1')[0]).toMatchObject({ state: 'failed', error: expect.stringMatching(/locked/) });
  });

  it('drops the messages of a session gone from AoE for ten minutes', async () => {
    sessions(session('s1', 'working'));
    const h = make();
    await h.hold('s1', 'hello');
    sessions();
    await tick(h);
    expect(h.has('s1')).toBe(true);
    clock += 9 * 60_000;
    await tick(h);
    expect(h.has('s1')).toBe(false);
  });

  it('does nothing while AoE cannot be reached', async () => {
    sessions(session('s1', 'idle'));
    store.health.aoe.state = 'unreachable' as never;
    const h = make();
    await h.hold('s1', 'hello');
    await tick(h);
    expect(sent).toEqual([]);
  });

  it('shares the typing gate with the worker watch: one of them types, the other waits for AoE', async () => {
    store.projects = [project('alpha', 'ctl')];
    store.tasks = [task('AS-0001', 'alpha', 's1')];
    sessions(session('ctl', 'idle', { title: 'alpha control' }), session('s1', 'working'));
    const watchSent: string[] = [];
    const watch = new WorkerWatch(
      ctx as never,
      store,
      { read: async () => ({ messages: [] }) as never },
      {
        send: async (id, message) => {
          watchSent.push(message);
          store.noteTyped(id, clock);
        },
        capture: async () => 'pane',
        now: () => new Date(clock),
      },
    );
    const h = make();
    clock += 60_000;
    store.sessionsListedAt = clock;
    await watch.tick();
    await h.hold('ctl', 'from you');
    sessions(session('ctl', 'idle', { title: 'alpha control' }), session('s1', 'error'));
    clock += 60_000;
    store.sessionsListedAt = clock;
    await watch.tick();
    expect(watchSent).toHaveLength(1);
    // Same poll: the control chat's idle is from before the notice went in.
    await h.tick();
    expect(sent).toEqual([]);
    await tick(h);
    expect(sent.map((s) => s.message)).toEqual(['from you']);
  });
});

describe('heldReason', () => {
  const m = { id: 'a', sessionId: 's', message: 'x', heldAt: '', state: 'held' as const, error: null };
  it('says why it waits', () => {
    expect(heldReason(m, 0, { status: 'working' })).toBe('Held. Sends when Claude is done');
    expect(heldReason(m, 0, { status: 'waiting', prompt: {} })).toBe(
      "Held. Sends after you answer Claude's menu",
    );
    expect(heldReason(m, 1, { status: 'working' })).toBe('Held. Waiting its turn');
    expect(heldReason({ ...m, state: 'sending' }, 0, null)).toBe('Sending…');
    expect(heldReason({ ...m, state: 'failed', error: 'boom' }, 0, null)).toBe('boom');
  });
});

describe('Store.claimTyping: one sender at a time, and only on a status read after the last typing', () => {
  it('claims, refuses a second claim until a newer list, and releases when nothing was typed', () => {
    const store = new Store({ daemon: {}, aoe: { state: 'ok' }, config: {} } as never, {
      waitingDebounceSeconds: () => 20,
    });
    const release = store.claimTyping('s1', 1_000);
    expect(release).not.toBeNull();
    expect(store.claimTyping('s1', 1_100)).toBeNull();
    store.setSessions([], 1_500);
    expect(store.claimTyping('s1', 1_600)).toBeNull();
    store.setSessions([], 2_500);
    const second = store.claimTyping('s1', 2_600)!;
    second();
    expect(store.claimTyping('s1', 2_700)).not.toBeNull();
    // An older list never moves the time back.
    store.setSessions([], 100);
    expect(store.sessionsListedAt).toBe(2_500);
  });
});

describe('paneInterrupted: Claude stopped by Escape', () => {
  const box = ['', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏵⏵ auto mode on (shift+tab to cycle)'];
  it('needs the banner and no spinner', () => {
    expect(
      paneInterrupted(
        ['⏺ Working on it', '  ⎿  Interrupted · What should Claude do instead?', ...box].join('\n'),
      ),
    ).toBe(true);
    expect(
      paneInterrupted(['⏺ Working on it', '✽ Clauding… (4m 42s · ↓ 23.9k tokens)', ...box].join('\n')),
    ).toBe(false);
    expect(
      paneInterrupted(
        ['  ⎿  Interrupted · What should Claude do instead?', '❯ next', '✻ Thinking…', ...box].join('\n'),
      ),
    ).toBe(false);
    expect(paneInterrupted(['⏺ Done.', '✻ Cooked for 1m 58s', ...box].join('\n'))).toBe(false);
  });
});
