import { randomInt } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { NoteRecord } from '../shared/types.ts';
import { readJson, withLock, writeJsonAtomic } from './fs.ts';
import type { Paths } from './paths.ts';

interface NotesFile {
  schema: 1;
  notes: NoteRecord[];
}

/** No 0/o, 1/l/i: an id is read off a whiteboard and typed. */
const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const GLOBAL = '_global';
export const MAX_NOTE = 4000;

export interface NewNote {
  project: string | null;
  kind: NoteRecord['kind'];
  text: string;
  by: NoteRecord['by'];
  sessionId?: string | null;
}

export type NoteChange = Partial<Pick<NoteRecord, 'text' | 'done' | 'archivedAt'>>;

/**
 * Notes and todos (SPEC §14.6), one file per project plus one for global notes, under the data
 * directory. Every write is atomic and under one lock, so the CLI (Claude's /note) and the dashboard
 * never lose each other's changes. Project names are slugs, so `_global` can't clash with one.
 */
export class Notes {
  constructor(readonly paths: Paths) {}

  private file(project: string | null) {
    return join(this.paths.notesDir, `${project ?? GLOBAL}.json`);
  }

  private async read(project: string | null): Promise<NoteRecord[]> {
    return (await readJson<NotesFile>(this.file(project)))?.notes ?? [];
  }

  /** Every note, archived ones too, oldest first. */
  async all(): Promise<NoteRecord[]> {
    let names: string[] = [];
    try {
      names = (await readdir(this.paths.notesDir)).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const lists = await Promise.all(
      names.map((n) => this.read(n === `${GLOBAL}.json` ? null : n.slice(0, -'.json'.length))),
    );
    return lists.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async add(n: NewNote, now = new Date()): Promise<NoteRecord> {
    const text = n.text.trim();
    if (!text) throw new Error('A note needs some text.');
    if (text.length > MAX_NOTE) throw new Error(`A note can be at most ${MAX_NOTE} characters.`);
    return withLock(this.paths.notesDir, async () => {
      const taken = new Set((await this.all()).map((x) => x.id));
      let id = '';
      do id = Array.from({ length: 4 }, () => ID_CHARS[randomInt(ID_CHARS.length)]).join('');
      while (taken.has(id));
      const at = now.toISOString();
      const note: NoteRecord = {
        id,
        project: n.project,
        kind: n.kind,
        text,
        done: false,
        doneAt: null,
        archivedAt: null,
        by: n.by,
        sessionId: n.sessionId ?? null,
        createdAt: at,
        updatedAt: at,
      };
      const notes = await this.read(n.project);
      await writeJsonAtomic(this.file(n.project), { schema: 1, notes: [...notes, note] } satisfies NotesFile);
      return note;
    });
  }

  /** Change one note, wherever it is. Null when there is no note with that id. */
  async update(id: string, change: NoteChange, now = new Date()): Promise<NoteRecord | null> {
    if (change.text !== undefined) {
      change = { ...change, text: change.text.trim() };
      if (!change.text) throw new Error('A note needs some text.');
      if (change.text.length > MAX_NOTE) throw new Error(`A note can be at most ${MAX_NOTE} characters.`);
    }
    return withLock(this.paths.notesDir, async () => {
      const found = (await this.all()).find((x) => x.id === id);
      if (!found) return null;
      const at = now.toISOString();
      const next: NoteRecord = { ...found, ...change, updatedAt: at };
      if (change.done !== undefined && change.done !== found.done) next.doneAt = change.done ? at : null;
      const notes = (await this.read(found.project)).map((x) => (x.id === id ? next : x));
      await writeJsonAtomic(this.file(found.project), { schema: 1, notes } satisfies NotesFile);
      return next;
    });
  }
}
