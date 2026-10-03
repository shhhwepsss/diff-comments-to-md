import { useCallback, useSyncExternalStore } from 'react';
import type { ActiveDiff, DiffStore } from './diffStore';

/** The diff of one file, re-rendering the caller only when that file's entry changes. */
export function useFileDiff(store: DiffStore, path: string | null): ActiveDiff | null {
  const subscribe = useCallback((listener: () => void) => (path === null ? () => undefined : store.subscribe(path, listener)), [store, path]);
  return useSyncExternalStore(subscribe, () => (path === null ? null : store.get(path)));
}
