import { getChunks } from '@codemirror/merge';
import { RangeSet, StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, WidgetType, gutterLineClass, lineNumbers, type DecorationSet } from '@codemirror/view';
import type { LineRange } from '../lineMap';
import { chunkInfo } from './chunks';
import { PortalWidget, setBlocks } from './blocks';
import { FoldWidget, UnfoldedWidget, foldUnchanged, mirrorBar } from './collapse';
import { deletedLineClass } from './gutters';

// The split view: @codemirror/merge's MergeView with the old file on the left
// (editor "a") and the new one on the right (editor "b"). Everything the
// reviewer works with — comments, folds, selection, code navigation — lives on
// the new side, as in the unified view. The old side only reads.
//
// MergeView lines the two editors up at every changed chunk. Between chunks
// the lines must stay level by themselves, so whatever the new side puts
// between its unchanged lines (a comment card, a fold bar) is mirrored on the
// old side: a gap of the same height, a bar over the same lines.

// ---------------------------------------------------------------- old side

type OldChunks = { changed: LineRange[]; pure: LineRange[]; source: unknown };

function buildOldChunks(state: EditorState): OldChunks {
  const info = getChunks(state);
  const changed: LineRange[] = [];
  const pure: LineRange[] = [];
  for (const c of info?.chunks ?? []) {
    if (c.fromA >= c.toA) continue;
    const range = { from: state.doc.lineAt(c.fromA).number, to: state.doc.lineAt(c.endA).number };
    changed.push(range);
    // Lines removed with nothing in their place: no word highlighting.
    if (c.fromB === c.toB) pure.push(range);
  }
  return { changed, pure, source: info?.chunks };
}

/** The old side's changed lines, recomputed only when the merge chunks change. */
const oldChunks = StateField.define<OldChunks>({
  create: buildOldChunks,
  update(value, tr) {
    return getChunks(tr.state)?.chunks === value.source ? value : buildOldChunks(tr.state);
  },
});

const pureDelLine = Decoration.line({ class: 'rv-pure-del' });

/**
 * The old editor's own extensions: one column of old numbers (read only, no
 * comments), deleted lines colored, and no word highlighting on lines deleted
 * without a counterpart — `unpaired` (from git's hunks) plus chunks that only
 * delete.
 */
export function oldSide(unpaired: readonly number[]): Extension {
  return [
    oldChunks,
    lineNumbers(),
    gutterLineClass.compute([oldChunks], (state) => {
      const marks: Range<GutterMarker>[] = [];
      const doc = state.doc;
      for (const r of state.field(oldChunks).changed) {
        for (let n = r.from; n <= r.to && n <= doc.lines; n++) marks.push(deletedLineClass.range(doc.line(n).from));
      }
      return RangeSet.of(marks, true);
    }),
    EditorView.decorations.compute([oldChunks], (state) => {
      const doc = state.doc;
      const lines = new Set(unpaired);
      for (const r of state.field(oldChunks).pure) for (let n = r.from; n <= r.to; n++) lines.add(n);
      const ranges: Range<Decoration>[] = [];
      for (const n of [...lines].sort((x, y) => x - y)) if (n >= 1 && n <= doc.lines) ranges.push(pureDelLine.range(doc.line(n).from));
      return Decoration.set(ranges);
    }),
  ];
}

// ---------------------------------------------------------------- mirror

/**
 * What the old side draws for the new side's widgets between unchanged
 * lines. `range` is in new line numbers (what a press acts on), the rest in
 * old ones.
 */
export type MirrorItem =
  | { kind: 'fold'; range: LineRange; old: LineRange }
  | { kind: 'open'; range: LineRange; oldLine: number }
  | { kind: 'gap'; oldLine: number; height: number };

const setMirror = StateEffect.define<MirrorItem[]>();

/** A fold bar of the new side, drawn over the same lines of the old file. */
class MirrorFoldWidget extends WidgetType {
  constructor(
    readonly open: boolean,
    readonly range: LineRange,
    readonly shown: LineRange,
    readonly onPress: (open: boolean, range: LineRange) => void,
  ) {
    super();
  }

