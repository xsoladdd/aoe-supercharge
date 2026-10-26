import { join } from 'node:path';
import type { ScheduledPrompt } from '../shared/schedule.ts';
import { readJson, writeJsonAtomic } from './fs.ts';
import type { Paths } from './paths.ts';

/** Scheduled prompts (`schedules.json` in the data dir; only the daemon writes it). */
const schedulesFile = (paths: Paths) => join(paths.dataDir, 'schedules.json');

export async function readSchedules(paths: Paths): Promise<ScheduledPrompt[]> {
  const f = await readJson<{ schema: 1; schedules: ScheduledPrompt[] }>(schedulesFile(paths));
  return f?.schedules ?? [];
}

export async function writeSchedules(paths: Paths, schedules: ScheduledPrompt[]): Promise<void> {
  await writeJsonAtomic(schedulesFile(paths), { schema: 1, schedules }, 0o600);
}
