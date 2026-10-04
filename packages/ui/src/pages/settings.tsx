import { ArrowsClockwiseIcon, BellRingingIcon, FloppyDiskIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import type { Health } from '@aoe-supercharge/core/shared';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, getJson, sendJson } from '@/lib/api';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/pages/overview';

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: string[];
  const?: unknown;
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
}

interface ConfigResponse {
  config: Record<string, unknown>;
  errors: string[];
  path: string;
  schema: JsonSchema;
  restartRequired: string[];
  restartPrefixes: string[];
  supervised: boolean;
}

const SECTION_TITLE: Record<string, string> = {
  server: 'Dashboard',
  aoe: 'Agent of Empires',
  agent: 'Claude Code sessions',
  remoteControl: 'Remote Control',
  tasks: 'Tasks',
  poll: 'Polling',
  mr: 'Merge requests',
  notifications: 'Notifications',
  ui: 'Appearance',
  logging: 'Logging',
};

const LABEL: Record<string, string> = {
  'server.port': 'Port',
  'server.hostname': 'Hostname',
  'aoe.binary': 'aoe binary',
  'aoe.profile': 'AoE profile',
  'aoe.autoStart': 'Start aoe serve when needed',
  'aoe.url': 'AoE URL',
  'agent.kind': 'Agent',
  'agent.extraArgs': 'Extra claude arguments',
  'agent.workerPermissionMode': 'Worker permission mode',
  'remoteControl.enabled': 'Remote Control for control chats',
  'remoteControl.nameTemplate': 'Session name',
  'tasks.branchPrefix': 'Branch prefix',
  'tasks.idPrefix': 'Task id prefix',
  'poll.aoeSessions': 'AoE, dashboard open (s)',
  'poll.aoeSessionsIdle': 'AoE, dashboard closed (s)',
  'poll.mr': 'Merge requests (s)',
  'poll.reconcile': 'Full rescan (s)',
  'mr.provider': 'Provider',
  'mr.gitlab.hosts': 'GitLab hosts',
  'mr.gitlab.glabBinary': 'glab binary',
  'mr.gitlab.readyRequiresNonDraft': 'Drafts are never ready',
  'notifications.enabled': 'Desktop notifications',
  'notifications.blocked': 'A worker asks a question',
  'notifications.readyForReview': 'An MR is ready for review',
  'notifications.aoeWaiting': 'A worker waits in AoE',
  'notifications.controlWaiting': 'A control chat waits',
  'notifications.error': 'A session errors',
  'notifications.waitingDebounceSeconds': 'Waiting debounce (s)',
  'ui.theme': 'Theme',
  'ui.density': 'Density',
  'logging.level': 'Log level',
  'logging.maxFileMb': 'Rotate at (MB)',
  'logging.maxFiles': 'Rotated files kept',
};

type Field = { path: string; schema: JsonSchema };

/** Schema descriptions use `backticks` for commands; render those as code. */
function Desc({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/g).map((part, i) =>
        part.startsWith('`') && part.endsWith('`') ? (
          <code key={i} className="rounded-sm bg-raised px-1 py-0.5 font-mono text-[13px] text-foreground">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

function fieldsOf(schema: JsonSchema, prefix: string): Field[] {
  return Object.entries(schema.properties ?? {}).flatMap(([k, s]) =>
    s.type === 'object' && s.properties
      ? fieldsOf(s, `${prefix}${k}.`)
      : [{ path: `${prefix}${k}`, schema: s }],
  );
}

const get = (obj: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined),
      obj,
    );

function toPatch(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, v] of Object.entries(values)) {
    const keys = path.split('.');
    let cur = out;
    keys.slice(0, -1).forEach((k) => (cur = (cur[k] ??= {}) as Record<string, unknown>));
    cur[keys.at(-1)!] = v;
  }
  return out;
}

