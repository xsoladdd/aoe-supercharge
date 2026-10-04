import { Fragment, useEffect, useMemo } from 'react';
import { IconContext } from '@phosphor-icons/react';
import { Link, Route, Switch, useLocation, useRoute } from 'wouter';
import { toast } from 'sonner';
import { AppSidebar } from '@/components/app-sidebar';
import { HealthBanners } from '@/components/banners';
import { BrandMark } from '@/components/brand';
import { CommandLine } from '@/components/copy';
import { NeedsYouStrip } from '@/components/needs-you';
import { SessionDrawer, TaskDrawer } from '@/components/task-drawer';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { sendJson } from '@/lib/api';
import { useSearchParam } from '@/lib/nav';
import { startLive, useLive, type Connection } from '@/lib/live';
import { setThemePref, useResolvedTheme, useSyncThemeFrom } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { OverviewPage } from '@/pages/overview';
import { ProjectPage } from '@/pages/project';
import { SettingsPage } from '@/pages/settings';

function CenterCard({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-7">
        <div className="mb-5 flex items-center gap-2.5">
          <BrandMark />
          <span className="text-[17px] font-semibold">Supercharge</span>
        </div>
        {children}
      </div>
    </main>
  );
}

function SignedOut() {
  return (
    <CenterCard>
      <h1 className="text-[22px] font-semibold">Sign in from your terminal</h1>
      <p className="mt-2 text-[15px] text-muted-foreground">
        The dashboard only accepts this machine’s local token. Run this to open a signed-in tab:
      </p>
      <CommandLine command="supercharge open" className="mt-4" />
    </CenterCard>
  );
}

function Unreachable({ error }: { error: string | null }) {
  return (
    <CenterCard>
      <h1 className="text-[22px] font-semibold">The daemon is not answering</h1>
      <p className="mt-2 text-[15px] text-muted-foreground">{error ?? 'Check that it is running:'}</p>
      <CommandLine command="supercharge status" className="mt-4" />
    </CenterCard>
  );
}

function LoadingShell() {
  return (
    <div className="flex min-h-dvh gap-2 bg-background p-2" aria-busy="true" aria-label="Loading">
      <div className="hidden w-[18.5rem] shrink-0 flex-col gap-3 p-3 md:flex">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="mt-4 h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-3/4" />
      </div>
      <div className="flex-1 space-y-4 rounded-xl bg-surface p-7">
        <Skeleton className="h-6 w-48" />
        <div className="flex gap-3">
          <Skeleton className="h-24 w-72" />
          <Skeleton className="h-24 w-72" />
        </div>
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}

function ConnectionPill({ connection }: { connection: Connection }) {
  const live = connection === 'live';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-sm',
        live ? 'text-muted-foreground' : 'text-st-yellow',
      )}
      role="status"
    >
      <span className={cn('size-2 rounded-full', live ? 'bg-st-green' : 'bg-st-yellow')} aria-hidden />
      {live ? 'Live' : 'Reconnecting'}
    </span>
  );
}

