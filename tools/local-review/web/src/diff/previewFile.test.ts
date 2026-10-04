import { describe, expect, it } from 'vitest';
import type { DiffResponse } from '../api/types';
import { isHtmlPath, isMarkdownPath, previewKind, previewToRender } from './previewFile';

function diff(over: Partial<DiffResponse>): DiffResponse {
  return {
    path: 'README.md',
    status: 'M',
    kind: 'modified',
    hunks: [],
    binary: false,
    additions: 0,
    deletions: 0,
    ...over,
  };
}

describe('isMarkdownPath', () => {
  it.each(['README.md', 'docs/guide.markdown', 'a/b/Notes.MD', 'page.mdx', 'x.mdown', 'x.mkd', 'x.mkdn'])(
    'accepts %s',
    (p) => expect(isMarkdownPath(p)).toBe(true),
  );

  it.each(['README', 'notes.txt', 'md', 'docs.md/index.ts', 'file.md.bak', 'x.rmd', 'x.mdc', ''])('rejects %s', (p) =>
    expect(isMarkdownPath(p)).toBe(false),
  );
});

describe('isHtmlPath', () => {
  it.each(['index.html', 'a/b/Page.HTM', 'x.xhtml'])('accepts %s', (p) => expect(isHtmlPath(p)).toBe(true));
  it.each(['index.html.bak', 'html', 'page.shtml', 'x.htmlx', 'html/index.ts', ''])('rejects %s', (p) =>
    expect(isHtmlPath(p)).toBe(false),
  );
});

describe('previewKind', () => {
  it('tells markdown from html', () => {
    expect(previewKind('README.md')).toBe('markdown');
    expect(previewKind('index.html')).toBe('html');
    expect(previewKind('main.ts')).toBeNull();
  });
});

describe('previewToRender', () => {
  it('renders the new version of a modified file', () => {
    expect(previewToRender('README.md', diff({ oldText: '# old', newText: '# new' }))).toEqual({
      kind: 'markdown',
      text: '# new',
      side: 'new',
    });
  });

  it('renders the new version of an added file', () => {
    expect(previewToRender('README.md', diff({ oldText: null, newText: '# added' }))).toEqual({
      kind: 'markdown',
      text: '# added',
      side: 'new',
    });
  });

  it('renders the old version of a deleted file', () => {
    expect(previewToRender('README.md', diff({ oldText: '# gone', newText: null }))).toEqual({
      kind: 'markdown',
      text: '# gone',
      side: 'old',
    });
  });

  it('renders an emptied file as empty rather than falling back to the old text', () => {
    expect(previewToRender('README.md', diff({ oldText: '# was here', newText: '' }))).toEqual({ kind: 'markdown', text: '', side: 'new' });
  });

  it('renders html files as html', () => {
    expect(previewToRender('site/index.html', diff({ path: 'site/index.html', oldText: null, newText: '<p>hi</p>' }))).toEqual({
      kind: 'html',
      text: '<p>hi</p>',
      side: 'new',
    });
  });

  it('returns null for files without a rendered view', () => {
    expect(previewToRender('index.ts', diff({ oldText: 'a', newText: 'b' }))).toBeNull();
  });

  it('returns null when there is no text to render', () => {
    expect(previewToRender('README.md', diff({ oldText: null, newText: null, textUnavailable: 'too big' }))).toBeNull();
    expect(previewToRender('README.md', diff({}))).toBeNull();
  });

  it('returns null for binary or missing files', () => {
    expect(previewToRender('README.md', diff({ binary: true, newText: 'x' }))).toBeNull();
    expect(previewToRender('README.md', diff({ missing: true, newText: 'x' }))).toBeNull();
  });
});
