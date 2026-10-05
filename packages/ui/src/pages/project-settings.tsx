import { CircleNotchIcon, TrashIcon, WarningIcon } from '@phosphor-icons/react';
import { ago, type Snapshot } from '@aoe-supercharge/core/shared';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Link, useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ApiError, sendJson } from '@/lib/api';
import { useNow } from '@/lib/theme';
import { PageHeader } from '@/pages/overview';

/** Type-to-confirm delete: forget the project, and optionally delete its AoE sessions too. */
function DeleteProject({ name, sessions, tasks }: { name: string; sessions: number; tasks: number }) {
  const id = useId();
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [withSessions, setWithSessions] = useState(false);
  const [worktrees, setWorktrees] = useState(false);
  const [branches, setBranches] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await sendJson<{ deleted: string[]; failed: { sessionId: string; error: string }[] }>(
        'DELETE',
        `/api/projects/${encodeURIComponent(name)}`,
        {
          confirm: typed,
          deleteSessions: withSessions,
          deleteWorktrees: worktrees,
          deleteBranches: branches,
        },
      );
      toast.success(`Deleted ${name}`, {
        description: r.failed.length
          ? `AoE could not delete ${r.failed.length} sessions; they are still in AoE.`
          : withSessions
            ? `${r.deleted.length} AoE sessions deleted too.`
            : 'Its AoE sessions are kept.',
      });
      setOpen(false);
      navigate('/');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not delete the project.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby={`${id}-danger`}
      className="rounded-xl border border-st-red/40 bg-st-red/5 px-5 py-4"
    >
      <h2 id={`${id}-danger`} className="flex items-center gap-2 text-sm font-semibold text-st-red">
        <WarningIcon weight="fill" className="size-4" />
        Danger zone
      </h2>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-[0.9375rem] text-muted-foreground">
          Delete this project from Supercharge: its {tasks} {tasks === 1 ? 'task' : 'tasks'}, plans, comments
          and notes. You can also delete its AoE sessions. This cannot be undone.
        </p>
        <Button variant="destructive" onClick={() => setOpen(true)}>
          <TrashIcon />
          Delete project
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setTyped('');
        }}
      >
        <DialogContent className="gap-4 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Delete {name}?</DialogTitle>
            <DialogDescription>
              Supercharge forgets the project, its tasks, plans, comments and notes. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <form
            id={`${id}-form`}
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (typed === name) void remove();
            }}
          >
            <label className="flex items-start gap-2 rounded-lg border border-border bg-background px-3 py-2.5 text-[0.9375rem]">
              <input
                type="checkbox"
                className="mt-1"
                checked={withSessions}
                onChange={(e) => setWithSessions(e.target.checked)}
              />
              <span>
                Also delete its {sessions} AoE {sessions === 1 ? 'session' : 'sessions'} (control chat and
                workers)
                <span className="block text-sm text-muted-foreground">
                  Off: they stay in AoE and show under Other AoE sessions.
                </span>
              </span>
            </label>
            {withSessions && (
              <div className="space-y-1.5 pl-6 text-[0.9375rem]">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={worktrees}
                    onChange={(e) => setWorktrees(e.target.checked)}
                  />
                  and their worktrees (uncommitted work in them is lost)
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={branches} onChange={(e) => setBranches(e.target.checked)} />
                  and their branches
                </label>
              </div>
            )}
            <div className="space-y-1.5">
              <label htmlFor={`${id}-confirm`} className="text-sm">
                Type <strong translate="no">{name}</strong> to confirm
              </label>
              <Input
                id={`${id}-confirm`}
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                className="font-mono"
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-st-red">
                {error}
              </p>
            )}
          </form>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" form={`${id}-form`} variant="destructive" disabled={busy || typed !== name}>
              {busy ? <CircleNotchIcon className="animate-spin" /> : <TrashIcon />}
              {withSessions ? 'Delete project and sessions' : 'Delete project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** A project's details, and the hard-to-reach danger zone (reached from the project page's ⋯ menu). */
export function ProjectSettingsPage({ snap, name }: { snap: Snapshot; name: string }) {
  const now = useNow();
  const project = snap.projects.find((p) => p.name === name);
  if (!project)
    return (
      <p className="text-[0.9375rem] text-muted-foreground">
        No project called “{name}”.{' '}
        <Link href="/" className="underline">
          Back to the overview
        </Link>
        .
      </p>
    );
  const tasks = snap.tasks.filter((t) => t.project === name);
  const control = snap.sessions.find((s) => s.id === project.controlSessionId);
  const sessions = tasks.length + (project.controlSessionId ? 1 : 0);
  const rows: [string, React.ReactNode][] = [
    [
      'Repository',
      <span translate="no" className="font-mono text-[0.8125rem] break-all">
        {project.repoPath}
      </span>,
    ],
    [
      'Remote',
      project.remoteUrl ? (
        <span translate="no" className="font-mono text-[0.8125rem] break-all">
          {project.remoteUrl}
        </span>
      ) : (
        'None'
      ),
    ],
    [
      'Control chat',
      project.controlSessionId ? (
        <Link href={`/chat/${project.controlSessionId}`} className="underline underline-offset-3">
          {control?.title ?? project.controlSessionId}
        </Link>
      ) : (
        'None'
      ),
    ],
    [
      'Task ids',
      <span translate="no" className="font-mono">
        {project.idPrefix}-0001…
      </span>,
    ],
    ['Tasks', `${tasks.length} (${tasks.filter((t) => t.stage !== 'done').length} active)`],
    ['Created', ago(project.createdAt, now)],
  ];
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title={`${name} settings`}
        sub="Project details. Other options are in config.toml under [projects.<name>]."
      />
      <section className="rounded-xl border border-border bg-card px-5 py-4">
        <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[0.9375rem]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-sm text-muted-foreground">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      <DeleteProject name={name} sessions={sessions} tasks={tasks.length} />
    </div>
  );
}
