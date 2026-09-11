import { describe, expect, it } from 'vitest';
import { collapsedRanges, oldLineNumbers, orderedRange, stripFinalNewline, type LineChunk } from './lineMap';

describe('oldLineNumbers', () => {
  it('is identity without changes', () => {
    expect(Array.from(oldLineNumbers(3, []))).toEqual([0, 1, 2, 3]);
  });

  it('blanks inserted lines and shifts the rest down', () => {
    // old: a b c   new: a X Y b c
    const chunks: LineChunk[] = [{ oldFrom: 2, oldCount: 0, newFrom: 2, newCount: 2 }];
    expect(Array.from(oldLineNumbers(5, chunks))).toEqual([0, 1, 0, 0, 2, 3]);
  });

  it('shifts lines after a pure deletion up', () => {
    // old: a b c d   new: a d   (b, c deleted before new line 2)
    const chunks: LineChunk[] = [{ oldFrom: 2, oldCount: 2, newFrom: 2, newCount: 0 }];
    expect(Array.from(oldLineNumbers(2, chunks))).toEqual([0, 1, 4]);
  });

  it('handles a modification followed by an insertion', () => {
    // old: a b c d e   new: a B c d X e
    const chunks: LineChunk[] = [
      { oldFrom: 2, oldCount: 1, newFrom: 2, newCount: 1 },
      { oldFrom: 5, oldCount: 0, newFrom: 5, newCount: 1 },
    ];
    expect(Array.from(oldLineNumbers(6, chunks))).toEqual([0, 1, 0, 3, 4, 0, 5]);
  });

  it('does not depend on chunk order', () => {
    const chunks: LineChunk[] = [
      { oldFrom: 5, oldCount: 0, newFrom: 5, newCount: 1 },
      { oldFrom: 2, oldCount: 1, newFrom: 2, newCount: 1 },
    ];
    expect(Array.from(oldLineNumbers(6, chunks))).toEqual([0, 1, 0, 3, 4, 0, 5]);
  });
});

describe('collapsedRanges', () => {
  const change: LineChunk = { oldFrom: 50, oldCount: 1, newFrom: 50, newCount: 1 };

  it('folds everything far from a change', () => {
    expect(collapsedRanges(100, [change], [], 3, 4)).toEqual([
      { from: 1, to: 46 },
      { from: 54, to: 100 },
    ]);
  });

  it('keeps commented lines visible and splits the fold around them', () => {
    expect(collapsedRanges(100, [change], [20], 3, 4)).toEqual([
      { from: 1, to: 19 },
      { from: 21, to: 46 },
      { from: 54, to: 100 },
    ]);
  });

  it('does not fold runs shorter than minSize', () => {
    // lines 1..3 hidden (3 < 4) stay visible
    const c: LineChunk = { oldFrom: 7, oldCount: 1, newFrom: 7, newCount: 1 };
    expect(collapsedRanges(10, [c], [], 3, 4)).toEqual([]);
  });

  it('keeps context after a pure deletion', () => {
    const del: LineChunk = { oldFrom: 50, oldCount: 5, newFrom: 50, newCount: 0 };
    // visible: 47..52 (3 before, 3 after the deletion point)
    expect(collapsedRanges(100, [del], [], 3, 4)).toEqual([
      { from: 1, to: 46 },
      { from: 53, to: 100 },
    ]);
  });

  it('skips expanded ranges', () => {
    expect(collapsedRanges(100, [change], [], 3, 4, new Set(['1-46']))).toEqual([{ from: 54, to: 100 }]);
  });

  it('folds the whole file when there is no change and nothing to keep', () => {
    expect(collapsedRanges(10, [], [], 3, 4)).toEqual([{ from: 1, to: 10 }]);
  });
});

describe('helpers', () => {
  it('orders a drag in either direction', () => {
    expect(orderedRange(9, 3)).toEqual({ from: 3, to: 9 });
    expect(orderedRange(3, 3)).toEqual({ from: 3, to: 3 });
  });

  it('strips exactly one final line terminator', () => {
    expect(stripFinalNewline('a\nb\n')).toBe('a\nb');
    expect(stripFinalNewline('a\r\n')).toBe('a');
    expect(stripFinalNewline('a\n\n')).toBe('a\n');
    expect(stripFinalNewline('a')).toBe('a');
  });
});
