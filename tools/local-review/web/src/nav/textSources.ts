import type { FileEntry } from '../api/types';
import type { DiffStore } from '../review/diffStore';
import type { TextFile } from './textSearch';

/** Files read for one search at most: a huge PR is searched in its first ones (the sidebar's order). */
export const MAX_TEXT_FILES = 300;

/**
 * The new side of the files of the diff, for the search by text: what the
 * diff shows, so a place found is a line on screen. Diffs already loaded are
 * reused; the rest are fetched through the review's store (its queue keeps the
 * server from being asked for hundreds at once, and the feed gets them too).
 * Deleted files have no new side; binary and too-big ones no text.
 */
export async function diffTexts(
  diffs: DiffStore,
  files: readonly FileEntry[],
  limit: number = MAX_TEXT_FILES,
): Promise<{ files: TextFile[]; skipped: number }> {
  const present = files.filter((f) => f.status !== 'D');
  const wanted = present.slice(0, limit);
  const texts = await Promise.all(
    wanted.map(async (f): Promise<TextFile | null> => {
      const known = diffs.get(f.path);
      const entry = known?.kind === 'ready' && !known.stale ? known : await diffs.ensure(f.path);
      if (entry?.kind !== 'ready') return null;
      const text = entry.diff.newText;
      return typeof text === 'string' ? { path: f.path, text } : null;
    }),
  );
  return { files: texts.filter((t): t is TextFile => t !== null), skipped: present.length - wanted.length };
}
