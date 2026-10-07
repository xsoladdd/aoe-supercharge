import { PlusIcon, DotsThreeIcon, GearSixIcon, TerminalWindowIcon } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import type { Snapshot } from '@aoe-supercharge/core/shared';
import { CommandLine } from '@/components/copy';
import { ControlBox } from '@/components/control-box';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { WorkerList } from '@/components/worker-list';
import { projectViews, sessionMap } from '@/lib/derive';
import { LiveStatus } from '@/components/status';
import { SessionMenu } from '@/components/session-menu';
import { chatHref, useSearchParam } from '@/lib/nav';
import { PageHeader } from '@/pages/overview';

/**
 * Tasks are spawned by the control chat or the CLI (SPEC §8.2); the dashboard never spawns agents on
 * its own. This dialog builds the exact command so creating one stays an explicit step.
 */
function NewTaskDialog({ project }: { project: string }) {
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const quote = (s: string) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
  const command = `supercharge task new ${quote(title.trim() || '<title>')} --project ${project}${brief.trim() ? ` --brief ${quote(brief.trim())}` : ''}`;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="gradient">
          <PlusIcon weight="bold" />
          New task
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            Ask the project’s control chat, or run the command below. It creates a branch, a worktree and a
            worker session for the task.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="nt-title">Title</Label>
            <Input
              id="nt-title"
              name="title"
              autoComplete="off"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Build the listing template…"
              className="h-10 text-[0.9375rem]"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="nt-brief">Brief</Label>
            <Textarea
              id="nt-brief"
              name="brief"
              autoComplete="off"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={3}
              className="text-[0.9375rem]"
            />
            <p className="text-sm text-muted-foreground">Goal, constraints and what counts as done.</p>
          </div>
          <div className="space-y-2">
            <Label>Command</Label>
            <CommandLine command={command} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectPage({
  snap,
  name,
  changed,
}: {
  snap: Snapshot;
  name: string;
  changed: Record<string, number>;
}) {
  const view = useMemo(() => projectViews(snap).find((p) => p.project.name === name), [snap, name]);
  const sessions = useMemo(() => sessionMap(snap), [snap]);
  const [location, navigate] = useLocation();
  // "Show done" lives in the URL so the view is shareable and survives reloads.
  const showDone = useSearchParam('done') === '1';
  const showArchived = useSearchParam('archived') === '1';
  const setParam = (key: string, v: boolean) => {
    const q = new URLSearchParams(window.location.search);
    if (v) q.set(key, '1');
    else q.delete(key);
    navigate(q.size ? `${location}?${q}` : location, { replace: true });
  };
  const setShowDone = (v: boolean) => setParam('done', v);
  if (!view) {
    return (
      <div className="space-y-3">
        <PageHeader
          title="Project not found"
          sub={`No project called “${name}” is registered. Check the sidebar, or run supercharge init in its repository.`}
        />
      </div>
    );
  }
  const done = view.counts.done;
  const archived = view.tasks.filter((t) => sessions.get(t.aoeSessionId)?.archived).length;
  return (
    <div className="space-y-6">
      <PageHeader
        title={view.project.name}
        sub={
          <span translate="no" className="font-mono text-[0.8125rem] break-all">
            {view.project.repoPath}
          </span>
        }
      >
        <div className="flex items-center gap-2">
          <NewTaskDialog project={view.project.name} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More project actions">
                <DotsThreeIcon weight="bold" className="size-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/p/${view.project.name}/settings`}>
                  <GearSixIcon />
                  Project settings
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </PageHeader>
      <ControlBox view={view} remoteControl={snap.health.remoteControl} />
      <section aria-labelledby="workers-heading" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id="workers-heading" className="text-base font-semibold">
            Workers
          </h2>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {archived > 0 && (
              <label className="flex cursor-pointer items-center gap-2 text-[0.9375rem] text-muted-foreground">
                <Switch
                  checked={showArchived}
                  onCheckedChange={(v) => setParam('archived', v)}
                  aria-label="Show archived workers"
                />
                Show archived ({archived})
              </label>
            )}
            {done > 0 && (
              <label className="flex cursor-pointer items-center gap-2 text-[0.9375rem] text-muted-foreground">
                <Switch checked={showDone} onCheckedChange={setShowDone} aria-label="Show done tasks" />
                Show done ({done})
              </label>
            )}
          </div>
        </div>
        <WorkerList
          project={view.project.name}
          tasks={view.tasks}
          sessions={sessions}
          changed={changed}
          showDone={showDone}
          showArchived={showArchived}
        />
      </section>
      {view.spawned.length > 0 && (
        <section aria-labelledby="spawned-heading" className="space-y-3">
          <div>
            <h2 id="spawned-heading" className="text-base font-semibold">
              Started by the control chat
            </h2>
            <p className="text-[0.9375rem] text-muted-foreground">
              Sessions the control chat started straight through AoE rather than as tasks, so they have no
              stage or merge request here.
            </p>
          </div>
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {view.spawned.map((s) => (
              <SessionMenu key={s.id} sessionId={s.id} order={view.spawned.map((x) => x.id)}>
                <li className="data-[state=open]:bg-raised data-selected:bg-primary/10">
                  <Link
                    href={chatHref(s.id)}
                    className="flex min-w-0 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-raised/70"
                  >
                    <TerminalWindowIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    {view.project.crew?.[s.id] && (
                      <span className="shrink-0 text-[0.9375rem] font-medium">{view.project.crew[s.id]}</span>
                    )}
                    <span className="truncate text-[0.9375rem]">{s.title}</span>
                    {s.branch && (
                      <span
                        translate="no"
                        className="truncate font-mono text-[0.8125rem] text-muted-foreground"
                      >
                        {s.branch}
                      </span>
                    )}
                    <span className="ml-auto shrink-0">
                      <LiveStatus status={s.status} unread={s.unread} />
                    </span>
                  </Link>
                </li>
              </SessionMenu>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
