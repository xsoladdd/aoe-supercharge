import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeFileAtomic, writeJsonAtomic, type Paths } from '@aoe-supercharge/core/node';

export const SKILL_NAMES = ['supercharge-control', 'supercharge-worker'] as const;
export const MARKER = '.supercharge-managed';

/** Works from both src/ (tests) and dist/supercharge.mjs (published): templates/ is a sibling of either. */
export const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url));

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function readTemplate(rel: string): Promise<string> {
  return readFile(join(TEMPLATES_DIR, rel), 'utf8');
}

export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');
}

export type SkillState =
  'installed' | 'updated' | 'current' | 'missing' | 'user-owned' | 'user-modified' | 'outdated';

export interface SkillReport {
  name: string;
  dir: string;
  state: SkillState;
}

interface Marker {
  version: string;
  sha256: string;
}

async function inspect(
  paths: Paths,
  name: string,
  version: string,
): Promise<SkillReport & { marker: Marker | null; onDisk: string | null; wanted: string }> {
  const dir = join(paths.claudeSkillsDir, name);
  const wanted = await readTemplate(`skills/${name}/SKILL.md`);
  const onDisk = await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => null);
  const marker = await readJson<Marker>(join(dir, MARKER)).catch(() => null);
  let state: SkillState;
  if (onDisk === null) state = 'missing';
  else if (!marker) state = 'user-owned';
  else if (marker.sha256 !== sha(onDisk)) state = 'user-modified';
  else if (onDisk !== wanted || marker.version !== version) state = 'outdated';
  else state = 'current';
  return { name, dir, state, marker, onDisk, wanted };
}

export async function skillsStatus(paths: Paths, version: string): Promise<SkillReport[]> {
  return Promise.all(
    SKILL_NAMES.map(async (n) => {
      const { name, dir, state } = await inspect(paths, n, version);
      return { name, dir, state };
    }),
  );
}

/**
 * D1: user-level skills in ~/.claude/skills. Only writes skills we own (marker present and
 * unmodified); a skill you edited or created yourself is left alone and reported by `doctor`.
 */
export async function installUserSkills(paths: Paths, version: string): Promise<SkillReport[]> {
  const out: SkillReport[] = [];
  for (const n of SKILL_NAMES) {
    const info = await inspect(paths, n, version);
    if (info.state === 'missing' || info.state === 'outdated') {
      await writeFileAtomic(join(info.dir, 'SKILL.md'), info.wanted);
      await writeJsonAtomic(join(info.dir, MARKER), { version, sha256: sha(info.wanted) } satisfies Marker);
      out.push({ name: n, dir: info.dir, state: info.state === 'missing' ? 'installed' : 'updated' });
    } else {
      out.push({ name: n, dir: info.dir, state: info.state });
    }
  }
  return out;
}

export async function removeUserSkills(paths: Paths, version: string): Promise<SkillReport[]> {
  const out: SkillReport[] = [];
  for (const n of SKILL_NAMES) {
    const info = await inspect(paths, n, version);
    if (info.state === 'current' || info.state === 'outdated') {
      await rm(info.dir, { recursive: true, force: true });
      out.push({ name: n, dir: info.dir, state: 'missing' });
    } else {
      out.push({ name: n, dir: info.dir, state: info.state });
    }
  }
  return out;
}

const BEGIN = '<!-- supercharge:begin v1 -->';
const END = '<!-- supercharge:end -->';

/** Insert or replace the managed CLAUDE.md block between markers (--commit mode). */
export function upsertManagedBlock(existing: string, block: string): string {
  const wrapped = `${BEGIN}\n${block.trim()}\n${END}`;
  const re = new RegExp(
    `<!-- supercharge:begin v\\d+ -->[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  );
  if (re.test(existing)) return existing.replace(re, wrapped);
  const sep = existing.length && !existing.endsWith('\n\n') ? (existing.endsWith('\n') ? '\n' : '\n\n') : '';
  return `${existing}${sep}${wrapped}\n`;
}

export function removeManagedBlock(existing: string): string {
  return existing
    .replace(/\n*<!-- supercharge:begin v\d+ -->[\s\S]*?<!-- supercharge:end -->\n?/, '\n')
    .replace(/\n{3,}$/, '\n');
}
