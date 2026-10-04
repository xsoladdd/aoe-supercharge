import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { appendFile, chmod, mkdir, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function ensureDir(dir: string, mode = 0o755): Promise<void> {
  await mkdir(dir, { recursive: true, mode });
}

/** Write via temp file + fsync + rename + dir fsync, so readers never see a torn file (SPEC §6.2). */
export async function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o644): Promise<void> {
  await ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fh = await open(tmp, constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC, mode);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  await chmod(file, mode).catch(() => {});
  try {
    const dh = await open(dirname(file), 'r');
    await dh.sync().catch(() => {});
    await dh.close();
  } catch {
    // directory fsync is best effort (not supported everywhere)
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeJsonAtomic(file: string, value: unknown, mode = 0o644): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function appendLine(file: string, line: string): Promise<void> {
  await ensureDir(dirname(file));
  await appendFile(file, `${line}\n`, { mode: 0o600 });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Cross-process lock using an atomic `mkdir`. Locks older than `staleMs` are taken over, so a crashed
 * writer can't wedge a task forever. Critical sections are expected to last milliseconds.
 */
export async function withLock<T>(
  dir: string,
  fn: () => Promise<T>,
  opts: { staleMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const staleMs = opts.staleMs ?? 10_000;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const lockDir = join(dir, '.lock');
  await ensureDir(dir);
  const started = Date.now();
  let delay = 5;
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const st = await stat(lockDir);
        if (Date.now() - st.mtimeMs > staleMs) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for lock ${lockDir}`);
      await sleep(delay + Math.random() * delay);
      delay = Math.min(delay * 2, 100);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}
