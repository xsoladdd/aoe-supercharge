import {
  ArchiveIcon,
  CoffeeIcon,
  DeskIcon,
  DoorIcon,
  EnvelopeOpenIcon,
  ChatCircleIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  ClockIcon,
  EyeIcon,
  FolderIcon,
  HourglassMediumIcon,
  StopIcon,
  WarningOctagonIcon,
  XCircleIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useEffect, useRef } from 'react';
import { Link } from 'wouter';
import { blocksWork, DRESS_CODE_LABEL, relativeTime, type Prop } from '@aoe-supercharge/core/shared';
import { Avatar } from '@/components/office/avatar';
import { CostLine } from '@/components/office/cost';
import { GoHome, RestoreButton } from '@/components/office/go-home';
import { KIND } from '@/components/needs-you';
import { LiveStatus, StageBadge } from '@/components/status';
import type { OfficeModel, OfficeTeam, OfficeWorker } from '@/lib/office';
import { cn } from '@/lib/utils';

const MUTED = 'text-muted-foreground';

/** Pantry and away reasons; door reasons reuse the Needs-you vocabulary (`KIND`). */
const PROP_META: Partial<Record<Exclude<Prop, null>, { icon: Icon; color: string }>> = {
  pipeline: { icon: HourglassMediumIcon, color: 'text-st-violet' },
  pipeline_failed: { icon: XCircleIcon, color: 'text-st-red' },
  folder: { icon: EyeIcon, color: 'text-st-green' },
  folder_amber: { icon: FolderIcon, color: 'text-st-yellow' },
  folder_red: { icon: XCircleIcon, color: 'text-st-red' },
  letter: { icon: EnvelopeOpenIcon, color: 'text-st-cyan' },
  mug: { icon: CoffeeIcon, color: MUTED },
};

function Pill({ icon: I, color, children }: { icon: Icon; color: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-[0.8125rem] font-medium whitespace-nowrap',
        // Grey on its own 14% tint falls under 4.5:1, so neutral reasons get an outline instead.
        color === MUTED ? 'border border-border-strong' : 'tint',
        color,
      )}
    >
      <I weight="bold" className="size-3.5" aria-hidden />
      {children}
    </span>
  );
}

/** Why a worker is where it is: the Needs-you kind at the door, the stage at a desk. */
export function Reason({ w }: { w: OfficeWorker }) {
  if (w.zone === 'door' && w.spot.kind) {
    const k = KIND[w.spot.kind];
    return (
      <Pill icon={k.icon} color={k.color}>
        {k.label}
      </Pill>
    );
  }
  if (w.zone === 'desk') {
    if (w.task) return <StageBadge stage={w.task.stage} size="sm" />;
    return <LiveStatus status={w.session?.status ?? 'missing'} />;
  }
  if (w.zone === 'archived')
    return (
      <Pill icon={ArchiveIcon} color={MUTED}>
        Sent home
      </Pill>
    );
  if (w.zone === 'away')
    return (
      <Pill icon={w.spot.reason === 'Archived' ? ArchiveIcon : StopIcon} color={MUTED}>
        {w.spot.reason}
      </Pill>
    );
  const meta = (w.spot.prop && PROP_META[w.spot.prop]) || {
    icon: WarningOctagonIcon,
    color: MUTED,
  };
  return (
    <Pill icon={meta.icon} color={meta.color}>
      {w.spot.reason}
    </Pill>
  );
}

const PIPELINE: Record<string, { icon: Icon; color: string; label: string }> = {
  ok: { icon: CheckCircleIcon, color: 'text-st-green', label: 'pipeline passed' },
  failed: { icon: XCircleIcon, color: 'text-st-red', label: 'pipeline failed' },
  running: { icon: ClockIcon, color: 'text-st-yellow', label: 'pipeline running' },
  none: { icon: CircleDashedIcon, color: MUTED, label: 'no pipeline' },
};

export function pipelineKind(p: string | null): keyof typeof PIPELINE {
  if (p === 'success') return 'ok';
  if (p === 'failed' || p === 'canceled') return 'failed';
  if (p === null || p === 'skipped') return 'none';
  return 'running';
}

/**
 * The MR badge (SPEC §14.5): its number, the pipeline and the open review threads. A link to the MR
 * in a new tab; the floor draws the same badge under the character.
 */
