import { StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { collapsedRanges, type LineRange } from '../lineMap';
import { chunkInfo } from './chunks';
import { setBlocks } from './blocks';
import { setSelectedLines } from './selection';
import { visibleLineCount } from './lastLine';

// Folding of unchanged lines. Written here instead of using
// @codemirror/merge's collapseUnchanged so that lines carrying a comment (or
// the open editor, or the selection) are never folded away.
//
// A fold the reviewer opened can be closed again: a bar stays above its first
// line («Скрыть N строк»), and the file header folds all of them at once
// (FoldHub).

const MARGIN = 3;
const MIN_SIZE = 4;

const expandRange = StateEffect.define<LineRange>();
const collapseRange = StateEffect.define<LineRange>();
const collapseAll = StateEffect.define<null>();

function sameRange(a: LineRange, b: LineRange): boolean {
  return a.from === b.from && a.to === b.to;
}

/** The bar of a fold: its icon and what a click on it does. */
function bar(className: string, title: string, text: string, icon: string, onPress: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  el.title = title;
  const button = el.appendChild(document.createElement('button'));
  button.type = 'button';
  button.className = 'rv-fold__button';
  button.append(octicon(icon));
  const label = el.appendChild(document.createElement('span'));
  label.className = 'rv-fold__label';
  label.textContent = text;
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    onPress();
  });
  return el;
}

function describe(verb: string, range: LineRange): string {
  const count = range.to - range.from + 1;
  return `${verb} ${count} ${plural(count)} (${range.from}–${range.to})`;
}

/** Folded lines: one bar in their place. */
export class FoldWidget extends WidgetType {
  constructor(readonly range: LineRange) {
    super();
  }

  eq(other: FoldWidget) {
    return sameRange(other.range, this.range);
  }

  toDOM(view: EditorView) {
    return bar('rv-fold', 'Показать скрытые строки', describe('Показать', this.range), UNFOLD_ICON, () =>
      view.dispatch({ effects: expandRange.of(this.range) }),
    );
  }

  ignoreEvent() {
    return true;
  }

  get estimatedHeight() {
    return 32;
  }
}

/** Lines the reviewer unfolded: a bar above the first of them folds them back. */
export class UnfoldedWidget extends WidgetType {
  constructor(readonly range: LineRange) {
    super();
  }

  eq(other: UnfoldedWidget) {
    return sameRange(other.range, this.range);
  }

  toDOM(view: EditorView) {
    return bar('rv-fold rv-fold--open', 'Скрыть развёрнутые строки', describe('Скрыть', this.range), FOLD_ICON, () =>
      view.dispatch({ effects: collapseRange.of(this.range) }),
    );
  }

  ignoreEvent() {
    return true;
  }

  get estimatedHeight() {
    return 24;
  }
}

/** A bar of this file (folded lines, or the one above unfolded ones) — not the merge view's deleted lines. */
export function isFoldWidget(widget: WidgetType | null | undefined): boolean {
  return widget instanceof FoldWidget || widget instanceof UnfoldedWidget;
}

// Octicons "unfold" and "fold" (16px).
const UNFOLD_ICON =
  'm8.177.677 2.896 2.896a.25.25 0 0 1-.177.427H8.75v1.25a.75.75 0 0 1-1.5 0V4H5.104a.25.25 0 0 1-.177-.427L7.823.677a.25.25 0 0 1 .354 0ZM7.25 10.75a.75.75 0 0 1 1.5 0V12h2.146a.25.25 0 0 1 .177.427l-2.896 2.896a.25.25 0 0 1-.354 0l-2.896-2.896A.25.25 0 0 1 5.104 12H7.25v-1.25Zm-5-2a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5ZM6 8a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5A.75.75 0 0 1 6 8Zm2.25.75a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5ZM12 8a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5A.75.75 0 0 1 12 8Zm2.25.75a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5Z';
const FOLD_ICON =
  'M10.896 2H8.75V.75a.75.75 0 0 0-1.5 0V2H5.104a.25.25 0 0 0-.177.427l2.896 2.896a.25.25 0 0 0 .354 0l2.896-2.896A.25.25 0 0 0 10.896 2ZM8.75 15.25a.75.75 0 0 1-1.5 0V14H5.104a.25.25 0 0 1-.177-.427l2.896-2.896a.25.25 0 0 1 .354 0l2.896 2.896a.25.25 0 0 1-.177.427H8.75v1.25Zm-6.5-6.5a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5ZM6 8a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5A.75.75 0 0 1 6 8Zm2.25.75a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5ZM12 8a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5A.75.75 0 0 1 12 8Zm2.25.75a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5Z';

