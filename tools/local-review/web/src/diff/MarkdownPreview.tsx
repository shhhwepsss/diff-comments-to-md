import { useMemo } from 'react';
import { renderMarkdown } from './renderMarkdown';
import './markdown.css';

// Read-only rendered view of a markdown file. Loaded with React.lazy, so the
// markdown parser, the sanitizer and these styles stay out of the main bundle.

export default function MarkdownPreview({ text }: { text: string }) {
  // renderMarkdown sanitizes: the HTML below never carries scripts, event
  // handlers or javascript: URLs (see renderMarkdown.test.ts).
  const html = useMemo(() => renderMarkdown(text), [text]);
  if (!text.trim()) {
    return <div className="rv-markdown rv-markdown--empty">Файл пуст.</div>;
  }
  return <div className="rv-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
