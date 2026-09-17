import type { Comment } from '../api/types';

// Per-file "hide comments" toggle in the file header. In memory only, like the
// Код/Просмотр choice: a reload shows every comment again.

export type HiddenFiles = Record<string, boolean>;

/**
 * The file's comments still on screen. Hiding keeps the one being edited, so
 * the toggle never throws away unsaved text.
 */
export function visibleComments(comments: Comment[], hidden: boolean, editingId: string | null): Comment[] {
  return hidden ? comments.filter((c) => c.id === editingId) : comments;
}

export function setFileHidden(prev: HiddenFiles, file: string, hidden: boolean): HiddenFiles {
  if (Boolean(prev[file]) === hidden) return prev;
  const next = { ...prev };
  if (hidden) next[file] = true;
  else delete next[file];
  return next;
}
