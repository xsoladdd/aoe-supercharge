import { describe, expect, it } from 'vitest';
import {
  computeNeedsYou,
  countBusyGeneral,
  generalSessionIds,
  type GeneralRecord,
} from '@aoe-supercharge/core/shared';
import { session } from './office-fixtures.ts';

const general: GeneralRecord = {
  schema: 1,
  controlSessionId: 'gctl',
  sessions: { chat1: 'Wilfred', w1: 'Osric' },
};

describe('General sessions', () => {
  it('are the recorded ones and anything the General control chat started, never the control chat itself', () => {
    const ids = generalSessionIds(general, [
      { id: 'gctl', parentId: null },
      { id: 'w2', parentId: 'gctl' },
      { id: 'other', parentId: 'elsewhere' },
    ]);
    expect([...ids].sort()).toEqual(['chat1', 'w1', 'w2']);
  });

  it('count toward the cap only while busy, or while their first message waits', () => {
    const status: Record<string, string> = { a: 'working', b: 'waiting', c: 'idle', d: 'idle', e: 'stopped' };
    const held = new Set(['d', 'e']);
    expect(
      countBusyGeneral(
        ['a', 'b', 'c', 'd', 'e', 'gone'],
        (id) => status[id] ?? null,
        (id) => held.has(id),
      ),
    ).toBe(3);
  });

  it('the General control chat is a control chat from the start, with no project', () => {
    const items = computeNeedsYou({
      now: new Date(),
      aoeReachable: true,
      waitingDebounceSeconds: 0,
      projects: [],
      tasks: [],
      general,
      sessions: [
        session('gctl', 'waiting', { title: 'General control', statusSince: '2026-10-05T11:00:00Z' }),
      ],
    });
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'control_waiting',
        project: null,
        sessionId: 'gctl',
        title: 'General control chat',
      }),
    ]);
  });

  it("relays the General control chat's NEEDS YOU item about a worker by its name", () => {
    const items = computeNeedsYou({
      now: new Date(),
      aoeReachable: true,
      waitingDebounceSeconds: 0,
      projects: [],
      tasks: [],
      general,
      sessions: [
        session('gctl', 'idle', {
          title: 'General control',
          asks: {
            at: '2026-10-05T11:00:00Z',
            items: [{ text: 'Osric: wants a folder to write to. Blocked.', blocker: true }],
          },
        }),
        session('w1', 'waiting', {
          title: 'Nightly report',
          parentId: 'gctl',
          statusSince: '2026-10-05T11:00:00Z',
        }),
      ],
    });
    expect(items.find((i) => i.kind === 'control_relayed')).toMatchObject({
      title: 'Osric via the General control chat',
      relay: { name: 'Osric', sessionId: 'w1' },
    });
  });
});