export function MrBadge({ w }: { w: OfficeWorker }) {
  const mr = w.task?.mr;
  if (!mr) return null;
  const p = PIPELINE[pipelineKind(mr.pipeline)]!;
  const threads = mr.unresolvedThreads;
  const label = `MR !${mr.iid}: ${p.label}, ${threads} open review ${threads === 1 ? 'thread' : 'threads'} (opens in a new tab)`;
  return (
    <a
      href={mr.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      data-mr-badge={mr.iid}
      className="tabular inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border-strong px-2.5 text-[0.8125rem] font-semibold hover:bg-raised"
    >
      <span translate="no">!{mr.iid}</span>
      <p.icon weight="bold" className={cn('size-4', p.color)} aria-hidden />
      <span className="inline-flex items-center gap-0.5">
        <ChatCircleIcon weight="bold" className="size-4" aria-hidden />
        {threads}
      </span>
    </a>
  );
}

function WorkerRow({
  w,
  now,
  label,
  highlighted,
  showProject,
  onSelect,
  steal,
  extra,
  below,
}: {
  w: OfficeWorker;
  now: Date;
  /** Queue position or desk, shown first. */
  label?: React.ReactNode;
  highlighted: boolean;
  showProject: boolean;
  /** Pick the worker on the floor instead of following the link. */
  onSelect?: (key: string) => void;
  /** Move keyboard focus to the row when it lights up (a deep link), not just scroll to it. */
  steal: boolean;
  /** A control beside the row (not inside its link or button): the MR badge. */
  extra?: React.ReactNode;
  /** Controls under the row: the "go home?" prompt. */
  below?: React.ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!highlighted) return;
    ref.current?.scrollIntoView({ block: steal ? 'center' : 'nearest' });
    if (steal) ref.current?.focus({ preventScroll: true });
  }, [highlighted, steal]);
  const since = w.since ? relativeTime(w.since, now) : '';
  const cls = cn(
    // A grid, so one reason pill can sit beside the time (wide) or under the title (narrow, beside
    // the floor). Inset focus ring: the rounded list clips anything drawn outside the row.
    'grid min-h-[3.25rem] w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2 text-left transition-colors hover:bg-raised/70 focus-visible:-outline-offset-2 @2xl:grid-cols-[auto_minmax(0,1fr)_auto_auto]',
    // A bar and a hairline rather than a tint: tinted pills on a tinted row lose contrast.
    highlighted &&
      'shadow-[inset_3px_0_0_var(--color-primary),inset_0_0_0_1px_color-mix(in_oklch,var(--color-primary)_45%,transparent)]',
  );
  const body = (
    <>
      <span className="col-start-1 row-span-2 row-start-1 flex items-center gap-3 @2xl:row-span-1">
        {label !== undefined && (
          <span className="tabular w-14 shrink-0 font-mono text-[0.8125rem] text-muted-foreground">
            {label}
          </span>
        )}
        <span title={DRESS_CODE_LABEL[w.outfit.dressCode]} className="shrink-0">
          <Avatar outfit={w.outfit} className="size-9" />
        </span>
      </span>
      <span className="col-start-2 row-start-1 min-w-0">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-[0.9375rem] font-semibold">{w.name}</span>
          {w.id && (
            <span translate="no" className="shrink-0 font-mono text-[0.8125rem] text-muted-foreground">
              {w.id}
            </span>
          )}
        </span>
        <span className="block truncate text-sm text-muted-foreground">
          {showProject ? `${w.project} · ${w.title}` : w.title}
        </span>
        <CostLine w={w} className="mt-0.5" />
      </span>
      <span className="col-start-2 row-start-2 flex @2xl:col-start-3 @2xl:row-start-1">
        <Reason w={w} />
      </span>
      <span
        className="tabular col-start-3 row-start-1 self-start pt-0.5 text-right text-sm text-muted-foreground @2xl:col-start-4 @2xl:w-10 @2xl:self-center @2xl:pt-0"
        title={w.since ? new Date(w.since).toLocaleString() : undefined}
      >
        {since}
      </span>
    </>
  );
  return (
    <li
      data-task={w.id ?? undefined}
      data-session={w.id ? undefined : (w.session?.id ?? undefined)}
      data-project={w.project}
      data-role={w.role}
      data-zone={w.zone}
      data-since={w.since ?? undefined}
      data-blocks={w.zone === 'door' ? String(blocksWork(w.spot)) : undefined}
      className={
        extra
          ? 'flex items-center gap-2 pr-3 [&>:first-child]:min-w-0 [&>:first-child]:flex-1'
          : below
            ? 'pb-2'
            : undefined
      }
    >
      {onSelect ? (
        <button
          ref={ref as React.RefObject<HTMLButtonElement>}
          type="button"
          data-worker={w.key}
          onClick={() => onSelect(w.key)}
          aria-current={highlighted ? 'true' : undefined}
          className={cls}
        >
          {body}
        </button>
      ) : (
        <Link
          ref={ref as React.RefObject<HTMLAnchorElement>}
          href={w.href}
          data-worker={w.key}
          aria-current={highlighted ? 'true' : undefined}
          className={cls}
        >
          {body}
        </Link>
      )}
      {extra}
      {below}
    </li>
  );
}

