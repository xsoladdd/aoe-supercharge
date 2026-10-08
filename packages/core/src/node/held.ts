import { join } from 'node:path';
import type { HeldMessage } from '../shared/held.ts';
import { readJson, writeJsonAtomic } from './fs.ts';
import type { Paths } from './paths.ts';

/** Messages the daemon holds until their session is free (`held.json` in the state dir; only the daemon writes it). */
const heldFile = (paths: Paths) => join(paths.stateDir, 'held.json');

/** Held messages by session id, oldest first. */
export async function readHeld(paths: Paths): Promise<Record<string, HeldMessage[]>> {
  const f = await readJson<{ schema: 1; sessions: Record<string, HeldMessage[]> }>(heldFile(paths)).catch(
    () => null,
  );
  return f?.sessions ?? {};
}

export async function writeHeld(paths: Paths, sessions: Record<string, HeldMessage[]>): Promise<void> {
  const kept = Object.fromEntries(Object.entries(sessions).filter(([, list]) => list.length));
  await writeJsonAtomic(heldFile(paths), { schema: 1, sessions: kept }, 0o600);
}
