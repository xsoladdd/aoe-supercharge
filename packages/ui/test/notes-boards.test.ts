import { describe, expect, it } from 'vitest';
import type { NoteRecord } from '@aoe-supercharge/core/shared';
import { allBoardLines, splitBoards } from '../src/lib/notes.ts';

const note = (id: string, project: string | null, kind: NoteRecord['kind'], text: string, done = false) =>
  ({ id, project, kind, text, done }) as NoteRecord;

const all = [
  note('a1', 'web', 'todo', 'Confirm the cutover'),
  note('a2', 'web', 'todo', 'Book a QA pass', true),
  note('a3', 'web', 'note', 'Staging is read-only'),
  note('b1', 'api', 'todo', 'Rotate the key'),
  note('g1', null, 'note', 'Renew the token'),
  note('g2', null, 'todo', 'Order cables'),
  note('x1', 'gone', 'todo', 'A project with no room'),
];

describe('whiteboards: global versus per project', () => {
  it('keeps only the global notes by the door, and each project’s in its own room', () => {
    const split = splitBoards(all, ['web', 'api']);
    const ids = (k: string) => split[k]!.map((n) => n.id);
    expect(ids('board:web')).toEqual(['a1', 'a2', 'a3']);
    expect(ids('board:api')).toEqual(['b1']);
    expect(ids('board')).toEqual(expect.arrayContaining(['g1', 'g2']));
    expect(ids('board').some((i) => i.startsWith('a') || i === 'b1')).toBe(false);
  });

  it('puts a project with no room on the door board, so nothing disappears', () => {
    expect(splitBoards(all, ['web', 'api'])['board']!.map((n) => n.id)).toContain('x1');
  });

  it('gives every room a board, empty when it has nothing', () => {
    const split = splitBoards([], ['web']);
    expect(Object.keys(split).sort()).toEqual(['board', 'board:web']);
    const lines = allBoardLines([], ['web']);
    expect(lines['board:web']).toEqual([]);
    // The door board says so, as it always has.
    expect(lines['board']![0]).toEqual({ kind: 'head', text: 'Nothing on the board yet' });
  });

  it('writes a room board as the door board is written: open todos, ticked ones struck, then notes', () => {
    const lines = allBoardLines(all, ['web', 'api'])['board:web']!;
    expect(lines).toEqual([
      { kind: 'head', text: 'To do (1)' },
      { kind: 'todo', text: 'Confirm the cutover' },
      { kind: 'todo', text: 'Book a QA pass', done: true },
      { kind: 'head', text: 'Notes' },
      { kind: 'note', text: 'Staging is read-only' },
    ]);
  });
});
