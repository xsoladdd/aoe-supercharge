import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { SAFE_ARG, type Paths } from '@aoe-supercharge/core/node';

/** Big enough for screenshots and logs, small enough to keep the daemon light. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/;

/** Served inline (thumbnails in the chat); everything else downloads, so nothing can run as the dashboard. */
const INLINE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** A file name that is safe in a path, a URL and a shell line: letters, digits, dot, dash, underscore. */
export function safeFileName(name: string): string {
  const base = basename(name)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '');
  const ext = extname(base).slice(0, 10);
  const stem = base.slice(0, base.length - ext.length).slice(0, 80) || 'file';
  return `${stem}${ext}`;
}

export interface SavedUpload {
  /** Absolute path, as Claude reads it. */
  path: string;
  file: string;
  url: string;
}

export async function saveUpload(
  paths: Pick<Paths, 'uploadsDir'>,
  sessionId: string,
  name: string,
  bytes: Uint8Array,
): Promise<SavedUpload> {
  if (!SESSION_ID.test(sessionId)) throw new Error('Bad session id');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const file = `${stamp}-${randomBytes(2).toString('hex')}-${safeFileName(name)}`;
  const dir = join(paths.uploadsDir, sessionId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, file);
  await writeFile(path, bytes, { mode: 0o600 });
  return { path, file, url: `/api/uploads/${sessionId}/${file}` };
}

export async function readUpload(
  paths: Pick<Paths, 'uploadsDir'>,
  sessionId: string,
  file: string,
): Promise<{ bytes: Buffer; type: string; inline: boolean } | null> {
  if (!SESSION_ID.test(sessionId) || !FILE_NAME.test(file)) return null;
  const bytes = await readFile(join(paths.uploadsDir, sessionId, file)).catch(() => null);
  if (!bytes) return null;
  const type = INLINE[extname(file).toLowerCase()];
  return { bytes, type: type ?? 'application/octet-stream', inline: !!type };
}

/** `--add-dir <uploads>` so new sessions can read attachments without a permission prompt. */
export function uploadArgs(paths: Pick<Paths, 'uploadsDir'>): string[] {
  return SAFE_ARG.test(paths.uploadsDir) ? ['--add-dir', paths.uploadsDir] : [];
}