/** An octicon (16px), built with DOM calls. */
function octicon(d: string): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const path = svg.appendChild(document.createElementNS(ns, 'path'));
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', d);
  return svg;
}

function plural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'строку';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'строки';
  return 'строк';
}

type Value = { expanded: readonly LineRange[]; keep: number[]; selection: number[]; deco: DecorationSet };

function build(state: EditorState, expanded: readonly LineRange[], keep: number[], selection: number[]): DecorationSet {
  const { chunks } = state.field(chunkInfo);
  const doc = state.doc;
  const lines = visibleLineCount(state);
  const ranges: Range<Decoration>[] = [];
  for (const r of collapsedRanges(lines, chunks, [...keep, ...selection], MARGIN, MIN_SIZE, expanded)) {
    ranges.push(
      Decoration.replace({ widget: new FoldWidget(r), block: true }).range(doc.line(r.from).from, doc.line(r.to).to),
    );
  }
  for (const r of expanded) {
    if (r.from > lines) continue;
    ranges.push(Decoration.widget({ widget: new UnfoldedWidget(r), block: true, side: -1 }).range(doc.line(r.from).from));
  }
  return Decoration.set(ranges, true);
}

export const foldUnchanged = StateField.define<Value>({
  create(state) {
    return { expanded: [], keep: [], selection: [], deco: build(state, [], [], []) };
  },
  update(value, tr) {
    let { expanded, keep, selection } = value;
    let changed = false;
    for (const e of tr.effects) {
      if (e.is(expandRange)) {
        const range = e.value;
        if (!expanded.some((r) => sameRange(r, range))) expanded = [...expanded, range];
        changed = true;
      } else if (e.is(collapseRange)) {
        const range = e.value;
        expanded = expanded.filter((r) => !sameRange(r, range));
        changed = true;
      } else if (e.is(collapseAll)) {
        expanded = [];
        changed = true;
      } else if (e.is(setBlocks)) {
        keep = e.value.map((b) => b.line);
        changed = true;
      } else if (e.is(setSelectedLines)) {
        const r = e.value;
        selection = r ? [r.from, r.to] : [];
        changed = true;
      }
    }
    if (!changed) return value;
    return { expanded, keep, selection, deco: build(tr.state, expanded, keep, selection) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/**
 * What the file header knows about a file's folds: how many the reviewer has
 * open, and how to close them all. Lives as long as the file's component; the
 * editor under it may be rebuilt, and starts again with everything folded.
 */
export class FoldHub {
  private view: EditorView | null = null;
  private open = 0;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** How many unfolded runs the file has. */
  getSnapshot = (): number => this.open;

  attach(view: EditorView) {
    this.view = view;
    this.publish(view.state.field(foldUnchanged, false)?.expanded.length ?? 0);
  }

  detach(view: EditorView) {
    if (this.view !== view) return;
    this.view = null;
    this.publish(0);
  }

  /** Fold back everything the reviewer unfolded in this file. */
  collapseAll() {
    this.view?.dispatch({ effects: collapseAll.of(null) });
  }

  publish(open: number) {
    if (open === this.open) return;
    this.open = open;
    for (const l of this.listeners) l();
  }
}

/** The folding of unchanged lines, reported to `hub` for the file header. */
export function folding(hub: FoldHub): Extension {
  return [
    foldUnchanged,
    EditorView.updateListener.of((update) => {
      const now = update.state.field(foldUnchanged).expanded;
      if (now !== update.startState.field(foldUnchanged).expanded) hub.publish(now.length);
    }),
  ];
}

/** The effect that unfolds the folded lines hiding `pos`, or null when none do. */
export function unfoldAt(state: EditorState, pos: number): StateEffect<LineRange> | null {
  let found: StateEffect<LineRange> | null = null;
  state.field(foldUnchanged, false)?.deco.between(pos, pos, (from, to, deco) => {
    const widget = deco.spec.widget;
    if (widget instanceof FoldWidget && from <= pos && pos <= to) {
      found = expandRange.of(widget.range);
      return false;
    }
  });
  return found;
}
