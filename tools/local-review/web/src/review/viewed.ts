import type { FileEntry, StateResponse } from '../api/types';

/**
 * The state with one file's viewed flag flipped, for an optimistic update.
 * Only a file that has a fingerprint can be marked: without one there is no
 * version of the diff to tie the mark to, and the server would refuse it.
 * Returns the same object when nothing changes, so React skips the render.
 */
export function withViewed(state: StateResponse, path: string, viewed: boolean): StateResponse {
  return withViewedMany(state, [path], viewed);
}

/** `withViewed` for several files at once — a folder marked in one click. */
export function withViewedMany(state: StateResponse, paths: readonly string[], viewed: boolean): StateResponse {
  const wanted = new Set(paths);
  let changed = false;
  const files = state.files.map((file) => {
    if (!wanted.has(file.path) || file.viewed === viewed || (viewed && !file.fingerprint)) return file;
    changed = true;
    return { ...file, viewed };
  });
  return changed ? { ...state, files } : state;
}

export function viewedCount(files: readonly FileEntry[]): number {
  return files.reduce((n, f) => n + (f.viewed ? 1 : 0), 0);
}

export type FolderViewed = 'all' | 'some' | 'none';

/**
 * How much of a folder is viewed. Files with no fingerprint can never be
 * marked, so they don't count either way: a folder whose every markable file
 * is viewed reads as viewed. A folder with nothing markable reads as 'none'.
 */
export function folderViewed(files: readonly FileEntry[]): FolderViewed {
  const markable = files.filter((f) => f.fingerprint);
  const viewed = viewedCount(markable);
  if (viewed === 0) return 'none';
  return viewed === markable.length ? 'all' : 'some';
}

/**
 * The file to open after `current` was marked viewed: the next unviewed one
 * in `order`, wrapping around to the start. Null when every other file is
 * viewed (or can't be marked) — then there is nowhere to go.
 */
export function nextUnviewed(files: readonly FileEntry[], order: readonly string[], current: string): string | null {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const start = order.indexOf(current);
  for (let step = 1; step <= order.length; step++) {
    const path = order[(start + step) % order.length];
    const file = byPath.get(path);
    if (path !== current && file && !file.viewed && file.fingerprint) return path;
  }
  return null;
}