export function App() {
  const live = useLive();
  const snap = live.snapshot;
  const [location, navigate] = useLocation();
  const [, taskParams] = useRoute<{ project: string; taskId: string }>('/p/:project/t/:taskId');
  const openSession = useSearchParam('session');
  const setOpenSession = (id: string | null) =>
    navigate(id ? `${location}?session=${encodeURIComponent(id)}` : location);
  const resolved = useResolvedTheme();

  useEffect(() => {
    void startLive();
  }, []);
  useSyncThemeFrom(snap?.ui.theme);

  const crumbs = useMemo(() => {
    const parts = location.split('/').filter(Boolean);
    if (parts[0] === 'settings') return [{ label: 'Settings' }];
    if (parts[0] === 'p' && parts[1]) {
      const c: { label: string; href?: string }[] = [{ label: parts[1], href: `/p/${parts[1]}` }];
      if (parts[2] === 't' && parts[3]) c.push({ label: parts[3] });
      return c;
    }
    return [];
  }, [location]);

  if (live.connection === 'signed_out') return <SignedOut />;
  if (!snap) return live.connection === 'error' ? <Unreachable error={live.error} /> : <LoadingShell />;

  const task = taskParams
    ? (snap.tasks.find((t) => t.project === taskParams.project && t.id === taskParams.taskId) ?? null)
    : null;
  const taskSession = task ? (snap.sessions.find((s) => s.id === task.aoeSessionId) ?? null) : null;
  const session = openSession ? (snap.sessions.find((s) => s.id === openSession) ?? null) : null;

  const toggleTheme = () => {
    const next = resolved === 'dark' ? 'light' : 'dark';
    setThemePref(next);
    sendJson('PUT', '/api/config', { patch: { ui: { theme: next } } }).catch((e: Error) =>
      toast.error('Could not save the theme', { description: e.message }),
    );
  };

  return (
    // Icons are decorative by default; the few that carry meaning set aria-hidden={false} and a label.
    <IconContext.Provider
      value={{ 'aria-hidden': true } as React.ComponentProps<typeof IconContext.Provider>['value']}
    >
      <TooltipProvider delayDuration={300}>
        <a
          href="#main"
          className="sr-only z-50 rounded-md bg-card px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Skip to content
        </a>
        <SidebarProvider style={{ '--sidebar-width': '18.5rem' } as React.CSSProperties}>
          <AppSidebar snap={snap} onToggleTheme={toggleTheme} />
          <SidebarInset className="min-w-0 bg-surface">
            <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 rounded-t-xl border-b border-border bg-surface/95 px-4 backdrop-blur lg:px-6">
              <SidebarTrigger className="size-9" />
              <Separator orientation="vertical" className="h-5" />
              <Breadcrumb className="min-w-0 flex-1">
                <BreadcrumbList className="text-[15px]">
                  <BreadcrumbItem>
                    {crumbs.length ? (
                      <BreadcrumbLink asChild>
                        <Link href="/">Overview</Link>
                      </BreadcrumbLink>
                    ) : (
                      <BreadcrumbPage>Overview</BreadcrumbPage>
                    )}
                  </BreadcrumbItem>
                  {crumbs.map((c, i) => (
                    <Fragment key={c.label}>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem>
                        {c.href && i < crumbs.length - 1 ? (
                          <BreadcrumbLink asChild>
                            <Link href={c.href}>{c.label}</Link>
                          </BreadcrumbLink>
                        ) : (
                          <BreadcrumbPage
                            className={c.label.includes('-') && i === 1 ? 'font-mono' : undefined}
                          >
                            {c.label}
                          </BreadcrumbPage>
                        )}
                      </BreadcrumbItem>
                    </Fragment>
                  ))}
                </BreadcrumbList>
              </Breadcrumb>
              {snap.health.daemon.demo && (
                <span
                  className="tint rounded-full px-2.5 py-0.5 text-sm font-medium text-st-orange"
                  title="Fake AoE and sample projects from npm run demo"
                >
                  Demo data
                </span>
              )}
              <ConnectionPill connection={live.connection} />
            </header>

            <HealthBanners health={snap.health} connection={live.connection} />
            <NeedsYouStrip items={snap.needsYou} />

            <main id="main" tabIndex={-1} className="px-5 pt-4 pb-10 outline-none lg:px-7">
              <Switch>
                <Route path="/">
                  <OverviewPage snap={snap} />
                </Route>
                <Route path="/settings">
                  <SettingsPage health={snap.health} />
                </Route>
                <Route path="/p/:project" nest>
                  {(params: { project: string }) => (
                    <ProjectPage snap={snap} name={params.project} changed={live.changed} />
                  )}
                </Route>
                <Route>
                  <p className="text-[15px] text-muted-foreground">
                    Nothing here.{' '}
                    <Link href="/" className="underline">
                      Back to the overview
                    </Link>
                    .
                  </p>
                </Route>
              </Switch>
            </main>
          </SidebarInset>

          <TaskDrawer
            task={task}
            session={taskSession}
            aoeOrigin={snap.health.aoe.origin}
            open={!!task}
            onOpenChange={(o) => !o && taskParams && navigate(`/p/${taskParams.project}`)}
          />
          <SessionDrawer
            session={session}
            aoeOrigin={snap.health.aoe.origin}
            open={!!session}
            onOpenChange={(o) => !o && setOpenSession(null)}
          />
          <Toaster position="bottom-right" />
        </SidebarProvider>
      </TooltipProvider>
    </IconContext.Provider>
  );
}
