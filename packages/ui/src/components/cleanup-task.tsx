import { BroomIcon, CircleNotchIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useLocation } from 'wouter';
import { workerLabel, type TaskRecord } from '@aoe-supercharge/core/shared';
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
import { Button } from '@/components/ui/button';
import { ApiError, getJson, sendJson } from '@/lib/api';

/** What `GET /api/tasks/:project/:id/cleanup` and the POST answer with (packages/cli/src/cleanup.ts). */
interface CleanupResult {
  taskId: string;
  branch: string;
  ok: boolean;
  removed?: boolean;
  landedBy?: 'ancestor' | 'cherry' | 'merged_pr';
  reason?: string;
  hint?: string;
  detail?: string[];
}

const HOW: Record<NonNullable<CleanupResult['landedBy']>, string> = {
  ancestor: 'Its commits are on origin/main.',
  cherry: 'Its commits are on origin/main as equivalent patches (cherry-picked or rebased).',
  merged_pr: 'Its pull request is merged and nothing in the worktree is past it.',
};

const url = (task: Pick<TaskRecord, 'project' | 'id'>) =>
  `/api/tasks/${encodeURIComponent(task.project)}/${encodeURIComponent(task.id)}/cleanup`;

function Why({ r }: { r: CleanupResult }) {
  return (
    <div role="alert" className="space-y-2 text-[0.9375rem]">
      <p className="text-st-red">{r.reason}</p>
      {r.detail && r.detail.length > 0 && (
        <ul className="rounded-md border border-border bg-raised px-3 py-2 font-mono text-[0.8125rem] [overflow-wrap:anywhere]">
          {r.detail.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
      {r.hint && <p className="text-muted-foreground">{r.hint}</p>}
    </div>
  );
}

/**
 * Clean up one finished worker: its AoE session, worktree and branch. The daemon checks that the work
 * is on origin/main first (and fetches); the dialog says what it found, and the button stays off when
 * it is not safe.
 */
export function CleanupTaskDialog({
  task,
  open,
  onOpenChange,
}: {
  task: Pick<TaskRecord, 'project' | 'id' | 'name' | 'branch'>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [check, setCheck] = useState<CleanupResult | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!open) return;
    let live = true;
    setCheck(null);
    setFailed(null);
    getJson<CleanupResult>(url(task))
      .then((r) => live && setCheck(r))
      .catch((e) => live && setFailed(e instanceof ApiError ? e.message : 'Could not check it.'));
    return () => {
      live = false;
    };
  }, [open, task.project, task.id]);

  const run = async () => {
    setBusy(true);
    try {
      const r = await sendJson<CleanupResult>('POST', url(task), { confirm: true });
      if (!r.removed) {
        setCheck(r);
        return;
      }
      toast.success(`${workerLabel(task as TaskRecord)} cleaned up`, {
        description: 'Session, worktree and branch removed. Recorded in the audit log.',
      });
      onOpenChange(false);
      navigate(`/p/${encodeURIComponent(task.project)}`);
    } catch (e) {
      setFailed(e instanceof ApiError ? e.message : 'Could not clean it up.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Clean up {workerLabel(task as TaskRecord)}?</AlertDialogTitle>
          <AlertDialogDescription>
            Removes its AoE session, its worktree and the branch {task.branch}. It only goes ahead when the
            work is on origin/main.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {failed ? (
          <p role="alert" className="text-[0.9375rem] text-st-red">
            {failed}
          </p>
        ) : !check ? (
          <p className="flex items-center gap-2 text-[0.9375rem] text-muted-foreground">
            <CircleNotchIcon className="animate-spin" /> Fetching origin and checking the work…
          </p>
        ) : check.ok ? (
          <p className="text-[0.9375rem]">{check.landedBy ? HOW[check.landedBy] : 'The work has landed.'}</p>
        ) : (
          <Why r={check} />
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Close</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy || !check?.ok}
            onClick={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            {busy ? <CircleNotchIcon className="animate-spin" /> : <BroomIcon />}
            Clean up
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function CleanupTaskButton({ task }: { task: TaskRecord }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <BroomIcon />
        Clean up
      </Button>
      <CleanupTaskDialog task={task} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** Clean up every done worker of a project; the unsafe ones are skipped and listed with why. */
export function CleanupDoneButton({ project, count }: { project: string; count: number }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState<CleanupResult[] | null>(null);

  const run = async () => {
    setBusy(true);
    try {
      const { results } = await sendJson<{ results: CleanupResult[] }>(
        'POST',
        `/api/projects/${encodeURIComponent(project)}/cleanup-done`,
        { confirm: true },
      );
      const cleaned = results.filter((r) => r.removed).length;
      const left = results.filter((r) => !r.removed);
      if (cleaned) toast.success(`${cleaned} worker${cleaned === 1 ? '' : 's'} cleaned up`);
      if (left.length) setSkipped(left);
      else setOpen(false);
    } catch (e) {
      toast.error('Could not clean up', { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setSkipped(null);
          setOpen(true);
        }}
      >
        <BroomIcon />
        Clean up all done
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clean up all {count} done tasks?</AlertDialogTitle>
            <AlertDialogDescription>
              Each one is checked on its own, after fetching origin. Those whose work is on origin/main lose
              their session, worktree and branch; the others are left as they are, and listed here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {skipped && (
            <ul className="max-h-64 space-y-2 overflow-y-auto text-[0.9375rem]">
              {skipped.map((r) => (
                <li key={r.taskId}>
                  <span className="font-mono text-[0.8125rem]">{r.taskId}</span> <Why r={r} />
                </li>
              ))}
            </ul>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{skipped ? 'Close' : 'Cancel'}</AlertDialogCancel>
            {!skipped && (
              <AlertDialogAction
                disabled={busy}
                onClick={(e) => {
                  e.preventDefault();
                  void run();
                }}
              >
                {busy ? <CircleNotchIcon className="animate-spin" /> : <BroomIcon />}
                Clean up
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
