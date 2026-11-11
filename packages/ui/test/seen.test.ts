import { describe, expect, it } from 'vitest';
import type { NeedsYouItem } from '@aoe-supercharge/core/shared';
import { badgedIcon } from '../src/lib/favicon.ts';
import { isSeen, SeenStore, seenBefore, unseen } from '../src/lib/seen.ts';

/** A Storage stand-in; `broken` makes every call throw, like a blocked or private window. */
function memoryStorage(broken = false) {
  const data = new Map<string, string>();
  const guard = () => {
    if (broken) throw new Error('SecurityError');
  };
  return {
    data,
    getItem: (k: string) => (guard(), data.get(k) ?? null),
    setItem: (k: string, v: string) => (guard(), void data.set(k, v)),
  };
}

const item = (id: string, since: string, kind: NeedsYouItem['kind'] = 'question'): NeedsYouItem => ({
  id,
  kind,
  project: 'p',
  taskId: 'P-0001',
  sessionId: 's1',
  title: 't',
  detail: 'd',
  since,
});

describe('seen Needs-you items (per browser, id + time)', () => {
  it('an item seen stays seen until something new happens on it', () => {
    const store = new SeenStore(() => memoryStorage());
    const q = item('question:P-0001', '2026-11-11T10:00:00.000Z');
    expect(isSeen(store.get().seen, q)).toBe(false);
    store.mark([q]);
    expect(isSeen(store.get().seen, q)).toBe(true);
    // A newer question on the same task is new again.
    expect(isSeen(store.get().seen, { ...q, since: '2026-11-11T10:05:00.000Z' })).toBe(false);
  });

  it('keeps what you saw for the next visit, and shows it as new only during this look', () => {
    const storage = memoryStorage();
    const store = new SeenStore(() => storage);
    const q = item('question:P-0001', '2026-11-11T10:00:00.000Z');
    store.mark([q]);
    expect(seenBefore(store.get(), q)).toBe(false);
    store.endLook();
    expect(seenBefore(store.get(), q)).toBe(true);
    const later = new SeenStore(() => storage);
    expect(seenBefore(later.get(), q)).toBe(true);
  });

  it('counts only items not seen and not passed on', () => {
    const store = new SeenStore(() => memoryStorage());
    const a = item('a', '2026-11-11T10:00:00.000Z');
    const b = item('b', '2026-11-11T10:00:00.000Z');
    const relayed = item('r', '2026-11-11T10:00:00.000Z', 'control_relayed');
    store.mark([a]);
    expect(unseen([a, b, relayed], store.get().seen).map((i) => i.id)).toEqual(['b']);
  });

  it('works without storage, for the life of the page', () => {
    const store = new SeenStore(() => memoryStorage(true));
    const q = item('q', '2026-11-11T10:00:00.000Z');
    store.mark([q]);
    expect(isSeen(store.get().seen, q)).toBe(true);
  });

  it('ignores a stored value it cannot read', () => {
    const storage = memoryStorage();
    storage.data.set('supercharge:needs-you-seen', '[1,2');
    expect(new SeenStore(() => storage).get().seen).toEqual({});
    storage.data.set('supercharge:needs-you-seen', JSON.stringify({ a: 5, b: '2026-11-11T10:00:00.000Z' }));
    expect(new SeenStore(() => storage).get().seen).toEqual({ b: '2026-11-11T10:00:00.000Z' });
  });
});

describe('the tab icon badge', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle r="12"/></svg>';
  const decode = (url: string) => decodeURIComponent(url.replace(/^data:image\/svg\+xml,/, ''));
  it('draws the count over the icon, and 9+ past nine', () => {
    const one = decode(badgedIcon(svg, 3));
    expect(one).toContain(svg);
    expect(one).toMatch(/fill="#e5484d"/);
    expect(one).toMatch(/>3<\/text>/);
    expect(decode(badgedIcon(svg, 12))).toMatch(/>9\+<\/text>/);
  });
});