function Count({ n }: { n: number }) {
  return (
    <span className="tabular grid h-6 min-w-6 place-items-center rounded-full bg-raised px-2 text-[0.8125rem] font-semibold">
      {n}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border-strong px-4 py-3 text-[0.9375rem] text-muted-foreground">
      {children}
    </p>
  );
}

const LIST = 'divide-y divide-border overflow-hidden rounded-xl border border-border bg-card';

function Team({ team, now, focus }: { team: OfficeTeam; now: Date; focus: Focus }) {
  const leadSeated = team.lead?.zone === 'desk' ? team.lead : null;
  const busy = team.seated.length;
  return (
    <section
      aria-labelledby={`team-${team.project}`}
      data-team={team.project}
      className={cn('scroll-mt-20', focus.section === team.project && 'rounded-xl ring-2 ring-primary/50')}
    >
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 id={`team-${team.project}`} className="text-[0.9375rem] font-semibold">
          <Link href={`/p/${encodeURIComponent(team.project)}`} className="hover:underline">
            {team.project}
          </Link>
        </h3>
        <span className="tabular text-sm text-muted-foreground">
          {team.desks ? `${busy} of ${team.desks} desks in use` : 'No open tasks'}
        </span>
      </div>
      {leadSeated || busy ? (
        <ul className={LIST} aria-label={`${team.project} desks`}>
          {leadSeated && (
            <WorkerRow
              w={leadSeated}
              now={now}
              label="Lead"
              highlighted={focus.worker === leadSeated.key}
              showProject={false}
              onSelect={focus.onSelect}
              steal={!!focus.steal}
            />
          )}
          {team.seated.map((w) => (
            <WorkerRow
              key={w.key}
              w={w}
              now={now}
              label={`Desk ${w.desk ?? '?'}`}
              highlighted={focus.worker === w.key}
              showProject={false}
              onSelect={focus.onSelect}
              steal={!!focus.steal}
            />
          ))}
        </ul>
      ) : (
        <Empty>Nobody at a desk.</Empty>
      )}
    </section>
  );
}

export interface Focus {
  /** `OfficeWorker.key` to highlight. */
  worker: string | null;
  /** A zone or a project name to scroll to. */
  section: string | null;
  /** Focus the highlighted row (deep links), rather than only scrolling it into view. */
  steal?: boolean;
  /** Rows pick a worker on the floor instead of opening its page. */
  onSelect?: (key: string) => void;
}

