import type { DiffResponse } from '../api/types';

// Which files get a rendered ("rich diff") view, and which version of them.

const MARKDOWN_EXT = /\.(md|markdown|mdown|mkdn?|mdx)$/i;
const HTML_EXT = /\.(html?|xhtml)$/i;

export type PreviewKind = 'markdown' | 'html';

function fileName(path: string): string {
  return path.split('/').pop() ?? '';
}

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXT.test(fileName(path));
}

export function isHtmlPath(path: string): boolean {
  return HTML_EXT.test(fileName(path));
}

/** How the file is rendered in «Просмотр», or null when it has no rendered view. */
export function previewKind(path: string): PreviewKind | null {
  if (isMarkdownPath(path)) return 'markdown';
  if (isHtmlPath(path)) return 'html';
  return null;
}

export type PreviewSource = { kind: PreviewKind; text: string; side: 'new' | 'old' };

/**
 * The text the rendered view shows: the new version, or the old one when the
 * file was deleted. Null when the file has no rendered view or no text.
 */
export function previewToRender(path: string, diff: DiffResponse): PreviewSource | null {
  const kind = previewKind(path);
  if (!kind || diff.binary || diff.missing) return null;
  if (diff.newText != null) return { kind, text: diff.newText, side: 'new' };
  if (diff.oldText != null) return { kind, text: diff.oldText, side: 'old' };
  return null;
}
