import { PencilSimpleIcon, PlayIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'wouter';
import {
  ago,
  type ScheduleDays,
  type ScheduleResult,
  type ScheduleView,
  type Snapshot,
} from '@aoe-supercharge/core/shared';
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
import { Badge } from '@/components/ui/badge';
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
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, sendJson } from '@/lib/api';
import { chatHref } from '@/lib/nav';
import { useNow } from '@/lib/theme';
import { PageHeader } from '@/pages/overview';

/** A chat by the name the dashboard shows it under: a control chat, a worker, a crew member, or its title. */
function chatLabel(snap: Snapshot, id: string): string {
  const project = snap.projects.find((p) => p.controlSessionId === id);
  if (project) return `${project.name} control chat`;
  const task = snap.tasks.find((t) => t.aoeSessionId === id);
  if (task) return `${task.id} ${task.title}`;
  const session = snap.sessions.find((s) => s.id === id);
  const lead = session?.parentId ? snap.projects.find((p) => p.controlSessionId === session.parentId) : null;
  return lead?.crew?.[id] ?? session?.title ?? 'Chat gone from AoE';
}

const DAYS: Record<ScheduleDays, string> = { daily: 'Every day', weekdays: 'Weekdays' };

const RESULT: Record<
  ScheduleResult['status'],
  { label: string; variant: 'secondary' | 'outline' | 'destructive' }
> = {
  queued: { label: 'Waiting for the chat', variant: 'outline' },
  sent: { label: 'Sent', variant: 'secondary' },
  skipped: { label: 'Skipped', variant: 'outline' },
  failed: { label: 'Failed', variant: 'destructive' },
};

