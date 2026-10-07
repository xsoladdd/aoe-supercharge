import { join } from 'node:path';
import { readJson, withLock, writeJsonAtomic } from './fs.ts';
import type { Paths } from './paths.ts';

/**
 * Needs-you items you dismissed (SPEC §10.2): only "Control chat replied", by control chat session id,
 * with when you dismissed it. A newer reply (one that finished after that) brings it back.
 */
interface DismissedFile {
  schema: 1;
  controlReplied: Record<string, string>;
}

const dismissedFile = (paths: Paths) => join(paths.dataDir, 'needs-you.json');

export async function readDismissed(paths: Paths): Promise<Record<string, string>> {
  const f = await readJson<DismissedFile>(dismissedFile(paths)).catch(() => null);
  return f?.controlReplied ?? {};
}

/** Notes that you dismissed a control chat's reply at `at`; returns every dismissal. */
export async function dismissControlReply(
  paths: Paths,
  sessionId: string,
  at: string,
): Promise<Record<string, string>> {
  return withLock(paths.dataDir, async () => {
    const controlReplied = await readDismissed(paths);
    controlReplied[sessionId] = at;
    await writeJsonAtomic(dismissedFile(paths), { schema: 1, controlReplied } satisfies DismissedFile, 0o600);
    return controlReplied;
  });
}
