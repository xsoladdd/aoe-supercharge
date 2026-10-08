import { describe, expect, it } from 'vitest';
import {
  computeNeedsYou,
  derivePrefix,
  evaluateMr,
  formatTaskId,
  normalizeAoeStatus,
  relativeTime,
  slugify,
  type SessionView,
  type TaskRecord,
} from '@aoe-supercharge/core/shared';

const base = { state: 'opened' as const, draft: false, pipeline: 'success' as const, unresolvedThreads: 0 };

describe('evaluateMr (ready rule, SPEC §11.2)', () => {
  it('is ready when open, pipeline passed and no unresolved threads', () => {
    expect(evaluateMr(base, { requireNonDraft: false })).toBe('ready');
  });
  it('is not ready with unresolved threads (CodeRabbit)', () => {
    expect(evaluateMr({ ...base, unresolvedThreads: 2 }, { requireNonDraft: false })).toBe('not_ready');
  });
  it('is not ready while the pipeline runs or fails', () => {
    expect(evaluateMr({ ...base, pipeline: 'running' }, { requireNonDraft: false })).toBe('not_ready');
    expect(evaluateMr({ ...base, pipeline: 'failed' }, { requireNonDraft: false })).toBe('not_ready');
    expect(evaluateMr({ ...base, pipeline: null }, { requireNonDraft: false })).toBe('not_ready');
  });
  it('honours readyRequiresNonDraft', () => {
    expect(evaluateMr({ ...base, draft: true }, { requireNonDraft: false })).toBe('ready');
    expect(evaluateMr({ ...base, draft: true }, { requireNonDraft: true })).toBe('not_ready');
  });
  it('reports merged and closed', () => {
    expect(evaluateMr({ ...base, state: 'merged' }, { requireNonDraft: false })).toBe('merged');
    expect(evaluateMr({ ...base, state: 'closed' }, { requireNonDraft: false })).toBe('closed');
  });
});

describe('normalizeAoeStatus covers the AoE 1.17.2 enum', () => {
  it.each([
    ['Running', 'working'],
    ['Starting', 'working'],
    ['Creating', 'working'],
    ['Waiting', 'waiting'],
    ['Idle', 'idle'],
    ['Error', 'error'],
    ['Stopped', 'stopped'],
    ['Unknown', 'unknown'],
    ['Deleting', 'unknown'],
    ['something-new', 'unknown'],
  ])('%s → %s', (raw, expected) => expect(normalizeAoeStatus(raw)).toBe(expected));
});

describe('util', () => {
  it('slugify is shell-safe', () => {
    expect(slugify('Northwind Web!  Relaunch ')).toBe('northwind-web-relaunch');
    expect(slugify('Café; rm -rf /')).toBe('cafe-rm-rf');
  });
  it('derivePrefix and formatTaskId', () => {
    expect(derivePrefix('northwind-web')).toBe('NW');
    expect(derivePrefix('apollo')).toBe('AP');
    expect(formatTaskId('NW', 8)).toBe('NW-0008');
  });
  it('relativeTime has no dashes', () => {
    const now = new Date('2026-10-05T12:00:00Z');
    expect(relativeTime('2026-10-05T11:56:00Z', now)).toBe('4m');
    expect(relativeTime('2026-10-05T10:00:00Z', now)).toBe('2h');
    expect(relativeTime(null, now)).toBe('never');
  });
});

const now = new Date('2026-10-05T12:00:00Z');
function session(p: Partial<SessionView> & { id: string }): SessionView {
  return {
    title: p.id,
    prompt: null,
    pinned: false,
    archived: false,
    locked: false,
    status: 'idle',
    rawStatus: 'Idle',
    statusSince: '2026-10-05T11:00:00Z',
    parentId: null,
    branch: null,
    projectPath: null,
    group: null,
    tool: 'claude',
    unread: false,
    lastError: null,
    createdAt: null,
    lastAccessedAt: null,
    ...p,
  };
}
function task(p: Partial<TaskRecord> & { id: string }): TaskRecord {
  return {
    schema: 1,
    rev: 1,
    project: 'northwind',
    title: 'Content entry',
    brief: '',
    branch: `sc/${p.id.toLowerCase()}`,
    baseBranch: 'main',
    worktreePath: '/tmp/x',
    aoeSessionId: `s-${p.id}`,
    parentSessionId: 'ctrl',
    stage: 'implementing',
    blockedFrom: null,
    openQuestion: null,
    plan: null,
    mr: null,
    createdAt: '2026-10-05T09:00:00Z',
    updatedAt: '2026-10-05T09:00:00Z',
    history: [],
    ...p,
  };
}

