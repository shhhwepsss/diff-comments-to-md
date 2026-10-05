import { getChunks, getOriginalDoc } from '@codemirror/merge';
import { StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import {
  BlockType,
  Decoration,
  EditorView,
  ViewPlugin,
  type BlockInfo,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { isTypingTarget } from '../../lib/keybindings';
import { portalOpen } from '../../lib/portal';
import { PortalWidget } from './blocks';
import { isFoldWidget, unfoldAt } from './collapse';
import {
  compareKeys,
  findWord,
  isSingleWord,
  lineColumn,
  lineStarts,
  rulerTop,
  stepIndex,
  thinMarks,
  wordAt,
  type OrderKey,
} from './occurrenceMatch';

// «Highlight occurrences», by text: a click on a word (or a selection of
// exactly one word) marks every whole-word occurrence of it in the file —
// the new text and the deleted lines alike, comments and strings included.
// No language server: a reviewer wants to see where a name goes even in a
// file nobody can parse.
//
// The new text is the document, so its occurrences are plain mark
// decorations. Deleted lines are the merge view's widget DOM, which we do not
// own; those are painted with the CSS Custom Highlight API, which marks DOM
// ranges without touching the nodes.

/** An occurrence in the document (new text). */
type DocOccurrence = { kind: 'doc'; from: number; to: number; key: OrderKey };
/** An occurrence in a deleted block drawn above document position `at`. */
type DeletedOccurrence = { kind: 'del'; at: number; line: number; col: number; len: number; key: OrderKey };
type Occurrence = DocOccurrence | DeletedOccurrence;

type Highlight = { word: string; list: Occurrence[]; index: number };

const setHighlight = StateEffect.define<Highlight | null>();

/** Every occurrence of `word` in the file, in the order they are drawn. */
function occurrencesOf(state: EditorState, word: string): Occurrence[] {
  const list: Occurrence[] = [];
  for (const from of findWord(state.doc.toString(), word)) {
    list.push({ kind: 'doc', from, to: from + word.length, key: { pos: from, side: 1, offset: from } });
  }
  const info = getChunks(state);
  if (info) {
    const a = getOriginalDoc(state);
    const docLength = state.doc.length;
    for (const c of info.chunks) {
      if (c.fromA >= c.toA) continue;
      const text = a.sliceString(c.fromA, c.endA);
      const starts = lineStarts(text);
      const at = Math.min(c.fromB, docLength);
      for (const offset of findWord(text, word)) {
        const { line, col } = lineColumn(starts, offset);
        list.push({ kind: 'del', at, line, col, len: word.length, key: { pos: at, side: 0, offset } });
      }
    }
    list.sort((x, y) => compareKeys(x.key, y.key));
  }
  return list;
}

/** The highlight the editor's selection asks for, reusing `prev` for the same word. */
function fromSelection(state: EditorState, prev: Highlight | null): Highlight | null {
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  let range: { from: number; to: number } | null;
  if (sel.empty) {
    const w = wordAt(line.text, sel.head - line.from);
    range = w && { from: line.from + w.from, to: line.from + w.to };
  } else {
    // A selection of exactly one whole word: not a part of one, not two.
    const text = state.sliceDoc(sel.from, sel.to);
    const w = isSingleWord(text) && sel.from >= line.from ? wordAt(line.text, sel.from - line.from) : null;
    range = w && line.from + w.from === sel.from && line.from + w.to === sel.to ? { from: sel.from, to: sel.to } : null;
  }
  if (!range) return null;
  const word = state.sliceDoc(range.from, range.to);
  const list = prev && prev.word === word ? prev.list : occurrencesOf(state, word);
  const index = list.findIndex((o) => o.kind === 'doc' && o.from === range.from);
  return { word, list, index };
}

const mark = Decoration.mark({ class: 'rv-occ' });
const currentMark = Decoration.mark({ class: 'rv-occ rv-occ--current' });

const highlightField = StateField.define<Highlight | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHighlight)) return e.value;
    // The text never changes (read-only), so only the selection matters.
    return tr.selection ? fromSelection(tr.state, value) : value;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (h): DecorationSet => {
      if (!h) return Decoration.none;
      const ranges: Range<Decoration>[] = [];
      h.list.forEach((o, i) => {
        if (o.kind === 'doc') ranges.push((i === h.index ? currentMark : mark).range(o.from, o.to));
      });
      return Decoration.set(ranges, true);
    }),
});

/** What the file header shows: the word and «index + 1 of total». */
export type OccurrenceSnapshot = { word: string; index: number; total: number } | null;

/** The hub whose highlight is on screen: one file at a time, the one last clicked. */
let activeHub: OccurrenceHub | null = null;