const fail = (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Could not reach the daemon.');

function when(iso: string): string {
  return new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * Scheduled prompts (SPEC §8.5): the daemon types a prompt into an existing chat every day (or weekday) at a
 * set time, through the chat's held-message line, so it waits until Claude is free.
 */
export function SchedulesPage({ snap }: { snap: Snapshot }) {
  const now = useNow();
  const [editing, setEditing] = useState<ScheduleView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ScheduleView | null>(null);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="Schedules"
        sub="Prompts Supercharge sends to a chat at a set time, in your home time zone. A prompt waits until Claude is free, and a usage limit at stop skips the run."
      >
        <Button variant="gradient" onClick={() => setEditing('new')}>
          <PlusIcon weight="bold" />
          New schedule
        </Button>
      </PageHeader>

      {snap.schedules.length ? (
        <ul className="space-y-3">
          {snap.schedules.map((j) => (
            <ScheduleRow
              key={j.id}
              job={j}
              chat={chatLabel(snap, j.sessionId)}
              now={now}
              onEdit={() => setEditing(j)}
              onDelete={() => setDeleting(j)}
            />
          ))}
        </ul>
      ) : (
        <div className="rounded-xl border border-dashed border-border-strong px-6 py-10 text-center">
          <div className="text-base font-medium">Nothing scheduled</div>
          <p className="mx-auto mt-1 max-w-md text-[0.9375rem] text-muted-foreground">
            Schedule a prompt for a chat, like a nightly status update from a project’s control chat.
          </p>
        </div>
      )}

      {editing && (
        <ScheduleDialog
          snap={snap}
          job={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              It stops running. The chat and what it has already sent stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) void sendJson('DELETE', `/api/schedules/${deleting.id}`).catch(fail);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ScheduleRow({
  job,
  chat,
  now,
  onEdit,
  onDelete,
}: {
  job: ScheduleView;
  chat: string;
  now: Date;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const r = job.lastResult;
  const patch = (body: object) => sendJson('PATCH', `/api/schedules/${job.id}`, body).catch(fail);
  const runNow = async () => {
    setBusy(true);
    try {
      const { result } = await sendJson<{ result: ScheduleResult }>('POST', `/api/schedules/${job.id}/run`);
      if (result.status === 'failed') toast.error(result.detail ?? 'It could not be sent.');
      else if (result.status === 'skipped') toast(`Skipped: ${result.detail}`);
      else toast.success('Sent to the chat. It goes in once Claude is free.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="rounded-xl border border-border bg-card px-4 py-3.5" aria-label={job.name}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{job.name}</div>
          <div className="text-sm text-muted-foreground">
            {DAYS[job.days]} at {job.time} ·{' '}
            <Link href={chatHref(job.sessionId)} className="underline-offset-4 hover:underline">
              {chat}
            </Link>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Switch
            checked={job.enabled}
            onCheckedChange={(enabled) => void patch({ enabled })}
            aria-label={`Run ${job.name} on schedule`}
          />
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void runNow()}>
            <PlayIcon />
            Run now
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={`Edit ${job.name}`}>
            <PencilSimpleIcon />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onDelete} aria-label={`Delete ${job.name}`}>
            <TrashIcon />
          </Button>
        </div>
      </div>
      <p className="mt-2 line-clamp-2 text-[0.9375rem] whitespace-pre-wrap">{job.prompt}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>Next: {job.nextRunAt ? when(job.nextRunAt) : 'off'}</span>
        <span className="flex min-w-0 items-center gap-1.5">
          Last: {r ? `${ago(r.at, now)}${r.manual ? ' (Run now)' : ''}` : 'never'}
          {r && <Badge variant={RESULT[r.status].variant}>{RESULT[r.status].label}</Badge>}
        </span>
      </div>
      {r?.detail && (r.status === 'failed' || r.status === 'skipped') && (
        <p
          className={
            r.status === 'failed' ? 'mt-1 text-sm text-destructive' : 'mt-1 text-sm text-muted-foreground'
          }
        >
          {r.detail}
        </p>
      )}
    </li>
  );
}

function ScheduleDialog({
  snap,
  job,
  onClose,
}: {
  snap: Snapshot;
  job: ScheduleView | null;
  onClose: () => void;
}) {
  const [name, setName] = useState(job?.name ?? '');
  const [sessionId, setSessionId] = useState(job?.sessionId ?? '');
  const [prompt, setPrompt] = useState(job?.prompt ?? '');
  const [time, setTime] = useState(job?.time ?? '00:00');
  const [days, setDays] = useState<ScheduleDays>(job?.days ?? 'daily');
  const [busy, setBusy] = useState(false);
  const chats = snap.sessions
    .map((s) => ({ id: s.id, label: chatLabel(snap, s.id) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const ready = name.trim() && sessionId && prompt.trim() && time;

  const save = async () => {
    setBusy(true);
    try {
      const body = { name, sessionId, prompt, time, days };
      if (job) await sendJson('PATCH', `/api/schedules/${job.id}`, body);
      else await sendJson('POST', '/api/schedules', { ...body, enabled: true });
      onClose();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{job ? 'Edit schedule' : 'New schedule'}</DialogTitle>
          <DialogDescription>
            Sent to an existing chat at this time in your home time zone (Settings, office clocks).
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) void save();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="sc-name">Name</Label>
            <Input
              id="sc-name"
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nightly status"
              className="h-10 text-[0.9375rem]"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sc-chat">Chat</Label>
            <Select value={sessionId} onValueChange={setSessionId}>
              <SelectTrigger id="sc-chat" className="h-10 w-full text-[0.9375rem]">
                <SelectValue placeholder="Choose a chat" />
              </SelectTrigger>
              <SelectContent>
                {chats.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="sc-prompt">Prompt</Label>
            <Textarea
              id="sc-prompt"
              autoComplete="off"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              className="text-[0.9375rem]"
            />
          </div>
          <div className="flex flex-wrap gap-4">
            <div className="space-y-2">
              <Label htmlFor="sc-time">Time</Label>
              <Input
                id="sc-time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="h-10 w-32 text-[0.9375rem]"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sc-days">Days</Label>
              <Select value={days} onValueChange={(v) => setDays(v as ScheduleDays)}>
                <SelectTrigger id="sc-days" className="h-10 w-40 text-[0.9375rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(DAYS) as ScheduleDays[]).map((d) => (
                    <SelectItem key={d} value={d}>
                      {DAYS[d]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="gradient" disabled={!ready || busy}>
              {job ? 'Save' : 'Add schedule'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
