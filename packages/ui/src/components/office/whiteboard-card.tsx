import { ArrowSquareOutIcon, ChalkboardSimpleIcon, XIcon } from '@phosphor-icons/react';
import { Link } from 'wouter';
import type { NoteRecord } from '@aoe-supercharge/core/shared';
import { AddNote, NotesBoard } from '@/components/notes/board';
import { Button } from '@/components/ui/button';
import { groupNotes } from '@/lib/notes';

/**
 * The whiteboard up close (SPEC §14.6): everything on it, readable, with the boxes to tick, Archive,
 * and a line to add to it. Opens when you click the board on the floor.
 */
export function WhiteboardCard({
  notes,
  projects,
  now,
  onClose,
}: {
  notes: NoteRecord[];
  projects: string[];
  now: Date;
  onClose: () => void;
}) {
  const groups = groupNotes(notes, projects);
  const open = notes.filter((n) => n.kind === 'todo' && !n.done).length;
  return (
    <section
      aria-labelledby="whiteboard-card-title"
      data-whiteboard-card
      className="pointer-events-auto flex max-h-full w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-lg"
    >
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <ChalkboardSimpleIcon className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 id="whiteboard-card-title" className="text-base font-semibold">
            Whiteboard
          </h2>
          <p className="text-sm text-muted-foreground">
            {open} to do · {notes.filter((n) => n.kind === 'note').length} notes
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close" className="-mr-2 shrink-0">
          <XIcon />
        </Button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <AddNote projects={projects} initialScope={projects[0] ?? null} compact />
        {groups.length ? (
          <NotesBoard groups={groups} now={now} compact />
        ) : (
          <p className="text-sm text-muted-foreground">
            Nothing on the board yet. Add a todo above, or ask Claude with /todo, /note or /gnote.
          </p>
        )}
      </div>
      <footer className="border-t border-border px-4 py-3">
        <Button asChild variant="outline" className="px-3">
          <Link href="/notes">
            <ArrowSquareOutIcon />
            Notes page
          </Link>
        </Button>
      </footer>
    </section>
  );
}