/**
 * Connects one file's editor to its header: the counter reads the snapshot,
 * the arrows step through the occurrences. Lives as long as the file's
 * component, while the editor under it may be recreated.
 */
export class OccurrenceHub {
  private view: EditorView | null = null;
  private snapshot: OccurrenceSnapshot = null;
  private listeners = new Set<() => void>();
  /** The strip of marks beside the editor (rendered by DiffEditor). */
  ruler: HTMLElement | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): OccurrenceSnapshot => this.snapshot;

  attach(view: EditorView) {
    this.view = view;
  }

  detach(view: EditorView) {
    if (this.view !== view) return;
    this.view = null;
    this.publish(null);
  }

  /** Called by the editor whenever its highlight changes. */
  publish(h: Highlight | null) {
    const next: OccurrenceSnapshot = h ? { word: h.word, index: h.index, total: h.list.length } : null;
    const prev = this.snapshot;
    if (prev === next || (prev && next && prev.word === next.word && prev.index === next.index && prev.total === next.total)) {
      return;
    }
    this.snapshot = next;
    if (next && activeHub !== this) {
      const other = activeHub;
      activeHub = this;
      window.addEventListener('keydown', onEscape, true);
      other?.clear();
    } else if (!next && activeHub === this) {
      activeHub = null;
      window.removeEventListener('keydown', onEscape, true);
    }
    for (const l of this.listeners) l();
  }

  clear() {
    if (this.view?.state.field(highlightField, false)) this.view.dispatch({ effects: setHighlight.of(null) });
    else this.publish(null);
  }

  /** Go to the previous (-1) or the next (1) occurrence. */
  step(dir: 1 | -1) {
    const h = this.view?.state.field(highlightField, false);
    if (!h) return;
    this.goTo(stepIndex(h.index, h.list.length, dir));
  }

  /** Make occurrence `index` the current one and scroll it to the middle. */
  goTo(index: number) {
    const view = this.view;
    const h = view?.state.field(highlightField, false);
    if (!view || !h || index < 0 || index >= h.list.length) return;
    const o = h.list[index];
    const pos = o.kind === 'doc' ? o.from : o.at;
    const unfold = unfoldAt(view.state, pos);
    view.dispatch({
      effects: [
        setHighlight.of({ ...h, index }),
        ...(unfold ? [unfold] : []),
        EditorView.scrollIntoView(pos, { y: 'center' }),
      ],
    });
    if (o.kind === 'del') {
      // The editor scrolls to the line under the deleted block; the line
      // itself is in the widget, centred once it has been drawn.
      view.requestMeasure({
        read: () => deletedLineElement(deletedChunks(view), o),
        write: (el) => el?.scrollIntoView({ block: 'center' }),
      });
    }
  }
}

function onEscape(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !activeHub || e.defaultPrevented) return;
  if (isTypingTarget(e.target) || portalOpen()) return;
  // A drag over line numbers is in progress: this Esc cancels the drag
  // (DiffEditor), the highlight stays.
  if (document.body.classList.contains('rv-dragging-lines')) return;
  // The right-click menu is open: this Esc closes it (cm/lsp.ts), the highlight stays.
  if (document.querySelector('.rv-lsp-menu')) return;
  // Before Zen's own Escape (App.tsx), which skips a handled event.
  e.preventDefault();
  activeHub.clear();
}

/**
 * The drawn deleted blocks by the document position they stand at. Built once
 * per measure: looking each occurrence up in the DOM would cost
 * occurrences × blocks `posAtDOM` calls on every scroll frame.
 */
function deletedChunks(view: EditorView): Map<number, HTMLElement> {
  const chunks = new Map<number, HTMLElement>();
  for (const chunk of view.contentDOM.querySelectorAll<HTMLElement>('.cm-deletedChunk')) {
    chunks.set(view.posAtDOM(chunk), chunk);
  }
  return chunks;
}

/** The `.cm-deletedLine` element an occurrence is in, if it is drawn. */
function deletedLineElement(chunks: Map<number, HTMLElement>, o: DeletedOccurrence): HTMLElement | null {
  return chunks.get(o.at)?.querySelectorAll<HTMLElement>(':scope > .cm-deletedLine')[o.line] ?? null;
}

/** A DOM range over `len` characters from `col` of a line element's text. */
function textRange(lineEl: HTMLElement, col: number, len: number): globalThis.Range | null {
  const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let seen = 0;
  let started = false;
  const end = col + len;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const length = node.data.length;
    if (!started && col <= seen + length) {
      range.setStart(node, col - seen);
      started = true;
    }
    if (started && end <= seen + length) {
      range.setEnd(node, end - seen);
      return range;
    }
    seen += length;
  }
  return null;
}

