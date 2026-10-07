import { ArchiveIcon, ArrowCounterClockwiseIcon, CircleNotchIcon, HouseIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { relativeTime, type OfficeAction } from '@aoe-supercharge/core/shared';
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
import { ApiError, sendJson } from '@/lib/api';
import type { OfficeWorker } from '@/lib/office';
import { cn } from '@/lib/utils';

/** At least 24px tall: a touch target (WCAG 2.5.8). */
const BTN = 'h-7 px-2.5 text-[0.8125rem]';

const DONE: Record<OfficeAction, (name: string) => string> = {
  archive: (n) => `${n} went home`,
  keep: (n) => `${n} stays in the office`,
  snooze: (n) => `Asking ${n} again in 30 minutes`,
  restore: (n) => `${n} is back in the office`,
};

/** Archive, Keep, Snooze or Restore (SPEC §14.5). Office-only: it writes the office's own state. */
export function useOfficeAction() {
  const [busy, setBusy] = useState<OfficeAction | null>(null);
  const run = async (w: OfficeWorker, action: OfficeAction) => {
    setBusy(action);
    try {
      await sendJson('POST', '/api/office/marks', { key: w.key, action });
      toast.success(DONE[action](w.name));
      return true;
    } catch (e) {
      toast.error('That did not work', { description: e instanceof ApiError ? e.message : undefined });
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

/** The confirmation before a worker goes home: what happens, and what does not. */
export function ArchiveDialog({
  w,
  open,
  onOpenChange,
}: {
  w: OfficeWorker;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { busy, run } = useOfficeAction();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-archive-dialog={w.key}>
        <AlertDialogHeader>
          <AlertDialogTitle>Send {w.name} home?</AlertDialogTitle>
          <AlertDialogDescription>
            {w.name} walks out of the office and leaves the floor. This only changes the office: the session,
            its worktree, its conversation and the office history stay as they are. {w.name} comes back by
            itself on starting work again or needing you, or with Restore under Archived.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!!busy}
            onClick={async (e) => {
              e.preventDefault();
              if (await run(w, 'archive')) onOpenChange(false);
            }}
          >
            {busy ? <CircleNotchIcon className="animate-spin" /> : <ArchiveIcon />}
            Send home
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The "go home?" prompt for a worker idle in the pantry past `office.idle.promptMinutes`: Archive (with
 * a confirmation), Keep (not asked again until it has worked), or Snooze 30m.
 */
export function GoHome({ w, now, className }: { w: OfficeWorker; now: Date; className?: string }) {
  const { busy, run } = useOfficeAction();
  const [confirm, setConfirm] = useState(false);
  if (!w.idle.prompt) return null;
  const idle = w.idle.since ? relativeTime(w.idle.since, now) : '';
  return (
    <div
      role="group"
      aria-label={`${w.name} has been idle ${idle}. Go home?`}
      data-go-home={w.key}
      className={cn('flex flex-wrap items-center gap-2 text-sm', className)}
    >
      <span className="inline-flex items-center gap-1.5 font-medium">
        <HouseIcon weight="bold" className="size-4 text-muted-foreground" aria-hidden />
        Idle {idle}. Go home?
      </span>
      <span className="flex flex-wrap gap-1.5">
        <Button
          size="xs"
          variant="outline"
          className={BTN}
          disabled={!!busy}
          onClick={() => setConfirm(true)}
        >
          <ArchiveIcon aria-hidden />
          Archive
        </Button>
        <Button
          size="xs"
          variant="outline"
          className={BTN}
          disabled={!!busy}
          onClick={() => void run(w, 'keep')}
        >
          Keep
        </Button>
        <Button
          size="xs"
          variant="outline"
          className={BTN}
          disabled={!!busy}
          onClick={() => void run(w, 'snooze')}
        >
          Snooze 30m
        </Button>
      </span>
      <ArchiveDialog w={w} open={confirm} onOpenChange={setConfirm} />
    </div>
  );
}

/** Restore for a worker that went home: it walks back in to where its status puts it. */
export function RestoreButton({ w, className }: { w: OfficeWorker; className?: string }) {
  const { busy, run } = useOfficeAction();
  return (
    <Button
      size="xs"
      variant="outline"
      className={cn(BTN, className)}
      disabled={!!busy}
      aria-label={`Restore ${w.name} to the office`}
      data-restore={w.key}
      onClick={() => void run(w, 'restore')}
    >
      {busy ? <CircleNotchIcon className="animate-spin" /> : <ArrowCounterClockwiseIcon aria-hidden />}
      Restore
    </Button>
  );
}
