import { describe, expect, it, vi } from 'vitest';
import type { DiffResponse } from '../api/types';
import { createDiffStore } from './diffStore';

function diffOf(path: string): DiffResponse {
  return { path, status: 'M', kind: 'text', hunks: [], binary: false, additions: 1, deletions: 0 };
}

/** A fetcher whose every request is settled by hand. */
function manualFetcher() {
  const calls: { path: string; resolve: (d: DiffResponse) => void; reject: (e: unknown) => void }[] = [];
  const fetcher = (path: string) =>
    new Promise<DiffResponse>((resolve, reject) => {
      calls.push({ path, resolve, reject });
    });
  return { calls, fetcher };
}

describe('createDiffStore', () => {
  it('knows nothing about a file nobody asked for', () => {
    const { fetcher } = manualFetcher();
    expect(createDiffStore(fetcher).get('a.ts')).toBeNull();
  });

  it('goes loading, then ready, and tells the subscriber of that file only', async () => {
    const { calls, fetcher } = manualFetcher();
    const store = createDiffStore(fetcher);
    const onA = vi.fn();
    const onB = vi.fn();
    store.subscribe('a.ts', onA);
    store.subscribe('b.ts', onB);

    const done = store.ensure('a.ts');
    expect(store.get('a.ts')).toEqual({ kind: 'loading' });
    expect(onA).toHaveBeenCalledTimes(1);

    const diff = diffOf('a.ts');
    calls[0].resolve(diff);
    expect(await done).toEqual({ kind: 'ready', diff });
    expect(onA).toHaveBeenCalledTimes(2);
    expect(onB).not.toHaveBeenCalled();
  });

  it('hands back the very same entry on every read', async () => {
    const { calls, fetcher } = manualFetcher();
    const store = createDiffStore(fetcher);
    const done = store.ensure('a.ts');
    calls[0].resolve(diffOf('a.ts'));
    await done;
    expect(store.get('a.ts')).toBe(store.get('a.ts'));
  });

  it('does not fetch a file twice unless forced', async () => {
    const { calls, fetcher } = manualFetcher();
    const store = createDiffStore(fetcher);
    const first = store.ensure('a.ts');
    void store.ensure('a.ts');
    expect(calls).toHaveLength(1);
    calls[0].resolve(diffOf('a.ts'));
    await first;
    await store.ensure('a.ts');
    expect(calls).toHaveLength(1);

    void store.ensure('a.ts', { force: true });
    expect(calls).toHaveLength(2);
    expect(store.get('a.ts')).toEqual({ kind: 'loading' });
  });

  it('drops the answer of a request a forced one replaced', async () => {
    const { calls, fetcher } = manualFetcher();
    const store = createDiffStore(fetcher);
    const first = store.ensure('a.ts');
    const second = store.ensure('a.ts', { force: true });
    const late = diffOf('a.ts');
    const current = diffOf('a.ts');
    calls[1].resolve(current);
    calls[0].resolve(late);
    expect(await first).toBeNull();
    expect(await second).toEqual({ kind: 'ready', diff: current });
    const entry = store.get('a.ts');
    expect(entry?.kind === 'ready' && entry.diff).toBe(current);
  });

  it('keeps a failure as an entry, with the cause', async () => {
    const { calls, fetcher } = manualFetcher();
    const store = createDiffStore(fetcher);
    const done = store.ensure('a.ts');
    const cause = new Error('boom');
    calls[0].reject(cause);
    expect(await done).toEqual({ kind: 'error', message: 'boom', cause });
    expect(store.get('a.ts')?.kind).toBe('error');
  });

  it('marks an orphan without fetching', () => {
    const { calls, fetcher } = manualFetcher();
    const store = createDiffStore(fetcher);
    store.setOrphan('gone.ts');
    expect(store.get('gone.ts')).toEqual({ kind: 'orphan' });
    expect(calls).toHaveLength(0);
  });

  it('forgets everything on reset and ignores answers from before it', async () => {
    const { calls, fetcher } = manualFetcher();
    const store = createDiffStore(fetcher);
    const onA = vi.fn();
    store.subscribe('a.ts', onA);
    const done = store.ensure('a.ts');
    store.reset();
    expect(store.get('a.ts')).toBeNull();
    calls[0].resolve(diffOf('a.ts'));
    expect(await done).toBeNull();
    expect(store.get('a.ts')).toBeNull();
    // loading, then the reset.
    expect(onA).toHaveBeenCalledTimes(2);
  });

  it('keeps loaded diffs on screen across a reset that asks for it, marked stale', async () => {
    const { calls, fetcher } = manualFetcher();
    const store = createDiffStore(fetcher);
    const first = store.ensure('a.ts');
    const old = diffOf('a.ts');
    calls[0].resolve(old);
    await first;
    void store.ensure('b.ts');

    store.reset({ keep: true });
    expect(store.get('a.ts')).toEqual({ kind: 'ready', diff: old, stale: true });
    const kept = store.get('a.ts');
    expect(kept?.kind === 'ready' && kept.diff).toBe(old);
    // Only a loaded diff is worth keeping.
    expect(store.get('b.ts')).toBeNull();
  });

  it('re-reads a stale diff without a loading gap', async () => {
    const { calls, fetcher } = manualFetcher();
    const store = createDiffStore(fetcher);
    const first = store.ensure('a.ts');
    calls[0].resolve(diffOf('a.ts'));
    await first;
    store.reset({ keep: true });

    const again = store.ensure('a.ts');
    expect(calls).toHaveLength(2);
    expect(store.get('a.ts')?.kind).toBe('ready');
    const next = diffOf('a.ts');
    calls[1].resolve(next);
    expect(await again).toEqual({ kind: 'ready', diff: next });
    // Fresh now: asking again fetches nothing.
    await store.ensure('a.ts');
    expect(calls).toHaveLength(2);
  });

  it('keeps the very same diff when a re-read brings nothing new', async () => {
    const { calls, fetcher } = manualFetcher();
    const store = createDiffStore(fetcher);
    const first = store.ensure('a.ts');
    const old = diffOf('a.ts');
    calls[0].resolve(old);
    await first;
    store.reset({ keep: true });

    const again = store.ensure('a.ts');
    calls[1].resolve(diffOf('a.ts'));
    const entry = await again;
    expect(entry).toEqual({ kind: 'ready', diff: old });
    expect(entry?.kind === 'ready' && entry.diff).toBe(old);
  });

  it('takes the new diff when a re-read brings a change', async () => {
    const { calls, fetcher } = manualFetcher();
    const store = createDiffStore(fetcher);
    const first = store.ensure('a.ts');
    calls[0].resolve(diffOf('a.ts'));
    await first;
    store.reset({ keep: true });

    const again = store.ensure('a.ts');
    const next = { ...diffOf('a.ts'), additions: 2 };
    calls[1].resolve(next);
    const entry = await again;
    expect(entry?.kind === 'ready' && entry.diff).toBe(next);
  });

  it('asks for a stale diff once, however many times it is ensured', async () => {
    const { calls, fetcher } = manualFetcher();
    const store = createDiffStore(fetcher);
    const first = store.ensure('a.ts');
    calls[0].resolve(diffOf('a.ts'));
    await first;
    store.reset({ keep: true });
    void store.ensure('a.ts');
    void store.ensure('a.ts');
    expect(calls).toHaveLength(2);
  });

  it('runs at most `limit` requests at once and starts the rest as slots free up', async () => {
    const { calls, fetcher } = manualFetcher();
    const store = createDiffStore(fetcher, 2);
    const a = store.ensure('a.ts');
    void store.ensure('b.ts');
    const c = store.ensure('c.ts');
    expect(calls.map((x) => x.path)).toEqual(['a.ts', 'b.ts']);
    expect(store.get('c.ts')).toEqual({ kind: 'loading' });

    calls[0].resolve(diffOf('a.ts'));
    await a;
    expect(calls.map((x) => x.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    calls[2].resolve(diffOf('c.ts'));
    expect((await c)?.kind).toBe('ready');
  });

  it('starts a forced request at once, past the limit', () => {
    const { calls, fetcher } = manualFetcher();
    const store = createDiffStore(fetcher, 1);
    void store.ensure('a.ts');
    void store.ensure('b.ts');
    void store.ensure('c.ts', { force: true });
    expect(calls.map((x) => x.path)).toEqual(['a.ts', 'c.ts']);
  });

  it('never starts a queued request that a reset made pointless', async () => {
    const { calls, fetcher } = manualFetcher();
    const store = createDiffStore(fetcher, 1);
    const a = store.ensure('a.ts');
    const b = store.ensure('b.ts');
    store.reset();
    expect(await b).toBeNull();
    calls[0].resolve(diffOf('a.ts'));
    await a;
    expect(calls).toHaveLength(1);
  });

  it('stops telling a subscriber that left', () => {
    const { fetcher } = manualFetcher();
    const store = createDiffStore(fetcher);
    const onA = vi.fn();
    const leave = store.subscribe('a.ts', onA);
    leave();
    void store.ensure('a.ts');
    expect(onA).not.toHaveBeenCalled();
  });
});
