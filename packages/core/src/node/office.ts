import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyRecord,
  filterRecord,
  historyDay,
  officeAt,
  type CharState,
  type FrameRecord,
  type HistoryFilter,
  type HistoryRecord,
} from '../shared/office-history.ts';
import type { OfficeMark } from '../shared/types.ts';
import { appendLine, readJson, withLock, writeJsonAtomic } from './fs.ts';
import type { Paths } from './paths.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** Appends records to their UTC day's file (`<state>/history/YYYY-MM-DD.jsonl`). */
export async function appendHistory(paths: Paths, records: HistoryRecord[]): Promise<void> {
  for (const r of records)
    await appendLine(join(paths.historyDir, `${historyDay(r.ts)}.jsonl`), JSON.stringify(r));
}

async function historyDays(paths: Paths): Promise<string[]> {
  const files = await readdir(paths.historyDir).catch(() => [] as string[]);
  return files
    .map((f) => DAY_FILE.exec(f)?.[1])
    .filter((d): d is string => !!d)
    .sort();
}

async function readDay(paths: Paths, day: string): Promise<HistoryRecord[]> {
  const raw = await readFile(join(paths.historyDir, `${day}.jsonl`), 'utf8').catch(() => '');
  const out: HistoryRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as HistoryRecord;
      if (r?.v === 1 && (r.type === 'move' || r.type === 'frame') && typeof r.ts === 'string') out.push(r);
    } catch {
      // a torn last line (the daemon stopped mid-write) is skipped
    }
  }
  return out;
}

export interface HistoryRange {
  /** Everyone's state at `from` (a frame at `from`), narrowed to the filter. */
  start: FrameRecord;
  /** The records after `from` up to `to`, oldest first, narrowed to the filter. */
  records: HistoryRecord[];
}

/**
 * The history between `from` and `to` (epoch ms): the state at `from`, then what happened. Reads back
 * day by day from `from` until it finds a frame, so the start state is whole.
 */
export async function readHistory(
  paths: Paths,
  from: number,
  to: number,
  filter: HistoryFilter = {},
): Promise<HistoryRange> {
  const days = await historyDays(paths);
  const fromDay = historyDay(from);
  const toDay = historyDay(to);
  const before: HistoryRecord[] = [];
  // Back from `from`'s day to the first file with a frame at or before `from`.
  for (const day of days.filter((d) => d <= fromDay).reverse()) {
    const recs = (await readDay(paths, day)).filter((r) => Date.parse(r.ts) <= from);
    before.unshift(...recs);
    if (recs.some((r) => r.type === 'frame')) break;
  }
  const chars: CharState[] = officeAt(before, from) ?? [];
  const records: HistoryRecord[] = [];
  for (const day of days.filter((d) => d >= fromDay && d <= toDay))
    for (const r of await readDay(paths, day)) {
      const t = Date.parse(r.ts);
      if (t <= from || t > to) continue;
      const f = filterRecord(r, filter);
      if (f) records.push(f);
    }
  records.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const start = filterRecord(
    { v: 1, type: 'frame', ts: new Date(from).toISOString(), chars },
    filter,
  ) as FrameRecord;
  return { start, records };
}

/** The last state the history holds (for a daemon that starts again: who was where). */
export async function lastHistoryState(paths: Paths): Promise<Map<string, CharState>> {
  const floor = new Map<string, CharState>();
  const days = await historyDays(paths);
  const recent: HistoryRecord[] = [];
  for (const day of [...days].reverse()) {
    const recs = await readDay(paths, day);
    recent.unshift(...recs);
    if (recs.some((r) => r.type === 'frame')) break;
  }
  const lastFrame = recent.map((r) => r.type).lastIndexOf('frame');
  for (const r of recent.slice(Math.max(0, lastFrame))) applyRecord(floor, r);
  return floor;
}

/** Deletes history files older than `retentionDays` (by their UTC day). Returns the days removed. */
export async function pruneHistory(paths: Paths, retentionDays: number, now = Date.now()): Promise<string[]> {
  const oldest = historyDay(now - retentionDays * DAY_MS);
  const removed: string[] = [];
  for (const day of await historyDays(paths)) {
    if (day >= oldest) continue;
    await unlink(join(paths.historyDir, `${day}.jsonl`)).catch(() => {});
    removed.push(day);
  }
  return removed;
}

interface OfficeFile {
  schema: 1;
  marks: Record<string, OfficeMark>;
}

const officeFile = (paths: Paths) => join(paths.officeDir, 'office.json');

/** Who is archived, kept or snoozed in the office, by character key. Office-only: nothing else is touched. */
export async function readOfficeMarks(paths: Paths): Promise<Record<string, OfficeMark>> {
  const f = await readJson<OfficeFile>(officeFile(paths)).catch(() => null);
  return f?.marks ?? {};
}

const EMPTY: OfficeMark = { archivedAt: null, keptAt: null, snoozedUntil: null };

/** Changes one character's mark under the office lock; a mark with nothing set is dropped. */
export async function updateOfficeMark(
  paths: Paths,
  key: string,
  change: Partial<OfficeMark>,
): Promise<Record<string, OfficeMark>> {
  return withLock(paths.officeDir, async () => {
    const marks = await readOfficeMarks(paths);
    const next = { ...EMPTY, ...marks[key], ...change };
    if (!next.archivedAt && !next.keptAt && !next.snoozedUntil) delete marks[key];
    else marks[key] = next;
    await writeJsonAtomic(officeFile(paths), { schema: 1, marks } satisfies OfficeFile, 0o600);
    return marks;
  });
}
