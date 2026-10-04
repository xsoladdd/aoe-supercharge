import { CaretDownIcon, CpuIcon } from '@phosphor-icons/react';
import {
  EFFORT_LEVELS,
  MODEL_ALIASES,
  prettyModel,
  type EffortLevel,
  type ModelAlias,
} from '@aoe-supercharge/core/shared';
import { useState } from 'react';
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
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ApiError, sendJson } from '@/lib/api';

const MODEL_LABEL: Record<ModelAlias, string> = {
  fable: 'Fable',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  default: 'Your default',
};
const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  auto: 'Auto',
};

type Change = { model: ModelAlias } | { effort: EffortLevel };

/**
 * The session's model and effort, as its latest reply (or /model, /effort) recorded them, with a way to
 * switch. AoE can only type /model or /effort into the session, and Claude Code then also keeps the
 * choice as your default for new sessions, so each change is confirmed with that spelled out.
 */
export function ModelMenu({
  sessionId,
  model,
  effort,
  disabled,
}: {
  sessionId: string;
  model: string | null;
  effort: string | null;
  disabled: boolean;
}) {
  const [change, setChange] = useState<Change | null>(null);
  const [sending, setSending] = useState(false);
  const label = model ? prettyModel(model) : 'Model';

  const apply = async () => {
    if (!change) return;
    setSending(true);
    try {
      await sendJson('POST', `/api/sessions/${encodeURIComponent(sessionId)}/model`, change);
      toast.success(
        'model' in change
          ? `Switching to ${MODEL_LABEL[change.model]}`
          : `Effort set to ${EFFORT_LABEL[change.effort]}`,
        {
          description: 'Shows here once Claude Code confirms it.',
        },
      );
    } catch (e) {
      toast.error('Not changed', {
        description: e instanceof ApiError ? e.message : 'Could not reach the session.',
      });
    } finally {
      setSending(false);
      setChange(null);
    }
  };

  // max and auto stay in the session; a typed /model and /effort low to xhigh are also saved as defaults.
  const persists =
    change !== null &&
    ('model' in change ? change.model !== 'default' : !['max', 'auto'].includes(change.effort));
  const what = change
    ? 'model' in change
      ? `${MODEL_LABEL[change.model]} model`
      : `${EFFORT_LABEL[change.effort].toLowerCase()} effort`
    : '';

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 px-2 text-muted-foreground"
            aria-label={`Model and effort: ${label}${effort ? `, ${effort}` : ''}`}
          >
            <CpuIcon className="size-4" />
            <span className="max-w-40 truncate text-xs">
              {label}
              {effort && <span className="text-muted-foreground"> · {effort}</span>}
            </span>
            <CaretDownIcon className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {model ? `Now ${prettyModel(model)}${effort ? `, ${effort} effort` : ''}` : 'Model and effort'}
          </DropdownMenuLabel>
          {disabled && <p className="px-2 pb-1.5 text-xs text-st-yellow">Answer the open menu first.</p>}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs">Model</DropdownMenuLabel>
          {MODEL_ALIASES.map((m) => (
            <DropdownMenuItem key={m} disabled={disabled} onSelect={() => setChange({ model: m })}>
              {MODEL_LABEL[m]}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs">Effort</DropdownMenuLabel>
          {EFFORT_LEVELS.map((e) => (
            <DropdownMenuItem key={e} disabled={disabled} onSelect={() => setChange({ effort: e })}>
              {EFFORT_LABEL[e]}
              {effort === e && <span className="ml-auto text-xs text-muted-foreground">current</span>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={!!change} onOpenChange={(o) => !o && setChange(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch this session to {what}?</AlertDialogTitle>
            <AlertDialogDescription>
              Supercharge types{' '}
              {change ? ('model' in change ? `/model ${change.model}` : `/effort ${change.effort}`) : ''} into
              the session, from the next reply on.
              {persists
                ? ' Claude Code also saves it as your default for new Claude Code sessions (in ~/.claude/settings.json), including outside Supercharge.'
                : ' This one stays in this session; your defaults do not change.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={apply} disabled={sending}>
              {persists ? 'Switch and save as default' : 'Switch'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