function FieldInput({
  field,
  value,
  onChange,
  error,
}: {
  field: Field;
  value: unknown;
  onChange: (v: unknown) => void;
  error?: string;
}) {
  const { path, schema } = field;
  const id = `f-${path.replace(/\./g, '-')}`;
  const label = LABEL[path] ?? path;
  const desc = schema.description;
  const errId = `${id}-err`;
  const common = {
    id,
    name: path,
    'aria-invalid': !!error || undefined,
    'aria-describedby': error ? errId : desc ? `${id}-desc` : undefined,
  };

  if (schema.type === 'boolean') {
    return (
      <div className="flex items-start justify-between gap-6 py-3">
        <div className="min-w-0">
          <Label htmlFor={id} className="text-[15px]">
            {label}
          </Label>
          {desc && (
            <p id={`${id}-desc`} className="mt-0.5 text-sm text-muted-foreground">
              <Desc text={desc} />
            </p>
          )}
          {error && (
            <p id={errId} className="mt-1 text-sm text-st-red">
              {error}
            </p>
          )}
        </div>
        <Switch {...common} checked={!!value} onCheckedChange={(c) => onChange(c)} className="mt-0.5" />
      </div>
    );
  }
  let control: React.ReactNode;
  if (schema.const !== undefined) {
    control = (
      <p className="flex h-10 items-center text-[15px] text-muted-foreground">
        {String(schema.const)} (only option in v1)
      </p>
    );
  } else if (schema.enum) {
    control = (
      <Select value={String(value ?? '')} onValueChange={(v) => onChange(v)}>
        <SelectTrigger {...common} className="h-10 w-full max-w-xs text-[15px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {schema.enum.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else if (schema.type === 'array') {
    control = (
      <Textarea
        {...common}
        autoComplete="off"
        spellCheck={false}
        rows={Math.max(2, (Array.isArray(value) ? value.length : 0) + 1)}
        value={Array.isArray(value) ? value.join('\n') : ''}
        onChange={(e) =>
          onChange(
            e.target.value
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
        className="max-w-md font-mono text-[14px]"
      />
    );
  } else if (schema.type === 'integer' || schema.type === 'number') {
    control = (
      <Input
        {...common}
        type="number"
        autoComplete="off"
        inputMode="numeric"
        min={schema.minimum}
        max={schema.maximum}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        className="h-10 max-w-40 text-[15px]"
      />
    );
  } else {
    control = (
      <Input
        {...common}
        autoComplete="off"
        spellCheck={false}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 max-w-md font-mono text-[14px]"
      />
    );
  }
  return (
    <div className="grid gap-1.5 py-3">
      <Label htmlFor={id} className="text-[15px]">
        {label}
      </Label>
      {control}
      {desc && (
        <p id={`${id}-desc`} className="text-sm text-muted-foreground">
          <Desc text={desc} />
          {schema.type === 'array' ? ' One per line.' : ''}
        </p>
      )}
      {error && (
        <p id={errId} className="text-sm text-st-red">
          {error}
        </p>
      )}
    </div>
  );
}

export function SettingsPage({ health }: { health: Health }) {
  const [data, setData] = useState<ConfigResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const load = () =>
    getJson<ConfigResponse>('/api/config')
      .then((r) => {
        setData(r);
        setValues({});
        setErrors({});
      })
      .catch((e: Error) => setLoadError(e.message));
  useEffect(() => {
    void load();
  }, []);

  const sections = useMemo(
    () =>
      data
        ? Object.entries(data.schema.properties ?? {})
            .filter(([k]) => k !== 'projects')
            .map(([k, s]) => ({ key: k, fields: fieldsOf(s, `${k}.`) }))
        : [],
    [data],
  );

  const dirty = Object.keys(values).length > 0;
  const restart = health.config.restartRequired;

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = async () => {
    if (!dirty) {
      toast.message('No changes to save');
      return;
    }
    setSaving(true);
    setErrors({});
    try {
      const r = await sendJson<{ changedKeys: string[]; restartRequired: string[] }>('PUT', '/api/config', {
        patch: toPatch(values),
      });
      toast.success(r.changedKeys.length ? 'Settings saved' : 'Nothing changed', {
        description: r.restartRequired.length ? 'Some changes need a restart.' : undefined,
      });
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        const issues = ((e.body as { issues?: string[] })?.issues ?? []) as string[];
        const map: Record<string, string> = {};
        for (const i of issues) {
          const [path, ...rest] = i.split(': ');
          map[path!] = rest.join(': ');
        }
        setErrors(map);
        toast.error('Some values are invalid', {
          description: 'Fix the highlighted fields, then save again.',
        });
        const first = Object.keys(map)[0];
        if (first)
          requestAnimationFrame(() => document.getElementById(`f-${first.replace(/\./g, '-')}`)?.focus());
      } else toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const restartNow = async () => {
    try {
      await sendJson('POST', '/api/daemon/restart');
      toast.message('Restarting the daemon', { description: 'The dashboard reconnects by itself.' });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const testNotification = async () => {
    try {
      const r = await sendJson<{ ok: boolean }>('POST', '/api/notifications/test');
      if (r.ok) toast.success('Test notification sent');
      else
        toast.error('The notification could not be shown', {
          description: 'macOS: allow notifications for Script Editor. Linux: install notify-send.',
        });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        sub={
          data ? (
            <span translate="no" className="font-mono text-[13px] break-all">
              {data.path}
            </span>
          ) : (
            'config.toml'
          )
        }
      >
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={testNotification}>
            <BellRingingIcon />
            Test notification
          </Button>
          <Button variant="gradient" disabled={saving} onClick={save}>
            <FloppyDiskIcon weight="bold" />
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </PageHeader>

      {restart.length > 0 && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-st-yellow/40 bg-st-yellow/8 px-4 py-3"
        >
          <div className="text-[15px]">
            <span className="font-medium">Restart required</span>
            <span className="text-muted-foreground"> for {restart.join(', ')}</span>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="secondary">
                <ArrowsClockwiseIcon />
                Restart daemon
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Restart the Supercharge daemon?</AlertDialogTitle>
                <AlertDialogDescription>
                  The dashboard disconnects for a few seconds and reconnects by itself. Your AoE sessions keep
                  running.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={restartNow}>Restart daemon</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}

      {loadError && (
        <p role="alert" className="text-[15px] text-st-red">
          Could not load settings: {loadError}. Reload the page; if it persists, check supercharge logs.
        </p>
      )}
      {!data && !loadError && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 w-full rounded-xl" />
          ))}
        </div>
      )}

      {data && (
        <div className="grid gap-4 xl:grid-cols-2">
          {sections.map(({ key, fields }) => {
            const needsRestart = data.restartPrefixes.includes(key);
            return (
              <section
                key={key}
                aria-labelledby={`s-${key}`}
                className="rounded-xl border border-border bg-card px-5 pt-4 pb-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <h2 id={`s-${key}`} className="text-base font-semibold">
                    {SECTION_TITLE[key] ?? key}
                  </h2>
                  {needsRestart && (
                    <span className="text-sm text-muted-foreground">Changes need a restart</span>
                  )}
                </div>
                <div className={cn('divide-y divide-border')}>
                  {fields.map((f) => (
                    <FieldInput
                      key={f.path}
                      field={f}
                      value={f.path in values ? values[f.path] : get(data.config, f.path)}
                      error={errors[f.path]}
                      onChange={(v) => setValues((cur) => ({ ...cur, [f.path]: v }))}
                    />
                  ))}
                </div>
              </section>
            );
          })}
          <section className="rounded-xl border border-dashed border-border-strong px-5 py-4 text-[15px] text-muted-foreground xl:col-span-2">
            Per-project overrides (<code className="font-mono text-[13px]">[projects.&lt;name&gt;]</code>) are
            edited in config.toml or with{' '}
            <code className="font-mono text-[13px]">supercharge config edit</code>.
          </section>
        </div>
      )}
    </div>
  );
}
