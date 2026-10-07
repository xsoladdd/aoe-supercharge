import {
  BuildingOfficeIcon,
  CaretRightIcon,
  ChalkboardSimpleIcon,
  ChatTeardropTextIcon,
  GearSixIcon,
  MoonIcon,
  SquaresFourIcon,
  SunIcon,
  TerminalWindowIcon,
  PlusIcon,
  PushPinIcon,
  LockSimpleIcon,
} from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { STAGE_LABEL, type SessionView, type Snapshot } from '@aoe-supercharge/core/shared';
import { Wordmark } from '@/components/brand';
import { LiveStatus, STAGE_META } from '@/components/status';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  SidebarGroupAction,
} from '@/components/ui/sidebar';
import { AddProjectDialog, AdoptDialog } from '@/components/add-project';
import { SessionMenu } from '@/components/session-menu';
import { UsageMeter } from '@/components/usage';
import { pinnedFirst, projectViews, sessionMap, unmanagedGroups } from '@/lib/derive';
import { chatHref } from '@/lib/nav';
import { useResolvedTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

/** A row picked for a bulk action (Ctrl, ⌘ or Shift click). */
const SELECTED =
  'rounded-md data-[state=open]:bg-sidebar-accent data-selected:bg-primary/15 data-selected:ring-1 data-selected:ring-primary/40';

/** Pinned and locked marks for a session row. */
function Marks({ session }: { session: SessionView | null | undefined }) {
  if (!session?.pinned && !session?.locked) return null;
  return (
    <>
      {session.pinned && (
        <PushPinIcon
          weight="fill"
          className="size-3.5 text-muted-foreground"
          aria-hidden={false}
          role="img"
          aria-label="Pinned"
        />
      )}
      {session.locked && (
        <LockSimpleIcon
          weight="fill"
          className="size-3.5 text-muted-foreground"
          aria-hidden={false}
          role="img"
          aria-label="Locked"
        />
      )}
    </>
  );
}

/** The control chat row gets the session menu once the project has a control chat. */
function ControlRow({ id, children }: { id: string | null; children: React.ReactElement }) {
  if (!id) return children;
  return (
    <SessionMenu sessionId={id} order={[id]}>
      {children}
    </SessionMenu>
  );
}

export function AppSidebar({ snap, onToggleTheme }: { snap: Snapshot; onToggleTheme: () => void }) {
  const [location] = useLocation();
  const projects = useMemo(() => projectViews(snap), [snap]);
  const groups = useMemo(() => unmanagedGroups(snap), [snap]);
  const sessions = useMemo(() => sessionMap(snap), [snap]);
  const theme = useResolvedTheme();
  const needsByProject = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of snap.needsYou) if (n.project) m.set(n.project, (m.get(n.project) ?? 0) + 1);
    return m;
  }, [snap.needsYou]);
  const aoe = snap.health.aoe;
  const [adding, setAdding] = useState(false);
  const [adopting, setAdopting] = useState<string | null>(null);

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader className="px-3 pt-3 pb-1">
        <Link href="/" className="rounded-md focus-visible:outline-2">
          <Wordmark />
        </Link>
      </SidebarHeader>

      <SidebarContent className="gap-0 [&>[data-slot=sidebar-group]]:py-1">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={location === '/'}
                  tooltip="Overview"
                  className="h-8 text-[0.9375rem]"
                >
                  <Link href="/" aria-current={location === '/' ? 'page' : undefined}>
                    <SquaresFourIcon weight={location === '/' ? 'fill' : 'regular'} className="size-4" />
                    <span>Overview</span>
                  </Link>
                </SidebarMenuButton>
                {snap.needsYou.length > 0 && (
                  <SidebarMenuBadge className="tabular text-st-yellow">
                    {snap.needsYou.length}
                  </SidebarMenuBadge>
                )}
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={location === '/office'}
                  tooltip="Office"
                  className="h-8 text-[0.9375rem]"
                >
                  <Link href="/office" aria-current={location === '/office' ? 'page' : undefined}>
                    <BuildingOfficeIcon
                      weight={location === '/office' ? 'fill' : 'regular'}
                      className="size-4"
                    />
                    <span>Office</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={location === '/notes'}
                  tooltip="Notes"
                  className="h-8 text-[0.9375rem]"
                >
                  <Link href="/notes" aria-current={location === '/notes' ? 'page' : undefined}>
                    <ChalkboardSimpleIcon
                      weight={location === '/notes' ? 'fill' : 'regular'}
                      className="size-4"
                    />
                    <span>Notes</span>
                  </Link>
                </SidebarMenuButton>
                {(() => {
                  const open = snap.notes.filter((n) => n.kind === 'todo' && !n.done).length;
                  return (
                    open > 0 && (
                      <SidebarMenuBadge className="tabular text-muted-foreground" title={`${open} to do`}>
                        {open}
                      </SidebarMenuBadge>
                    )
                  );
                })()}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel className="text-[0.8125rem]">Projects</SidebarGroupLabel>
          <SidebarGroupAction
            title="Add a project"
            aria-label="Add a project"
            onClick={() => setAdding(true)}
            // At least 24px whatever the interface size (WCAG 2.2 target size).
            className="top-2.5 w-[max(1.5rem,24px)]"
          >
            <PlusIcon />
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {projects.length === 0 && (
                <p className="px-2 py-1.5 text-[0.8125rem] text-muted-foreground group-data-[collapsible=icon]:hidden">
                  None yet. Run <code className="font-mono">supercharge init</code> in a repository.
                </p>
              )}
              {projects.map(({ project, control, tasks, spawned }) => {
                const href = `/p/${project.name}`;
                const active = location === href || location.startsWith(`${href}/`);
                const needs = needsByProject.get(project.name) ?? 0;
                return (
                  <Collapsible key={project.name} defaultOpen asChild className="group/collapsible">
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        asChild
                        isActive={location === href}
                        tooltip={project.name}
                        className="h-9 text-[0.9375rem] font-medium"
                      >
                        <Link href={href}>
                          <span
                            className={cn(
                              'grid size-5 shrink-0 place-items-center rounded text-[0.6875rem] font-semibold',
                              active
                                ? 'bg-gradient-primary text-on-gradient'
                                : 'bg-raised text-muted-foreground',
                            )}
                          >
                            {project.idPrefix.slice(0, 2)}
                          </span>
                          <span className="truncate">{project.name}</span>
                        </Link>
                      </SidebarMenuButton>
                      {needs > 0 && (
                        <SidebarMenuBadge className="right-8 tabular text-st-yellow">
                          {needs}
                        </SidebarMenuBadge>
                      )}
                      <CollapsibleTrigger asChild>
                        <button
                          className="absolute top-[calc((2.25rem_-_max(1.5rem,24px))/2)] right-1 grid size-[max(1.5rem,24px)] place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent group-data-[collapsible=icon]:hidden"
                          aria-label={`Toggle ${project.name}`}
                        >
                          <CaretRightIcon className="size-3.5 transition-transform group-data-[state=open]/collapsible:rotate-90" />
                        </button>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <SidebarMenuSub>
                          <ControlRow id={project.controlSessionId}>
                            <SidebarMenuSubItem className={SELECTED}>
                              <SidebarMenuSubButton
                                asChild
                                size="md"
                                className="h-8"
                                isActive={
                                  !!project.controlSessionId &&
                                  location === chatHref(project.controlSessionId)
                                }
                              >
                                <Link
                                  href={project.controlSessionId ? chatHref(project.controlSessionId) : href}
                                >
                                  <ChatTeardropTextIcon className="size-4" />
                                  <span className="truncate">Control chat</span>
                                  <div className="ml-auto flex shrink-0 items-center gap-1">
                                    <Marks session={control} />
                                    <LiveStatus
                                      status={control?.status ?? 'missing'}
                                      labelled={false}
                                      unread={control?.unread}
                                    />
                                  </div>
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          </ControlRow>
                          {(() => {
                            const open = pinnedFirst(
                              tasks.filter(
                                (t) => t.stage !== 'done' && !sessions.get(t.aoeSessionId)?.archived,
                              ),
                              (t) => !!sessions.get(t.aoeSessionId)?.pinned,
                            );
                            const order = open.map((t) => t.aoeSessionId);
                            return open.map((t) => {
                              const { icon: I, color } = STAGE_META[t.stage];
                              const taskHref = `${href}/t/${t.id}`;
                              const s = sessions.get(t.aoeSessionId);
                              return (
                                <SessionMenu key={t.id} sessionId={t.aoeSessionId} order={order}>
                                  <SidebarMenuSubItem className={SELECTED}>
                                    <SidebarMenuSubButton
                                      asChild
                                      size="md"
                                      isActive={location === taskHref || location.startsWith(`${taskHref}/`)}
                                      className="h-8"
                                    >
                                      <Link href={taskHref}>
                                        <I
                                          weight="bold"
                                          className={cn('size-4', color)}
                                          aria-hidden={false}
                                          role="img"
                                          aria-label={STAGE_LABEL[t.stage]}
                                        />
                                        {t.name ? (
                                          <span className="shrink-0 font-medium" title={t.id}>
                                            {t.name}
                                          </span>
                                        ) : (
                                          <span
                                            translate="no"
                                            className="font-mono text-[0.8125rem] text-muted-foreground"
                                          >
                                            {t.id.split('-')[1]}
                                          </span>
                                        )}
                                        <span className={cn('truncate', t.name && 'text-muted-foreground')}>
                                          {t.title}
                                        </span>
                                        {/* A div, not a span: the sidebar truncates a row's last span, which clipped these icons. */}
                                        <div className="ml-auto flex shrink-0 items-center gap-1">
                                          <Marks session={s} />
                                          {s && (s.status === 'waiting' || s.status === 'error') && (
                                            <LiveStatus status={s.status} labelled={false} />
                                          )}
                                        </div>
                                      </Link>
                                    </SidebarMenuSubButton>
                                  </SidebarMenuSubItem>
                                </SessionMenu>
                              );
                            });
                          })()}
                          {/* Started by the control chat straight through AoE, not as tasks. */}
                          {spawned.map((s) => {
                            const name = project.crew?.[s.id];
                            return (
                              <SessionMenu key={s.id} sessionId={s.id} order={spawned.map((x) => x.id)}>
                                <SidebarMenuSubItem className={SELECTED}>
                                  <SidebarMenuSubButton
                                    asChild
                                    size="md"
                                    isActive={location === chatHref(s.id)}
                                    className="h-8"
                                  >
                                    <Link
                                      href={chatHref(s.id)}
                                      title={`${s.title}, started by the control chat`}
                                    >
                                      <TerminalWindowIcon className="size-4" />
                                      {name && <span className="shrink-0 font-medium">{name}</span>}
                                      <span className={cn('truncate', name && 'text-muted-foreground')}>
                                        {s.title}
                                      </span>
                                      <div className="ml-auto flex shrink-0 items-center gap-1">
                                        <Marks session={s} />
                                        <LiveStatus status={s.status} labelled={false} unread={s.unread} />
                                      </div>
                                    </Link>
                                  </SidebarMenuSubButton>
                                </SidebarMenuSubItem>
                              </SessionMenu>
                            );
                          })}
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </SidebarMenuItem>
                  </Collapsible>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {groups.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel className="text-[0.8125rem]">Other AoE sessions</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {groups.map((g) => (
                  <SidebarMenuItem key={g.parent?.id ?? 'standalone'}>
                    <SidebarMenuButton
                      asChild
                      tooltip={g.parent?.title ?? 'Standalone sessions'}
                      className="h-8"
                    >
                      <Link href={`/#${g.parent ? `group-${g.parent.id}` : 'standalone'}`}>
                        <TerminalWindowIcon className="size-4" />
                        <span className="truncate">{g.parent?.title ?? 'Standalone'}</span>
                        <span className="ml-auto flex items-center gap-1.5">
                          {g.children.some((c) => c.status === 'waiting') && (
                            <LiveStatus status="waiting" labelled={false} />
                          )}
                          <span className="tabular text-[0.8125rem] text-muted-foreground">
                            {g.children.length}
                          </span>
                        </span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter className="gap-0.5 pb-2">
        <UsageMeter usage={snap.usage ?? null} />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={location === '/settings'}
              tooltip="Settings"
              className="h-8 text-[0.9375rem]"
            >
              <Link href="/settings">
                <GearSixIcon weight={location === '/settings' ? 'fill' : 'regular'} className="size-4" />
                <span>Settings</span>
                {snap.health.config.restartRequired.length > 0 && (
                  <span className="ml-auto text-[0.8125rem] text-st-yellow">Restart</span>
                )}
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={onToggleTheme}
              tooltip="Toggle theme"
              className="h-8 text-[0.9375rem]"
            >
              {theme === 'dark' ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
              <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="px-2 pt-1 text-xs leading-snug text-muted-foreground group-data-[collapsible=icon]:hidden">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                'size-2 rounded-full',
                aoe.state === 'ok' ? 'bg-st-green' : aoe.state === 'starting' ? 'bg-st-yellow' : 'bg-st-red',
              )}
              aria-hidden
            />
            AoE {aoe.serveVersion ?? aoe.installedVersion ?? ''}{' '}
            {aoe.state === 'ok' ? 'connected' : aoe.state}
          </div>
          <div>Supercharge {snap.health.daemon.version}</div>
        </div>
      </SidebarFooter>
      <SidebarRail />
      <AddProjectDialog
        snap={snap}
        open={adding}
        onOpenChange={setAdding}
        onAdopt={(id) => {
          setAdding(false);
          setAdopting(id);
        }}
      />
      <AdoptDialog snap={snap} sessionId={adopting} onOpenChange={(o) => !o && setAdopting(null)} />
    </Sidebar>
  );
}
