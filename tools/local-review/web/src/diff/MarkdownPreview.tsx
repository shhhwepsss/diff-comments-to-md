import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Button, useTheme } from '@primer/react';
import { ImageIcon } from '@primer/octicons-react';
import { renderMarkdown } from './renderMarkdown';
import { diagramAt, diagramIndexOf, renderMermaidBlocks } from './mermaidBlocks';
import { MermaidViewer } from './MermaidViewer';
import './markdown.css';

// Read-only rendered view of a markdown file. Loaded with React.lazy, so the
// markdown parser, the sanitizer and these styles stay out of the main bundle.

type Props = {
  text: string;
  /** Remote images load only after the reviewer asked for it for this file. */
  loadExternalImages: boolean;
  onLoadExternalImages: () => void;
};

export default function MarkdownPreview({ text, loadExternalImages, onLoadExternalImages }: Props) {
  // renderMarkdown sanitizes: the HTML below never carries scripts, event
  // handlers, javascript: URLs or, until opted in, remote resource URLs
  // (see renderMarkdown.test.ts).
  const { html, externalImages, mermaidBlocks } = useMemo(() => renderMarkdown(text, { loadExternalImages }), [text, loadExternalImages]);
  const body = useRef<HTMLDivElement>(null);
  const { resolvedColorMode } = useTheme();
  const dark = resolvedColorMode === 'night' || resolvedColorMode === 'dark';
  // The diagram shown in the full-window viewer: its block and its picture.
  const [expanded, setExpanded] = useState<{ index: number; src: string } | null>(null);

  // Diagrams are drawn into the HTML React has already put in place. React
  // only resets that HTML when `html` changes, and then this runs again; a
  // theme change redraws over the same blocks. mermaid itself is imported on
  // the first document that has a block.
  useEffect(() => {
    const root = body.current;
    if (!root || mermaidBlocks === 0) return;
    let stale = false;
    void renderMermaidBlocks(
      root,
      async (source) => (await import('./mermaidDiagram')).drawMermaid(source, dark),
      () => stale,
    ).then(() => {
      if (stale) return;
      // An open viewer follows the redraw: same block, its new picture.
      setExpanded((open) => {
        if (!open) return open;
        const src = diagramAt(root, open.index);
        if (!src) return null;
        return src === open.src ? open : { index: open.index, src };
      });
    });
    return () => {
      stale = true;
    };
  }, [html, mermaidBlocks, dark]);

  const expand = (e: MouseEvent<HTMLDivElement>) => {
    const root = body.current;
    if (!root) return;
    const index = diagramIndexOf(root, e.target as Element);
    const src = index < 0 ? null : diagramAt(root, index);
    if (src) setExpanded({ index, src });
  };

  if (!text.trim()) {
    return <div className="rv-markdown rv-markdown--empty">Файл пуст.</div>;
  }
  return (
    <>
      {externalImages > 0 && !loadExternalImages && (
        <div className="rv-markdown-external">
          <Button size="small" leadingVisual={ImageIcon} onClick={onLoadExternalImages}>
            Показать внешние картинки ({externalImages})
          </Button>
          <span className="rv-hint">Внешние картинки не загружаются сами: их сервер увидел бы твой IP.</span>
        </div>
      )}
      <div ref={body} className="rv-markdown" onClick={expand} dangerouslySetInnerHTML={{ __html: html }} />
      {expanded && <MermaidViewer src={expanded.src} onClose={() => setExpanded(null)} />}
    </>
  );
}
