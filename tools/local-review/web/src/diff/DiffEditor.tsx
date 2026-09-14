import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { unifiedMergeView } from '@codemirror/merge';
import type { Hunk } from '../api/types';
import { orderedRange, type LineRange } from './lineMap';
import { finalEmptyLine } from './cm/lastLine';
import { gitDiffOverride, unpairedAddedLines } from './gitDiff';
import { chunkInfo, pureInsertions } from './cm/chunks';
import { PortalRegistry, blocksField, setBlocks, type Block } from './cm/blocks';
import { selectedLines, setSelectedLines } from './cm/selection';
import { foldUnchanged } from './cm/collapse';
import { diffGutters, lineAtY } from './cm/gutters';
import { githubHighlight, githubTheme } from './cm/theme';
import { languageFor } from './cm/language';

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
};

/**
 * One read-only unified diff of a file: the new text is the document, the old
 * text is the merge view's original. Comments render inside it as React
 * portals.
 */
export function DiffEditor({ path, oldText, newText, hunks, deletedFile, wrap, blocks, selected, renderBlock, onSelectLines }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const registry = useMemo(() => new PortalRegistry(), []);
  const wrapConf = useMemo(() => new Compartment(), []);

  // Latest props for handlers created once per view.
  const latest = useRef({ blocks, selected, wrap, onSelectLines });
  latest.current = { blocks, selected, wrap, onSelectLines };

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
      const state = EditorState.create({
        doc: newText,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
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
          blocksField(registry),
          selectedLines,
          foldUnchanged,
          diffGutters({ onLineMouseDown }),
          githubTheme,
          githubHighlight,
          finalEmptyLine(deletedFile || /[\r\n]$/.test(newText)),
          wrapConf.of(latest.current.wrap ? EditorView.lineWrapping : []),
        ],
      });

      const v = new EditorView({ state, parent });
      view.current = v;
      registry.view = v;
      v.dispatch({
        effects: [setBlocks.of(latest.current.blocks), setSelectedLines.of(latest.current.selected)],
      });
    };

    // The language package is a lazy chunk; wait for it (cached after the
    // first file of a kind) so deleted lines get highlighted too.
    let alive = true;
    void languageFor(path).then((lang) => {
      if (alive) create(lang ?? []);
    });

    return () => {
      alive = false;
      stopDrag();
      drag.current = null;
      view.current?.destroy();
      view.current = null;
      registry.view = null;
      registry.destroy();
    };
  }, [path, oldText, newText, hunks, deletedFile, registry, wrapConf]);

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

  return (
    <>
      <div ref={host} className="rv-diff-editor" />
      {registry.entries().map(([key, el]) => createPortal(renderBlock(key), el, key))}
    </>
  );
}
