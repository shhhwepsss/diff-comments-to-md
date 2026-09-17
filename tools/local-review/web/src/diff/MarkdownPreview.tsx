import { useMemo } from 'react';
import { Button } from '@primer/react';
import { ImageIcon } from '@primer/octicons-react';
import { renderMarkdown } from './renderMarkdown';
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
  const { html, externalImages } = useMemo(() => renderMarkdown(text, { loadExternalImages }), [text, loadExternalImages]);
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
      <div className="rv-markdown" dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}
