import { ArchiveIcon, ChalkboardSimpleIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import type { NoteRecord, Snapshot } from '@aoe-supercharge/core/shared';
import { AddNote, NotesBoard } from '@/components/notes/board';
import { getJson } from '@/lib/api';
import { useSearchParam } from '@/lib/nav';
import { groupNotes } from '@/lib/notes';
import { useNow } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/pages/overview';

/** The archived ones, read when asked for and again whenever the board changes (a restore, say). */
function useArchived(on: boolean, version: unknown): NoteRecord[] | null {
  const [notes, setNotes] = useState<NoteRecord[] | null>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    getJson<{ notes: NoteRecord[] }>('/api/notes?archived=1')
      .then((r) => live && setNotes(r.notes))
      .catch(() => live && setNotes([]));
    return () => {
      live = false;
    };
  }, [on, version]);
  return on ? notes : null;
}

/**
 * Notes and todos (SPEC §14.6), per project and global: the same board as the whiteboard in the
 * office. `?scope=<project>|global` shows one; `?archived=1` shows what was archived, to restore.
 */
export function NotesPage({ snap }: { snap: Snapshot }) {
  const now = useNow();
  const scopeParam = useSearchParam('scope');
  const archivedView = useSearchParam('archived') === '1';
  const projects = useMemo(() => snap.projects.map((p) => p.name), [snap.projects]);
  const scope =
    scopeParam === 'global' ? null : scopeParam && projects.includes(scopeParam) ? scopeParam : undefined;
  const archived = useArchived(archivedView, snap.notes);
  const source = archivedView ? (archived ?? []) : snap.notes;
  const groups = groupNotes(source, projects).filter((g) => scope === undefined || g.project === scope);

  const href = (s: string | null | undefined, arch = archivedView) => {
    const q = new URLSearchParams();
    if (s !== undefined) q.set('scope', s ?? 'global');
    if (arch) q.set('archived', '1');
    const str = q.toString();
    return `/notes${str ? `?${str}` : ''}`;
  };
  const chips: [string, string | null | undefined][] = [
    ['All', undefined],
    ...projects.map((p): [string, string] => [p, p]),
    ['Global', null],
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title={archivedView ? 'Archived notes' : 'Notes'}
        sub={
          archivedView
            ? 'Out of sight, kept. Restore one to put it back on the board.'
            : 'Todos and notes for each project and for everything, also on the whiteboard in the office. Claude adds them when you type /todo, /note or /gnote.'
        }
      >
        <Link
          href={href(scope, !archivedView)}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {archivedView ? <ChalkboardSimpleIcon className="size-4" /> : <ArchiveIcon className="size-4" />}
          {archivedView ? 'Back to the board' : 'Archived'}
        </Link>
      </PageHeader>

      {!archivedView && (
        <AddNote projects={projects} initialScope={scope === undefined ? (projects[0] ?? null) : scope} />
      )}

      {projects.length > 0 && (
        <nav aria-label="Show" className="flex flex-wrap gap-1.5">
          {chips.map(([label, s]) => (
            <Link
              key={label}
              href={href(s)}
              aria-current={s === scope ? 'page' : undefined}
              className={cn(
                'inline-flex h-8 items-center rounded-full border px-3 text-sm font-medium transition-colors',
                s === scope
                  ? 'border-primary/50 bg-primary/12 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {label}
            </Link>
          ))}
        </nav>
      )}

      {archivedView && archived === null ? (
        <p className="text-sm text-muted-foreground" aria-busy="true">
          Reading the archive…
        </p>
      ) : groups.length ? (
        <NotesBoard groups={groups} now={now} archived={archivedView} />
      ) : (
        <div className="rounded-xl border border-dashed border-border-strong px-6 py-10 text-center">
          <div className="text-base font-medium">
            {archivedView ? 'Nothing archived' : 'The board is empty'}
          </div>
          {!archivedView && (
            <p className="mx-auto mt-1 max-w-md text-[0.9375rem] text-muted-foreground">
              Add a todo above, or ask Claude in any session: <code>/todo</code>, <code>/note</code> for this
              project, <code>/gnote</code> for everything.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
