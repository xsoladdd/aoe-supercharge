import {
  CheckCircleIcon,
  ChecksIcon,
  CircleDashedIcon,
  CircleHalfIcon,
  CircleIcon,
  ChatCircleDotsIcon,
  EyeIcon,
  GaugeIcon,
  GitPullRequestIcon,
  HandPalmIcon,
  LightningIcon,
  ProhibitIcon,
  QuestionIcon,
  StopIcon,
  WarningOctagonIcon,
  type Icon,
} from '@phosphor-icons/react';
import {
  LIVE_STATUS_LABEL,
  pathIndex,
  PATH_STAGES,
  pipelineLabel,
  STAGE_LABEL,
  type LiveStatus,
  type MrState,
  type Stage,
  mrLabel,
} from '@aoe-supercharge/core/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** SPEC §14.2: never colour alone. Each status has an icon shape and a text label. */
export const STAGE_META: Record<Stage, { icon: Icon; color: string }> = {
  planning: { icon: CircleDashedIcon, color: 'text-st-slate' },
  implementing: { icon: CircleHalfIcon, color: 'text-st-blue' },
  verifying: { icon: GaugeIcon, color: 'text-st-cyan' },
  mr_raised: { icon: GitPullRequestIcon, color: 'text-st-violet' },
  watching_mr: { icon: EyeIcon, color: 'text-st-violet' },
  ready_for_review: { icon: CheckCircleIcon, color: 'text-st-green' },
  blocked: { icon: ProhibitIcon, color: 'text-st-red' },
  done: { icon: ChecksIcon, color: 'text-st-muted' },
};

type LiveOrMissing = LiveStatus | 'missing';
export const LIVE_META: Record<LiveOrMissing, { icon: Icon; color: string }> = {
  working: { icon: LightningIcon, color: 'text-st-blue' },
  waiting: { icon: HandPalmIcon, color: 'text-st-yellow' },
  idle: { icon: CircleIcon, color: 'text-st-muted' },
  error: { icon: WarningOctagonIcon, color: 'text-st-red' },
  stopped: { icon: StopIcon, color: 'text-st-muted' },
  unknown: { icon: QuestionIcon, color: 'text-st-muted' },
  missing: { icon: QuestionIcon, color: 'text-st-red' },
};

export function StageBadge({
  stage,
  className,
  size = 'md',
}: {
  stage: Stage;
  className?: string;
  size?: 'sm' | 'md';
}) {
  const { icon: I, color } = STAGE_META[stage];
  return (
    <span
      className={cn(
        'tint inline-flex shrink-0 items-center gap-1.5 rounded-full font-medium whitespace-nowrap',
        size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-sm',
        color,
        className,
      )}
    >
      <I weight="bold" className={size === 'sm' ? 'size-3.5' : 'size-4'} aria-hidden />
      {STAGE_LABEL[stage]}
    </span>
  );
}

export function LiveStatus({
  status,
  className,
  labelled = true,
  unread = false,
}: {
  status: LiveOrMissing;
  className?: string;
  labelled?: boolean;
  unread?: boolean;
}) {
  const { icon: I, color } = LIVE_META[status];
  const label = LIVE_STATUS_LABEL[status];
  const content = (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1.5 text-sm whitespace-nowrap', color, className)}
      aria-label={labelled ? undefined : label}
    >
      <I
        weight={status === 'waiting' || status === 'error' ? 'fill' : 'bold'}
        className="size-4"
        aria-hidden
      />
      {labelled && (
        <span className={status === 'idle' || status === 'stopped' ? 'text-muted-foreground' : undefined}>
          {label}
        </span>
      )}
      {unread && (
        <ChatCircleDotsIcon
          weight="fill"
          className="size-4 text-brand"
          aria-hidden={false}
          role="img"
          aria-label="Unread output"
        />
      )}
    </span>
  );
  if (labelled) return content;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Six-step stepper for the happy path; blocked/done render as a state of the current step. */
export function StageStepper({
  stage,
  blockedFrom,
  className,
}: {
  stage: Stage;
  blockedFrom: Stage | null;
  className?: string;
}) {
  const effective = stage === 'blocked' ? (blockedFrom ?? 'planning') : stage;
  const current = stage === 'done' ? PATH_STAGES.length : pathIndex(effective);
  return (
    <ol className={cn('flex items-center gap-1', className)} aria-label={`Stage: ${STAGE_LABEL[stage]}`}>
      {PATH_STAGES.map((s, i) => {
        const done = i < current;
        const here = i === current;
        return (
          <li key={s} className="flex items-center" title={STAGE_LABEL[s]}>
            <span
              className={cn(
                'block h-1.5 w-5 rounded-full transition-colors',
                done && 'bg-st-green/80',
                here && stage === 'blocked' && 'bg-st-red',
                here && stage !== 'blocked' && 'bg-gradient-primary',
                !done && !here && 'bg-border-strong',
              )}
            />
            <span className="sr-only">
              {STAGE_LABEL[s]}:{' '}
              {done ? 'done' : here ? (stage === 'blocked' ? 'blocked' : 'current') : 'not started'}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function MrBadge({ mr, className }: { mr: MrState | null; className?: string }) {
  if (!mr) return <span className={cn('text-sm text-muted-foreground', className)}>No MR</span>;
  const p = mr.pipeline;
  const tone =
    mr.state === 'merged'
      ? 'text-st-violet'
      : mr.state === 'closed'
        ? 'text-st-red'
        : p === 'success'
          ? 'text-st-green'
          : p === 'failed'
            ? 'text-st-red'
            : p === 'running' || p === 'pending'
              ? 'text-st-blue'
              : 'text-muted-foreground';
  const label = mr.state === 'merged' ? 'Merged' : mr.state === 'closed' ? 'Closed' : pipelineLabel(p);
  return (
    <a
      href={mr.url}
      target="_blank"
      rel="noreferrer"
      className={cn(
        'inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md text-sm hover:underline',
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <span translate="no" className="font-mono text-foreground">
        {mrLabel(mr)}
      </span>
      <span className={cn('inline-flex items-center gap-1 whitespace-nowrap', tone)}>
        <GitPullRequestIcon weight="bold" className="size-4" aria-hidden />
        {label}
      </span>
      {mr.state === 'opened' && (
        <span
          className={cn(
            'whitespace-nowrap',
            mr.unresolvedThreads ? 'text-st-orange' : 'text-muted-foreground',
          )}
        >
          {mr.unresolvedThreads} open {mr.unresolvedThreads === 1 ? 'thread' : 'threads'}
        </span>
      )}
    </a>
  );
}