/** The offset of a DOM point within a line element's text. */
function offsetIn(lineEl: HTMLElement, node: Node, offset: number): number | null {
  if (!lineEl.contains(node)) return null;
  if (node.nodeType !== Node.TEXT_NODE) {
    // A point between children: count the text before that child.
    const before = document.createRange();
    before.setStart(lineEl, 0);
    before.setEnd(node, offset);
    return before.toString().length;
  }
  const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === node) return seen + offset;
    seen += (n as Text).data.length;
  }
  return null;
}

/** The text position under a pointer, in the browsers' two spellings. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => globalThis.Range | null;
  };
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    return p && { node: p.offsetNode, offset: p.offset };
  }
  const r = doc.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

/** The top of the text line holding `pos`, skipping the widgets drawn around it. */
function textTop(block: BlockInfo, pos: number): number {
  const parts = block.type;
  if (!Array.isArray(parts)) return block.top;
  const text = parts.find((b) => b.type === BlockType.Text && b.from <= pos && pos <= b.to);
  return (text ?? block).top;
}

/** The top of the deleted block above `block` (the merge view's widget). */
function deletionTop(block: BlockInfo): number {
  const parts = block.type;
  if (!Array.isArray(parts)) return block.top;
  const w = parts.find(
    (b) => b.type === BlockType.WidgetBefore && !(b.widget instanceof PortalWidget) && !isFoldWidget(b.widget),
  );
  return (w ?? block).top;
}

/** The nearest ancestor that scrolls vertically. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === 'auto' || y === 'scroll') return p;
  }
  return null;
}

const HIGHLIGHT = 'rv-occ';
const HIGHLIGHT_CURRENT = 'rv-occ-current';

type CssHighlights = { set(name: string, h: unknown): void; delete(name: string): void };
type HighlightCtor = new (...ranges: globalThis.Range[]) => unknown;

function cssHighlights(): { registry: CssHighlights; Ctor: HighlightCtor } | null {
  const registry = (globalThis.CSS as unknown as { highlights?: CssHighlights } | undefined)?.highlights;
  const Ctor = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
  return registry && Ctor ? { registry, Ctor } : null;
}

type Mark = { top: number; current: boolean; index: number };
type Measured = {
  word: string;
  total: number;
  deleted: { range: globalThis.Range; current: boolean }[];
  marks: Mark[];
  ruler: { top: number; height: number };
};

/** The plugin whose deleted-line highlights are on screen (they are page-global). */
let painter: object | null = null;

/**
 * Paints what the decorations cannot reach (the deleted lines), draws the
 * ruler, reports to the hub, and turns clicks in deleted lines into a
 * highlight.
 */
