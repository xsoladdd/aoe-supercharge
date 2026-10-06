import {
  ArchiveIcon,
  ArrowRightIcon,
  CaretRightIcon,
  FolderSimplePlusIcon,
  LockSimpleIcon,
  PushPinIcon,
  TerminalWindowIcon,
  TreeStructureIcon,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { relativeTime, STAGE_LABEL, type Snapshot, type SessionView } from '@aoe-supercharge/core/shared';
import { Link } from 'wouter';
import { AdoptDialog } from '@/components/add-project';
import { CommandLine } from '@/components/copy';
import { SessionMenu } from '@/components/session-menu';
import { Button } from '@/components/ui/button';
import { LiveStatus, STAGE_META } from '@/components/status';
import { archivedUnmanaged, projectViews, unmanagedGroups } from '@/lib/derive';
import { useSessionHref } from '@/lib/nav';
import { useNow } from '@/lib/theme';
import { cn } from '@/lib/utils';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function PageHeader({
  title,
  children,
  sub,
}: {
  title: string;
  sub?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[1.375rem] leading-tight font-semibold tracking-tight text-balance">{title}</h1>
        {sub && <div className="mt-1 text-[0.9375rem] text-muted-foreground">{sub}</div>}
      </div>
      {children}
    </div>
  );
}

/** A group's parent session row gets the session menu too (standalone groups have no parent). */
function ParentMenu({ id, children }: { id: string | null; children: React.ReactElement }) {
  if (!id) return children;
  return (
    <SessionMenu sessionId={id} order={[id]}>
      {children}
    </SessionMenu>
  );
}

function SessionRow({
  s,
  now,
  href,
  order,
}: {
  s: SessionView;
  now: Date;
  href: string;
  order: readonly string[];
}) {
  return (
    <SessionMenu sessionId={s.id} order={order}>
      <li className="data-[state=open]:bg-raised data-selected:bg-primary/10 data-selected:shadow-[inset_3px_0_0_var(--color-primary)]">
        <Link
          href={href}
          className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-2.5 text-left transition-colors hover:bg-raised/70 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_9rem_3.5rem]"
        >
          <span className="flex min-w-0 items-center gap-1.5 text-[0.9375rem]">
            <span className="truncate">{s.title}</span>
            {s.pinned && (
              <PushPinIcon
                weight="fill"
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden={false}
                role="img"
                aria-label="Pinned"
              />
            )}
            {s.locked && (
              <LockSimpleIcon
                weight="fill"
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden={false}
                role="img"
                aria-label="Locked"
              />
            )}
          </span>
          <span
            translate="no"
            className="hidden min-w-0 truncate font-mono text-[0.8125rem] text-muted-foreground md:block"
          >
            {s.branch ?? ''}
          </span>
          {s.archived ? (
            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              <ArchiveIcon className="size-4" />
              Archived
            </span>
          ) : (
            <LiveStatus status={s.status} unread={s.unread} />
          )}
          <span
            className="tabular hidden text-right text-sm text-muted-foreground md:block"
            title={s.statusSince ? new Date(s.statusSince).toLocaleString() : undefined}
          >
            {relativeTime(s.statusSince, now)}
          </span>
        </Link>
      </li>
    </SessionMenu>
  );
}