describe('computeNeedsYou', () => {
  it('collects questions, approvals, control chats and ready MRs, oldest first', () => {
    const items = computeNeedsYou({
      now,
      aoeReachable: true,
      waitingDebounceSeconds: 20,
      projects: [],
      sessions: [
        session({ id: 'ctrl', status: 'waiting', statusSince: '2026-10-05T11:50:00Z' }),
        session({
          id: 's-NW-0001',
          parentId: 'ctrl',
          status: 'waiting',
          statusSince: '2026-10-05T11:54:00Z',
        }),
        session({ id: 's-NW-0002', parentId: 'ctrl' }),
        session({ id: 's-NW-0003', parentId: 'ctrl' }),
        session({ id: 'fresh', parentId: 'ctrl', status: 'waiting', statusSince: '2026-10-05T11:59:55Z' }),
      ],
      tasks: [
        task({ id: 'NW-0001' }),
        task({
          id: 'NW-0002',
          stage: 'blocked',
          blockedFrom: 'implementing',
          openQuestion: { text: 'Final copy?', askedAt: '2026-10-05T10:00:00Z', answeredAt: null },
        }),
        task({
          id: 'NW-0003',
          stage: 'ready_for_review',
          history: [
            {
              at: '2026-10-05T11:58:00Z',
              from: 'watching_mr',
              to: 'ready_for_review',
              by: 'daemon',
              note: null,
            },
          ],
        }),
      ],
    });
    expect(items.map((i) => i.kind)).toEqual(['question', 'control_waiting', 'approval', 'mr_ready']);
    expect(items.find((i) => i.kind === 'approval')?.taskId).toBe('NW-0001');
    // No MR: the branch is what waits to be merged (SPEC §11.3).
    expect(items.find((i) => i.kind === 'mr_ready')?.detail).toMatch(/^Branch ready to merge: /);
  });
  it('a dismissed "Control chat replied" stays away until the control chat replies again', () => {
    const args = { now, aoeReachable: true, waitingDebounceSeconds: 20, projects: [], tasks: [] };
    // The control chat replied at 11:00 and you have not read it; a worker waits on you too.
    const sessions = [
      session({ id: 'ctrl', unread: true, statusSince: '2026-10-05T11:00:00Z' }),
      session({ id: 'w', parentId: 'ctrl', status: 'waiting', statusSince: '2026-10-05T11:30:00Z' }),
    ];
    const kinds = (dismissedReplies?: Record<string, string>) =>
      computeNeedsYou({ ...args, sessions, dismissedReplies }).map((i) => i.kind);
    expect(kinds()).toEqual(['control_replied', 'approval']);
    // Dismissed at 11:05: gone; nothing else changes.
    expect(kinds({ ctrl: '2026-10-05T11:05:00Z' })).toEqual(['approval']);
    // Dismissing another chat's reply does nothing here.
    expect(kinds({ other: '2026-10-05T11:05:00Z' })).toEqual(['control_replied', 'approval']);
    // A newer reply (idle again since 11:40) brings it back.
    const newer = [{ ...sessions[0]!, statusSince: '2026-10-05T11:40:00Z' }, sessions[1]!];
    expect(
      computeNeedsYou({ ...args, sessions: newer, dismissedReplies: { ctrl: '2026-10-05T11:05:00Z' } }).map(
        (i) => i.kind,
      ),
    ).toEqual(['approval', 'control_replied']);
  });
  it("lists a control chat's NEEDS YOU items, blockers marked, with the same id for the same item", () => {
    const asks = {
      at: '2026-10-05T11:40:00Z',
      items: [
        { text: 'Who owns the brand setting?', blocker: false },
        { text: 'May the tester edit the quote? Blocked until then.', blocker: true },
      ],
    };
    const args = { now, aoeReachable: true, waitingDebounceSeconds: 20, projects: [], tasks: [] };
    const items = computeNeedsYou({
      ...args,
      sessions: [session({ id: 'ctrl', asks }), session({ id: 'w', parentId: 'ctrl' })],
    });
    expect(items.map((i) => [i.kind, i.detail, i.since])).toEqual([
      ['control_needs', 'Who owns the brand setting?', asks.at],
      ['control_blocker', 'May the tester edit the quote? Blocked until then.', asks.at],
    ]);
    const again = computeNeedsYou({
      ...args,
      sessions: [
        session({ id: 'ctrl', asks: { ...asks, items: asks.items.slice(1) } }),
        session({ id: 'w', parentId: 'ctrl' }),
      ],
    });
    expect(again[0]!.id).toBe(items[1]!.id);
    // A session the control chat started belongs to its project.
    const project = { name: 'charma', controlSessionId: 'ctrl' } as Parameters<
      typeof computeNeedsYou
    >[0]['projects'][number];
    const waiting = computeNeedsYou({
      ...args,
      projects: [project],
      sessions: [
        session({ id: 'ctrl' }),
        session({ id: 'w', parentId: 'ctrl', status: 'waiting', statusSince: '2026-10-05T11:00:00Z' }),
      ],
    });
    expect(waiting.map((i) => [i.kind, i.project, i.taskId])).toEqual([['approval', 'charma', null]]);
    // Only a control chat's replies count.
    expect(computeNeedsYou({ ...args, sessions: [session({ id: 'w', asks })] })).toEqual([]);
  });
  it('flags missing sessions only when AoE is reachable', () => {
    const args = {
      now,
      waitingDebounceSeconds: 20,
      projects: [],
      sessions: [],
      tasks: [task({ id: 'NW-0009' })],
    };
    expect(computeNeedsYou({ ...args, aoeReachable: true }).map((i) => i.kind)).toEqual(['session_missing']);
    expect(computeNeedsYou({ ...args, aoeReachable: false })).toEqual([]);
  });
});

