/**
 * compat.json helpers for CI (SPEC §10.5):
 *   tsx scripts/compat.ts tested                 → first tested AoE version (for CI downloads)
 *   tsx scripts/compat.ts check <version>        → prints "in_range=true|false"
 *   tsx scripts/compat.ts widen <version>        → widens the range to include <version>, adds it to "tested"
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import semver from 'semver';

const file = join(import.meta.dirname, '..', 'compat.json');
const compat = JSON.parse(readFileSync(file, 'utf8')) as { aoe: { range: string; tested: string[] } };
const [cmd, version] = process.argv.slice(2);

if (cmd === 'tested') {
  process.stdout.write(`${compat.aoe.tested.at(-1)}\n`);
} else if (cmd === 'check' && version) {
  process.stdout.write(`in_range=${semver.satisfies(version, compat.aoe.range)}\n`);
} else if (cmd === 'widen' && version) {
  const min = semver.minVersion(compat.aoe.range)?.version ?? version;
  // Allow up to the tested version's minor line, the same shape as the original pin.
  const next = `${semver.major(version)}.${semver.minor(version) + 1}.0`;
  compat.aoe.range = `>=${min} <${next}`;
  if (!compat.aoe.tested.includes(version)) compat.aoe.tested.push(version);
  writeFileSync(file, `${JSON.stringify(compat, null, 2)}\n`);
  process.stdout.write(`range=${compat.aoe.range}\n`);
} else {
  process.stderr.write('usage: compat.ts tested | check <version> | widen <version>\n');
  process.exit(2);
}
