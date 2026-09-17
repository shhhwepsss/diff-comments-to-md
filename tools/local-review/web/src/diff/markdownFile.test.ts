import { describe, expect, it } from 'vitest';
import type { DiffResponse } from '../api/types';
import { isMarkdownPath, markdownToRender } from './markdownFile';

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

describe('markdownToRender', () => {
  it('renders the new version of a modified file', () => {
    expect(markdownToRender('README.md', diff({ oldText: '# old', newText: '# new' }))).toEqual({
      text: '# new',
      side: 'new',
    });
  });

  it('renders the new version of an added file', () => {
    expect(markdownToRender('README.md', diff({ oldText: null, newText: '# added' }))).toEqual({
      text: '# added',
      side: 'new',
    });
  });

  it('renders the old version of a deleted file', () => {
    expect(markdownToRender('README.md', diff({ oldText: '# gone', newText: null }))).toEqual({
      text: '# gone',
      side: 'old',
    });
  });

  it('renders an emptied file as empty rather than falling back to the old text', () => {
    expect(markdownToRender('README.md', diff({ oldText: '# was here', newText: '' }))).toEqual({ text: '', side: 'new' });
  });

  it('returns null for non-markdown files', () => {
    expect(markdownToRender('index.ts', diff({ oldText: 'a', newText: 'b' }))).toBeNull();
  });

  it('returns null when there is no text to render', () => {
    expect(markdownToRender('README.md', diff({ oldText: null, newText: null, textUnavailable: 'too big' }))).toBeNull();
    expect(markdownToRender('README.md', diff({}))).toBeNull();
  });

  it('returns null for binary or missing files', () => {
    expect(markdownToRender('README.md', diff({ binary: true, newText: 'x' }))).toBeNull();
    expect(markdownToRender('README.md', diff({ missing: true, newText: 'x' }))).toBeNull();
  });
});
