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
import { chatHref } from '@/lib/nav';
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
                  <Link href="/">
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
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel className="text-[0.8125rem]">Projects</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {projects.length === 0 && (
                <p className="px-2 py-1.5 text-[0.8125rem] text-muted-foreground group-data-[collapsible=icon]:hidden">
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
                          <SidebarMenuSubItem>
                            <SidebarMenuSubButton
                              asChild
                              size="md"
                              className="h-8"
                              isActive={
                                !!project.controlSessionId && location === chatHref(project.controlSessionId)
                              }
                            >
                              <Link
                                href={project.controlSessionId ? chatHref(project.controlSessionId) : href}
                              >
                                <ChatTeardropTextIcon className="size-4" />
                                <span className="truncate">Control chat</span>
                                <div className="ml-auto flex shrink-0">
                                  <LiveStatus
                                    status={control?.status ?? 'missing'}
                                    labelled={false}
                                    unread={control?.unread}
                                  />
                                </div>
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
                                      <span
                                        translate="no"
                                        className="font-mono text-[0.8125rem] text-muted-foreground"
                                      >
                                        {t.id.split('-')[1]}
                                      </span>
                                      <span className="truncate">{t.title}</span>
                                      {s && (s.status === 'waiting' || s.status === 'error') && (
                                        // A div, not a span: the sidebar truncates a row's last span, which clipped this icon.
                                        <div className="ml-auto flex shrink-0">
                                          <LiveStatus status={s.status} labelled={false} />
                                        </div>
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
    </Sidebar>
  );
}
