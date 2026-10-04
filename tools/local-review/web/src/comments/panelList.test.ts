import { describe, expect, it } from 'vitest';
import type { Comment } from '../api/types';
import { countByKind, excerpt, filterItems, highlightParts, panelItems, searchItems, stepId } from './panelList';

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

describe('searchItems', () => {
  const t = (id: string, file: string | null, text: string): Comment => ({ ...c(id, file, file === null ? null : 1), text });
  const items = panelItems(
    [
      t('gen', null, 'Общий: проверить README перед релизом'),
      t('todo', 'src/api/client.ts', 'TODO: handle the Timeout here'),
      t('ru', 'src/api/client.ts', 'Тут нужна Проверка на null'),
      t('re', 'lib/util.js', 'regexp chars: a.b (x) [y] \d+ $end*'),
      t('path', 'docs/Guide.md', 'опечатка'),
    ],
    ['src/api/client.ts', 'lib/util.js', 'docs/Guide.md'],
    () => false,
  );
  const ids = (q: string) => searchItems(items, q).map((i) => i.comment.id);

  it('returns the very same list for an empty or whitespace-only query', () => {
    expect(searchItems(items, '')).toBe(items);
    expect(searchItems(items, '  \t\n ')).toBe(items);
  });

  it('matches a substring of the text, ignoring case and outer whitespace', () => {
    expect(ids('timeout')).toEqual(['todo']);
    expect(ids('TIMEOUT')).toEqual(['todo']);
    expect(ids('  the Time  ')).toEqual(['todo']);
    expect(ids('imeou')).toEqual(['todo']);
  });

  it('matches Cyrillic text in any case', () => {
    expect(ids('проверка')).toEqual(['ru']);
    expect(ids('ПРОВЕР')).toEqual(['gen', 'ru']);
  });

  it('matches the file path as well as the text', () => {
    expect(ids('client.ts')).toEqual(['todo', 'ru']);
    expect(ids('SRC/API')).toEqual(['todo', 'ru']);
    expect(ids('guide')).toEqual(['path']);
  });

  it('a general comment has no path and matches by text only', () => {
    expect(ids('readme')).toEqual(['gen']);
    expect(ids('null')).toEqual(['ru']);
    expect(ids('общий комментарий')).toEqual([]);
  });

  it('takes the query literally, not as a regexp', () => {
    expect(ids('a.b')).toEqual(['re']);
    expect(ids('axb')).toEqual([]);
    expect(ids('.*')).toEqual([]);
    expect(ids('(x)')).toEqual(['re']);
    expect(ids('[y]')).toEqual(['re']);
    expect(ids('\d+')).toEqual(['re']);
    expect(ids('$end*')).toEqual(['re']);
    expect(ids('(')).toEqual(['re']);
  });

  it('keeps the order and gives nothing when nothing matches', () => {
    expect(ids('e')).toEqual(['gen', 'todo', 'ru', 're', 'path']);
    expect(ids('нет такого')).toEqual([]);
  });
});

describe('highlightParts', () => {
  it('is one plain part without a query or without a match', () => {
    expect(highlightParts('some text', ' ')).toEqual([{ text: 'some text', hit: false }]);
    expect(highlightParts('some text', 'zzz')).toEqual([{ text: 'some text', hit: false }]);
  });

  it('marks every occurrence, keeping the original case', () => {
    expect(highlightParts('Foo bar FOO', 'foo')).toEqual([
      { text: 'Foo', hit: true },
      { text: ' bar ', hit: false },
      { text: 'FOO', hit: true },
    ]);
    expect(highlightParts('нужна Проверка', ' ПРОВЕРКА ')).toEqual([
      { text: 'нужна ', hit: false },
      { text: 'Проверка', hit: true },
    ]);
  });

  it('takes regexp characters literally', () => {
    expect(highlightParts('a.b axb', 'a.b')).toEqual([
      { text: 'a.b', hit: true },
      { text: ' axb', hit: false },
    ]);
  });

  it('does not highlight when lowercasing changes the length of the text', () => {
    // 'İ'.toLowerCase() is two code units: offsets would no longer line up.
    expect(highlightParts('İstanbul foo', 'foo')).toEqual([{ text: 'İstanbul foo', hit: false }]);
  });
});

describe('excerpt', () => {
  const long = 'x'.repeat(200) + ' needle tail';

  it('leaves the text alone without a query, without a match or with an early match', () => {
    expect(excerpt(long, '')).toBe(long);
    expect(excerpt(long, 'zzz')).toBe(long);
    expect(excerpt('short needle', 'needle')).toBe('short needle');
  });

  it('starts shortly before a match that is far from the start', () => {
    const out = excerpt(long, 'NEEDLE');
    expect(out).toBe('…needle tail');
    expect(excerpt('x'.repeat(200) + 'needle tail', 'needle')).toBe('…' + 'x'.repeat(40) + 'needle tail');
  });

  it('cuts at a word boundary when there is one nearby', () => {
    const text = 'слово '.repeat(30) + 'иголка';
    expect(excerpt(text, 'иголка')).toMatch(/^…слово (слово )*иголка$/);
  });
});
