import { ArchiveIcon, ArrowCounterClockwiseIcon, PlusIcon } from '@phosphor-icons/react';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { relativeTime, type NoteRecord } from '@aoe-supercharge/core/shared';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { addNote, scopeLabel, setArchived, setDone, type NoteGroup } from '@/lib/notes';
import { cn } from '@/lib/utils';

const firstLine = (text: string) => text.split('\n')[0]!.slice(0, 80);

function failed(what: string) {
  return (e: unknown) =>
    toast.error(`Could not ${what}`, { description: e instanceof ApiError ? e.message : undefined });
}

/** One note or todo: a box to tick for a todo, who wrote it and when, and Archive (or Restore). */
export function NoteRow({
  note,
  now,
  archived = false,
}: {
  note: NoteRecord;
  now: Date;
  archived?: boolean;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const act = (fn: () => Promise<unknown>, what: string) => async () => {
    setBusy(true);
    await fn()
      .catch(failed(what))
      .finally(() => setBusy(false));
  };
  // The tick shows at once; the board catches up from the daemon, and a failed save puts it back.
  const [done, setDoneNow] = useState(note.done);
  useEffect(() => setDoneNow(note.done), [note.done]);
  const tick = () => {
    const next = !done;
    setDoneNow(next);
    setDone(note.id, next).catch((e: unknown) => {
      setDoneNow(!next);
      failed('update the todo')(e);
    });
  };
  const todo = note.kind === 'todo';
  return (
    <li data-note={note.id} data-done={todo ? done : undefined} className="flex items-start gap-3 py-2.5">
      {todo && (
        <input
          type="checkbox"
          checked={done}
          disabled={busy || archived}
          onChange={tick}
          aria-labelledby={`${id}-text`}
          className="mt-1 size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-default"
        />
      )}
      <div className="min-w-0 flex-1">
        <p
          id={`${id}-text`}
          className={cn(
            'text-[0.9375rem] break-words whitespace-pre-wrap',
            todo && done && 'text-muted-foreground line-through decoration-muted-foreground/60',
          )}
        >
          {note.text}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {note.by === 'claude' ? 'Claude' : 'You'}
          {' · '}
          <time dateTime={note.createdAt} title={new Date(note.createdAt).toLocaleString()}>
            {relativeTime(note.createdAt, now)}
          </time>
          {' · '}
          <span translate="no" className="font-mono">
            {note.id}
          </span>
        </p>
      </div>
      {archived ? (
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 px-2 text-muted-foreground"
          disabled={busy}
          onClick={act(() => setArchived(note.id, false), 'restore it')}
          aria-label={`Restore: ${firstLine(note.text)}`}
        >
          <ArrowCounterClockwiseIcon />
          Restore
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 px-2 text-muted-foreground"
          disabled={busy}
          onClick={act(() => setArchived(note.id, true), 'archive it')}
          aria-label={`Archive: ${firstLine(note.text)}`}
        >
          <ArchiveIcon />
          Archive
        </Button>
      )}
    </li>
  );
}

/** Each project's todos and notes, then the global ones. */
export function NotesBoard({
  groups,
  now,
  compact = false,
  archived = false,
}: {
  groups: NoteGroup[];
  now: Date;
  compact?: boolean;
  archived?: boolean;
}) {
  return (
    <div className={compact ? 'space-y-4' : 'space-y-6'}>
      {groups.map((g) => {
        const done = g.todos.filter((n) => n.done);
        const label = scopeLabel(g.project);
        return (
          <section
            key={g.project ?? ''}
            aria-label={label}
            data-scope={g.project ?? 'global'}
            className={compact ? 'space-y-1' : 'space-y-2'}
          >
            <h2 className={cn('font-semibold', compact ? 'text-sm' : 'text-base')}>{label}</h2>
            {g.todos.length > 0 && (
              <div>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-medium text-muted-foreground">To do</h3>
                  {!archived && done.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-muted-foreground"
                      onClick={() =>
                        void Promise.all(done.map((n) => setArchived(n.id, true))).catch(
                          failed('archive the ticked todos'),
                        )
                      }
                    >
                      <ArchiveIcon />
                      Archive {done.length} done
                    </Button>
                  )}
                </div>
                <ul className="divide-y divide-border">
                  {g.todos.map((n) => (
                    <NoteRow key={n.id} note={n} now={now} archived={archived} />
                  ))}
                </ul>
              </div>
            )}
            {g.notes.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-muted-foreground">Notes</h3>
                <ul className="divide-y divide-border">
                  {g.notes.map((n) => (
                    <NoteRow key={n.id} note={n} now={now} archived={archived} />
                  ))}
                </ul>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Write a todo or a note, for a project or global. Enter adds it. */
export function AddNote({
  projects,
  initialScope,
  compact = false,
}: {
  projects: string[];
  initialScope: string | null;
  compact?: boolean;
}) {
  const id = useId();
  const [kind, setKind] = useState<NoteRecord['kind']>('todo');
  const [scope, setScope] = useState<string>(initialScope ?? '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!text.trim()) {
      setError(kind === 'todo' ? 'Write the todo first.' : 'Write the note first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addNote(kind, text, scope || null);
      setText('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add it.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      aria-label="Add a todo or a note"
      className={cn('space-y-2', !compact && 'rounded-xl border border-border bg-card p-3')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="radiogroup"
          aria-label="Kind"
          className="flex rounded-lg border border-border bg-background p-0.5"
        >
          {(
            [
              ['todo', 'To do'],
              ['note', 'Note'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => setKind(k)}
              className={cn(
                'h-7 rounded-md px-2.5 text-sm font-medium transition-colors',
                kind === k
                  ? 'bg-raised text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <label htmlFor={`${id}-scope`} className="sr-only">
          For
        </label>
        <select
          id={`${id}-scope`}
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="h-8 rounded-lg border border-input bg-background px-2 text-sm dark:bg-input/30"
        >
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
          <option value="">Global</option>
        </select>
      </div>
      <div className="flex items-start gap-2">
        <label htmlFor={`${id}-text`} className="sr-only">
          {kind === 'todo' ? 'Todo' : 'Note'}
        </label>
        <textarea
          id={`${id}-text`}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={kind === 'todo' ? 'Something to do…' : 'Something to remember…'}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          className="field-sizing-content max-h-40 min-h-9 w-full flex-1 resize-none rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-[0.9375rem] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30"
        />
        <Button type="submit" disabled={busy} className="h-9 px-3">
          <PlusIcon />
          Add
        </Button>
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-st-red">
          {error}
        </p>
      )}
    </form>
  );
}
