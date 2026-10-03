import type { Comment } from '../api/types';
import type { Block } from './cm/blocks';
import type { LineRange } from './lineMap';
import { visibleComments } from './hiddenComments';

// Where one file's comments and the open new-comment form go: inside the
// diff, under a line, or above it. Pure, so it is the same for a file shown
// alone and for a file in the feed.

export type FileLayout = {
  /** Comments drawn under their last line. */
  anchored: Comment[];
  /** File-level comments and ones whose line is not in the document: above the diff. */
  unanchored: Comment[];
  blocks: Block[];
  /** The range the open form is for, when the form is in the document. */
  selected: LineRange | null;
  /** The open form sits in the document; otherwise it goes above the diff. */
  editorInDoc: boolean;
};

type Input = {
  /** Every comment of the file. */
  comments: Comment[];
  commentsHidden: boolean;
  editingId: string | null;
  /** The file has a line-by-line diff on screen. */
  showsEditor: boolean;
  docLines: number;
  /** The rendered markdown view is on: it has no lines to anchor to. */
  rendered: boolean;
  /** The open new-comment form of this file, if any. */
  editor: { start: number | null; end: number | null } | null;
};

export function fileLayout({ comments, commentsHidden, editingId, showsEditor, docLines, rendered, editor }: Input): FileLayout {
  const anchored: Comment[] = [];
  const unanchored: Comment[] = [];
  // Hidden comments leave both places; the header still counts them.
  for (const c of visibleComments(comments, commentsHidden, editingId)) {
    if (showsEditor && c.endLine !== null && c.endLine >= 1 && c.endLine <= docLines) anchored.push(c);
    else unanchored.push(c);
  }

  const hasRange = editor !== null && editor.start !== null && editor.end !== null;
  const from = hasRange ? Math.min(editor.start as number, editor.end as number) : 0;
  const to = hasRange ? Math.max(editor.start as number, editor.end as number) : 0;
  const editorInDoc = hasRange && showsEditor && !rendered && to <= docLines;

  const blocks: Block[] = anchored.map((c) => ({ key: `c:${c.id}`, line: c.endLine as number }));
  if (editorInDoc) blocks.push({ key: 'editor', line: to });

  return { anchored, unanchored, blocks, selected: editorInDoc ? { from, to } : null, editorInDoc };
}