function occurrencePlugin(hub: OccurrenceHub) {
  return ViewPlugin.fromClass(
    class {
      /** The pane that scrolls the file (the editor itself does not scroll). */
      scroller: HTMLElement | null;

      constructor(readonly view: EditorView) {
        view.contentDOM.addEventListener('mouseup', this.onMouseUp);
        this.scroller = scrollParent(view.dom);
        this.scroller?.addEventListener('scroll', this.onScroll, { passive: true });
        // The ruler spans the pane, which a window resize changes without
        // the editor itself changing size.
        window.addEventListener('resize', this.onScroll);
        this.schedule();
      }

      onScroll = () => {
        if (this.view.state.field(highlightField)) this.schedule();
      };

      update(u: ViewUpdate) {
        const h = u.state.field(highlightField);
        const changed = h !== u.startState.field(highlightField);
        if (changed) hub.publish(h);
        if (changed || ((u.viewportChanged || u.geometryChanged || u.heightChanged) && h)) this.schedule();
      }

      schedule() {
        this.view.requestMeasure({ key: this, read: () => this.measure(), write: (m) => this.draw(m) });
      }

      measure(): Measured {
        const view = this.view;
        const h = view.state.field(highlightField);
        const deleted: Measured['deleted'] = [];
        let marks: Mark[] = [];
        let ruler = { top: 0, height: 0 };
        if (h) {
          const chunks = deletedChunks(view);
          h.list.forEach((o, i) => {
            if (o.kind !== 'del') return;
            const el = deletedLineElement(chunks, o);
            const range = el && textRange(el, o.col, o.len);
            if (range) deleted.push({ range, current: i === h.index });
          });
          ruler = this.rulerBox();
          const total = view.contentHeight;
          const lh = view.defaultLineHeight;
          const tops = h.list.map((o) =>
            rulerTop(
              o.kind === 'doc'
                ? textTop(view.lineBlockAt(o.from), o.from)
                : deletionTop(view.lineBlockAt(o.at)) + o.line * lh,
              total,
              ruler.height,
            ),
          );
          // A common word in a long file: thousands of marks on a few
          // hundred pixels, one element per pixel row is enough.
          marks = thinMarks(tops, h.index).map((index) => ({ top: tops[index], current: index === h.index, index }));
        }
        return { word: h?.word ?? '', total: h?.list.length ?? 0, deleted, marks, ruler };
      }

      /**
       * The ruler maps the whole file onto the part of it that is on screen:
       * from under the sticky header (or the file's top) down to the pane's
       * bottom (or the file's end). The page scrolls, not the editor, so this
       * is what stands in for the editor's scrollbar.
       */
      rulerBox() {
        const el = hub.ruler;
        const frame = el?.parentElement?.parentElement;
        if (!el || !frame) return { top: 0, height: 0 };
        const header = el.closest('.rv-file')?.querySelector<HTMLElement>('.rv-file-header');
        const top = header ? header.offsetHeight + (parseFloat(getComputedStyle(header).top) || 0) : 0;
        const pane = this.scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
        const box = frame.getBoundingClientRect();
        const from = Math.max(box.top, pane.top + top);
        const to = Math.min(box.bottom, pane.bottom);
        return { top, height: Math.max(0, to - from) };
      }

      draw(m: Measured) {
        const css = cssHighlights();
        // Another file's highlight may already be painted: an empty one only
        // clears what this editor painted itself.
        if (css && (m.deleted.length || painter === this)) {
          css.registry.set(HIGHLIGHT, new css.Ctor(...m.deleted.filter((d) => !d.current).map((d) => d.range)));
          css.registry.set(HIGHLIGHT_CURRENT, new css.Ctor(...m.deleted.filter((d) => d.current).map((d) => d.range)));
          painter = m.deleted.length ? this : null;
        }
        const el = hub.ruler;
        if (!el) return;
        const wrap = el.parentElement;
        if (wrap) wrap.style.top = `${m.ruler.top}px`;
        el.style.height = `${m.ruler.height}px`;
        el.hidden = m.marks.length === 0;
        el.replaceChildren(
          ...m.marks.map((mk) => {
            const i = document.createElement('i');
            i.className = mk.current ? 'rv-occ-ruler__mark is-current' : 'rv-occ-ruler__mark';
            i.style.top = `${mk.top}px`;
            i.dataset.index = String(mk.index);
            i.title = `${m.word} — ${mk.index + 1} из ${m.total}`;
            return i;
          }),
        );
      }

      /** The editor ignores clicks in deleted lines (a widget); we read them here. */
      onMouseUp = (e: MouseEvent) => {
        if (e.button !== 0) return;
        const lineEl = (e.target as HTMLElement).closest?.<HTMLElement>('.cm-deletedLine');
        const chunk = lineEl?.parentElement;
        if (!lineEl || !chunk?.classList.contains('cm-deletedChunk')) return;
        const view = this.view;
        const text = lineEl.textContent ?? '';
        let range: { from: number; to: number } | null = null;
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.rangeCount) {
          const r = sel.getRangeAt(0);
          const from = offsetIn(lineEl, r.startContainer, r.startOffset);
          const to = offsetIn(lineEl, r.endContainer, r.endOffset);
          const w = from !== null && to !== null && isSingleWord(text.slice(from, to)) ? wordAt(text, from) : null;
          range = w && w.from === from && w.to === to ? w : null;
        } else {
          const caret = caretAt(e.clientX, e.clientY);
          const at = caret && offsetIn(lineEl, caret.node, caret.offset);
          range = at === null || at === undefined ? null : wordAt(text, at);
        }
        if (!range) {
          if (view.state.field(highlightField)) view.dispatch({ effects: setHighlight.of(null) });
          return;
        }
        const word = text.slice(range.from, range.to);
        const prev = view.state.field(highlightField);
        const list = prev && prev.word === word ? prev.list : occurrencesOf(view.state, word);
        const pos = view.posAtDOM(chunk);
        const line = [...chunk.querySelectorAll(':scope > .cm-deletedLine')].indexOf(lineEl);
        const index = list.findIndex((o) => o.kind === 'del' && o.at === pos && o.line === line && o.col === range.from);
        view.dispatch({ effects: setHighlight.of({ word, list, index }) });
      };

      destroy() {
        this.view.contentDOM.removeEventListener('mouseup', this.onMouseUp);
        this.scroller?.removeEventListener('scroll', this.onScroll);
        window.removeEventListener('resize', this.onScroll);
        hub.ruler?.replaceChildren();
        const css = cssHighlights();
        if (css && painter === this) {
          css.registry.delete(HIGHLIGHT);
          css.registry.delete(HIGHLIGHT_CURRENT);
          painter = null;
        }
      }
    },
  );
}

/** Highlight of occurrences for one diff editor, reporting to `hub`. */
export function occurrences(hub: OccurrenceHub): Extension {
  return [highlightField, occurrencePlugin(hub)];
}
