import { join } from 'node:path';
import { readJson, withLock, writeJsonAtomic } from './fs.ts';
import type { Paths } from './paths.ts';

/**
 * Needs-you items you dismissed (SPEC §10.2), by item id, with when you dismissed them. Something new
 * on an item (a `since` past the dismissal) brings it back.
 */
interface DismissedFile {
  schema: 1;
  items?: Record<string, string>;
  /** Older files: only "Control chat replied" could be dismissed, by control chat session id. */
  controlReplied?: Record<string, string>;
}

const dismissedFile = (paths: Paths) => join(paths.dataDir, 'needs-you.json');
/** Dismissals kept, newest first: enough for every item that could still show. */
const KEEP = 500;

export async function readDismissed(paths: Paths): Promise<Record<string, string>> {
  const f = await readJson<DismissedFile>(dismissedFile(paths)).catch(() => null);
  const older = Object.entries(f?.controlReplied ?? {}).map(([id, at]) => [`control_replied:${id}`, at]);
  return { ...Object.fromEntries(older), ...(f?.items ?? {}) };
}

/** Notes that you dismissed the Needs-you item `id` at `at`; returns every dismissal. */
export async function dismissNeedsYou(paths: Paths, id: string, at: string): Promise<Record<string, string>> {
  return withLock(paths.dataDir, async () => {
    const all = Object.entries({ ...(await readDismissed(paths)), [id]: at });
    const items = Object.fromEntries(all.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1])).slice(0, KEEP));
    await writeJsonAtomic(dismissedFile(paths), { schema: 1, items } satisfies DismissedFile, 0o600);
    return items;
  });
}
