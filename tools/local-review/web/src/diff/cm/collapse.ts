import { StateEffect, StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { collapsedRanges, rangeKey, type LineRange } from '../lineMap';
import { chunkInfo } from './chunks';
import { setBlocks } from './blocks';
import { setSelectedLines } from './selection';
import { visibleLineCount } from './lastLine';

// Folding of unchanged lines. Written here instead of using
// @codemirror/merge's collapseUnchanged so that lines carrying a comment (or
// the open editor, or the selection) are never folded away.

const MARGIN = 3;
const MIN_SIZE = 4;

const expandRange = StateEffect.define<string>();

export class FoldWidget extends WidgetType {
  constructor(readonly range: LineRange) {
    super();
  }

  eq(other: FoldWidget) {
    return other.range.from === this.range.from && other.range.to === this.range.to;
  }

  toDOM(view: EditorView) {
    const count = this.range.to - this.range.from + 1;
    const el = document.createElement('div');
    el.className = 'rv-fold';
    el.title = 'Показать скрытые строки';
    const button = el.appendChild(document.createElement('button'));
    button.type = 'button';
    button.className = 'rv-fold__button';
    button.append(unfoldIcon());
    const label = el.appendChild(document.createElement('span'));
    label.className = 'rv-fold__label';
    label.textContent = `Показать ${count} ${plural(count)} (${this.range.from}–${this.range.to})`;
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ effects: expandRange.of(rangeKey(this.range)) });
    });
    return el;
  }

  ignoreEvent() {
    return true;
  }

  get estimatedHeight() {
    return 32;
  }
}

/** Octicon "unfold" (16px), built with DOM calls. */
function unfoldIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const path = svg.appendChild(document.createElementNS(ns, 'path'));
  path.setAttribute('fill', 'currentColor');
  path.setAttribute(
    'd',
    'm8.177.677 2.896 2.896a.25.25 0 0 1-.177.427H8.75v1.25a.75.75 0 0 1-1.5 0V4H5.104a.25.25 0 0 1-.177-.427L7.823.677a.25.25 0 0 1 .354 0ZM7.25 10.75a.75.75 0 0 1 1.5 0V12h2.146a.25.25 0 0 1 .177.427l-2.896 2.896a.25.25 0 0 1-.354 0l-2.896-2.896A.25.25 0 0 1 5.104 12H7.25v-1.25Zm-5-2a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5ZM6 8a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5A.75.75 0 0 1 6 8Zm2.25.75a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5ZM12 8a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5A.75.75 0 0 1 12 8Zm2.25.75a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5Z',
  );
  return svg;
}

function plural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'строку';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'строки';
  return 'строк';
}

type Value = { expanded: Set<string>; keep: number[]; selection: number[]; deco: DecorationSet };

function build(state: EditorState, expanded: Set<string>, keep: number[], selection: number[]): DecorationSet {
  const { chunks } = state.field(chunkInfo);
  const doc = state.doc;
  const ranges: Range<Decoration>[] = [];
  for (const r of collapsedRanges(visibleLineCount(state), chunks, [...keep, ...selection], MARGIN, MIN_SIZE, expanded)) {
    ranges.push(
      Decoration.replace({ widget: new FoldWidget(r), block: true }).range(doc.line(r.from).from, doc.line(r.to).to),
    );
  }
  return Decoration.set(ranges);
}

export const foldUnchanged = StateField.define<Value>({
  create(state) {
    const expanded = new Set<string>();
    return { expanded, keep: [], selection: [], deco: build(state, expanded, [], []) };
  },
  update(value, tr) {
    let { expanded, keep, selection } = value;
    let changed = false;
    for (const e of tr.effects) {
      if (e.is(expandRange)) {
        expanded = new Set(expanded).add(e.value);
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
