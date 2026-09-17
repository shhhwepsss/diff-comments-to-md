import { describe, expect, it } from 'vitest';
import type { Comment } from '../api/types';
import { setFileHidden, visibleComments } from './hiddenComments';

function comment(over: Partial<Comment>): Comment {
  return {
    id: 'id',
    file: 'src/a.ts',
    startLine: 1,
    endLine: 1,
    text: 'text',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...over,
  };
}

describe('visibleComments', () => {
  const list = [comment({ id: 'line' }), comment({ id: 'file-level', startLine: null, endLine: null })];

  it('returns every comment while the file is not hidden', () => {
    expect(visibleComments(list, false, null)).toBe(list);
    expect(visibleComments(list, false, 'line')).toBe(list);
  });

  it('hides line and file-level comments alike', () => {
    expect(visibleComments(list, true, null)).toEqual([]);
  });

  it('keeps the comment being edited so its unsaved text survives', () => {
    expect(visibleComments(list, true, 'file-level').map((c) => c.id)).toEqual(['file-level']);
    // An edit on another file's comment does not leak into this one.
    expect(visibleComments(list, true, 'elsewhere')).toEqual([]);
  });
});

describe('setFileHidden', () => {
  it('hides and shows one file without touching the others', () => {
    const a = setFileHidden({}, 'a.ts', true);
    const ab = setFileHidden(a, 'b.ts', true);
    expect(ab).toEqual({ 'a.ts': true, 'b.ts': true });
    expect(setFileHidden(ab, 'a.ts', false)).toEqual({ 'b.ts': true });
    expect(ab).toEqual({ 'a.ts': true, 'b.ts': true });
  });

  it('returns the same object when nothing changes, so React skips the render', () => {
    const prev = { 'a.ts': true };
    expect(setFileHidden(prev, 'a.ts', true)).toBe(prev);
    const empty = {};
    expect(setFileHidden(empty, 'a.ts', false)).toBe(empty);
  });
});
