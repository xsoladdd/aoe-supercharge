import { CircleNotchIcon } from '@phosphor-icons/react';
import type { EffortLevel, ModelAlias, UsageReport } from '@aoe-supercharge/core/shared';
import { useState } from 'react';
import { EFFORT_LABEL, MODEL_LABEL } from '@/components/chat/model-menu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api';

export const TASK_MODELS: ModelAlias[] = ['opus', 'sonnet', 'fable'];
export const TASK_EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface NewTaskValues {
  title: string;
  brief: string;
  model: ModelAlias;
  effort: EffortLevel;
  /** Only ever true after the user clicked "Start anyway". */
  force: boolean;
}

/**
 * The form for starting a worker from the dashboard. Where the task goes and what the submit calls are
 * the caller's: `submit` throws an ApiError, and a 409 `limited` becomes the "Start anyway" step.
 */
export function NewTaskForm({
  usage,
  submit,
  onBusyChange,
  onCancel,
}: {
  usage: UsageReport | null;
  submit: (values: NewTaskValues) => Promise<void>;
  /** The dialog must not close while `aoe add` runs (up to 120 s). */
  onBusyChange?: (busy: boolean) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [model, setModel] = useState<ModelAlias>('opus');
  const [effort, setEffort] = useState<EffortLevel>('high');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limited, setLimited] = useState<string | null>(null);

  const go = async (force: boolean) => {
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    setLimited(null);
    try {
      await submit({ title: title.trim(), brief: brief.trim(), model, effort, force });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && (e.body as { error?: string })?.error === 'limited')
        setLimited(e.message);
      else setError(e instanceof ApiError ? e.message : 'Could not reach the daemon.');
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim() && !busy) void go(false);
      }}
    >
      <fieldset disabled={busy} className="min-w-0 space-y-4">
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
            rows={5}
            className="text-[0.9375rem]"
          />
          <p className="text-sm text-muted-foreground">Goal, constraints and what counts as done.</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="nt-model">Model</Label>
            <Select value={model} onValueChange={(v) => setModel(v as ModelAlias)}>
              <SelectTrigger id="nt-model" className="h-10 w-full text-[0.9375rem]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TASK_MODELS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {MODEL_LABEL[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="nt-effort">Effort</Label>
            <Select value={effort} onValueChange={(v) => setEffort(v as EffortLevel)}>
              <SelectTrigger id="nt-effort" className="h-10 w-full text-[0.9375rem]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TASK_EFFORTS.map((e) => (
                  <SelectItem key={e} value={e}>
                    {EFFORT_LABEL[e]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </fieldset>
      {usage && (
        <p className={`text-sm ${usage.canStart ? 'text-muted-foreground' : 'text-st-yellow'}`}>
          {usage.advice}
        </p>
      )}
      {limited && (
        <div role="alert" className="space-y-2 rounded-md border border-border bg-raised px-3 py-2">
          <p className="text-[0.9375rem] text-st-yellow">Not started: {limited}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void go(true)}>
            Start anyway
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-[0.9375rem] text-st-red">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <CircleNotchIcon className="size-4 animate-spin" />
          Creating the branch, worktree and session. This can take up to two minutes.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="gradient" disabled={busy || !title.trim()}>
          Start task
        </Button>
      </div>
    </form>
  );
}
