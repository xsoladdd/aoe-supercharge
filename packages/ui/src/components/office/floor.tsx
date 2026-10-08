import {
  AppWindowIcon,
  ClockCounterClockwiseIcon,
  ArrowsOutIcon,
  ChalkboardSimpleIcon,
  CoffeeIcon,
  CookingPotIcon,
  DoorOpenIcon,
  FolderIcon,
  ListBulletsIcon,
  MinusIcon,
  PlusIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  activityLight,
  AMBIENCE,
  DOOR_BOARD,
  roomBoardId,
  weatherKind,
  windowLook,
  type NoteRecord,
  type OfficeState,
} from '@aoe-supercharge/core/shared';
import { AwaySummaryButton } from '@/components/office/away';
import { OfficeClocks } from '@/components/office/clocks';
import { HistoryBar } from '@/components/office/history-bar';
import { CostSummary } from '@/components/office/cost';
import { OfficeRoster } from '@/components/office/roster';
import { WhiteboardCard } from '@/components/office/whiteboard-card';
import { WorkerCard } from '@/components/office/worker-card';
import { Button } from '@/components/ui/button';
import { allBoardLines } from '@/lib/notes';
import type { OfficeModel } from '@/lib/office';
import { useHistoryPlayer } from '@/lib/office-history';
import { openOfficeWindow } from '@/lib/office-window';
import { OfficeScene, type SceneEvents } from '@/lib/office/scene';
import { cn } from '@/lib/utils';

const reducedQuery =
  typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      reducedQuery?.addEventListener('change', cb);
      return () => reducedQuery?.removeEventListener('change', cb);
    },
    () => !!reducedQuery?.matches,
  );
}

/**
 * The theme the page is showing, from the `dark` class on <html>. The palette reads its colours from
 * the page's tokens, so following the class keeps the floor and the UI round it in step.
 */
function usePageTheme(): 'dark' | 'light' {
  return useSyncExternalStore(
    (cb) => {
      const o = new MutationObserver(cb);
      o.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      return () => o.disconnect();
    },
    () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'),
  );
}

/** Whether the list is shown; the office window keeps its own, so hiding it there leaves the dashboard's. */
const rosterKey = (standalone: boolean) => `supercharge.office.roster${standalone ? '.window' : ''}`;

function readRosterPref(standalone: boolean): boolean {
  try {
    return localStorage.getItem(rosterKey(standalone)) !== 'hidden';
  } catch {
    return true;
  }
}

type Renderer = 'loading' | 'webgl' | 'webgpu' | 'canvas' | 'fallback';

/** Pressed-state chip over the canvas. */
function Chip({
  pressed,
  onClick,
  children,
  icon: I,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
  icon?: React.ComponentType<{ className?: string; weight?: 'bold' | 'regular' }>;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium whitespace-nowrap shadow-sm backdrop-blur transition-colors',
        pressed
          ? 'border-primary/60 bg-primary/15 text-foreground'
          : 'border-border bg-card/90 text-muted-foreground hover:text-foreground',
      )}
    >
      {I && <I className="size-4" weight={pressed ? 'bold' : 'regular'} />}
      <span className="max-w-48 truncate">{children}</span>
    </button>
  );
}

export interface FloorProps {
  office: OfficeModel;
  /** The door sign: "Ericson’s office". */
  door: string;
  now: Date;
  /** `?worker=`: pick this worker and fly to it. */
  linkWorker: string | null;
  /** `?focus=`: fly to an area. */
  linkFocus: string | null;
  /** The polite live region text from `useOffice`. */
  announcement: string;
  /** In the office window, which has no way to open another. */
  standalone?: boolean;
  /** Everything on the whiteboards: each room's, and the one by your door. */
  notes: NoteRecord[];
  /** `ui.officeAnimations`: off, everyone jumps to their place as with reduced motion. */
  animations?: boolean;
  /** Changes with every whole snapshot (a reconnect): everyone is placed again without walking. */
  epoch?: number;
  /** `office.runaway.sessionTokens`: a full meter. */
  tokenLimit?: number;
  /** The clocks, the windows and the weather at home (`snap.office`). */
  ambience?: Pick<OfficeState, 'clocks' | 'windows' | 'weather'>;
}

/**
 * The drawn office (SPEC §14.5): a PixiJS floor with chips to jump between areas, zoom controls,
 * Call next at your door, and a card for the worker you pick. The roster beside it stays the
 * accessible list of the same people; without a canvas it is all you get.
 */
