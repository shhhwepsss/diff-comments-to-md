import { getChunks, getOriginalDoc } from '@codemirror/merge';
import { RangeSet, type Extension, type Range } from '@codemirror/state';
import {
  BlockType,
  EditorView,
  GutterMarker,
  gutter,
  gutterLineClass,
  gutterWidgetClass,
  lineNumbers,
  type BlockInfo,
  type WidgetType,
} from '@codemirror/view';
import { chunkInfo } from './chunks';
import { PortalWidget } from './blocks';
import { FoldWidget } from './collapse';

// Two number columns like GitHub: old line, new line. Deleted lines are not
// part of the document (the merge view draws them as one block widget), so
// their old numbers are a stacked marker next to that widget.

class NumberMarker extends GutterMarker {
  constructor(readonly n: number) {
    super();
  }
  eq(other: NumberMarker) {
    return other.n === this.n;
  }
  toDOM() {
    return document.createTextNode(String(this.n));
  }
}

class DeletedNumbers extends GutterMarker {
  constructor(
    readonly from: number,
    readonly count: number,
  ) {
    super();
  }
  eq(other: DeletedNumbers) {
    return other.from === this.from && other.count === this.count;
  }
  toDOM() {
    const el = document.createElement('div');
    el.className = 'rv-deleted-numbers';
    for (let i = 0; i < this.count; i++) {
      const row = el.appendChild(document.createElement('div'));
      row.textContent = String(this.from + i);
    }
    return el;
  }
}

class ClassMarker extends GutterMarker {
  constructor(readonly elementClass: string) {
    super();
  }
}
const addedClass = new ClassMarker('rv-gutter-add');
const deletedClass = new ClassMarker('rv-gutter-del');

/** The deletion block the merge view put at `block.from`, if that is what this widget is. */
function deletionAt(view: EditorView, widget: WidgetType, block: BlockInfo) {
  if (widget instanceof PortalWidget || widget instanceof FoldWidget) return null;
  const info = getChunks(view.state);
  if (!info) return null;
  const docLength = view.state.doc.length;
  const chunk = info.chunks.find((c) => c.fromA < c.toA && Math.min(c.fromB, docLength) === block.from);
  if (!chunk) return null;
  const a = getOriginalDoc(view.state);
  const first = a.lineAt(chunk.fromA).number;
  return { from: first, count: a.lineAt(chunk.endA).number - first + 1 };
}

export type GutterHandlers = {
  /** Mouse went down on a line number of new line `line`. */
  onLineMouseDown: (line: number, event: MouseEvent) => void;
};

/**
 * The new-file line under a vertical screen position, or null over a widget
 * (deleted lines, a comment card, a fold). `lineBlockAtHeight` would return
 * the whole line *including* its widgets, so ask for the element instead.
 */
export function lineAtY(view: EditorView, clientY: number): number | null {
  const block = view.elementAtHeight(clientY - view.documentTop);
  if (block.type !== BlockType.Text) return null;
  return view.state.doc.lineAt(block.from).number;
}

export function diffGutters(handlers: GutterHandlers): Extension {
  const mousedown = (view: EditorView, _block: BlockInfo, event: Event) => {
    const e = event as MouseEvent;
    const line = lineAtY(view, e.clientY);
    if (line === null) return false;
    handlers.onLineMouseDown(line, e);
    return true;
  };

  const oldNumbers = gutter({
    class: 'rv-old-numbers',
    lineMarker(view, line) {
      const n = view.state.field(chunkInfo).oldLines[view.state.doc.lineAt(line.from).number];
      return n ? new NumberMarker(n) : null;
    },
    widgetMarker(view, widget, block) {
      const del = deletionAt(view, widget, block);
      return del ? new DeletedNumbers(del.from, del.count) : null;
    },
    lineMarkerChange: (update) => update.startState.field(chunkInfo) !== update.state.field(chunkInfo),
    initialSpacer: (view) => new NumberMarker(Math.max(getOriginalDoc(view.state).lines, 9)),
    domEventHandlers: { mousedown },
  });

  const addedLines = gutterLineClass.compute([chunkInfo], (state) => {
    const marks: Range<GutterMarker>[] = [];
    const doc = state.doc;
    for (const c of state.field(chunkInfo).chunks) {
      for (let n = c.newFrom; n < c.newFrom + c.newCount && n <= doc.lines; n++) marks.push(addedClass.range(doc.line(n).from));
    }
    return RangeSet.of(marks, true);
  });

  const deletedWidgets = gutterWidgetClass.of((view, widget, block) =>
    deletionAt(view, widget, block) ? deletedClass : null,
  );

  return [
    oldNumbers,
    lineNumbers({ domEventHandlers: { mousedown } }),
    addedLines,
    deletedWidgets,
  ];
}
