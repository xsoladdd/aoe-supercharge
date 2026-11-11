import { isRelayed, needsYouShownOn, type NeedsYouItem } from '@aoe-supercharge/core/shared';
import { useEffect, useSyncExternalStore } from 'react';

const SEEN_KEY = 'supercharge:needs-you-seen';
/** Entries kept, newest first: older ones are items long gone. */
const SEEN_KEEP = 500;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type Item = Pick<NeedsYouItem, 'id' | 'since'>;

/** Item id → the event time (`since`) it had when you saw it. */
export type SeenMap = Readonly<Record<string, string>>;

export interface SeenState {
  seen: SeenMap;
  /** Seen during this look at the dashboard (since it last came to the front): still shown as new. */
  fresh: ReadonlySet<string>;
}

const freshKey = (i: Item) => `${i.id}@${i.since}`;

/** Seen at its latest event, the same id + time model as dismissing: a newer event makes it new again. */
export function isSeen(seen: SeenMap, item: Item): boolean {
  const at = seen[item.id];
  if (!at) return false;
  const a = Date.parse(at);
  const b = Date.parse(item.since);
  return Number.isNaN(a) || Number.isNaN(b) ? at === item.since : a >= b;
}

/** Seen before this look: the Needs-you list shows it in a quieter style. */
export const seenBefore = (s: SeenState, item: Item) => isSeen(s.seen, item) && !s.fresh.has(freshKey(item));

/** What the tab icon, the title and the sidebar count: not passed on (counted once), not seen yet. */
export const unseen = (items: NeedsYouItem[], seen: SeenMap) =>
  items.filter((i) => !isRelayed(i) && !isSeen(seen, i));

/**
 * The Needs-you items you have seen, kept per browser (SPEC §10.2). Without storage (a private window,
 * blocked site data) it still works for the life of the page.
 */
export class SeenStore {
  private state: SeenState | null = null;
  private listeners = new Set<() => void>();

  constructor(private storage: () => StorageLike | null) {}

  get = (): SeenState => {
    if (this.state) return this.state;
    const seen: Record<string, string> = {};
    try {
      const v: unknown = JSON.parse(this.storage()?.getItem(SEEN_KEY) ?? '{}');
      if (v && typeof v === 'object' && !Array.isArray(v))
        for (const [id, at] of Object.entries(v)) if (typeof at === 'string') seen[id] = at;
    } catch {
      // unreadable: nothing seen yet
    }
    this.state = { seen, fresh: new Set() };
    return this.state;
  };

  /** Marks items seen at their current event. */
  mark(items: Item[]) {
    const { seen, fresh } = this.get();
    const now = items.filter((i) => !isSeen(seen, i));
    if (!now.length) return;
    const next: Record<string, string> = { ...seen };
    const nextFresh = new Set(fresh);
    for (const i of now) {
      next[i.id] = i.since;
      nextFresh.add(freshKey(i));
    }
    const t = (at: string) => Date.parse(at) || 0;
    const kept = Object.fromEntries(
      Object.entries(next)
        .sort(([, a], [, b]) => t(b) - t(a))
        .slice(0, SEEN_KEEP),
    );
    this.set({ seen: kept, fresh: nextFresh });
    try {
      this.storage()?.setItem(SEEN_KEY, JSON.stringify(kept));
    } catch {
      // kept for this page only
    }
  }

  /** The dashboard left the front: what you saw during this look is no longer new. */
  endLook() {
    const s = this.get();
    if (s.fresh.size) this.set({ seen: s.seen, fresh: new Set() });
  }

  /** Another tab marked something seen. */
  reload() {
    const fresh = this.state?.fresh ?? new Set<string>();
    this.state = null;
    this.set({ seen: this.get().seen, fresh });
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private set(s: SeenState) {
    this.state = s;
    for (const l of this.listeners) l();
  }
}

export const seenStore = new SeenStore(() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
});

if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (e.key === SEEN_KEY) seenStore.reload();
  });

export function useSeen(): SeenState {
  return useSyncExternalStore(seenStore.subscribe, seenStore.get, seenStore.get);
}

const pageInFront = () => document.visibilityState === 'visible' && document.hasFocus();

function subscribeFront(fn: () => void) {
  window.addEventListener('focus', fn);
  window.addEventListener('blur', fn);
  document.addEventListener('visibilitychange', fn);
  return () => {
    window.removeEventListener('focus', fn);
    window.removeEventListener('blur', fn);
    document.removeEventListener('visibilitychange', fn);
  };
}

/** Whether you are looking at the dashboard: its tab shows and its window has focus. */
export function usePageInFront(): boolean {
  return useSyncExternalStore(subscribeFront, pageInFront, () => true);
}

/**
 * Marks items seen while you look at a page that shows them: the chat, task or project page they
 * belong to, or any page with the Needs-you list on it (`listShown`).
 */
export function useSeenOnVisit(items: NeedsYouItem[] | undefined, path: string, listShown: boolean) {
  const front = usePageInFront();
  useEffect(() => {
    if (!front) seenStore.endLook();
  }, [front]);
  useEffect(() => {
    if (!items || !front) return;
    seenStore.mark(listShown ? items : items.filter((i) => needsYouShownOn(i, path)));
  }, [items, path, listShown, front]);
}
