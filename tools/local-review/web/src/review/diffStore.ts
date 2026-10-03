import type { DiffResponse } from '../api/types';

/**
 * Diffs of the files of one review, by path. Not React state on purpose: a
 * file's diff arriving must re-render that file only, and the review context
 * hands every consumer a new value on any change (ReviewContext.tsx). So this
 * is a plain store with a subscription per path, read through useFileDiff.
 *
 * An entry is the same object on every read until it is replaced: the diff
 * editor is rebuilt whenever the texts or hunks it is given change identity.
 */
export type ActiveDiff =
  | { kind: 'loading' }
  | { kind: 'orphan' }
  | { kind: 'error'; message: string; cause?: unknown }
  | { kind: 'ready'; diff: DiffResponse };

export type DiffFetcher = (path: string, fresh: boolean) => Promise<DiffResponse>;

export type EnsureOptions = {
  /** Fetch even if the file is known or loading, and skip the queue: the reviewer asked for this file. */
  force?: boolean;
  /** Passed to the fetcher: bypass the server's cache. */
  fresh?: boolean;
};

export type DiffStore = {
  get: (path: string) => ActiveDiff | null;
  subscribe: (path: string, listener: () => void) => () => void;
  /**
   * Makes sure the file's diff is loaded or on its way. Resolves with the
   * entry this request produced, or null when something newer took its place
   * (a forced request for the same file, a reset).
   */
  ensure: (path: string, options?: EnsureOptions) => Promise<ActiveDiff | null>;
  /** A file that has comments but is not in the diff: nothing to fetch. */
  setOrphan: (path: string) => void;
  /** Another diff is on screen now: drop every entry and every pending answer. */
  reset: () => void;
};

/** Unforced requests in flight at once; each local one costs the server several git processes. */
const DEFAULT_LIMIT = 4;

export function createDiffStore(fetcher: DiffFetcher, limit: number = DEFAULT_LIMIT): DiffStore {
  const entries = new Map<string, ActiveDiff>();
  const listeners = new Map<string, Set<() => void>>();
  // The latest request per path; an answer to an older one is dropped.
  const tokens = new Map<string, number>();
  const pending = new Map<string, Promise<ActiveDiff | null>>();
  const queue: (() => void)[] = [];
  let generation = 0;
  let running = 0;
  let lastToken = 0;

  const notify = (path: string) => listeners.get(path)?.forEach((listener) => listener());

  const put = (path: string, entry: ActiveDiff) => {
    entries.set(path, entry);
    notify(path);
  };

  const pump = () => {
    while (running < limit && queue.length) queue.shift()?.();
  };

  const run = async (path: string, fresh: boolean, isCurrent: () => boolean): Promise<ActiveDiff | null> => {
    running += 1;
    let entry: ActiveDiff;
    try {
      entry = { kind: 'ready', diff: await fetcher(path, fresh) };
    } catch (e) {
      entry = { kind: 'error', message: e instanceof Error ? e.message : String(e), cause: e };
    }
    running -= 1;
    pump();
    if (!isCurrent()) return null;
    put(path, entry);
    return entry;
  };

  return {
    get: (path) => entries.get(path) ?? null,

    subscribe: (path, listener) => {
      const set = listeners.get(path) ?? new Set();
      listeners.set(path, set);
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(path);
      };
    },

    ensure: (path, { force = false, fresh = false } = {}) => {
      const known = entries.get(path);
      if (known && !force) return pending.get(path) ?? Promise.resolve(known);

      const token = ++lastToken;
      const born = generation;
      tokens.set(path, token);
      const isCurrent = () => born === generation && tokens.get(path) === token;
      put(path, { kind: 'loading' });

      const request =
        force || running < limit
          ? run(path, fresh, isCurrent)
          : new Promise<ActiveDiff | null>((resolve) => {
              queue.push(() => resolve(isCurrent() ? run(path, fresh, isCurrent) : null));
            });
      pending.set(path, request);
      return request;
    },

    setOrphan: (path) => {
      tokens.set(path, ++lastToken);
      pending.delete(path);
      put(path, { kind: 'orphan' });
    },

    reset: () => {
      generation += 1;
      const known = [...entries.keys()];
      entries.clear();
      tokens.clear();
      pending.clear();
      // Queued requests see the new generation and resolve empty-handed.
      queue.splice(0).forEach((job) => job());
      known.forEach(notify);
    },
  };
}
