import {
  CaretRightIcon,
  ChatTeardropTextIcon,
  GearSixIcon,
  MoonIcon,
  SquaresFourIcon,
  SunIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react';
import { useMemo } from 'react';
import { Link, useLocation } from 'wouter';
import { STAGE_LABEL, type Snapshot } from '@aoe-supercharge/core/shared';
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
} from '@/components/ui/sidebar';
import { projectViews, sessionMap, unmanagedGroups } from '@/lib/derive';
import { useResolvedTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

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

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader className="px-3 pt-4 pb-2">
        <Link href="/" className="rounded-md focus-visible:outline-2">
          <Wordmark />
        </Link>
      </SidebarHeader>

      <SidebarContent className="gap-1">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={location === '/'}
                  tooltip="Overview"
                  size="lg"
                  className="text-[15px]"
                >
                  <Link href="/">
                    <SquaresFourIcon weight={location === '/' ? 'fill' : 'regular'} className="size-5" />
                    <span>Overview</span>
                  </Link>
                </SidebarMenuButton>
                {snap.needsYou.length > 0 && (
                  <SidebarMenuBadge className="tabular text-st-yellow">
                    {snap.needsYou.length}
                  </SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel className="text-[13px]">Projects</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {projects.length === 0 && (
                <p className="px-2 py-1.5 text-[13px] text-muted-foreground group-data-[collapsible=icon]:hidden">
                  None yet. Run <code className="font-mono">supercharge init</code> in a repository.
                </p>
              )}
              {projects.map(({ project, control, tasks }) => {
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
                        size="lg"
                        className="text-[15px] font-medium"
                      >
                        <Link href={href}>
                          <span
                            className={cn(
                              'grid size-6 shrink-0 place-items-center rounded-md text-[12px] font-semibold',
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
                          className="absolute top-2.5 right-1.5 grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent group-data-[collapsible=icon]:hidden"
                          aria-label={`Toggle ${project.name}`}
                        >
                          <CaretRightIcon className="size-3.5 transition-transform group-data-[state=open]/collapsible:rotate-90" />
                        </button>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <SidebarMenuSub>
                          <SidebarMenuSubItem>
                            <SidebarMenuSubButton asChild size="md" className="h-9">
                              {/* Opens the chat drawer for the control session on the project page. */}
                              <Link
                                href={
                                  project.controlSessionId
                                    ? `${href}?session=${encodeURIComponent(project.controlSessionId)}`
                                    : href
                                }
                              >
                                <ChatTeardropTextIcon className="size-4" />
                                <span className="truncate">Control chat</span>
                                <span className="ml-auto">
                                  <LiveStatus
                                    status={control?.status ?? 'missing'}
                                    labelled={false}
                                    unread={control?.unread}
                                  />
                                </span>
                              </Link>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                          {tasks
                            .filter((t) => t.stage !== 'done')
                            .map((t) => {
                              const { icon: I, color } = STAGE_META[t.stage];
                              const taskHref = `${href}/t/${t.id}`;
                              const s = sessions.get(t.aoeSessionId);
                              return (
                                <SidebarMenuSubItem key={t.id}>
                                  <SidebarMenuSubButton
                                    asChild
                                    size="md"
                                    isActive={location === taskHref}
                                    className="h-9"
                                  >
                                    <Link href={taskHref}>
                                      <I
                                        weight="bold"
                                        className={cn('size-4', color)}
                                        aria-hidden={false}
                                        role="img"
                                        aria-label={STAGE_LABEL[t.stage]}
                                      />
                                      <span
                                        translate="no"
                                        className="font-mono text-[13px] text-muted-foreground"
                                      >
                                        {t.id.split('-')[1]}
                                      </span>
                                      <span className="truncate">{t.title}</span>
                                      {s && (s.status === 'waiting' || s.status === 'error') && (
                                        <span className="ml-auto">
                                          <LiveStatus status={s.status} labelled={false} />
                                        </span>
                                      )}
                                    </Link>
                                  </SidebarMenuSubButton>
                                </SidebarMenuSubItem>
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
            <SidebarGroupLabel className="text-[13px]">Other AoE sessions</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {groups.map((g) => (
                  <SidebarMenuItem key={g.parent?.id ?? 'standalone'}>
                    <SidebarMenuButton
                      asChild
                      tooltip={g.parent?.title ?? 'Standalone sessions'}
                      className="h-9"
                    >
                      <Link href={`/#${g.parent ? `group-${g.parent.id}` : 'standalone'}`}>
                        <TerminalWindowIcon className="size-4" />
                        <span className="truncate">{g.parent?.title ?? 'Standalone'}</span>
                        <span className="ml-auto flex items-center gap-1.5">
                          {g.children.some((c) => c.status === 'waiting') && (
                            <LiveStatus status="waiting" labelled={false} />
                          )}
                          <span className="tabular text-[13px] text-muted-foreground">
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

      <SidebarFooter className="gap-1 pb-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={location === '/settings'}
              tooltip="Settings"
              className="h-10 text-[15px]"
            >
              <Link href="/settings">
                <GearSixIcon weight={location === '/settings' ? 'fill' : 'regular'} className="size-5" />
                <span>Settings</span>
                {snap.health.config.restartRequired.length > 0 && (
                  <span className="ml-auto text-[13px] text-st-yellow">Restart</span>
                )}
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onToggleTheme} tooltip="Toggle theme" className="h-10 text-[15px]">
              {theme === 'dark' ? <SunIcon className="size-5" /> : <MoonIcon className="size-5" />}
              <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="px-2 pt-1 text-[13px] leading-snug text-muted-foreground group-data-[collapsible=icon]:hidden">
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
    </Sidebar>
  );
}
