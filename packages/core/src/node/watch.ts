import { readdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { WatchBook, WatchLogEntry } from '../shared/watch.ts';
import { readJson, writeFileAtomic, writeJsonAtomic } from './fs.ts';
import type { Paths } from './paths.ts';

/**
 * Worker watch state, all under the state dir's `watch/`: the keys it told (`book.json`), each
 * project's log (`projects/<name>.json`), and pane captures for the control chat to read (`logs/`).
 * Only the daemon writes these.
 */
const watchDir = (paths: Paths) => join(paths.stateDir, 'watch');
const bookFile = (paths: Paths) => join(watchDir(paths), 'book.json');
const logFile = (paths: Paths, project: string) => join(watchDir(paths), 'projects', `${project}.json`);
export const watchCaptureDir = (paths: Paths) => join(watchDir(paths), 'logs');

/** Entries kept in a project's log. */
export const WATCH_LOG_MAX = 200;
/** Days a pane capture is kept. */
export const WATCH_CAPTURE_DAYS = 7;

export async function readWatchBook(paths: Paths): Promise<WatchBook> {
  const f = await readJson<{ schema: 1; book: WatchBook }>(bookFile(paths)).catch(() => null);
  return { seen: f?.book.seen ?? {}, started: f?.book.started ?? {} };
}

export async function writeWatchBook(paths: Paths, book: WatchBook): Promise<void> {
  await writeJsonAtomic(bookFile(paths), { schema: 1, book }, 0o600);
}

/** A project's watch log, oldest first. */
export async function readWatchLog(paths: Paths, project: string): Promise<WatchLogEntry[]> {
  const f = await readJson<{ schema: 1; entries: WatchLogEntry[] }>(logFile(paths, project)).catch(
    () => null,
  );
  return f?.entries ?? [];
}

export async function writeWatchLog(paths: Paths, project: string, entries: WatchLogEntry[]): Promise<void> {
  await writeJsonAtomic(
    logFile(paths, project),
    { schema: 1, entries: entries.slice(-WATCH_LOG_MAX) },
    0o600,
  );
}

const CAPTURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.txt$/;

/** Saves a worker's pane text; returns its full path. */
export async function saveWatchCapture(
  paths: Paths,
  sessionId: string,
  text: string,
  now: Date,
): Promise<string> {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const name = `${sessionId.replace(/[^A-Za-z0-9_-]/g, '')}-${stamp}.txt`;
  const file = join(watchCaptureDir(paths), name);
  await writeFileAtomic(file, text.endsWith('\n') ? text : `${text}\n`, 0o600);
  return file;
}

/** The full path of a capture by its file name, or null for any name that isn't one of ours. */
export function watchCapturePath(paths: Paths, name: string): string | null {
  if (!CAPTURE_NAME.test(name) || basename(name) !== name) return null;
  return join(watchCaptureDir(paths), name);
}

/** Drops captures older than WATCH_CAPTURE_DAYS. */
export async function pruneWatchCaptures(paths: Paths, now: Date): Promise<void> {
  const dir = watchCaptureDir(paths);
  const names = await readdir(dir).catch(() => [] as string[]);
  const cutoff = now.getTime() - WATCH_CAPTURE_DAYS * 86_400_000;
  for (const name of names) {
    if (!CAPTURE_NAME.test(name)) continue;
    const st = await stat(join(dir, name)).catch(() => null);
    if (st && st.mtimeMs < cutoff) await rm(join(dir, name), { force: true });
  }
}
