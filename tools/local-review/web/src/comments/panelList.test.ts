import { describe, expect, it } from 'vitest';
import type { Comment } from '../api/types';
import { countByKind, filterItems, panelItems, stepId } from './panelList';

function c(id: string, file: string | null, line: number | null, createdAt = '2024-01-01T00:00:00Z'): Comment {
  return { id, file, startLine: line, endLine: line, text: id, createdAt, updatedAt: createdAt };
}

const FILES = ['b.ts', 'a.ts'];

describe('panelItems', () => {
  const comments = [
    c('orphan', 'gone.ts', 3),
    c('a10', 'a.ts', 10),
    c('stale', 'b.ts', 1),
    c('b20', 'b.ts', 20),
    c('gen2', null, null, '2024-01-02T00:00:00Z'),
    c('b5', 'b.ts', 5),
    c('aFile', 'a.ts', null),
    c('gen1', null, null, '2024-01-01T00:00:00Z'),
  ];
  const stale = new Set(['stale', 'gen1']);
  const items = panelItems(comments, FILES, (x) => stale.has(x.id));

  it('orders like the export: general, files in diff order by line, orphans, stale', () => {
    expect(items.map((i) => i.comment.id)).toEqual(['gen1', 'gen2', 'b5', 'b20', 'aFile', 'a10', 'orphan', 'stale']);
  });

  it('never marks a general comment stale', () => {
    expect(items.find((i) => i.comment.id === 'gen1')?.kind).toBe('general');
  });

  it('counts and filters by group', () => {
    expect(countByKind(items)).toEqual({ all: 8, general: 2, file: 4, orphan: 1, stale: 1 });
    expect(filterItems(items, 'stale').map((i) => i.comment.id)).toEqual(['stale']);
    expect(filterItems(items, 'all')).toBe(items);
  });
});

describe('stepId', () => {
  const items = panelItems([c('x', 'a.ts', 1), c('y', 'a.ts', 2), c('z', 'a.ts', 3)], ['a.ts'], () => false);

  it('moves and stops at the ends', () => {
    expect(stepId(items, 'x', 1)).toBe('y');
    expect(stepId(items, 'z', 1)).toBe('z');
    expect(stepId(items, 'x', -1)).toBe('x');
  });

  it('starts from the first going down and the last going up', () => {
    expect(stepId(items, null, 1)).toBe('x');
    expect(stepId(items, 'missing', -1)).toBe('z');
  });

  it('has nowhere to go in an empty list', () => {
    expect(stepId([], null, 1)).toBeNull();
  });
});
