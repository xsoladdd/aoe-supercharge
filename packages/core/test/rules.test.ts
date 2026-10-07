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
