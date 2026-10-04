/**
 * Live AoE contract test (SPEC §10.3), runnable on its own and in CI:
 *   tsx scripts/contract-live.ts [--aoe-bin <path>] [--record <dir>]
 * Runs AoE in a sandbox (temporary HOME, separate tmux socket, `sh` instead of Claude). It never
 * touches the real ~/.agent-of-empires. Exits non-zero when any check fails.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { runLiveContract } from '../packages/cli/src/aoe/contract.ts';

const { values } = parseArgs({
  options: {
    'aoe-bin': { type: 'string', default: 'aoe' },
    record: { type: 'string' },
    json: { type: 'boolean' },
  },
});
const result = await runLiveContract(
  values['aoe-bin']!,
  (line) => !values.json && process.stdout.write(`${line}\n`),
);
if (values.record && result.version) {
  const dir = join(values.record, result.version);
  mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(result.fixtures)) {
    writeFileSync(
      join(dir, `${name}.${typeof data === 'string' ? 'txt' : 'json'}`),
      typeof data === 'string' ? `${data}\n` : `${JSON.stringify(data, null, 2)}\n`,
    );
  }
  if (!values.json) process.stdout.write(`recorded fixtures in ${dir}\n`);
}
if (values.json)
  process.stdout.write(
    `${JSON.stringify({ ok: result.ok, version: result.version, checks: result.checks }, null, 2)}\n`,
  );
else
  process.stdout.write(
    `\n${result.ok ? 'PASS' : 'FAIL'} AoE ${result.version ?? 'unknown'}: ${result.checks.filter((c) => c.ok).length}/${result.checks.length} checks\n`,
  );
process.exit(result.ok ? 0 : 1);
