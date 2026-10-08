import { useCallback, useSyncExternalStore } from 'react';
import type { Attachment } from '@aoe-supercharge/core/shared';

/**
 * What you had typed in a session's composer and not sent: the text, and files already uploaded next to
 * the session (kept as references, never uploaded again).
 */
export interface Draft {
  text: string;
  files: Attachment[];
}

interface Stored extends Draft {
  at: number;
}

const PREFIX = 'supercharge.draft.';
/** A draft untouched this long is dropped. */
export const DRAFT_KEEP_MS = 30 * 86_400_000;
export const EMPTY_DRAFT: Draft = Object.freeze({ text: '', files: [] }) as Draft;

const isEmpty = (d: Draft) => !d.text && !d.files.length;

function parse(raw: string | null): Stored | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Stored>;
    if (typeof v.text !== 'string' || !Array.isArray(v.files) || typeof v.at !== 'number') return null;
    const files = v.files.filter(
      (f): f is Attachment =>
        !!f && typeof f.path === 'string' && typeof f.name === 'string' && typeof f.image === 'boolean',
    );
    return { text: v.text, files: files.map((f) => ({ ...f, url: f.url ?? null })), at: v.at };
  } catch {
    return null;
  }
}

/**
 * Drafts by session: in memory for this page, and in browser storage so a reload keeps them. Storage
 * may be missing or throw (a private window, blocked site data): every use of it is guarded, and the
 * drafts still last while the page is open. Written on every change (no debounce), so a late write
 * can't bring back a draft you sent; only this tab's own changes write.
 */
export class DraftStore {
  private mem = new Map<string, Draft>();
  private listeners = new Set<() => void>();

  constructor(
    private storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'> | null,
    private now: () => number = () => Date.now(),
  ) {}

  get(sessionId: string): Draft {
    const known = this.mem.get(sessionId);
    if (known) return known;
    let stored: Stored | null = null;
    try {
      stored = parse(this.storage()?.getItem(PREFIX + sessionId) ?? null);
    } catch {
      stored = null;
    }
    const draft =
      stored && this.now() - stored.at < DRAFT_KEEP_MS
        ? { text: stored.text, files: stored.files }
        : EMPTY_DRAFT;
    this.mem.set(sessionId, draft);
    return draft;
  }

  set(sessionId: string, draft: Draft) {
    const next = isEmpty(draft) ? EMPTY_DRAFT : draft;
    if (next === this.mem.get(sessionId)) return;
    this.mem.set(sessionId, next);
    try {
      const s = this.storage();
      if (isEmpty(next)) s?.removeItem(PREFIX + sessionId);
      else s?.setItem(PREFIX + sessionId, JSON.stringify({ ...next, at: this.now() } satisfies Stored));
    } catch {
      // Full or blocked: the draft still lasts in memory.
    }
    for (const l of this.listeners) l();
  }

  update(sessionId: string, fn: (d: Draft) => Draft) {
    this.set(sessionId, fn(this.get(sessionId)));
  }

  /** Drop stored drafts older than `DRAFT_KEEP_MS`. */
  prune() {
    try {
      const s = this.storage();
      if (!s) return;
      const old: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (!k?.startsWith(PREFIX)) continue;
        const v = parse(s.getItem(k));
        if (!v || this.now() - v.at >= DRAFT_KEEP_MS) old.push(k);
      }
      for (const k of old) s.removeItem(k);
    } catch {
      // nothing to prune without storage
    }
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
}

export const drafts = new DraftStore(() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
});
let pruned = false;

/** A session's draft, and a way to change it; it outlives the composer (switching chats, reloads). */
export function useDraft(sessionId: string): [Draft, (fn: (d: Draft) => Draft) => void] {
  if (!pruned) {
    pruned = true;
    drafts.prune();
  }
  const draft = useSyncExternalStore(
    drafts.subscribe,
    () => drafts.get(sessionId),
    () => EMPTY_DRAFT,
  );
  const update = useCallback((fn: (d: Draft) => Draft) => drafts.update(sessionId, fn), [sessionId]);
  return [draft, update];
}

/**
 * After a send from a session: the text goes only if it is still what was sent (anything typed during
 * the send stays), and only the files that went are removed.
 */
export function clearSent(d: Draft, sent: { text: string; paths: string[] }): Draft {
  const went = new Set(sent.paths);
  return {
    text: d.text === sent.text ? '' : d.text,
    files: d.files.filter((f) => !went.has(f.path)),
  };
}

/** A held message taken back for editing goes before what is in the box, its files with the others. */
export function mergeIntoDraft(d: Draft, taken: { text: string; files: Attachment[] }): Draft {
  const known = new Set(d.files.map((f) => f.path));
  return {
    text: [taken.text, d.text].filter((t) => t.trim()).join('\n\n'),
    files: [...taken.files.filter((f) => !known.has(f.path)), ...d.files],
  };
}
