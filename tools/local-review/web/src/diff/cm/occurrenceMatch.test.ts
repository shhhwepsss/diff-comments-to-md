import { describe, expect, it } from 'vitest';
import {
  compareKeys,
  findWord,
  isSingleWord,
  isWordChar,
  lineColumn,
  lineStarts,
  rulerTop,
  stepIndex,
  thinMarks,
  wordAt,
  type OrderKey,
} from './occurrenceMatch';

describe('isWordChar / isSingleWord', () => {
  it('counts letters of any script, digits, _ and $', () => {
    for (const ch of ['a', 'Z', 'я', 'Ё', '7', '_', '$', 'ß']) expect(isWordChar(ch)).toBe(true);
    for (const ch of ['', ' ', '.', '-', '(', '"', '\n']) expect(isWordChar(ch)).toBe(false);
  });

  it('accepts one word and nothing else', () => {
    expect(isSingleWord('fetchFile')).toBe(true);
    expect(isSingleWord('$el_2')).toBe(true);
    expect(isSingleWord('')).toBe(false);
    expect(isSingleWord('a b')).toBe(false);
    expect(isSingleWord('foo.bar')).toBe(false);
    expect(isSingleWord(' foo')).toBe(false);
  });
});

describe('wordAt', () => {
  const line = '  const path = join(root, path2);';

  it('finds the word the caret is inside', () => {
    expect(wordAt(line, 10)).toEqual({ from: 8, to: 12 });
  });

  it('takes a caret at either edge of a word', () => {
    expect(wordAt(line, 8)).toEqual({ from: 8, to: 12 });
    expect(wordAt(line, 12)).toEqual({ from: 8, to: 12 });
  });

  it('is null between non-word characters', () => {
    expect(wordAt(line, 0)).toBeNull();
    expect(wordAt('a = b', 2)).toBeNull();
    expect(wordAt('', 0)).toBeNull();
  });

  it('is null outside the line', () => {
    expect(wordAt('abc', -1)).toBeNull();
    expect(wordAt('abc', 4)).toBeNull();
  });

  it('keeps surrogate pairs whole', () => {
    // 𝒳 is a letter outside the BMP: two UTF-16 units.
    expect(wordAt('a𝒳b c', 1)).toEqual({ from: 0, to: 4 });
  });
});

describe('findWord', () => {
  it('finds whole-word occurrences only', () => {
    const text = 'path pathname path2 _path path\n// path in a comment\n"path"';
    expect(findWord(text, 'path')).toEqual([0, 26, 34, 53]);
  });

  it('treats $ and _ as part of a word', () => {
    expect(findWord('$path path_ path', 'path')).toEqual([12]);
  });

  it('finds words at the very start and end', () => {
    expect(findWord('x', 'x')).toEqual([0]);
    expect(findWord('x+x', 'x')).toEqual([0, 2]);
  });

  it('finds nothing for an empty word or no match', () => {
    expect(findWord('anything', '')).toEqual([]);
    expect(findWord('anything', 'thing')).toEqual([]);
  });

  it('respects non-latin word boundaries', () => {
    expect(findWord('путь путьК путь', 'путь')).toEqual([0, 11]);
  });
});

describe('stepIndex', () => {
  it('steps forward and back, wrapping around', () => {
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(1, 3, -1)).toBe(0);
  });

  it('starts at an end when there is no current one', () => {
    expect(stepIndex(-1, 3, 1)).toBe(0);
    expect(stepIndex(-1, 3, -1)).toBe(2);
  });

  it('stays put with one, and is -1 with none', () => {
    expect(stepIndex(0, 1, 1)).toBe(0);
    expect(stepIndex(0, 0, 1)).toBe(-1);
  });
});

describe('compareKeys', () => {
  it('puts a deleted block before the line it is drawn above', () => {
    const keys: OrderKey[] = [
      { pos: 20, side: 1, offset: 25 },
      { pos: 20, side: 0, offset: 7 },
      { pos: 10, side: 1, offset: 12 },
      { pos: 20, side: 0, offset: 2 },
      { pos: 20, side: 1, offset: 20 },
    ];
    expect([...keys].sort(compareKeys)).toEqual([
      { pos: 10, side: 1, offset: 12 },
      { pos: 20, side: 0, offset: 2 },
      { pos: 20, side: 0, offset: 7 },
      { pos: 20, side: 1, offset: 20 },
      { pos: 20, side: 1, offset: 25 },
    ]);
  });
});

describe('lineStarts / lineColumn', () => {
  it('maps an offset to its line and column', () => {
    const text = 'ab\ncde\n\nf';
    const starts = lineStarts(text);
    expect(starts).toEqual([0, 3, 7, 8]);
    expect(lineColumn(starts, 0)).toEqual({ line: 0, col: 0 });
    expect(lineColumn(starts, 4)).toEqual({ line: 1, col: 1 });
    expect(lineColumn(starts, 7)).toEqual({ line: 2, col: 0 });
    expect(lineColumn(starts, 8)).toEqual({ line: 3, col: 0 });
  });

  it('has one line for text without newlines', () => {
    expect(lineColumn(lineStarts('abc'), 2)).toEqual({ line: 0, col: 2 });
  });
});

describe('rulerTop', () => {
  it('scales the content position to the ruler', () => {
    expect(rulerTop(500, 1000, 300)).toBe(150);
    expect(rulerTop(0, 1000, 300)).toBe(0);
  });

  it('keeps the mark inside the ruler', () => {
    expect(rulerTop(1000, 1000, 300)).toBe(297);
    expect(rulerTop(-5, 1000, 300)).toBe(0);
  });

  it('is 0 for an empty ruler or content', () => {
    expect(rulerTop(10, 0, 300)).toBe(0);
    expect(rulerTop(10, 1000, 0)).toBe(0);
  });
});

describe('thinMarks', () => {
  it('keeps the first mark of each pixel row', () => {
    expect(thinMarks([0, 0, 5, 5, 5, 9], -1)).toEqual([0, 2, 5]);
  });

  it('always keeps the current mark, and only it on its row', () => {
    expect(thinMarks([0, 0, 5, 5, 5, 9], 3)).toEqual([0, 3, 5]);
    expect(thinMarks([7, 7], 1)).toEqual([1]);
  });

  it('keeps every mark when none share a row', () => {
    expect(thinMarks([1, 2, 3], 0)).toEqual([0, 1, 2]);
    expect(thinMarks([], -1)).toEqual([]);
  });
});