export default function OfficeFloor({
  office: live,
  door,
  now,
  linkWorker,
  linkFocus,
  announcement,
  standalone = false,
  notes,
  animations = true,
  epoch = 0,
  tokenLimit = 50_000_000,
  ambience,
}: FloorProps) {
  const host = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<OfficeScene | null>(null);
  const [renderer, setRenderer] = useState<Renderer>('loading');
  const theme = usePageTheme();
  const prefersReduced = useReducedMotion();
  const reduced = prefersReduced || !animations;
  const [selected, setSelected] = useState<string | null>(linkWorker);
  /** The whiteboard whose card is open: `board` by your door, or `board:<project>`. */
  const [boardOpen, setBoardOpen] = useState<string | null>(
    !linkWorker && linkFocus?.startsWith(DOOR_BOARD) ? linkFocus : null,
  );
  const [steal, setSteal] = useState(!!linkWorker);
  const [called, setCalled] = useState<string | null>(null);
  const [following, setFollowing] = useState<string | null>(null);
  const [focus, setFocus] = useState(linkWorker ?? linkFocus ?? 'office');
  const [walking, setWalking] = useState(0);
  const [errands, setErrands] = useState('');
  const [arriving, setArriving] = useState(0);
  const [plates, setPlates] = useState('');
  const [zoom, setZoom] = useState(1);
  const [rosterOpen, setRosterOpen] = useState(() => readRosterPref(standalone));
  // History mode (SPEC §14.5): the floor as it was, replayed from the office history.
  const [inHistory, setInHistory] = useState(false);
  const player = useHistoryPlayer(inHistory);
  const history = inHistory ? player.model : null;
  const office = history ?? live;
  /** A camera move asked for before the scene was ready. */
  const pending = useRef<{ worker?: string; area?: string } | null>(
    linkWorker ? { worker: linkWorker } : linkFocus ? { area: linkFocus } : null,
  );

  // No cards and no Call next in the past: the floor is for looking at.
  const sel = selected && !inHistory ? (office.everyone.find((w) => w.key === selected) ?? null) : null;
  const next = inHistory ? null : (office.door.find((w) => w.key !== called) ?? null);

  function pick(key: string | null, from: 'floor' | 'roster' | 'link' | 'call') {
    setSelected(key);
    if (key) setBoardOpen(null);
    setSteal(from === 'link');
    if (!key || from === 'floor' || from === 'call') return;
    if (scene) scene.focusWorker(key, cardShift());
    else pending.current = { worker: key };
  }

  /** The card covers the left of the floor; put the worker in the middle of what is left. */
  function cardShift() {
    const w = host.current?.clientWidth ?? 0;
    return w > 760 ? Math.min(220, w * 0.22) : 0;
  }

  function callNext() {
    if (!next) return;
    setCalled(next.key);
    pick(next.key, 'call');
    scene?.focus('door');
  }

  function close() {
    setSelected(null);
    setFollowing(null);
    setBoardOpen(null);
  }

  /** Up to a whiteboard (by your door, or a room's), close enough to read, with its card open. */
  function openBoard(id = DOOR_BOARD) {
    setSelected(null);
    setFollowing(null);
    setBoardOpen(id);
    // The card is 26rem plus its margin; on a narrow floor it covers the board whatever we do.
    const cover = (host.current?.clientWidth ?? 0) > 760 ? 430 : 0;
    if (scene) scene.focusBoard(id, cover);
    else pending.current = { area: id };
  }

  // The scene calls back through this, so it always sees the latest state.
  const handlers = useRef<SceneEvents | null>(null);
  handlers.current = {
    select: (key) => pick(key, 'floor'),
    focus: (area) => {
      setFocus(area);
      if (area === 'free') setFollowing(null);
    },
    walking: setWalking,
    errands: (e, a) => {
      setErrands(e.join(','));
      setArriving(a);
    },
    plates: (eaters) => setPlates(eaters.join(',')),
    door: callNext,
    board: (id) => openBoard(id),
    openMr: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    zoom: setZoom,
  };

  // Start the renderer once; theme, door and motion follow below without rebuilding it.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    let made: OfficeScene | null = null;
    const events: SceneEvents = {
      select: (k) => handlers.current?.select(k),
      focus: (a) => handlers.current?.focus(a),
      walking: (n) => handlers.current?.walking(n),
      errands: (e, a) => handlers.current?.errands(e, a),
      plates: (eaters) => handlers.current?.plates(eaters),
      door: () => handlers.current?.door(),
      board: (id) => handlers.current?.board(id),
      openMr: (url) => handlers.current?.openMr(url),
      zoom: (z) => handlers.current?.zoom(z),
    };
    OfficeScene.create(el, { theme, reducedMotion: reduced, doorLabel: door, events })
      .then((s) => {
        if (cancelled) return s.destroy();
        made = s;
        setScene(s);
        setRenderer((s.renderer as Renderer) || 'webgl');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn('The office floor could not start a renderer', err);
        setRenderer('fallback');
      });
    return () => {
      cancelled = true;
      made?.destroy();
      setScene(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A reconnect brings a whole new snapshot: place everyone again, nobody walks (runs before setModel).
  const seenEpoch = useRef(epoch);
  useEffect(() => {
    if (!scene || epoch === seenEpoch.current) return;
    seenEpoch.current = epoch;
    scene.resync();
  }, [scene, epoch]);
  // In the past everyone jumps to where they were (no walking storms when you scrub or play fast),
  // except at 1x, where they walk as they did; going in and out of history jumps too.
  const wasHistory = useRef(inHistory);
  const walkHistory = player.playing && player.speed === 1;
  useEffect(() => {
    if (!scene) return;
    if (inHistory !== wasHistory.current || (inHistory && !walkHistory)) scene.resync();
    wasHistory.current = inHistory;
    scene.setModel(office);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, office]);
  const rooms = office.teams.map((t) => t.project);
  const roomKey = rooms.join('\n');
  useEffect(
    () => scene?.setBoards(allBoardLines(notes, roomKey ? roomKey.split('\n') : [])),
    [scene, notes, roomKey],
  );
  useEffect(() => scene?.setTheme(theme), [scene, theme]);
  useEffect(() => scene?.setDoorLabel(door), [scene, door]);

  // The light follows what the office is doing; the windows can show the weather at home instead.
  const light = activityLight(live, now);
  const weather = ambience?.weather ?? null;
  const weatherWindows = ambience?.windows === 'weather' && !!weather;
  const look = windowLook(ambience?.windows ?? 'activity', AMBIENCE[light.mode], weather);
  useEffect(
    () => scene?.setLight(AMBIENCE[light.mode], look, weatherWindows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scene, light.mode, look.sky, look.cloud, look.precip, weatherWindows],
  );
  useEffect(() => scene?.setReducedMotion(reduced), [scene, reduced]);
  useEffect(() => scene?.setLimits({ sessionTokens: tokenLimit }), [scene, tokenLimit]);
  useEffect(() => scene?.select(sel ? sel.key : null), [scene, sel]);
  useEffect(() => scene?.setCalled(called), [scene, called]);
  useEffect(() => scene?.follow(following), [scene, following]);

  // Deep links and moves asked for while the renderer was starting.
  useEffect(() => {
    if (!scene || !pending.current) return;
    const p = pending.current;
    pending.current = null;
    if (p.worker) scene.focusWorker(p.worker, cardShift());
    else if (p.area?.startsWith(DOOR_BOARD)) openBoard(p.area);
    else if (p.area) scene.focus(p.area === 'desk' ? 'office' : p.area);
  }, [scene]);
  useEffect(() => {
    if (linkWorker) pick(linkWorker, 'link');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkWorker]);
  useEffect(() => {
    if (linkFocus?.startsWith(DOOR_BOARD) && !linkWorker) {
      if (scene) openBoard(linkFocus);
    } else if (linkFocus && !linkWorker) scene?.focus(linkFocus === 'desk' ? 'office' : linkFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkFocus]);

  // The one you called in goes back to the line when you pick someone else or close the card,
  // and walks out on its own once you have answered.
  const calledZone = called ? office.everyone.find((w) => w.key === called)?.zone : undefined;
  useEffect(() => {
    if (called && (calledZone !== 'door' || selected !== called)) setCalled(null);
  }, [called, calledZone, selected]);
  useEffect(() => {
    if (following && following !== selected) setFollowing(null);
  }, [following, selected]);
  useEffect(() => {
    if (selected && !sel) setSelected(null);
  }, [selected, sel]);

  // Escape closes the card from anywhere on the page (Safari does not focus buttons on click), but not
  // while typing an answer or when a menu or dialog has it.
  const open = !!sel || boardOpen;
  useEffect(() => {
    if (!open) return;
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"]'))
        return;
      e.preventDefault();
      setSelected(null);
      setFollowing(null);
      setBoardOpen(null);
      host.current?.focus();
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [open]);

  function toggleRoster() {
    setRosterOpen((open) => {
      try {
        localStorage.setItem(rosterKey(standalone), open ? 'hidden' : 'shown');
      } catch {
        // private mode: it just resets next time
      }
      return !open;
    });
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    // Camera keys only while the floor itself has focus.
    if (target !== host.current || !scene) return;
    const step = 96;
    const pan: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      a: [-step, 0],
      ArrowRight: [step, 0],
      d: [step, 0],
      ArrowUp: [0, -step],
      w: [0, -step],
      ArrowDown: [0, step],
      s: [0, step],
    };
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (pan[k]) scene.nudge(...pan[k]!);
    else if (k === '+' || k === '=') scene.zoomBy(1.25);
    else if (k === '-' || k === '_') scene.zoomBy(0.8);
    else if (k === '0') scene.focus('office');
    else if (k === 'n') callNext();
    else if (k === 'f' && sel) setFollowing((f) => (f === sel.key ? null : sel.key));
    else return;
    e.preventDefault();
  }

  const at = (area: string) => ({ pressed: focus === area, onClick: () => scene?.focus(area) });
  const deskCount = office.teams.reduce((n, t) => n + t.seated.length + (t.lead?.zone === 'desk' ? 1 : 0), 0);
  const fallback = renderer === 'fallback';

  return (
    <div
      data-office-floor
      data-renderer={renderer}
      data-camera-focus={focus}
      data-walking={walking}
      data-errands={errands}
      data-arriving={arriving}
      data-plates={plates}
      data-motion={reduced ? 'jump' : 'walk'}
      data-called={called ?? ''}
      data-selected={sel?.key ?? ''}
      data-rooms={office.teams.map((t) => t.project).join(',')}
      data-light={light.mode}
      data-history={inHistory ? (history ? 'ready' : 'loading') : undefined}
      data-windows={weatherWindows && weather ? weatherKind(weather.code).kind : 'activity'}
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={onKey}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2.5 lg:px-6">
        <h1 className="text-lg font-semibold tracking-tight">Office</h1>
        <p className="tabular text-sm text-muted-foreground">
          {office.door.length} at your door · {deskCount} at desks · {office.kitchen.length} in the kitchen ·{' '}
          {office.review.length} in review · {office.pantry.length} in the pantry
          {office.away.length ? ` · ${office.away.length} away` : ''}
        </p>
        {!inHistory && <CostSummary office={live} onAttention={(key) => pick(key, 'roster')} />}
        <OfficeClocks clocks={ambience?.clocks} weather={weather} />
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
        <div className="ml-auto flex items-center gap-1">
          <AwaySummaryButton office={live} />
          {!inHistory && (
            <Button
              variant="ghost"
              className="px-3"
              title="Replay the office: scrub back through the day, or play it at 1x, 10x or 60x"
              onClick={() => {
                setSelected(null);
                setCalled(null);
                setFollowing(null);
                setInHistory(true);
              }}
              data-history-button
            >
              <ClockCounterClockwiseIcon />
              History
            </Button>
          )}
          {!standalone && (
            <Button
              variant="ghost"
              className="px-3"
              title="Open the office in a window of its own, to keep on another screen"
              onClick={openOfficeWindow}
            >
              <AppWindowIcon />
              New window
            </Button>
          )}
          {!fallback && (
            <Button
              variant="ghost"
              className="px-3"
              aria-expanded={rosterOpen}
              aria-controls="office-roster"
              onClick={toggleRoster}
            >
              <ListBulletsIcon />
              {rosterOpen ? 'Hide list' : 'Show list'}
            </Button>
          )}
        </div>
      </div>

      {inHistory && <HistoryBar player={player} onLive={() => setInHistory(false)} />}

      {fallback && (
        <div
          role="note"
          className="mx-4 mt-4 rounded-xl border border-border bg-card px-4 py-3 text-[0.9375rem] lg:mx-6"
        >
          <span className="font-medium">The office floor could not start here.</span>{' '}
          <span className="text-muted-foreground">
            This browser has no WebGL or canvas available, so everyone is listed below instead.
          </span>
        </div>
      )}

      {/* Side by side on a wide screen; on a tall one the list goes under the floor. */}
      <div className="flex min-h-0 flex-1 portrait:flex-col">
        <div className={cn('relative min-w-0 flex-1 overflow-hidden', fallback && 'hidden')}>
          <div
            ref={host}
            role="application"
            aria-roledescription="office floor"
            aria-label={`Office floor with ${office.everyone.length} workers`}
            aria-describedby="office-keys"
            tabIndex={0}
            className="absolute inset-0 cursor-grab outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[dragging=true]:cursor-grabbing"
          />
          <p id="office-keys" className="sr-only">
            Arrow keys move around, plus and minus zoom, 0 shows the whole office. N calls the next worker in
            line, F follows the worker you picked, Escape closes its card. The list beside the floor has
            everyone in it.
          </p>

          {renderer === 'loading' && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center" aria-busy="true">
              <span className="rounded-full border border-border bg-card px-4 py-2 text-sm text-muted-foreground">
                Opening the office…
              </span>
            </div>
          )}

          {/* Area chips. */}
          <nav
            aria-label="Go to"
            className="pointer-events-none absolute inset-x-0 top-0 flex gap-1.5 overflow-x-auto p-3 [&>*]:pointer-events-auto"
          >
            <Chip icon={ArrowsOutIcon} {...at('office')}>
              Whole office
            </Chip>
            <Chip icon={DoorOpenIcon} {...at('door')}>
              {door}
            </Chip>
            <Chip icon={CoffeeIcon} {...at('pantry')}>
              Pantry
            </Chip>
            <Chip icon={CookingPotIcon} {...at('kitchen')}>
              Kitchen
            </Chip>
            <Chip icon={FolderIcon} {...at('review')}>
              Review lounge
            </Chip>
            <Chip icon={ChalkboardSimpleIcon} pressed={boardOpen === DOOR_BOARD} onClick={() => openBoard()}>
              Whiteboard
            </Chip>
            {office.teams.map((t) => (
              <Chip key={t.project} icon={UsersThreeIcon} {...at(t.project)}>
                {t.project}
              </Chip>
            ))}
          </nav>

          {/* Zoom. */}
          <div className="absolute top-16 right-3 flex flex-col items-center rounded-full border border-border bg-card/90 shadow-sm backdrop-blur">
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              aria-label="Zoom in"
              onClick={() => scene?.zoomBy(1.25)}
            >
              <PlusIcon />
            </Button>
            <button
              type="button"
              onClick={() => scene?.focus('office')}
              className="tabular h-10 w-12 text-[0.8125rem] font-medium text-muted-foreground hover:text-foreground"
              title="Fit the office to the screen (0)"
              aria-label={`Zoom ${Math.round(zoom * 100)} percent, fit to screen`}
            >
              {Math.round(zoom * 100)}%
            </button>
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              aria-label="Zoom out"
              onClick={() => scene?.zoomBy(0.8)}
            >
              <MinusIcon />
            </Button>
          </div>

          {/* Call next: serve the line at your door. */}
          {next && (
            <div className="pointer-events-none absolute right-3 bottom-3">
              <Button
                variant="gradient"
                size="lg"
                className="pointer-events-auto rounded-full shadow-lg"
                onClick={callNext}
                aria-keyshortcuts="n"
              >
                <DoorOpenIcon weight="fill" />
                Call next
                <span className="tabular rounded-full bg-black/15 px-2 py-0.5 text-sm">
                  {office.door.length - (called ? 1 : 0)} waiting
                </span>
              </Button>
            </div>
          )}

          {!sel && !boardOpen && (
            <p className="pointer-events-none absolute bottom-4 left-4 hidden max-w-[calc(100%-18rem)] truncate rounded-full bg-card/80 px-3 py-1.5 text-sm text-muted-foreground backdrop-blur xl:block">
              Drag to look around, scroll to zoom, double-click to zoom in
            </p>
          )}

          {boardOpen && !sel && (
            <div className="pointer-events-none absolute top-16 bottom-16 left-3 flex flex-col justify-end">
              <WhiteboardCard
                board={boardOpen}
                all={notes}
                projects={rooms}
                now={now}
                onClose={() => {
                  close();
                  host.current?.focus();
                }}
              />
            </div>
          )}

          {sel && (
            <div className="pointer-events-none absolute top-16 bottom-16 left-3 flex flex-col justify-end">
              <WorkerCard
                w={sel}
                office={office}
                now={now}
                called={called === sel.key}
                following={following === sel.key}
                onFollow={() => setFollowing((f) => (f === sel.key ? null : sel.key))}
                onClose={() => {
                  close();
                  host.current?.focus();
                }}
                onPick={(key) => pick(key, 'roster')}
              />
            </div>
          )}
        </div>

        {(rosterOpen || fallback) && (
          <aside
            id="office-roster"
            aria-label="Everyone in the office"
            className={cn(
              'min-h-0 overflow-y-auto bg-surface px-4 py-4',
              fallback
                ? 'flex-1 lg:px-6'
                : 'w-[26rem] shrink-0 border-l border-border portrait:h-[42%] portrait:w-full portrait:border-t portrait:border-l-0',
            )}
          >
            <OfficeRoster
              office={office}
              door={door}
              now={now}
              focus={{
                worker: sel?.key ?? null,
                section: null,
                steal,
                onSelect: fallback ? undefined : (key) => pick(key, 'roster'),
                onBoard: fallback ? undefined : (project) => openBoard(roomBoardId(project)),
              }}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
