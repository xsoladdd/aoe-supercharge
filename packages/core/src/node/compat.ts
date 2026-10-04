import semver from 'semver';
import { readJson, writeJsonAtomic } from './fs.ts';
import type { Paths } from './paths.ts';

export interface CompatFile {
  aoe: { range: string; tested: string[] };
}

export interface LocalCompat {
  verified: { version: string; verifiedAt: string }[];
}

export interface CompatResult {
  ok: boolean;
  version: string | null;
  range: string;
  verifiedLocally: boolean;
  message: string | null;
  fix: string | null;
}

/** "aoe 1.17.2" → "1.17.2" */
export function parseAoeVersion(output: string): string | null {
  const m = output.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
  return m ? (m[1] ?? null) : null;
}

export async function readLocalCompat(paths: Paths): Promise<LocalCompat> {
  return (await readJson<LocalCompat>(paths.compatLocalFile)) ?? { verified: [] };
}

export async function addLocalVerified(paths: Paths, version: string): Promise<void> {
  const local = await readLocalCompat(paths);
  if (!local.verified.some((v) => v.version === version)) {
    local.verified.push({ version, verifiedAt: new Date().toISOString() });
    await writeJsonAtomic(paths.compatLocalFile, local);
  }
}

export function isAllowed(version: string, shipped: CompatFile, local: LocalCompat): boolean {
  return (
    semver.satisfies(version, shipped.aoe.range, { includePrerelease: false }) ||
    local.verified.some((v) => v.version === version)
  );
}

export function checkCompat(version: string | null, shipped: CompatFile, local: LocalCompat): CompatResult {
  const range = shipped.aoe.range;
  if (!version) {
    return {
      ok: false,
      version: null,
      range,
      verifiedLocally: false,
      message: 'Agent of Empires (aoe) is not installed or did not report a version.',
      fix: 'Install AoE (see README#dependencies), then run "supercharge doctor".',
    };
  }
  const verifiedLocally = local.verified.some((v) => v.version === version);
  if (isAllowed(version, shipped, local)) {
    return { ok: true, version, range, verifiedLocally, message: null, fix: null };
  }
  return {
    ok: false,
    version,
    range,
    verifiedLocally,
    message: `AoE ${version} is outside the tested range ${range}.`,
    fix: 'Run "supercharge aoe upgrade" to test it, or reinstall a tested AoE release (see README#aoe-versions).',
  };
}
