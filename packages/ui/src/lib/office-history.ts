import { useEffect, useMemo, useState } from 'react';
import {
  eventTimes,
  historyModel,
  historyPeople,
  sortedRecords,
  stateAt,
  type HistoryFilter,
  type HistoryWindow,
  type OfficeModel,
} from '@aoe-supercharge/core/shared';
import { ApiError, getJson } from '@/lib/api';

/** How far back history mode looks. */
export const HISTORY_RANGES = [
  { hours: 1, label: 'Last hour' },
  { hours: 8, label: 'Last 8 hours' },
  { hours: 24, label: 'Last 24 hours' },
  { hours: 24 * 7, label: 'Last 7 days' },
] as const;

export const SPEEDS = [1, 10, 60] as const;
export type Speed = (typeof SPEEDS)[number];

/** How often the player moves the time on while playing. */
const STEP_MS = 250;

export async function fetchHistory(from: number, to: number): Promise<HistoryWindow> {
  const q = new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
  return getJson<HistoryWindow>(`/api/office/history?${q}`);
}

export interface HistoryPlayer {
  loading: boolean;
  error: string | null;
  from: number;
  to: number;
  at: number;
  setAt: (t: number) => void;
  playing: boolean;
  setPlaying: (on: boolean) => void;
  speed: Speed;
  setSpeed: (s: Speed) => void;
  hours: number;
  setHours: (h: number) => void;
  filter: HistoryFilter;
  setFilter: (f: HistoryFilter) => void;
  projects: string[];
  people: { key: string; name: string; project: string }[];
  /** When something happened, for stepping. */
  times: number[];
  /** The floor at `at`, drawn like the live one. */
  model: OfficeModel | null;
}

/**
 * Office history mode (SPEC §14.5): reads the history once for the range, then replays it locally as
 * you scrub or play (1x, 10x or 60x real time), narrowed to a project or an agent.
 */
export function useHistoryPlayer(active: boolean): HistoryPlayer {
  const [hours, setHours] = useState<number>(8);
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const [data, setData] = useState<HistoryWindow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(10);
  const [filter, setFilter] = useState<HistoryFilter>({});

  // Read the range when history mode opens, or the range changes; it starts at the end, where you were.
  useEffect(() => {
    if (!active) {
      setData(null);
      setRange(null);
      setPlaying(false);
      return;
    }
    const to = Date.now();
    const from = to - hours * 60 * 60 * 1000;
    let cancelled = false;
    setError(null);
    fetchHistory(from, to)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setRange({ from, to });
        setAt(to);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'The history could not be read.');
      });
    return () => {
      cancelled = true;
    };
  }, [active, hours]);

  useEffect(() => {
    if (!playing || !range) return;
    const t = setInterval(() => {
      setAt((a) => {
        const next = a + STEP_MS * speed;
        if (next >= range.to) {
          setPlaying(false);
          return range.to;
        }
        return next;
      });
    }, STEP_MS);
    return () => clearInterval(t);
  }, [playing, speed, range]);

  const sorted = useMemo(() => (data ? sortedRecords(data, filter) : []), [data, filter]);
  // Whole seconds: the floor is built again only when the second changes.
  const second = Math.floor(at / 1000);
  const model = useMemo(
    () => (data ? historyModel(stateAt(data, sorted, second * 1000 + 999, filter)) : null),
    [data, sorted, second, filter],
  );
  const people = useMemo(() => (data ? historyPeople(data) : []), [data]);

  return {
    loading: active && !data && !error,
    error,
    from: range?.from ?? 0,
    to: range?.to ?? 0,
    at,
    setAt: (t) => setAt(Math.max(range?.from ?? t, Math.min(range?.to ?? t, t))),
    playing,
    setPlaying: (on) => {
      if (on && range && at >= range.to) setAt(range.from);
      setPlaying(on);
    },
    speed,
    setSpeed,
    hours,
    setHours,
    filter,
    setFilter,
    projects: [...new Set(people.map((p) => p.project))],
    people: filter.project ? people.filter((p) => p.project === filter.project) : people,
    times: useMemo(() => eventTimes(sorted), [sorted]),
    model,
  };
}
