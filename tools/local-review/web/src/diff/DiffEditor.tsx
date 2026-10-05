import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { unifiedMergeView } from '@codemirror/merge';
import type { Hunk } from '../api/types';
import { failureMessage } from '../api/client';
import { useToast } from '../lib/toast';
import { orderedRange, type LineRange } from './lineMap';
import { finalEmptyLine } from './cm/lastLine';
import { gitDiffOverride, unpairedAddedLines } from './gitDiff';
import { chunkInfo, pureInsertions } from './cm/chunks';
import { PortalRegistry, blocksField, setBlocks, type Block } from './cm/blocks';
import { pinBlocks } from './cm/blockPin';
import { selectedLines, setSelectedLines } from './cm/selection';
import { foldUnchanged, unfoldAt } from './cm/collapse';
import { diffGutters, fullFileGutter, lineAtY } from './cm/gutters';
import { githubHighlight, githubTheme } from './cm/theme';
import { languageFor } from './cm/language';
import { occurrences as occurrenceHighlight, type OccurrenceHub } from './cm/occurrences';
import { lspNavigation, type LspHub } from './cm/lsp';

type Props = {
  path: string;
  oldText: string;
  newText: string;
  /** Git's hunks for these two texts (the line structure of the diff). */
  hunks: Hunk[];
  /** The file is gone in the new version: hide the empty new document line. */
  deletedFile: boolean;
  wrap: boolean;
  /** Comment cards / the editor, anchored under a new-file line. */
  blocks: Block[];
  /** Highlighted range (the one the open editor is for). */
  selected: LineRange | null;
  renderBlock: (key: string) => ReactNode;
  /** A click or drag over line numbers finished on this range. */
  onSelectLines: (range: LineRange) => void;
  /**
   * Scroll these lines to the middle and flash them; a new `nonce` asks again.
   * `ch` (a column of `from`, zero-based) also puts the caret there, which
   * highlights the word it lands on — the symbol a jump led to.
   */
  reveal?: { from: number; to: number; nonce: number; ch?: number } | null;
  /** The reveal with this nonce is done — the caller stops passing it. */
  onRevealed?: (nonce: number) => void;
  /** Where the highlight of a clicked word's occurrences is reported (the file header). */
  occurrences: OccurrenceHub;
  /** Hover, Ctrl+click and the context menu of code navigation. */
  lsp: LspHub;
  /**
   * A whole file outside the diff (opened by code navigation, or one with
   * comments): `newText` is the file, there is no old side, nothing is
   * folded, one column of numbers — clickable for comments like the diff's.
   */
  full?: boolean;
};

const FLASH_MS = 1600;
/** How long after a reveal the scroll still follows the growing content. */
const SETTLE_MS = 500;

/**
 * One read-only unified diff of a file: the new text is the document, the old
 * text is the merge view's original. Comments render inside it as React
 * portals.
 */
