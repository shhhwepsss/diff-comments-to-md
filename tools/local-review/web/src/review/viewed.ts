import type { FileEntry, StateResponse } from '../api/types';

/**
 * The state with one file's viewed flag flipped, for an optimistic update.
 * Only a file that has a fingerprint can be marked: without one there is no
 * version of the diff to tie the mark to, and the server would refuse it.
 * Returns the same object when nothing changes, so React skips the render.
 */
export function withViewed(state: StateResponse, path: string, viewed: boolean): StateResponse {
  const index = state.files.findIndex((f) => f.path === path);
  if (index === -1) return state;
  const file = state.files[index];
  if (file.viewed === viewed || (viewed && !file.fingerprint)) return state;
  const files = state.files.slice();
  files[index] = { ...file, viewed };
  return { ...state, files };
}

export function viewedCount(files: readonly FileEntry[]): number {
  return files.reduce((n, f) => n + (f.viewed ? 1 : 0), 0);
}