/** Every worker by where it stands: the accessible, testable face of the office (SPEC §14.5). */
export function OfficeRoster({
  office,
  door,
  now,
  focus,
}: {
  office: OfficeModel;
  door: string;
  now: Date;
  focus: Focus;
}) {
  useEffect(() => {
    if (!focus.section || focus.worker) return;
    document
      .querySelector(
        `[data-zone-section="${CSS.escape(focus.section)}"], [data-team="${CSS.escape(focus.section)}"]`,
      )
      ?.scrollIntoView({ block: 'start' });
  }, [focus.section, focus.worker]);

  const sectionCls = (zone: string) =>
    cn('scroll-mt-20 space-y-3', focus.section === zone && 'rounded-xl ring-2 ring-primary/50');
  return (
    <div className="@container space-y-8">
      <section aria-labelledby="zone-door" data-zone-section="door" className={sectionCls('door')}>
        <div className="flex flex-wrap items-center gap-2">
          <DoorIcon className="size-5 text-muted-foreground" />
          <h2 id="zone-door" className="text-base font-semibold">
            {door}
          </h2>
          <Count n={office.door.length} />
          <span className="text-sm text-muted-foreground">Everyone who needs you, oldest first.</span>
        </div>
        {office.door.length ? (
          <ol className={LIST} aria-label="Queue at your door">
            {office.door.map((w, i) => (
              <WorkerRow
                key={w.key}
                w={w}
                now={now}
                label={`${i + 1}`}
                highlighted={focus.worker === w.key}
                showProject
                onSelect={focus.onSelect}
                steal={!!focus.steal}
              />
            ))}
          </ol>
        ) : (
          <Empty>Nobody is at your door.</Empty>
        )}
      </section>

      <div className="grid grid-cols-1 gap-8 @4xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <section aria-labelledby="zone-desk" data-zone-section="desk" className={sectionCls('desk')}>
          <div className="flex items-center gap-2">
            <DeskIcon className="size-5 text-muted-foreground" />
            <h2 id="zone-desk" className="text-base font-semibold">
              Desks
            </h2>
            <Count
              n={office.teams.reduce((n, t) => n + t.seated.length + (t.lead?.zone === 'desk' ? 1 : 0), 0)}
            />
          </div>
          {office.teams.length ? (
            <div className="space-y-5">
              {office.teams.map((t) => (
                <Team key={t.project} team={t} now={now} focus={focus} />
              ))}
            </div>
          ) : (
            <Empty>No teams yet.</Empty>
          )}
        </section>

        <div className="space-y-8">
          <section aria-labelledby="zone-review" data-zone-section="review" className={sectionCls('review')}>
            <div className="flex items-center gap-2">
              <FolderIcon className="size-5 text-muted-foreground" />
              <h2 id="zone-review" className="text-base font-semibold">
                Review lounge
              </h2>
              <Count n={office.review.length} />
            </div>
            {office.review.length ? (
              <ul className={LIST} aria-label="In the review lounge">
                {office.review.map((w) => (
                  <WorkerRow
                    key={w.key}
                    w={w}
                    now={now}
                    highlighted={focus.worker === w.key}
                    showProject
                    onSelect={focus.onSelect}
                    steal={!!focus.steal}
                    extra={<MrBadge w={w} />}
                  />
                ))}
              </ul>
            ) : (
              <Empty>Nobody is waiting on review. Workers with an MR out wait here with their folder.</Empty>
            )}
          </section>

          <section aria-labelledby="zone-pantry" data-zone-section="pantry" className={sectionCls('pantry')}>
            <div className="flex items-center gap-2">
              <CoffeeIcon className="size-5 text-muted-foreground" />
              <h2 id="zone-pantry" className="text-base font-semibold">
                Pantry
              </h2>
              <Count n={office.pantry.length} />
            </div>
            {office.pantry.length ? (
              <ul className={LIST} aria-label="In the pantry">
                {office.pantry.map((w) => (
                  <WorkerRow
                    key={w.key}
                    w={w}
                    now={now}
                    highlighted={focus.worker === w.key}
                    showProject
                    onSelect={focus.onSelect}
                    steal={!!focus.steal}
                    below={w.idle.prompt ? <GoHome w={w} now={now} className="px-4" /> : undefined}
                  />
                ))}
              </ul>
            ) : (
              <Empty>The pantry is empty. Idle workers take a break here.</Empty>
            )}
          </section>

          {office.away.length > 0 && (
            <section aria-labelledby="zone-away" data-zone-section="away" className={sectionCls('away')}>
              <div className="flex items-center gap-2">
                <StopIcon className="size-5 text-muted-foreground" />
                <h2 id="zone-away" className="text-base font-semibold">
                  Away
                </h2>
                <Count n={office.away.length} />
              </div>
              <ul className={LIST} aria-label="Away">
                {office.away.map((w) => (
                  <WorkerRow
                    key={w.key}
                    w={w}
                    now={now}
                    highlighted={focus.worker === w.key}
                    showProject
                    onSelect={focus.onSelect}
                    steal={!!focus.steal}
                  />
                ))}
              </ul>
            </section>
          )}

          {office.archived.length > 0 && (
            <section
              aria-labelledby="zone-archived"
              data-zone-section="archived"
              className={sectionCls('archived')}
            >
              <div className="flex flex-wrap items-center gap-2">
                <ArchiveIcon className="size-5 text-muted-foreground" />
                <h2 id="zone-archived" className="text-base font-semibold">
                  Archived
                </h2>
                <Count n={office.archived.length} />
                <span className="text-sm text-muted-foreground">Sent home from the office only.</span>
              </div>
              <ul className={LIST} aria-label="Archived">
                {office.archived.map((w) => (
                  <WorkerRow
                    key={w.key}
                    w={w}
                    now={now}
                    highlighted={focus.worker === w.key}
                    showProject
                    onSelect={focus.onSelect}
                    steal={!!focus.steal}
                    extra={<RestoreButton w={w} />}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
