/**
 * Resource check (SPEC §15): start the daemon against fake AoE, let it idle, then measure RSS,
 * idle CPU and CLI cold start. Fails above the RSS budget when RSS_LIMIT_MB is set (CI on Ubuntu).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemo } from '../e2e/harness.ts';

const IDLE_SECONDS = Number(process.env.IDLE_SECONDS ?? 60);
const limit = process.env.RSS_LIMIT_MB ? Number(process.env.RSS_LIMIT_MB) : null;
const demo = await startDemo({ dir: join(tmpdir(), 'sc-resource-check'), port: 47491, aoePort: 47492 });
const state = JSON.parse(readFileSync(join(demo.dir, '.local/state/supercharge/daemon.json'), 'utf8')) as {
  pid: number;
};
const ps = (field: string) =>
  execFileSync('ps', ['-o', `${field}=`, '-p', String(state.pid)], { encoding: 'utf8' }).trim();
const cpuSeconds = () => {
  const t = ps('time'); // [[dd-]hh:]mm:ss(.xx)
  return t
    .split(/[-:]/)
    .map(Number)
    .reverse()
    .reduce((acc, v, i) => acc + v * [1, 60, 3600, 86400][i]!, 0);
};
await new Promise((r) => setTimeout(r, 5000));
const cpu0 = cpuSeconds();
await new Promise((r) => setTimeout(r, IDLE_SECONDS * 1000));
const cpu1 = cpuSeconds();
const rssMb = Math.round(Number(ps('rss')) / 1024);
const t0 = performance.now();
execFileSync(process.execPath, [
  join(import.meta.dirname, '../packages/cli/dist/supercharge.mjs'),
  '--version',
]);
const coldStartMs = Math.round(performance.now() - t0);
await demo.stop();

const cpuPct = (((cpu1 - cpu0) / IDLE_SECONDS) * 100).toFixed(2);
const lines = [
  `| Metric | Value |`,
  `|---|---|`,
  `| Daemon idle RSS | ${rssMb} MB${limit ? ` (limit ${limit} MB)` : ''} |`,
  `| Daemon idle CPU over ${IDLE_SECONDS}s | ${cpuPct}% |`,
  `| CLI cold start (--version) | ${coldStartMs} ms |`,
];
process.stdout.write(`${lines.join('\n')}\n`);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Resource check (${process.platform})\n\n${lines.join('\n')}\n`,
  );
if (limit && rssMb > limit) {
  process.stderr.write(`Idle RSS ${rssMb} MB is over the ${limit} MB budget\n`);
  process.exit(1);
}
process.exit(0);
