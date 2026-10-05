import {
  CircleNotchIcon,
  FolderPlusIcon,
  TerminalWindowIcon,
  TreeStructureIcon,
} from '@phosphor-icons/react';
import { slugify, type Snapshot } from '@aoe-supercharge/core/shared';
import { useEffect, useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useLocation } from 'wouter';
import { CommandLine } from '@/components/copy';
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
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, getJson, sendJson } from '@/lib/api';
import { unmanagedGroups } from '@/lib/derive';
import { cn } from '@/lib/utils';

interface Preview {
  control: { id: string; title: string; path: string | null; managed: boolean };
  children: { id: string; title: string; branch: string | null; repo: string; managed: boolean }[];
  projects: { name: string; repo: string }[];
  suggestion: { repoPath: string | null; project: string | null; currentControl: string | null };
}

/**
 * Turn an existing AoE parent session and its children into a Supercharge project: the parent as its
 * control chat, each child as a task. Only Supercharge's ledger changes; no agent starts or is messaged.
 */
export function AdoptDialog({
  snap,
  sessionId,
  onOpenChange,
}: {
  snap: Snapshot;
  sessionId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [, navigate] = useLocation();
  const id = useId();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [project, setProject] = useState('');
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');
  const [makeControl, setMakeControl] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    setPreview(null);
    setError(null);
    getJson<Preview>(`/api/adopt/${encodeURIComponent(sessionId)}`)
      .then((p) => {
        if (!live) return;
        setPreview(p);
        const has = p.suggestion.project;
        setMode(has ? 'existing' : 'new');
        setProject(has ?? snap.projects[0]?.name ?? '');
        setRepo(p.suggestion.repoPath ?? '');
        setName(slugify(p.suggestion.repoPath?.split('/').pop() ?? p.control.title));
        setPicked(new Set(p.children.filter((c) => !c.managed).map((c) => c.id)));
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [sessionId, snap.projects]);

  const target = mode === 'existing' ? snap.projects.find((p) => p.name === project) : null;
  const targetRepo =
    (mode === 'existing' ? preview?.projects.find((p) => p.name === project)?.repo : repo)?.replace(
      /\/+$/,
      '',
    ) ?? '';
  const currentControl = target?.controlSessionId
    ? snap.sessions.find((s) => s.id === target.controlSessionId)
    : null;
  const replacing =
    mode === 'existing' && !!target?.controlSessionId && target.controlSessionId !== sessionId;

  const submit = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await sendJson<{
        project: string;
        tasks: string[];
        skipped: { title: string; reason: string }[];
      }>('POST', '/api/adopt', {
        controlSessionId: preview.control.id,
        projectName: mode === 'existing' ? project : name,
        repoPath: mode === 'new' ? repo : undefined,
        children: [...picked],
        makeControl,
      });
      toast.success(
        `Adopted ${r.tasks.length} ${r.tasks.length === 1 ? 'session' : 'sessions'} into ${r.project}`,
        {
          description: r.skipped.length
            ? `Skipped ${r.skipped.length}: ${r.skipped.map((s) => `${s.title} (${s.reason})`).join(', ')}`
            : 'Open MRs are looked up in the background.',
        },
      );
      onOpenChange(false);
      navigate(`/p/${r.project}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not adopt the sessions.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!sessionId} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] gap-4 overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Adopt as a project</DialogTitle>
          <DialogDescription>
            The parent becomes the project’s control chat and each child a task. Nothing is started or sent to
            the sessions; Supercharge just starts tracking them.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-st-red">
            {error}
          </p>
        )}
        {!preview && !error && <Skeleton className="h-40 w-full" />}
        {preview && (
          <form
            id={`${id}-form`}
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium">Project</legend>
              {snap.projects.length > 0 && (
                <label className="flex items-center gap-2 text-[0.9375rem]">
                  <input
                    type="radio"
                    name={`${id}-mode`}
                    checked={mode === 'existing'}
                    onChange={() => setMode('existing')}
                  />
                  Add to
                  <select
                    aria-label="Existing project"
                    value={project}
                    onChange={(e) => {
                      setProject(e.target.value);
                      setMode('existing');
                    }}
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                  >
                    {snap.projects.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex items-center gap-2 text-[0.9375rem]">
                <input
                  type="radio"
                  name={`${id}-mode`}
                  checked={mode === 'new'}
                  onChange={() => setMode('new')}
                />
                New project
              </label>
              {mode === 'new' && (
                <div className="grid gap-2 pl-6 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-name`}>Name</Label>
                    <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-repo`}>Repository</Label>
                    <Input
                      id={`${id}-repo`}
                      value={repo}
                      onChange={(e) => setRepo(e.target.value)}
                      className="font-mono text-[0.8125rem]"
                    />
                  </div>
                </div>
              )}
            </fieldset>

            <label className="flex items-start gap-2 rounded-lg border border-border bg-background px-3 py-2.5">
              <input
                type="checkbox"
                className="mt-1"
                checked={makeControl}
                onChange={(e) => setMakeControl(e.target.checked)}
              />
              <span className="text-[0.9375rem]">
                Make <strong>{preview.control.title}</strong> the project’s control chat
                {replacing && currentControl && (
                  <span className="block text-sm text-muted-foreground">
                    Replaces “{currentControl.title}”, which stays in AoE as a normal session.
                  </span>
                )}
              </span>
            </label>

            <fieldset>
              <legend className="mb-2 flex w-full items-center justify-between text-sm font-medium">
                <span>
                  Children to adopt as tasks ({picked.size} of {preview.children.length})
                </span>
                <button
                  type="button"
                  className="cursor-pointer text-xs text-muted-foreground underline"
                  onClick={() =>
                    setPicked(
                      picked.size
                        ? new Set()
                        : new Set(preview.children.filter((c) => !c.managed).map((c) => c.id)),
                    )
                  }
                >
                  {picked.size ? 'None' : 'All'}
                </button>
              </legend>
              <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                {preview.children.map((c) => {
                  const other = !!targetRepo && !!c.repo && c.repo !== targetRepo;
                  return (
                    <li key={c.id}>
                      <label
                        className={cn(
                          'flex items-start gap-2.5 px-3 py-2',
                          (c.managed || other) && 'opacity-70',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="mt-1"
                          disabled={c.managed}
                          checked={picked.has(c.id)}
                          onChange={(e) => {
                            const next = new Set(picked);
                            if (e.target.checked) next.add(c.id);
                            else next.delete(c.id);
                            setPicked(next);
                          }}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[0.9375rem]">{c.title}</span>
                          <span
                            translate="no"
                            className="block truncate font-mono text-xs text-muted-foreground"
                          >
                            {c.branch ?? 'no worktree'}
                          </span>
                        </span>
                        {c.managed && (
                          <span className="shrink-0 text-xs text-muted-foreground">Already a task</span>
                        )}
                        {!c.managed && other && (
                          <span className="shrink-0 text-xs text-st-yellow">Other repository, skipped</span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          </form>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={`${id}-form`}
            variant="gradient"
            disabled={busy || !preview || (!picked.size && !makeControl)}
          >
            {busy ? <CircleNotchIcon className="animate-spin" /> : <TreeStructureIcon />}
            Adopt {picked.size} {picked.size === 1 ? 'session' : 'sessions'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "+" next to Projects: adopt an existing AoE parent and its children, or set up a new repository. */
export function AddProjectDialog({
  snap,
  open,
  onOpenChange,
  onAdopt,
}: {
  snap: Snapshot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdopt: (sessionId: string) => void;
}) {
  const id = useId();
  const [repo, setRepo] = useState('');
  const parents = useMemo(() => unmanagedGroups(snap).filter((g) => g.parent), [snap]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] gap-5 overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a project</DialogTitle>
          <DialogDescription>
            Adopt AoE sessions you already run, or start fresh in a repository.
          </DialogDescription>
        </DialogHeader>
        <section aria-labelledby={`${id}-adopt`} className="space-y-2">
          <h3 id={`${id}-adopt`} className="flex items-center gap-2 text-sm font-semibold">
            <TreeStructureIcon className="size-4" />
            From AoE sessions with children
          </h3>
          {parents.length ? (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {parents.map((g) => (
                <li key={g.parent!.id} className="flex items-center gap-3 px-3 py-2">
                  <TerminalWindowIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[0.9375rem]">{g.parent!.title}</span>
                  <span className="shrink-0 text-sm text-muted-foreground">{g.children.length} children</span>
                  <Button size="sm" variant="secondary" onClick={() => onAdopt(g.parent!.id)}>
                    Adopt
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No AoE session with child sessions outside a project.
            </p>
          )}
        </section>
        <section aria-labelledby={`${id}-new`} className="space-y-2">
          <h3 id={`${id}-new`} className="flex items-center gap-2 text-sm font-semibold">
            <FolderPlusIcon className="size-4" />
            New project in a repository
          </h3>
          <Label htmlFor={`${id}-repo`} className="text-sm text-muted-foreground">
            Path to the repository
          </Label>
          <Input
            id={`${id}-repo`}
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="~/Dev/my-repo"
            className="font-mono text-[0.8125rem]"
          />
          <CommandLine
            command={`cd ${/\s/.test(repo.trim()) ? `"${repo.trim()}"` : repo.trim() || '<repository>'} && supercharge init`}
          />
          <p className="text-sm text-muted-foreground">
            Run it in a terminal: it registers the repository and starts its control chat. The dashboard never
            starts agents itself.
          </p>
        </section>
      </DialogContent>
    </Dialog>
  );
}