export function DiffEditor({
  path,
  oldText,
  newText,
  hunks,
  deletedFile,
  wrap,
  blocks,
  selected,
  renderBlock,
  onSelectLines,
  reveal = null,
  onRevealed,
  occurrences,
  lsp,
  full = false,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const registry = useMemo(() => new PortalRegistry(), []);
  const wrapConf = useMemo(() => new Compartment(), []);
  const toast = useToast();

  // Latest props for handlers created once per view.
  const latest = useRef({ blocks, selected, wrap, onSelectLines, reveal, onRevealed });
  latest.current = { blocks, selected, wrap, onSelectLines, reveal, onRevealed };

  // The editor is created asynchronously (the language chunk), so a reveal
  // asked for before that runs once the view exists.
  const flashTimer = useRef<number | undefined>(undefined);
  const settle = useRef<ResizeObserver | null>(null);
  const settleTimer = useRef<number | undefined>(undefined);
  const applyReveal = useCallback(() => {
    const v = view.current;
    const r = latest.current.reveal;
    if (!v || !r) return;
    const doc = v.state.doc;
    const line = doc.line(Math.min(Math.max(1, r.from), doc.lines));
    // A line in a folded run of unchanged lines is shown first.
    const unfold = unfoldAt(v.state, line.from);
    v.dispatch({
      effects: [
        ...(unfold ? [unfold] : []),
        EditorView.scrollIntoView(line.from, { y: 'center' }),
        setSelectedLines.of({ from: r.from, to: r.to }),
      ],
      ...(r.ch !== undefined ? { selection: { anchor: line.from + Math.min(Math.max(0, r.ch), line.length) } } : {}),
    });
    // The comment's card under the line is drawn a moment later (a React
    // portal). Near the end of the file it would land below the fold, so the
    // scroll is repeated while the content is still growing.
    settle.current?.disconnect();
    const grown = new ResizeObserver(() => {
      if (view.current !== v) return;
      const at = v.state.doc.line(Math.min(line.number, v.state.doc.lines)).from;
      v.dispatch({ effects: EditorView.scrollIntoView(at, { y: 'center' }) });
    });
    grown.observe(v.contentDOM);
    settle.current = grown;
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => grown.disconnect(), SETTLE_MS);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => {
      if (!drag.current) view.current?.dispatch({ effects: setSelectedLines.of(latest.current.selected) });
    }, FLASH_MS);
    latest.current.onRevealed?.(r.nonce);
  }, []);
  useEffect(
    () => () => {
      window.clearTimeout(flashTimer.current);
      window.clearTimeout(settleTimer.current);
      settle.current?.disconnect();
    },
    [],
  );

  // Drag over line numbers: anchor line + current line, painted live.
  const drag = useRef<{ anchor: number; current: number } | null>(null);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;

    const paint = (range: LineRange | null) => view.current?.dispatch({ effects: setSelectedLines.of(range) });

    const lineAtPointer = (event: MouseEvent): number | null =>
      view.current ? lineAtY(view.current, event.clientY) : null;

    const stopDrag = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onCancel);
      window.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('rv-dragging-lines');
    };
    const onMove = (event: MouseEvent) => {
      if (!drag.current) return;
      const n = lineAtPointer(event);
      if (n === null || n === drag.current.current) return;
      drag.current.current = n;
      paint(orderedRange(drag.current.anchor, n));
    };
    const onUp = () => {
      const d = drag.current;
      drag.current = null;
      stopDrag();
      if (d) latest.current.onSelectLines(orderedRange(d.anchor, d.current));
    };
    const onCancel = () => {
      if (!drag.current) return;
      drag.current = null;
      stopDrag();
      paint(latest.current.selected);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && drag.current) {
        event.stopPropagation();
        onCancel();
      }
    };

    const onLineMouseDown = (line: number, event: MouseEvent) => {
      if (event.button !== 0) return;
      // Otherwise the browser starts selecting diff text while we drag.
      event.preventDefault();
      const sel = latest.current.selected;
      const anchor = event.shiftKey && sel ? sel.from : line;
      drag.current = { anchor, current: line };
      document.body.classList.add('rv-dragging-lines');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('blur', onCancel);
      window.addEventListener('keydown', onKey, true);
      paint(orderedRange(anchor, line));
    };

    const create = (lang: Extension) => {
      // Both texts keep their final newline (see cm/lastLine.ts).
      const diffOnly: Extension[] = full
        ? [fullFileGutter({ onLineMouseDown })]
        : [
            // Before the merge view: its deletion blocks are highlighted with
            // the language that is active when they are first drawn.
            lang,
            unifiedMergeView({
              original: oldText,
              mergeControls: false,
              gutter: false,
              highlightChanges: true,
              syntaxHighlightDeletions: true,
              // Line structure from git's hunks, so blocks match `git diff`.
              diffConfig: { override: gitDiffOverride(hunks) },
            }),
            chunkInfo,
            pureInsertions(unpairedAddedLines(hunks)),
          ];
      const state = EditorState.create({
        doc: newText,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          full ? lang : [],
          diffOnly,
          blocksField(registry),
          pinBlocks,
          selectedLines,
          full ? [] : foldUnchanged,
          occurrenceHighlight(occurrences),
          lspNavigation(lsp),
          full ? [] : diffGutters({ onLineMouseDown }),
          githubTheme,
          githubHighlight,
          finalEmptyLine(deletedFile || /[\r\n]$/.test(newText)),
          wrapConf.of(latest.current.wrap ? EditorView.lineWrapping : []),
        ],
      });

      const v = new EditorView({ state, parent });
      view.current = v;
      registry.view = v;
      occurrences.attach(v);
      v.dispatch({
        effects: [setBlocks.of(latest.current.blocks), setSelectedLines.of(latest.current.selected)],
      });
      applyReveal();
    };

    // The language package is a lazy chunk; wait for it (cached after the
    // first file of a kind) so deleted lines get highlighted too.
    let alive = true;
    void languageFor(path).then(
      (lang) => {
        if (alive) create(lang ?? []);
      },
      (e) => {
        if (!alive) return;
        // The chunk didn't load: the diff is still readable, just plain.
        create([]);
        toast(failureMessage('Подсветка синтаксиса не загрузилась', e), true);
      },
    );

    return () => {
      alive = false;
      stopDrag();
      drag.current = null;
      if (view.current) occurrences.detach(view.current);
      view.current?.destroy();
      view.current = null;
      registry.view = null;
      registry.destroy();
    };
  }, [path, oldText, newText, hunks, deletedFile, registry, wrapConf, toast, applyReveal, occurrences, lsp, full]);

  useEffect(() => {
    if (reveal) applyReveal();
  }, [reveal?.nonce, applyReveal]);

  const blocksKey = blocks.map((b) => `${b.key}@${b.line}`).join('|');
  useEffect(() => {
    view.current?.dispatch({ effects: setBlocks.of(latest.current.blocks) });
  }, [blocksKey]);

  const selectedKey = selected ? `${selected.from}-${selected.to}` : '';
  useEffect(() => {
    if (!drag.current) view.current?.dispatch({ effects: setSelectedLines.of(latest.current.selected) });
  }, [selectedKey]);

  useEffect(() => {
    view.current?.dispatch({ effects: wrapConf.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap, wrapConf]);

  useSyncExternalStore(registry.subscribe, registry.getSnapshot);

  const rulerRef = useCallback(
    (el: HTMLDivElement | null) => {
      occurrences.ruler = el;
    },
    [occurrences],
  );

  return (
    <>
      {/* The occurrence marks: sticky, so they stay beside the part of the
          file on screen (cm/occurrences.ts sizes and fills them). */}
      <div className="rv-occ-ruler-wrap">
        <div
          className="rv-occ-ruler"
          hidden
          ref={rulerRef}
          onMouseDown={(e) => {
            const index = (e.target as HTMLElement).dataset.index;
            if (index === undefined) return;
            e.preventDefault();
            occurrences.goTo(Number(index));
          }}
        />
      </div>
      <div ref={host} className="rv-diff-editor" />
      {registry.entries().map(([key, el]) => createPortal(renderBlock(key), el, key))}
    </>
  );
}
