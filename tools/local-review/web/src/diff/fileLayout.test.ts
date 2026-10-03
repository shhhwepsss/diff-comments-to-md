import { describe, expect, it } from 'vitest';
import type { Comment } from '../api/types';
import { fileLayout } from './fileLayout';

function comment(id: string, startLine: number | null, endLine: number | null): Comment {
  return { id, file: 'a.ts', startLine, endLine, text: id, createdAt: '', updatedAt: '' };
}

const base = { commentsHidden: false, editingId: null, showsEditor: true, docLines: 10, rendered: false, editor: null };

describe('fileLayout', () => {
  it('anchors a comment under its last line when that line is in the document', () => {
    const c = comment('c1', 2, 4);
    const out = fileLayout({ ...base, comments: [c] });
    expect(out.anchored).toEqual([c]);
    expect(out.unanchored).toEqual([]);
    expect(out.blocks).toEqual([{ key: 'c:c1', line: 4 }]);
  });

  it('puts file-level comments and lines past the document above the diff', () => {
    const whole = comment('whole', null, null);
    const past = comment('past', 11, 11);
    const out = fileLayout({ ...base, comments: [whole, past] });
    expect(out.anchored).toEqual([]);
    expect(out.unanchored).toEqual([whole, past]);
    expect(out.blocks).toEqual([]);
  });

  it('anchors nothing when there is no line-by-line diff', () => {
    const c = comment('c1', 2, 2);
    const out = fileLayout({ ...base, showsEditor: false, docLines: 0, comments: [c] });
    expect(out.unanchored).toEqual([c]);
  });

  it('drops hidden comments, except the one being edited', () => {
    const a = comment('a', 1, 1);
    const b = comment('b', 2, 2);
    const out = fileLayout({ ...base, comments: [a, b], commentsHidden: true, editingId: 'b' });
    expect(out.anchored).toEqual([b]);
  });

  it('places the open form under the lower end of its range and highlights the range in order', () => {
    const out = fileLayout({ ...base, comments: [], editor: { start: 7, end: 3 } });
    expect(out.editorInDoc).toBe(true);
    expect(out.blocks).toEqual([{ key: 'editor', line: 7 }]);
    expect(out.selected).toEqual({ from: 3, to: 7 });
  });

  it('moves the form above the diff for a file-level comment', () => {
    const out = fileLayout({ ...base, comments: [], editor: { start: null, end: null } });
    expect(out.editorInDoc).toBe(false);
    expect(out.blocks).toEqual([]);
    expect(out.selected).toBeNull();
  });

  it('moves the form above the diff in the rendered view and past the document end', () => {
    expect(fileLayout({ ...base, comments: [], rendered: true, editor: { start: 2, end: 2 } }).editorInDoc).toBe(false);
    expect(fileLayout({ ...base, comments: [], editor: { start: 11, end: 11 } }).editorInDoc).toBe(false);
  });
});
