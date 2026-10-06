import {
  ArchiveIcon,
  ArrowSquareOutIcon,
  ArrowUUpLeftIcon,
  CircleNotchIcon,
  CopyIcon,
  EnvelopeOpenIcon,
  EnvelopeSimpleIcon,
  LockSimpleIcon,
  LockSimpleOpenIcon,
  PlayIcon,
  PushPinIcon,
  PushPinSlashIcon,
  StopIcon,
  TerminalWindowIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import type { SessionView, Snapshot, TaskRecord } from '@aoe-supercharge/core/shared';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useLocation } from 'wouter';
import { copyText } from '@/components/copy';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { ApiError, sendJson } from '@/lib/api';
import { useLive } from '@/lib/live';
import { chatHref } from '@/lib/nav';
import { useSelectableRow, useSelection } from '@/lib/selection';

type Action =
  | 'pin'
  | 'unpin'
  | 'lock'
  | 'unlock'
  | 'read'
  | 'unread'
  | 'stop'
  | 'start'
  | 'archive'
  | 'unarchive'
  | 'delete';

interface Result {
  id: string;
  ok: boolean;
  error?: string;
  locked?: boolean;
}

const DONE: Record<Action, string> = {
  pin: 'Pinned',
  unpin: 'Unpinned',
  lock: 'Locked',
  unlock: 'Unlocked',
  read: 'Marked as read',
  unread: 'Marked as unread',
  stop: 'Stopped',
  start: 'Started',
  archive: 'Archived',
  unarchive: 'Unarchived',
  delete: 'Deleted',
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

async function runAction(
  action: Action,
  ids: string[],
  extra: { permanent?: boolean; deleteWorktree?: boolean; deleteBranch?: boolean } = {},
): Promise<Result[] | null> {
  try {
    const { results } = await sendJson<{ results: Result[] }>('POST', '/api/sessions/actions', {
      action,
      ids,
      ...extra,
    });
    const ok = results.filter((r) => r.ok).length;
    const locked = results.filter((r) => r.locked).length;
    const failed = results.filter((r) => !r.ok && !r.locked);
    const notes = [
      locked ? `${plural(locked, 'locked session')} left alone.` : '',
      failed.length ? failed.map((f) => f.error).join(' ') : '',
    ]
      .filter(Boolean)
      .join(' ');
    if (ok)
      toast.success(ids.length === 1 ? DONE[action] : `${DONE[action]} ${plural(ok, 'session')}`, {
        description: notes || undefined,
      });
    else toast.error(`Nothing ${DONE[action].toLowerCase()}`, { description: notes || undefined });
    return results;
  } catch (e) {
    toast.error('That did not work', { description: e instanceof ApiError ? e.message : undefined });
    return null;
  }
}

interface Target {
  id: string;
  session: SessionView;
  task: TaskRecord | null;
  /** A project's control chat: deleted only with its project. */
  control: boolean;
}

function resolveTargets(snap: Snapshot, ids: string[]): Target[] {
  return ids.flatMap((id) => {
    const session = snap.sessions.find((s) => s.id === id);
    if (!session) return [];
    return [
      {
        id,
        session,
        task: snap.tasks.find((t) => t.aoeSessionId === id) ?? null,
        control: snap.projects.some((p) => p.controlSessionId === id),
      },
    ];
  });
}

/**
 * Right-click menu for a session row, acting on every selected row when this one is part of a
 * selection. Wraps a single element (an <li> or row) that becomes the menu's trigger; Ctrl, ⌘ and Shift
 * clicks on it select rows (see useSelectableRow). `order` is the list's session ids, for Shift ranges.
 */
export function SessionMenu({
  sessionId,
  order,
  children,
}: {
  sessionId: string;
  order: readonly string[];
  children: React.ReactElement;
}) {
  const snap = useLive().snapshot;
  const sel = useSelection();
  const row = useSelectableRow(sessionId, order);
  const [, navigate] = useLocation();
  const [ids, setIds] = useState<string[]>([sessionId]);
  const [deleting, setDeleting] = useState<Target[] | null>(null);
  const targets = useMemo(() => (snap ? resolveTargets(snap, ids) : []), [snap, ids]);

  const run = async (action: Action, list: Target[]) => {
    if (!list.length) return;
    const results = await runAction(
      action,
      list.map((t) => t.id),
    );
    if (results?.some((r) => r.ok) && list.length > 1) sel.clear();
  };

  const one = targets.length === 1 ? targets[0]! : null;
  const live = targets.filter((t) => !t.session.archived);
  const unlocked = targets.filter((t) => !t.session.locked);
  const allPinned = live.length > 0 && live.every((t) => t.session.pinned);
  const allLocked = targets.length > 0 && targets.every((t) => t.session.locked);
  const anyUnread = targets.some((t) => t.session.unread);
  const running = live.filter((t) => t.session.status !== 'stopped');
  const stoppable = running.filter((t) => !t.session.locked);
  const startable = live.filter((t) => t.session.status === 'stopped');
  const archivable = live.filter((t) => !t.session.locked);
  const archived = targets.filter((t) => t.session.archived);
  const deletable = unlocked.filter((t) => !t.control);
  const openHref = one ? (one.task ? `/p/${one.task.project}/t/${one.task.id}` : chatHref(one.id)) : null;
  const lockedNote = (blocked: boolean) =>
    blocked ? <ContextMenuShortcut>Locked</ContextMenuShortcut> : null;

  return (
    <>
      {/* Not modal: a modal menu aria-hides the page while its links stay focusable. */}
      <ContextMenu modal={false} onOpenChange={(open) => open && setIds(sel.targets(sessionId))}>
        <ContextMenuTrigger asChild {...row}>
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent aria-label="Session actions">
          <ContextMenuLabel className="max-w-64 truncate">
            {one
              ? one.task
                ? `${one.task.id} ${one.task.title}`
                : one.session.title
              : `${targets.length} sessions`}
          </ContextMenuLabel>
          {one && openHref && (
            <>
              <ContextMenuItem onSelect={() => navigate(openHref)}>
                <ArrowSquareOutIcon />
                Open
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() =>
                  navigate(one.task ? `${openHref}/chat?view=terminal` : chatHref(one.id, 'terminal'))
                }
              >
                <TerminalWindowIcon />
                Open terminal
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          {live.length > 0 &&
            (allPinned ? (
              <ContextMenuItem onSelect={() => run('unpin', live)}>
                <PushPinSlashIcon />
                Unpin
              </ContextMenuItem>
            ) : (
              <ContextMenuItem
                onSelect={() =>
                  run(
                    'pin',
                    live.filter((t) => !t.session.pinned),
                  )
                }
              >
                <PushPinIcon />
                Pin to top
              </ContextMenuItem>
            ))}
          {allLocked ? (
            <ContextMenuItem onSelect={() => run('unlock', targets)}>
              <LockSimpleOpenIcon />
              Unlock
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onSelect={() => run('lock', unlocked)}>
              <LockSimpleIcon />
              Lock
            </ContextMenuItem>
          )}
          {anyUnread ? (
            <ContextMenuItem
              onSelect={() =>
                run(
                  'read',
                  targets.filter((t) => t.session.unread),
                )
              }
            >
              <EnvelopeOpenIcon />
              Mark as read
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onSelect={() => run('unread', targets)}>
              <EnvelopeSimpleIcon />
              Mark as unread
            </ContextMenuItem>
          )}
          {running.length > 0 && (
            <ContextMenuItem disabled={!stoppable.length} onSelect={() => run('stop', stoppable)}>
              <StopIcon />
              Stop
              {lockedNote(!stoppable.length)}
            </ContextMenuItem>
          )}
          {startable.length > 0 && (
            <ContextMenuItem onSelect={() => run('start', startable)}>
              <PlayIcon />
              Start
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          {archived.length > 0 && (
            <ContextMenuItem onSelect={() => run('unarchive', archived)}>
              <ArrowUUpLeftIcon />
              Unarchive
            </ContextMenuItem>
          )}
          {live.length > 0 && (
            <ContextMenuItem disabled={!archivable.length} onSelect={() => run('archive', archivable)}>
              <ArchiveIcon />
              Archive
              {lockedNote(!archivable.length)}
            </ContextMenuItem>
          )}
          <ContextMenuItem
            variant="destructive"
            disabled={!deletable.length}
            onSelect={() => setDeleting(targets)}
          >
            <TrashIcon />
            Delete…
            {deletable.length ? null : (
              <ContextMenuShortcut>{allLocked ? 'Locked' : 'With project'}</ContextMenuShortcut>
            )}
          </ContextMenuItem>
          {one && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={async () => {
                  if (await copyText(one.id)) toast.success('Copied the session id');
                }}
              >
                <CopyIcon />
                Copy session id
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={async () => {
                  const cmd = `aoe session attach ${one.id}`;
                  if (await copyText(cmd)) toast.success('Copied', { description: cmd });
                }}
              >
                <CopyIcon />
                Copy attach command
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      <DeleteSessions
        targets={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null);
          sel.clear();
        }}
      />
    </>
  );
}

/** Confirm a delete: to AoE's trash by default (restorable from AoE), or permanently. */
function DeleteSessions({
  targets,
  onClose,
  onDeleted,
}: {
  targets: Target[] | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const id = useId();
  const [permanent, setPermanent] = useState(false);
  const [worktree, setWorktree] = useState(true);
  const [branch, setBranch] = useState(false);
  const [busy, setBusy] = useState(false);
  const list = targets ?? [];
  const go = list.filter((t) => !t.session.locked && !t.control);
  const locked = list.filter((t) => t.session.locked).length;
  const controls = list.filter((t) => t.control && !t.session.locked).length;
  const workers = go.filter((t) => t.task).length;
  const name = (t: Target) => (t.task ? `${t.task.id} ${t.task.title}` : t.session.title);

  return (
    <AlertDialog
      open={!!targets}
      onOpenChange={(o) => {
        if (!o) {
          onClose();
          setPermanent(false);
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {go.length === 1 ? name(go[0]!) : plural(go.length, 'session')}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {permanent
              ? 'AoE deletes them for good. This cannot be undone.'
              : 'They go to AoE’s trash, where you can restore them until AoE empties it (30 days by default).'}
            {workers > 0 &&
              ` ${workers === 1 ? 'Its worker leaves' : 'Their workers leave'} Supercharge; the plan and comments are kept${permanent ? '' : ', and come back if you restore the session'}.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {go.length > 1 && (
          <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-border bg-background px-3 py-2 text-sm">
            {go.map((t) => (
              <li key={t.id} className="truncate">
                {name(t)}
              </li>
            ))}
          </ul>
        )}
        {(locked > 0 || controls > 0) && (
          <p className="text-sm text-muted-foreground">
            {[
              locked ? `${plural(locked, 'locked session')} will be left alone.` : '',
              controls
                ? `${plural(controls, 'control chat')} will be left alone: delete a project from its settings.`
                : '',
            ]
              .filter(Boolean)
              .join(' ')}
          </p>
        )}
        <div className="space-y-1.5 text-[0.9375rem]">
          <label className="flex items-center gap-2">
            <input
              id={`${id}-permanent`}
              type="checkbox"
              checked={permanent}
              onChange={(e) => setPermanent(e.target.checked)}
            />
            Delete permanently instead of moving to the trash
          </label>
          {permanent && (
            <div className="space-y-1.5 pl-6">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
                and their worktrees (uncommitted work in them is lost)
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={branch} onChange={(e) => setBranch(e.target.checked)} />
                and their branches
              </label>
            </div>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy || !go.length}
            onClick={async (e) => {
              e.preventDefault();
              setBusy(true);
              const r = await runAction(
                'delete',
                go.map((t) => t.id),
                permanent ? { permanent, deleteWorktree: worktree, deleteBranch: branch } : {},
              );
              setBusy(false);
              if (r?.some((x) => x.ok)) onDeleted();
            }}
          >
            {busy ? <CircleNotchIcon className="animate-spin" /> : <TrashIcon />}
            {permanent ? 'Delete permanently' : 'Move to trash'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
