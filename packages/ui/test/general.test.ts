import { describe, expect, it } from 'vitest';
import type { Snapshot } from '@aoe-supercharge/core/shared';
import { session } from '../../core/test/office-fixtures.ts';
import { generalView, unmanagedGroups } from '../src/lib/derive.ts';

describe('the General section', () => {
  const snap = {
    projects: [],
    tasks: [],
    general: { schema: 1, controlSessionId: 'gctl', sessions: { chat1: 'Wilfred' } },
    sessions: [
      session('gctl', 'idle'),
      session('w1', 'working', { parentId: 'gctl' }),
      session('chat1', 'idle'),
      session('old', 'idle', { archived: true, parentId: 'gctl' }),
      session('loose', 'idle'),
    ],
  } as unknown as Snapshot;

  it('lists the General control chat, and its chats and workers that are not archived', () => {
    const g = generalView(snap);
    expect(g.control?.id).toBe('gctl');
    expect(g.sessions.map((s) => s.id).sort()).toEqual(['chat1', 'w1']);
  });

  it('takes General sessions out of "Other AoE sessions"', () => {
    expect(unmanagedGroups(snap).flatMap((g) => [g.parent?.id, ...g.children.map((c) => c.id)])).toEqual([
      undefined,
      'loose',
    ]);
  });
});