describe('computeNeedsYou: what a control chat lists about its workers (relayed)', () => {
  const project = {
    name: 'northwind',
    controlSessionId: 'ctrl',
    crew: { 'w-crew': 'Osric' },
  } as unknown as Parameters<typeof computeNeedsYou>[0]['projects'][number];
  const listed = '2026-10-05T11:40:00Z';
  const asks = (...texts: string[]) => ({
    at: listed,
    items: texts.map((text) => ({ text, blocker: /blocked/i.test(text), since: listed })),
  });
  const aldric = (p: Partial<TaskRecord> = {}) => task({ id: 'AS-0018', name: 'Aldric', ...p });
  const asking = aldric({
    stage: 'blocked',
    blockedFrom: 'implementing',
    openQuestion: { text: 'Which db?', askedAt: '2026-10-05T11:30:00Z', answeredAt: null },
  });
  const run = (tasks: TaskRecord[], sessions: SessionView[], ...texts: string[]) =>
    computeNeedsYou({
      now,
      aoeReachable: true,
      waitingDebounceSeconds: 20,
      projects: [project],
      tasks,
      sessions: [session({ id: 'ctrl', asks: asks(...texts) }), ...sessions],
    });
  const worker = (p: Partial<SessionView> = {}) => session({ id: 's-AS-0018', parentId: 'ctrl', ...p });
  const kinds = (items: ReturnType<typeof computeNeedsYou>) => items.map((i) => i.kind);

  it('passes on what a worker asked: the worker stands in line, the item points to it', () => {
    const items = run([asking], [worker()], 'Aldric (AS-0018): which db? Blocked until you say.');
    expect(kinds(items)).toEqual(['question', 'control_relayed']);
    expect(items[1]).toMatchObject({
      project: 'northwind',
      taskId: null,
      sessionId: 'ctrl',
      relay: { name: 'Aldric', label: 'Aldric (AS-0018)', taskId: 'AS-0018', sessionId: 's-AS-0018' },
    });
  });

  it('matches the task id, the worker name or its session title, and tolerates any order', () => {
    for (const text of [
      'Which db for as-0018? Blocked.',
      'Blocked: Aldric needs a db.',
      'The content-entry worker wants a db.',
    ])
      expect(kinds(run([asking], [worker({ title: 'content-entry worker' })], text))).toEqual([
        'question',
        'control_relayed',
      ]);
  });

  it('clears by itself once you answer the worker, with no new reply', () => {
    const answered = aldric({
      openQuestion: {
        text: 'Which db?',
        askedAt: '2026-10-05T11:30:00Z',
        answeredAt: '2026-10-05T11:50:00Z',
      },
    });
    const items = run(
      [answered],
      [worker({ status: 'working', statusSince: '2026-10-05T11:50:00Z' })],
      'Aldric (AS-0018): which db? Blocked until you say.',
    );
    expect(items).toEqual([]);
  });

  it('clears when you answered before the reply came in, as the worker is back at work', () => {
    const items = run(
      [aldric()],
      [worker({ status: 'working', statusSince: '2026-10-05T11:35:00Z' })],
      'Aldric (AS-0018): which db?',
    );
    expect(items).toEqual([]);
  });

  it('a stall is the control chat telling you: its own ask, until the worker moves', () => {
    const text = 'Aldric (AS-0018) stalled 30m with nothing to report. Nudge him?';
    const idle = worker({ status: 'idle', statusSince: '2026-10-05T11:00:00Z' });
    expect(kinds(run([aldric()], [idle], text))).toEqual(['control_needs']);
    const nudged = worker({ status: 'working', statusSince: '2026-10-05T11:45:00Z' });
    expect(run([aldric()], [nudged], text)).toEqual([]);
  });

  it('stays the control chat’s own ask when it names two workers, or nobody it knows', () => {
    const gareth = task({ id: 'AS-0017', name: 'Gareth', aoeSessionId: 's-AS-0017' });
    const both = run(
      [asking, gareth],
      [worker(), session({ id: 's-AS-0017', parentId: 'ctrl', status: 'waiting', statusSince: listed })],
      'Aldric and Gareth both want the db settled.',
    );
    expect(kinds(both)).toEqual(['question', 'approval', 'control_needs']);
    expect(kinds(run([asking], [worker()], 'Pick a db for the new API work.'))).toEqual([
      'question',
      'control_needs',
    ]);
    // A short session title is too common a word to go by.
    expect(kinds(run([asking], [worker({ title: 'api' })], 'Who owns the api keys?'))).toEqual([
      'question',
      'control_needs',
    ]);
  });

  it('a worker that left before the item was listed is gone: its own ask; one that left after, cleared', () => {
    const done = (at: string) =>
      aldric({
        stage: 'done',
        history: [{ at, from: 'ready_for_review', to: 'done', by: 'daemon', note: null }],
      });
    const text = 'Reuse what Aldric (AS-0018) built for the importer?';
    expect(kinds(run([done('2026-10-05T10:00:00Z')], [], text))).toEqual(['control_needs']);
    expect(run([done('2026-10-05T11:50:00Z')], [], text)).toEqual([]);
  });

  it('passes on what a crew session waits for, by its name or its AoE title', () => {
    const crew = session({
      id: 'w-crew',
      title: 'hero copy fix',
      parentId: 'ctrl',
      status: 'waiting',
      statusSince: '2026-10-05T11:30:00Z',
    });
    for (const text of ['Osric wants to push. Blocked.', 'hero copy fix wants to push. Blocked.']) {
      const items = run([], [crew], text);
      expect(kinds(items)).toEqual(['approval', 'control_relayed']);
      expect(items[1]!.relay).toEqual({ name: 'Osric', label: 'Osric', taskId: null, sessionId: 'w-crew' });
    }
  });

  it('shows again, relayed, when the worker needs you again', () => {
    const again = aldric({
      stage: 'blocked',
      openQuestion: { text: 'And the cache?', askedAt: '2026-10-05T11:55:00Z', answeredAt: null },
    });
    // Oldest first: the new question came after the list.
    expect(kinds(run([again], [worker()], 'Aldric (AS-0018): which db?'))).toEqual([
      'control_relayed',
      'question',
    ]);
  });
});