  eq(other: MirrorFoldWidget) {
    return (
      other.open === this.open &&
      other.range.from === this.range.from &&
      other.range.to === this.range.to &&
      other.shown.from === this.shown.from &&
      other.shown.to === this.shown.to
    );
  }

  toDOM() {
    return mirrorBar(this.open, this.shown, () => this.onPress(this.open, this.range));
  }

  ignoreEvent() {
    return true;
  }

  get estimatedHeight() {
    return this.open ? 24 : 32;
  }
}

/** Empty room beside a comment card of the new side. */
class GapWidget extends WidgetType {
  constructor(readonly height: number) {
    super();
  }

  eq(other: GapWidget) {
    return other.height === this.height;
  }

  toDOM() {
    const el = document.createElement('div');
    el.className = 'rv-split-gap';
    el.style.height = `${this.height}px`;
    return el;
  }

  updateDOM(el: HTMLElement) {
    el.style.height = `${this.height}px`;
    return true;
  }

  get estimatedHeight() {
    return this.height;
  }
}

function mirrorDeco(state: EditorState, items: readonly MirrorItem[], onPress: (open: boolean, range: LineRange) => void): DecorationSet {
  const doc = state.doc;
  const ranges: Range<Decoration>[] = [];
  const inDoc = (n: number) => n >= 1 && n <= doc.lines;
  for (const item of items) {
    if (item.kind === 'fold') {
      if (!inDoc(item.old.from) || !inDoc(item.old.to)) continue;
      ranges.push(
        Decoration.replace({ widget: new MirrorFoldWidget(false, item.range, item.old, onPress), block: true }).range(
          doc.line(item.old.from).from,
          doc.line(item.old.to).to,
        ),
      );
    } else if (item.kind === 'open') {
      if (!inDoc(item.oldLine)) continue;
      const shown = { from: item.oldLine, to: item.oldLine + (item.range.to - item.range.from) };
      ranges.push(
        Decoration.widget({ widget: new MirrorFoldWidget(true, item.range, shown, onPress), block: true, side: -1 }).range(
          doc.line(item.oldLine).from,
        ),
      );
    } else {
      if (!inDoc(item.oldLine)) continue;
      ranges.push(Decoration.widget({ widget: new GapWidget(item.height), block: true, side: 1 }).range(doc.line(item.oldLine).to));
    }
  }
  return Decoration.set(ranges, true);
}

/**
 * The old editor's copy of the new side's folds and comment cards. A press on
 * a copied fold bar goes to `onPress`, which acts on the new side.
 */
export function mirrorField(onPress: (open: boolean, range: LineRange) => void): Extension {
  return StateField.define<{ items: MirrorItem[]; deco: DecorationSet }>({
    create: () => ({ items: [], deco: Decoration.none }),
    update(value, tr) {
      for (const e of tr.effects) if (e.is(setMirror)) return { items: e.value, deco: mirrorDeco(tr.state, e.value, onPress) };
      return value;
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });
}

/** Height of the comment cards the new side shows under `line`, measured or estimated. */
function cardsHeight(view: EditorView, line: number): number {
  const block = view.lineBlockAt(view.state.doc.line(line).from);
  if (!Array.isArray(block.type)) return 0;
  let height = 0;
  for (const part of block.type) if (part.widget instanceof PortalWidget) height += part.height;
  return height;
}

/** What the old side must draw so its unchanged lines stay level with the new side's. */
export function mirrorItems(b: EditorView): MirrorItem[] {
  const state = b.state;
  const { oldLines } = state.field(chunkInfo);
  const doc = state.doc;
  const items: MirrorItem[] = [];
  const cardLines = new Set<number>();

  state.field(foldUnchanged, false)?.deco.between(0, doc.length, (_from, _to, deco) => {
    const widget = deco.spec.widget;
    if (widget instanceof FoldWidget) {
      const from = oldLines[widget.range.from];
      const to = oldLines[widget.range.to];
      if (from && to) items.push({ kind: 'fold', range: widget.range, old: { from, to } });
    } else if (widget instanceof UnfoldedWidget) {
      const oldLine = oldLines[widget.range.from];
      if (oldLine) items.push({ kind: 'open', range: widget.range, oldLine });
    }
  });

  // Cards: block widgets after their line. Only unchanged lines need a copy;
  // inside a chunk MergeView evens the two sides out at the chunk's end.
  for (const { from } of b.state.field(cardsField, false)?.lines ?? []) cardLines.add(from);
  for (const line of cardLines) {
    if (line < 1 || line > doc.lines || !oldLines[line]) continue;
    const height = cardsHeight(b, line);
    if (height > 0) items.push({ kind: 'gap', oldLine: oldLines[line], height });
  }
  return items;
}

/** The lines the new side has comment cards under (from setBlocks). */
const cardsField = StateField.define<{ lines: { from: number }[] }>({
  create: () => ({ lines: [] }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBlocks)) return { lines: e.value.map((b) => ({ from: b.line })) };
    return value;
  },
});

