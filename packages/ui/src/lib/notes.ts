import type { NoteRecord } from '@aoe-supercharge/core/shared';
import { sendJson } from './api';
import type { BoardLine } from './office/scene';

/** Notes and todos (SPEC §14.6). Writes go to the daemon; the board updates from its live events. */

export const scopeLabel = (project: string | null) => project ?? 'Global';

export interface NoteGroup {
  project: string | null;
  todos: NoteRecord[];
  notes: NoteRecord[];
}

/**
 * Per project, in the sidebar's order, then the global ones. Open todos come before ticked ones;
 * otherwise oldest first, as they were written. Projects with nothing are left out unless asked for.
 */
export function groupNotes(all: NoteRecord[], projects: string[], keepEmpty = false): NoteGroup[] {
  const scopes: (string | null)[] = [...projects, null];
  for (const n of all) if (n.project !== null && !scopes.includes(n.project)) scopes.splice(-1, 0, n.project);
  return scopes
    .map((project) => {
      const mine = all.filter((n) => n.project === project);
      return {
        project,
        todos: mine.filter((n) => n.kind === 'todo').sort((a, b) => Number(a.done) - Number(b.done)),
        notes: mine.filter((n) => n.kind === 'note'),
      };
    })
    .filter((g) => keepEmpty || g.todos.length || g.notes.length);
}

export const addNote = (kind: NoteRecord['kind'], text: string, project: string | null) =>
  sendJson<{ note: NoteRecord }>('POST', '/api/notes', { kind, text, project });

export const setDone = (id: string, done: boolean) => sendJson('PATCH', `/api/notes/${id}`, { done });

export const setArchived = (id: string, archived: boolean) =>
  sendJson('PATCH', `/api/notes/${id}`, { archived });

/**
 * What the whiteboard on the office floor says: the todos still to do, then the ticked ones, then the
 * notes, newest first. One line each; the card has the rest.
 */
export function boardLines(all: NoteRecord[]): BoardLine[] {
  const line = (n: NoteRecord) => n.text.split('\n')[0]!.trim();
  const todos = all.filter((n) => n.kind === 'todo');
  const open = todos.filter((n) => !n.done);
  const notes = all.filter((n) => n.kind === 'note').reverse();
  if (!all.length)
    return [
      { kind: 'head', text: 'Nothing on the board yet' },
      { kind: 'note', text: 'Add a todo or a note: click here' },
    ];
  const lines: BoardLine[] = [];
  if (todos.length) {
    lines.push({ kind: 'head', text: `To do (${open.length})` });
    for (const n of open) lines.push({ kind: 'todo', text: line(n) });
    for (const n of todos.filter((t) => t.done)) lines.push({ kind: 'todo', text: line(n), done: true });
  }
  if (notes.length) {
    lines.push({ kind: 'head', text: 'Notes' });
    for (const n of notes) lines.push({ kind: 'note', text: line(n) });
  }
  return lines;
}