export function OverviewPage({ snap }: { snap: Snapshot }) {
  const now = useNow();
  const sessionHref = useSessionHref();
  const projects = useMemo(() => projectViews(snap), [snap]);
  const groups = useMemo(() => unmanagedGroups(snap), [snap]);
  const archived = useMemo(() => archivedUnmanaged(snap), [snap]);
  const [adopting, setAdopting] = useState<string | null>(null);
  const aoeOk = snap.health.aoe.state === 'ok';

  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, []);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-[1.375rem] leading-tight font-semibold tracking-tight">Projects</h1>
        <p className="mt-1 text-[0.9375rem] text-muted-foreground">
          {plural(projects.length, 'project')},{' '}
          {plural(snap.tasks.filter((t) => t.stage !== 'done').length, 'active task')},{' '}
          {plural(snap.sessions.filter((x) => !x.archived).length, 'AoE session')}
        </p>
      </div>

      {projects.length === 0 ? (
        <section className="rounded-xl border border-dashed border-border-strong px-6 py-8">
          <div className="flex items-start gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-raised">
              <FolderSimplePlusIcon className="size-6" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold">Register your first project</h2>
              <p className="mt-1 max-w-xl text-[0.9375rem] text-muted-foreground">
                Run this inside a repository. It registers the project and starts its control chat in AoE.
                Nothing is written into the repository.
              </p>
              <CommandLine command="supercharge init" className="mt-3 max-w-sm" />
            </div>
          </div>
        </section>
      ) : (
        <section aria-label="Projects" className="grid grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] gap-4">
          {projects.map(({ project, control, counts, tasks }) => {
            const active = tasks.filter((t) => t.stage !== 'done');
            const shown = (
              ['implementing', 'verifying', 'watching_mr', 'ready_for_review', 'blocked'] as const
            ).filter((s) => counts[s] > 0);
            return (
              <Link
                key={project.name}
                href={`/p/${project.name}`}
                className="group flex flex-col gap-3 rounded-xl border border-border bg-card p-5 transition-colors hover:border-border-strong hover:bg-raised/60"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[1.0625rem] font-semibold">{project.name}</div>
                    <div translate="no" className="truncate font-mono text-[0.8125rem] text-muted-foreground">
                      {project.repoPath}
                    </div>
                  </div>
                  <ArrowRightIcon
                    className="mt-1 size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                    aria-hidden
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted-foreground">Control chat</span>
                  <LiveStatus status={control?.status ?? 'missing'} unread={control?.unread} />
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-border pt-3">
                  <span className="tabular text-[0.9375rem]">
                    <span className="font-semibold">{active.length}</span>{' '}
                    <span className="text-muted-foreground">active</span>
                  </span>
                  {shown.map((s) => {
                    const { icon: I, color } = STAGE_META[s];
                    return (
                      <span key={s} className={cn('inline-flex items-center gap-1 text-[0.9375rem]', color)}>
                        <I weight="bold" className="size-4" aria-hidden />
                        <span className="tabular font-semibold">{counts[s]}</span>
                        <span className="text-muted-foreground">{STAGE_LABEL[s]}</span>
                      </span>
                    );
                  })}
                </div>
              </Link>
            );
          })}
        </section>
      )}

      <section aria-labelledby="aoe-sessions" className="space-y-3">
        <div>
          <h2 id="aoe-sessions" className="text-base font-semibold">
            Other AoE sessions
          </h2>
          <p className="text-[0.9375rem] text-muted-foreground">
            Sessions Supercharge doesn’t manage, grouped under their parent session.
          </p>
        </div>
        {!aoeOk && snap.sessions.length === 0 ? (
          <p className="text-[0.9375rem] text-muted-foreground">Waiting for AoE…</p>
        ) : groups.length === 0 ? (
          <p className="text-[0.9375rem] text-muted-foreground">
            None. Every AoE session belongs to a project.
          </p>
        ) : (
          groups.map((g) => (
            <div
              key={g.parent?.id ?? 'standalone'}
              id={g.parent ? `group-${g.parent.id}` : 'standalone'}
              className="scroll-mt-4 overflow-hidden rounded-xl border border-border bg-card"
            >
              <ParentMenu id={g.parent?.id ?? null}>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                  <Link
                    href={g.parent ? sessionHref(g.parent.id) : '#standalone'}
                    className="flex min-w-0 items-center gap-2.5 text-left hover:underline"
                  >
                    <TerminalWindowIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate text-[0.9375rem] font-semibold">
                      {g.parent?.title ?? 'Standalone sessions'}
                    </span>
                    <span className="tabular shrink-0 text-sm text-muted-foreground">
                      {g.parent
                        ? plural(g.children.length, 'child', 'children')
                        : plural(g.children.length, 'session')}
                    </span>
                  </Link>
                  {g.parent && (
                    <span className="flex items-center gap-3">
                      <LiveStatus status={g.parent.status} unread={g.parent.unread} />
                      <Button size="sm" variant="secondary" onClick={() => setAdopting(g.parent!.id)}>
                        <TreeStructureIcon />
                        Adopt as project
                      </Button>
                    </span>
                  )}
                </div>
              </ParentMenu>
              <ul className="divide-y divide-border">
                {g.children.map((s) => (
                  <SessionRow
                    key={s.id}
                    s={s}
                    now={now}
                    href={sessionHref(s.id)}
                    order={g.children.map((c) => c.id)}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
        {archived.length > 0 && (
          <details className="group overflow-hidden rounded-xl border border-border bg-card">
            <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 text-[0.9375rem] font-semibold [&::-webkit-details-marker]:hidden">
              <CaretRightIcon className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
              <ArchiveIcon className="size-5 text-muted-foreground" />
              Archived
              <span className="tabular text-sm font-normal text-muted-foreground">
                {plural(archived.length, 'session')}
              </span>
            </summary>
            <ul className="divide-y divide-border border-t border-border">
              {archived.map((s) => (
                <SessionRow
                  key={s.id}
                  s={s}
                  now={now}
                  href={sessionHref(s.id)}
                  order={archived.map((a) => a.id)}
                />
              ))}
            </ul>
          </details>
        )}
      </section>
      <AdoptDialog snap={snap} sessionId={adopting} onOpenChange={(o) => !o && setAdopting(null)} />
    </div>
  );
}
