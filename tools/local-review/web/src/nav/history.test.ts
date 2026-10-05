import { describe, expect, it } from 'vitest';
import { NavHistory, navIndexOf, snapshotOf, withNavIndex, type HistoryLike, type StorageLike } from './history';

/** A browser history in miniature: a list of entries and a cursor, popstate left to the test. */
function fakeHistory(initial: { state: unknown; url: string }) {
  const entries = [initial];
  let at = 0;
  const h: HistoryLike & { url: () => string; entries: typeof entries } = {
    get state() {
      return entries[at].state;
    },
    pushState(state, _u, url) {
      entries.splice(at + 1);
      entries.push({ state, url: url ?? entries[at].url });
      at += 1;
    },
    replaceState(state, _u, url) {
      entries[at] = { state, url: url ?? entries[at].url };
    },
    back() {
      if (at > 0) at -= 1;
    },
    forward() {
      if (at < entries.length - 1) at += 1;
    },
    url: () => entries[at].url,
    entries,
  };
  return h;
}

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe('nav index in history.state', () => {
  it('reads only positive integers', () => {
    expect(navIndexOf(null)).toBe(0);
    expect(navIndexOf({ rvNav: 3 })).toBe(3);
    expect(navIndexOf({ rvNav: -1 })).toBe(0);
    expect(navIndexOf({ rvNav: '2' })).toBe(0);
  });

  it('keeps what else is in the state', () => {
    expect(withNavIndex({ other: 1 }, 2)).toEqual({ other: 1, rvNav: 2 });
    expect(withNavIndex('junk', 1)).toEqual({ rvNav: 1 });
  });

  it('enables ← above the review start and → below the furthest step', () => {
    expect(snapshotOf(0, 0)).toEqual({ canBack: false, canForward: false });
    expect(snapshotOf(1, 3)).toEqual({ canBack: true, canForward: true });
    expect(snapshotOf(3, 3)).toEqual({ canBack: true, canForward: false });
  });
});

describe('NavHistory', () => {
  it('pushes jumps and steps back and forward through them', () => {
    const h = fakeHistory({ state: null, url: '#/r?file=a.ts' });
    const nav = new NavHistory(h, memoryStorage(), '#/r');
    expect(nav.getSnapshot()).toEqual({ canBack: false, canForward: false });

    nav.replace('#/r?file=a.ts&line=4');
    nav.push('#/r?file=b.ts&line=10');
    nav.push('#/r?file=c.ts&line=2');
    expect(nav.getSnapshot()).toEqual({ canBack: true, canForward: false });
    expect(h.entries.map((e) => e.url)).toEqual(['#/r?file=a.ts&line=4', '#/r?file=b.ts&line=10', '#/r?file=c.ts&line=2']);

    expect(nav.back()).toBe(true);
    nav.sync(); // popstate
    expect(h.url()).toBe('#/r?file=b.ts&line=10');
    expect(nav.getSnapshot()).toEqual({ canBack: true, canForward: true });

    nav.back();
    nav.sync();
    expect(h.url()).toBe('#/r?file=a.ts&line=4');
    expect(nav.getSnapshot()).toEqual({ canBack: false, canForward: true });
    // Nothing behind inside the review: the key is the browser's.
    expect(nav.back()).toBe(false);

    nav.forward();
    nav.sync();
    expect(h.url()).toBe('#/r?file=b.ts&line=10');
  });

  it('a new jump drops what was ahead', () => {
    const h = fakeHistory({ state: null, url: '#/r?file=a.ts' });
    const nav = new NavHistory(h, memoryStorage(), '#/r');
    nav.push('#/r?file=b.ts');
    nav.push('#/r?file=c.ts');
    nav.back();
    nav.sync();
    nav.push('#/r?file=d.ts');
    expect(nav.getSnapshot()).toEqual({ canBack: true, canForward: false });
    expect(nav.forward()).toBe(false);
  });

  it('remembers the furthest step across a reload of the same review only', () => {
    const storage = memoryStorage();
    const h = fakeHistory({ state: null, url: '#/r?file=a.ts' });
    const nav = new NavHistory(h, storage, '#/r');
    nav.push('#/r?file=b.ts');
    nav.push('#/r?file=c.ts');
    nav.back();
    nav.sync();
    // Reload: a new object on the same history entry.
    const again = new NavHistory(h, storage, '#/r');
    expect(again.getSnapshot()).toEqual({ canBack: true, canForward: true });
    const other = new NavHistory(fakeHistory({ state: null, url: '#/q' }), storage, '#/q');
    expect(other.getSnapshot()).toEqual({ canBack: false, canForward: false });
  });

  it('works without storage, and with storage that throws', () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const nav = new NavHistory(fakeHistory({ state: null, url: '#/r' }), throwing, '#/r');
    nav.push('#/r?file=b.ts');
    expect(nav.getSnapshot().canBack).toBe(true);
    const bare = new NavHistory(fakeHistory({ state: { rvNav: 2 }, url: '#/r' }), null, '#/r');
    expect(bare.getSnapshot()).toEqual({ canBack: true, canForward: false });
  });

  it('a fresh entry (back from settings) has nothing ahead, whatever was remembered', () => {
    const storage = memoryStorage();
    const h = fakeHistory({ state: null, url: '#/r?file=a.ts' });
    const nav = new NavHistory(h, storage, '#/r');
    nav.push('#/r?file=b.ts');
    nav.push('#/r?file=c.ts');
    // The settings page and back: two entries the review did not push, then a remount.
    h.pushState(null, '', '#/settings');
    h.pushState(null, '', '#/r?file=c.ts');
    const again = new NavHistory(h, storage, '#/r');
    expect(again.getSnapshot()).toEqual({ canBack: false, canForward: false });
    // Reloaded on that entry, it is still the same: the stamp survives.
    expect(new NavHistory(h, storage, '#/r').getSnapshot()).toEqual({ canBack: false, canForward: false });
  });

  it('an address typed by hand is a step forward from where the review was', () => {
    const h = fakeHistory({ state: null, url: '#/r?file=a.ts' });
    const nav = new NavHistory(h, memoryStorage(), '#/r');
    nav.push('#/r?file=b.ts');
    nav.back();
    nav.sync();
    expect(nav.getSnapshot()).toEqual({ canBack: false, canForward: true });
    h.pushState(null, '', '#/r?file=z.ts'); // the browser, on a typed address
    nav.sync();
    expect(nav.getSnapshot()).toEqual({ canBack: true, canForward: false });
    nav.sync(); // hashchange after popstate: no second step
    expect(nav.getSnapshot()).toEqual({ canBack: true, canForward: false });
    expect(nav.back()).toBe(true);
    nav.sync();
    expect(h.url()).toBe('#/r?file=a.ts');
    expect(nav.getSnapshot()).toEqual({ canBack: false, canForward: true });
  });

  it('notifies only when the buttons change', () => {
    const nav = new NavHistory(fakeHistory({ state: null, url: '#/r' }), null, '#/r');
    let calls = 0;
    nav.subscribe(() => calls++);
    nav.push('#/r?file=b.ts');
    nav.push('#/r?file=c.ts');
    expect(calls).toBe(1);
  });
});
