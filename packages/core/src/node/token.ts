import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, readFile } from 'node:fs/promises';
import { ensureDir, writeFileAtomic } from './fs.ts';
import type { Paths } from './paths.ts';

/** Local auth token: 32 random bytes as hex, mode 0600, config dir 0700 (SPEC §12). */
export async function ensureToken(paths: Paths): Promise<string> {
  await ensureDir(paths.configDir, 0o700);
  await chmod(paths.configDir, 0o700).catch(() => {});
  try {
    const t = (await readFile(paths.tokenFile, 'utf8')).trim();
    if (/^[0-9a-f]{64}$/.test(t)) {
      await chmod(paths.tokenFile, 0o600).catch(() => {});
      return t;
    }
  } catch {
    // create below
  }
  const token = randomBytes(32).toString('hex');
  await writeFileAtomic(paths.tokenFile, `${token}\n`, 0o600);
  return token;
}

export async function readToken(paths: Paths): Promise<string | null> {
  try {
    const t = (await readFile(paths.tokenFile, 'utf8')).trim();
    return /^[0-9a-f]{64}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

export function hmac(key: string, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
