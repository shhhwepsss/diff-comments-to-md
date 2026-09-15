import { describe, expect, it } from 'vitest';
import type { Comment } from '../api/types';
import { anchorLabel } from '../lib/format';
import { generalComments, isGeneralComment } from './generalComments';

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

describe('isGeneralComment', () => {
  it('is true only for a comment without a file', () => {
    expect(isGeneralComment(comment({ file: null, startLine: null, endLine: null }))).toBe(true);
    expect(isGeneralComment(comment({}))).toBe(false);
    // A file-level comment has no lines either, but it still belongs to a file.
    expect(isGeneralComment(comment({ startLine: null, endLine: null }))).toBe(false);
  });
});

describe('generalComments', () => {
  it('keeps only general comments, oldest first, like the export', () => {
    const list = [
      comment({ id: 'line' }),
      comment({ id: 'late', file: null, createdAt: '2026-09-02T00:00:00.000Z' }),
      comment({ id: 'early', file: null, createdAt: '2026-09-01T00:00:00.000Z' }),
      comment({ id: 'file-level', startLine: null, endLine: null }),
    ];
    expect(generalComments(list).map((c) => c.id)).toEqual(['early', 'late']);
  });

  it('keeps store order for equal timestamps and does not mutate the input', () => {
    const list = [comment({ id: 'b', file: null }), comment({ id: 'a', file: null })];
    expect(generalComments(list).map((c) => c.id)).toEqual(['b', 'a']);
    expect(list.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('returns an empty list for a store written before general comments existed', () => {
    expect(generalComments([comment({}), comment({ id: 'x', startLine: null, endLine: null })])).toEqual([]);
  });
});

describe('anchorLabel', () => {
  it('names a general comment instead of printing a null path', () => {
    expect(anchorLabel({ file: null, startLine: null, endLine: null })).toBe('Общий комментарий');
  });

  it('keeps the export anchor format for code comments', () => {
    expect(anchorLabel({ file: 'a.ts', startLine: 3, endLine: 3 })).toBe('a.ts:L3');
    expect(anchorLabel({ file: 'a.ts', startLine: 3, endLine: 5 })).toBe('a.ts:L3-L5');
    expect(anchorLabel({ file: 'a.ts', startLine: null, endLine: null })).toBe('a.ts');
  });
});
