import { ArrowSquareOutIcon, ChalkboardSimpleIcon, XIcon } from '@phosphor-icons/react';
import { Link } from 'wouter';
import { DOOR_BOARD, roomBoardId, type NoteRecord } from '@aoe-supercharge/core/shared';
import { AddNote, NotesBoard } from '@/components/notes/board';
import { Button } from '@/components/ui/button';
import { groupNotes, splitBoards } from '@/lib/notes';

/**
 * A whiteboard up close (SPEC §14.6): everything on it, readable, with the boxes to tick, Archive,
 * and a line to add to it. Opens when you click a board on the floor: the one by your door (global
 * notes) or a room's (that project's).
 */
export function WhiteboardCard({
  board,
  all,
  projects,
  now,
  onClose,
}: {
  /** `board` by your door, or `board:<project>`. */
  board: string;
  /** Every note and todo; the card keeps the ones written on this board. */
  all: NoteRecord[];
  /** The projects that have a room, in the sidebar's order. */
  projects: string[];
  now: Date;
  onClose: () => void;
}) {
  const room = projects.find((p) => roomBoardId(p) === board) ?? null;
  const notes = splitBoards(all, projects)[room ? board : DOOR_BOARD] ?? [];
  const groups = groupNotes(notes, room ? [room] : []);
  const title = room ? `${room} whiteboard` : 'Whiteboard';
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
            {title}
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
        <AddNote key={board} projects={room ? [room] : []} initialScope={room} compact />
        {groups.length ? (
          <NotesBoard groups={groups} now={now} compact />
        ) : (
          <p className="text-sm text-muted-foreground">
            Nothing on the board yet. Add a todo above, or ask Claude with /todo, /note
            {room ? '' : ' or /gnote'}.
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
