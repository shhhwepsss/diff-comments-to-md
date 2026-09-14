import { Facet, RangeSet, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutterLineClass } from '@codemirror/view';

// Texts go into CodeMirror with their final newline: the merge library needs
// it to round chunk boundaries at the end of a file correctly. The price is an
// empty last "line" that git and GitHub don't show — hidden here by position
// (not with :last-child, which with CodeMirror's viewport rendering could be
// any line).

const hideLastLine = Facet.define<boolean, boolean>({ combine: (v) => v.some(Boolean) });

/** Whether the document's last line is the artificial empty one. */
export function lastLineHidden(state: EditorState): boolean {
  return state.facet(hideLastLine) && state.doc.line(state.doc.lines).length === 0;
}

/** Lines the reader actually sees (for folding and counts). */
export function visibleLineCount(state: EditorState): number {
  return lastLineHidden(state) ? Math.max(0, state.doc.lines - 1) : state.doc.lines;
}

class HiddenGutter extends GutterMarker {
  elementClass = 'rv-hidden-line';
}
const hiddenGutter = new HiddenGutter();
const hiddenLine = Decoration.line({ class: 'rv-hidden-line' });

/**
 * `hide` is true when the text ends with a line break, or when there is no
 * new text at all (a deleted file: its document is one empty line).
 */
export function finalEmptyLine(hide: boolean): Extension {
  return [
    hideLastLine.of(hide),
    EditorView.decorations.compute([], (state) =>
      lastLineHidden(state) ? Decoration.set([hiddenLine.range(state.doc.line(state.doc.lines).from)]) : Decoration.none,
    ),
    gutterLineClass.compute([], (state) =>
      lastLineHidden(state) ? RangeSet.of([hiddenGutter.range(state.doc.line(state.doc.lines).from)]) : RangeSet.empty,
    ),
  ];
}
