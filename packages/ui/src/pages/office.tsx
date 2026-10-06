import { ListBulletsIcon, MapTrifoldIcon } from '@phosphor-icons/react';
import { lazy, Suspense } from 'react';
import { Link } from 'wouter';
import { doorLabel, type Snapshot } from '@aoe-supercharge/core/shared';
import { CommandLine } from '@/components/copy';
import { OfficeRoster } from '@/components/office/roster';
import { HeaderActions } from '@/lib/header-slot';
import { useSearchParam } from '@/lib/nav';
import { useOffice } from '@/lib/office';
import { useNow } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/pages/overview';

// The renderer is big; only the floor view loads it.
const OfficeFloor = lazy(() => import('@/components/office/floor'));

export type OfficeView = 'floor' | 'list';

export function useOfficeView(): OfficeView {
  return useSearchParam('view') === 'list' ? 'list' : 'floor';
}

function ViewSwitch({ view }: { view: OfficeView }) {
  const keep = (v: OfficeView) => {
    const q = new URLSearchParams(window.location.search);
    q.delete('view');
    if (v === 'list') q.set('view', 'list');
    const s = q.toString();
    return `/office${s ? `?${s}` : ''}`;
  };
  return (
    <HeaderActions>
      <nav aria-label="View" className="flex rounded-lg border border-border bg-background p-0.5">
        {(
          [
            ['floor', 'Floor', MapTrifoldIcon],
            ['list', 'List', ListBulletsIcon],
          ] as const
        ).map(([key, label, I]) => (
          <Link
            key={key}
            href={keep(key)}
            aria-current={view === key ? 'page' : undefined}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors',
              view === key
                ? 'bg-raised text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <I className="size-4" />
            <span className="max-sm:sr-only">{label}</span>
          </Link>
        ))}
      </nav>
    </HeaderActions>
  );
}

/**
 * The office (SPEC §14.5): every worker stands where its status puts it. The floor view draws it;
 * the list view (`?view=list`) is the same people as a plain list. `?worker=NW-0007` (with
 * `&project=` when ids could clash) picks one; `?focus=door|desk|pantry|<project>` goes to an area.
 */
export function OfficePage({ snap }: { snap: Snapshot }) {
  const { office, announcement } = useOffice(snap);
  const now = useNow();
  const view = useOfficeView();
  const workerParam = useSearchParam('worker');
  const projectParam = useSearchParam('project');
  const focusParam = useSearchParam('focus');
  const worker = workerParam
    ? (office.everyone.find((w) => w.id === workerParam && (!projectParam || w.project === projectParam))
        ?.key ?? null)
    : null;
  const door = doorLabel(snap.ui.displayName);

  if (snap.projects.length === 0)
    return (
      <div className="space-y-6">
        <PageHeader title="Office" />
        <div className="rounded-xl border border-dashed border-border-strong px-6 py-10 text-center">
          <div className="text-base font-medium">The office is empty</div>
          <p className="mx-auto mt-1 max-w-md text-[0.9375rem] text-muted-foreground">
            Add a project, then ask its control chat for work. Every worker gets a desk here.
          </p>
          <CommandLine command="supercharge init" className="mx-auto mt-4 max-w-sm" />
        </div>
      </div>
    );

  if (view === 'floor')
    return (
      <>
        <ViewSwitch view={view} />
        <Suspense
          fallback={
            <div className="grid flex-1 place-items-center" aria-busy="true">
              <span className="text-sm text-muted-foreground">Opening the office…</span>
            </div>
          }
        >
          <OfficeFloor
            office={office}
            door={door}
            now={now}
            linkWorker={worker}
            linkFocus={focusParam}
            announcement={announcement}
          />
        </Suspense>
      </>
    );

  return (
    <div className="space-y-6">
      <ViewSwitch view={view} />
      <PageHeader
        title="Office"
        sub="Each worker stands where its status puts it: at your door, at a desk, or in the pantry."
      />
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <OfficeRoster
        office={office}
        door={door}
        now={now}
        focus={{ worker, section: focusParam, steal: true }}
      />
    </div>
  );
}
