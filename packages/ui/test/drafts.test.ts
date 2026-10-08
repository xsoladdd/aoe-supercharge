import { describe, expect, it } from 'vitest';
import { clearSent, DRAFT_KEEP_MS, DraftStore, EMPTY_DRAFT, mergeIntoDraft } from '../src/lib/drafts.ts';

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
    removeItem: (k: string) => (guard(), void data.delete(k)),
    key: (i: number) => (guard(), [...data.keys()][i] ?? null),
    get length() {
      guard();
      return data.size;
    },
  };
}

const file = (path: string) => ({
  path,
  name: path.split('/').pop()!,
  url: `/api/uploads/s1/${path}`,
  image: true,
});

describe('DraftStore: what you had typed, kept per session', () => {
  it('keeps text and uploaded files across a reload, and forgets them once empty', () => {
    const storage = memoryStorage();
    const a = new DraftStore(() => storage);
    a.set('s1', { text: 'half a thought', files: [file('/u/s1/a.png')] });
    a.set('s2', { text: 'other chat', files: [] });
    // A new page: read back from storage.
    const b = new DraftStore(() => storage);
    expect(b.get('s1')).toEqual({ text: 'half a thought', files: [file('/u/s1/a.png')] });
    expect(b.get('s2').text).toBe('other chat');
    b.set('s1', { text: '', files: [] });
    expect(storage.data.has('supercharge.draft.s1')).toBe(false);
    expect(new DraftStore(() => storage).get('s1')).toBe(EMPTY_DRAFT);
  });

  it('still keeps drafts for the page when storage throws or is missing', () => {
    for (const s of [() => memoryStorage(true), () => null]) {
      const store = new DraftStore(s);
      let told = 0;
      store.subscribe(() => told++);
      store.update('s1', (d) => ({ ...d, text: 'kept in memory' }));
      expect(store.get('s1').text).toBe('kept in memory');
      expect(told).toBe(1);
      expect(() => store.prune()).not.toThrow();
    }
  });

  it('drops drafts older than a month, and ignores what it cannot read', () => {
    const storage = memoryStorage();
    let now = 1_000_000;
    const store = new DraftStore(
      () => storage,
      () => now,
    );
    store.set('old', { text: 'ancient', files: [] });
    storage.data.set('supercharge.draft.junk', '{not json');
    storage.data.set('supercharge.panelOpen', '1');
    now += DRAFT_KEEP_MS + 1;
    store.set('new', { text: 'fresh', files: [] });
    store.prune();
    expect([...storage.data.keys()].sort()).toEqual(['supercharge.draft.new', 'supercharge.panelOpen']);
    expect(
      new DraftStore(
        () => storage,
        () => now,
      ).get('old'),
    ).toBe(EMPTY_DRAFT);
  });

  it('returns the same draft until it changes (for useSyncExternalStore)', () => {
    const store = new DraftStore(() => memoryStorage());
    store.set('s1', { text: 'x', files: [] });
    expect(store.get('s1')).toBe(store.get('s1'));
  });
});

describe('after a send, and when editing a held message', () => {
  it('clears only what went: text typed meanwhile and files added meanwhile stay', () => {
    const d = { text: 'send this', files: [file('/u/s1/a.png'), file('/u/s1/b.png')] };
    expect(clearSent(d, { text: 'send this', paths: ['/u/s1/a.png'] })).toEqual({
      text: '',
      files: [file('/u/s1/b.png')],
    });
    expect(clearSent({ ...d, text: 'send this, and more' }, { text: 'send this', paths: [] }).text).toBe(
      'send this, and more',
    );
  });

  it('puts a held message back before what is in the box, without doubling files', () => {
    const d = { text: 'new thought', files: [file('/u/s1/b.png')] };
    expect(
      mergeIntoDraft(d, { text: 'held text', files: [file('/u/s1/a.png'), file('/u/s1/b.png')] }),
    ).toEqual({ text: 'held text\n\nnew thought', files: [file('/u/s1/a.png'), file('/u/s1/b.png')] });
    expect(mergeIntoDraft({ text: '', files: [] }, { text: 'only', files: [] }).text).toBe('only');
  });
});
