import type { DiffResponse } from '../api/types';

// Which files get a rendered ("rich diff") view, and which version of them.

const MARKDOWN_EXT = /\.(md|markdown|mdown|mkdn?|mdx)$/i;

export function isMarkdownPath(path: string): boolean {
  const name = path.split('/').pop() ?? '';
  return MARKDOWN_EXT.test(name);
}

export type MarkdownSource = { text: string; side: 'new' | 'old' };

/**
 * The text the rendered view shows: the new version, or the old one when the
 * file was deleted. Null when the file is not markdown or has no text.
 */
export function markdownToRender(path: string, diff: DiffResponse): MarkdownSource | null {
  if (!isMarkdownPath(path) || diff.binary || diff.missing) return null;
  if (diff.newText != null) return { text: diff.newText, side: 'new' };
  if (diff.oldText != null) return { text: diff.oldText, side: 'old' };
  return null;
}
