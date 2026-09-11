import { getChunks, getOriginalDoc } from '@codemirror/merge';
import { StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { oldLineNumbers, type LineChunk } from '../lineMap';

/** The merge chunks of a unified view, in line numbers. */
export function lineChunksOf(state: EditorState): LineChunk[] {
  const info = getChunks(state);
  if (!info) return [];
  const a = getOriginalDoc(state);
  const b = state.doc;
  // `from` may point one past the end when a chunk sits after the last line.
  const lineOf = (doc: typeof a, pos: number) => (pos > doc.length ? doc.lines + 1 : doc.lineAt(pos).number);
  return info.chunks.map((c) => ({
    oldFrom: lineOf(a, c.fromA),
    oldCount: c.fromA === c.toA ? 0 : a.lineAt(c.endA).number - a.lineAt(c.fromA).number + 1,
    newFrom: lineOf(b, c.fromB),
    newCount: c.fromB === c.toB ? 0 : b.lineAt(c.endB).number - b.lineAt(c.fromB).number + 1,
  }));
}

type ChunkInfo = { chunks: LineChunk[]; oldLines: Int32Array; source: unknown };

function build(state: EditorState): ChunkInfo {
  const chunks = lineChunksOf(state);
  return { chunks, oldLines: oldLineNumbers(state.doc.lines, chunks), source: getChunks(state)?.chunks };
}

/**
 * Line chunks + the new→old line map, recomputed only when the merge
 * extension's chunks change (never, in a read-only view, after creation).
 */
export const chunkInfo = StateField.define<ChunkInfo>({
  create: build,
  update(value, tr) {
    return getChunks(tr.state)?.chunks === value.source ? value : build(tr.state);
  },
});

const pureAddLine = Decoration.line({ class: 'rv-pure-add' });

/**
 * Added lines with no deleted counterpart: those of chunks that only add
 * lines, plus `unpaired` (from git's hunks: the surplus of a modified block).
 * The merge view marks their whole text as "changed"; GitHub word-highlights
 * only modified lines, and so do we (see the theme).
 */
export function pureInsertions(unpaired: readonly number[]) {
  return EditorView.decorations.compute([chunkInfo], (state) => {
    const doc = state.doc;
    const lines = new Set(unpaired);
    for (const c of state.field(chunkInfo).chunks) {
      if (c.oldCount === 0) for (let n = c.newFrom; n < c.newFrom + c.newCount; n++) lines.add(n);
    }
    const ranges: Range<Decoration>[] = [];
    for (const n of [...lines].sort((x, y) => x - y)) if (n >= 1 && n <= doc.lines) ranges.push(pureAddLine.range(doc.line(n).from));
    return Decoration.set(ranges);
  });
}
