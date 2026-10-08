import { CircleNotchIcon, FileIcon, WarningCircleIcon, XIcon } from '@phosphor-icons/react';
import { useState, useSyncExternalStore } from 'react';
import type { Attachment } from '@aoe-supercharge/core/shared';
import { ApiError, uploadFile } from '@/lib/api';
import { drafts } from '@/lib/drafts';
import { cn } from '@/lib/utils';

export const isImage = (f: Blob) => /^image\/(png|jpe?g|gif|webp)$/.test(f.type);
const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;

/** A file on its way to the daemon's uploads folder, shown as a chip until it is in the draft. */
interface Upload {
  key: number;
  sessionId: string;
  name: string;
  /** A local preview of an image until the daemon has it. */
  preview: string | null;
  error: string | null;
  done: Promise<void>;
}

const NONE: Upload[] = [];

/**
 * Uploads by session. A file uploads as soon as you add it; once the daemon has it, it lands in the
 * draft of the session it was added to (even if you have switched chats since) as a path, which is
 * what gets sent. Outlives the composer, which unmounts whenever you switch chats.
 */
class Uploads {
  private all: Upload[] = [];
  private bySession = new Map<string, Upload[]>();
  private listeners = new Set<() => void>();
  private seq = 0;

  of = (sessionId: string): Upload[] => this.bySession.get(sessionId) ?? NONE;

  add(sessionId: string, blob: Blob, name: string) {
    const key = ++this.seq;
    const u: Upload = {
      key,
      sessionId,
      name,
      preview: isImage(blob) ? URL.createObjectURL(blob) : null,
      error: null,
      done: Promise.resolve(),
    };
    u.done = uploadFile(sessionId, blob, name).then(
      (saved) => {
        const file: Attachment = {
          path: saved.path,
          name,
          url: saved.url,
          image: IMAGE_FILE.test(saved.file),
        };
        drafts.update(sessionId, (d) => ({ ...d, files: [...d.files, file] }));
        this.drop(key);
      },
      (e: unknown) => this.patch(key, { error: e instanceof ApiError ? e.message : 'Could not upload it.' }),
    );
    this.all = [...this.all, u];
    this.emit();
  }

  /** Take a chip away (a failed upload, say). */
  drop(key: number) {
    const u = this.all.find((x) => x.key === key);
    if (!u) return;
    if (u.preview) URL.revokeObjectURL(u.preview);
    this.all = this.all.filter((x) => x.key !== key);
    this.emit();
  }

  /** Wait for a session's uploads to finish; false when any of them failed. */
  async settle(sessionId: string): Promise<boolean> {
    await Promise.all(this.of(sessionId).map((u) => u.done));
    return !this.of(sessionId).some((u) => u.error);
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private patch(key: number, p: Partial<Upload>) {
    this.all = this.all.map((x) => (x.key === key ? { ...x, ...p } : x));
    this.emit();
  }

  private emit() {
    this.bySession = new Map();
    for (const u of this.all)
      this.bySession.set(u.sessionId, [...(this.bySession.get(u.sessionId) ?? []), u]);
    for (const l of this.listeners) l();
  }
}

export const uploads = new Uploads();

export function useUploads(sessionId: string): Upload[] {
  return useSyncExternalStore(
    uploads.subscribe,
    () => uploads.of(sessionId),
    () => NONE,
  );
}

const CHIP =
  'flex h-16 max-w-48 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm';

/** The files going with the next message: uploaded ones (from the draft) and ones still uploading. */
export function AttachmentChips({ sessionId, files }: { sessionId: string; files: Attachment[] }) {
  const pending = useUploads(sessionId);
  if (!files.length && !pending.length) return null;
  const removeFile = (f: Attachment) =>
    drafts.update(sessionId, (d) => ({ ...d, files: d.files.filter((x) => x.path !== f.path) }));
  return (
    <ul aria-label="Attachments" className="flex flex-wrap gap-2 px-3 pt-3">
      {files.map((f) => (
        <li key={f.path} className="group/file relative">
          {f.image && f.url ? <Thumb src={f.url} name={f.name} /> : <FileChip name={f.name} />}
          <RemoveButton name={f.name} onClick={() => removeFile(f)} />
        </li>
      ))}
      {pending.map((u) => (
        <li key={`u${u.key}`} className="group/file relative" aria-busy={!u.error}>
          {u.preview ? (
            <img
              src={u.preview}
              alt={u.name}
              className={cn(
                'h-16 rounded-lg border object-cover',
                u.error ? 'border-attn-error/40 opacity-60' : 'border-border',
              )}
            />
          ) : (
            <span className={cn(CHIP, u.error && 'border-attn-error/40')}>
              <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{u.name}</span>
            </span>
          )}
          <span
            className={cn(
              'absolute inset-0 grid place-items-center rounded-lg',
              u.error ? 'bg-card/80 text-attn-error' : 'bg-background/40 text-muted-foreground',
            )}
            title={u.error ?? `Uploading ${u.name}…`}
          >
            {u.error ? (
              <WarningCircleIcon weight="fill" className="size-5" aria-hidden />
            ) : (
              <CircleNotchIcon className="size-5 animate-spin" aria-hidden />
            )}
            <span className="sr-only">
              {u.error ? `${u.name} did not upload: ${u.error}` : `Uploading ${u.name}…`}
            </span>
          </span>
          <RemoveButton name={u.name} onClick={() => uploads.drop(u.key)} />
        </li>
      ))}
    </ul>
  );
}

function Thumb({ src, name }: { src: string; name: string }) {
  const [gone, setGone] = useState(false);
  if (gone) return <FileChip name={name} />;
  return (
    <img
      src={src}
      alt={name}
      onError={() => setGone(true)}
      className="h-16 rounded-lg border border-border object-cover"
    />
  );
}

function FileChip({ name }: { name: string }) {
  return (
    <span className={CHIP}>
      <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{name}</span>
    </span>
  );
}

function RemoveButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Remove ${name}`}
      onClick={onClick}
      className="absolute -top-2 -right-2 grid size-6 cursor-pointer place-items-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <XIcon className="size-3" aria-hidden />
    </button>
  );
}
