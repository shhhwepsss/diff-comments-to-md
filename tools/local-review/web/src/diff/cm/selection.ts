import { RangeSet, StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutterLineClass, type DecorationSet } from '@codemirror/view';
import type { LineRange } from '../lineMap';

// The highlighted line range: while dragging over line numbers and while the
// comment editor for that range is open.

export const setSelectedLines = StateEffect.define<LineRange | null>();

const lineDeco = Decoration.line({ class: 'rv-line-selected' });

class SelectedGutter extends GutterMarker {
  elementClass = 'rv-gutter-selected';
}
const selectedGutter = new SelectedGutter();

type Value = { range: LineRange | null; deco: DecorationSet; gutter: RangeSet<GutterMarker> };

export const selectedLines = StateField.define<Value>({
  create: () => ({ range: null, deco: Decoration.none, gutter: RangeSet.empty }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setSelectedLines)) continue;
      const r = e.value;
      if (!r) return { range: null, deco: Decoration.none, gutter: RangeSet.empty };
      const doc = tr.state.doc;
      const lines: Range<Decoration>[] = [];
      const marks: Range<GutterMarker>[] = [];
      for (let n = Math.max(1, r.from); n <= Math.min(doc.lines, r.to); n++) {
        const pos = doc.line(n).from;
        lines.push(lineDeco.range(pos));
        marks.push(selectedGutter.range(pos));
      }
      return { range: r, deco: Decoration.set(lines), gutter: RangeSet.of(marks) };
    }
    return value;
  },
  provide: (f) => [EditorView.decorations.from(f, (v) => v.deco), gutterLineClass.from(f, (v) => v.gutter)],
});