function sameItems(a: readonly MirrorItem[], b: readonly MirrorItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    if (x.kind !== y.kind) return false;
    if (x.kind === 'gap' && y.kind === 'gap') return x.oldLine === y.oldLine && x.height === y.height;
    return JSON.stringify(x) === JSON.stringify(y);
  });
}

/**
 * Keeps the old editor's mirror in step with the new one, and the two lined
 * up. `newSide` goes into the new editor, `oldSide` into the old one; `attach`
 * connects them once both exist. Work is batched to one pass per frame.
 */
export class SplitMirror {
  private a: EditorView | null = null;
  private b: EditorView | null = null;
  private frame = 0;
  private alignFrame = 0;
  private last: MirrorItem[] = [];
  private realign: () => void = () => {};

  /**
   * MergeView lines the editors up again when an editor's height changes,
   * but a mirror change can land between its measuring and the old editor's,
   * leaving a stale spacer. So a height change found by measuring the page
   * (an update with no transaction) asks once more. Changes that come with a
   * transaction — MergeView's own spacers among them — do not: off screen,
   * where heights are estimates, answering those would never settle.
   */
  private readonly heights = EditorView.updateListener.of((update) => {
    if (update.heightChanged && update.transactions.length === 0) this.scheduleAlign();
  });

  readonly newSide: Extension = [
    cardsField,
    this.heights,
    EditorView.updateListener.of((update) => {
      const folds = update.state.field(foldUnchanged, false) !== update.startState.field(foldUnchanged, false);
      const blocks = update.transactions.some((tr) => tr.effects.some((e) => e.is(setBlocks)));
      if (update.heightChanged || update.geometryChanged || folds || blocks) this.schedule();
    }),
  ];

  readonly oldSide: Extension = this.heights;

  /** `realign` asks MergeView to line the editors up again. */
  attach(a: EditorView, b: EditorView, realign: () => void) {
    this.a = a;
    this.b = b;
    this.realign = realign;
    this.schedule();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.alignFrame);
    this.frame = 0;
    this.alignFrame = 0;
    this.a = null;
    this.b = null;
  }

  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.sync();
    });
  }

  private scheduleAlign() {
    if (this.alignFrame || !this.a) return;
    this.alignFrame = requestAnimationFrame(() => {
      this.alignFrame = 0;
      if (this.a) this.realign();
    });
  }

  private sync() {
    const { a, b } = this;
    if (!a || !b) return;
    const items = mirrorItems(b);
    if (sameItems(items, this.last)) return;
    this.last = items;
    a.dispatch({ effects: setMirror.of(items) });
    // Once the old editor has measured its new widgets.
    a.requestMeasure({ read: () => null, write: () => this.scheduleAlign() });
  }
}
