import { describe, expect, it } from 'vitest';
import { currentIndexAt, isCollapsed, placeholderHeight } from './feedMath';

describe('currentIndexAt', () => {
  const tops = [0, 300, 900, 950];

  it('has no current file in an empty feed', () => {
    expect(currentIndexAt([], 100)).toBe(-1);
  });

  it('is the first file above its own top', () => {
    expect(currentIndexAt(tops, -50)).toBe(0);
  });

  it.each([
    [0, 0],
    [299, 0],
    [300, 1],
    [899, 1],
    [900, 2],
    [949, 2],
    [950, 3],
    [5000, 3],
  ])('at y=%i it is file %i', (y, index) => {
    expect(currentIndexAt(tops, y)).toBe(index);
  });
});

describe('placeholderHeight', () => {
  it('grows with the changed lines', () => {
    expect(placeholderHeight(10, 4)).toBe(400);
  });

  it('never goes below the floor or above the cap', () => {
    expect(placeholderHeight(0, 0)).toBe(120);
    expect(placeholderHeight(0, 0)).toBeGreaterThanOrEqual(80);
    expect(placeholderHeight(5000, 5000)).toBe(1600);
  });

  it.each([
    [null, 3],
    [3, null],
    [undefined, undefined],
  ])('uses a fixed guess when a count is unknown (%j, %j)', (a, d) => {
    expect(placeholderHeight(a, d)).toBe(200);
  });
});

describe('isCollapsed', () => {
  it('follows the viewed mark when the reviewer did not toggle', () => {
    expect(isCollapsed(true, undefined)).toBe(true);
    expect(isCollapsed(false, undefined)).toBe(false);
  });

  it('keeps a manual toggle while the mark is unchanged', () => {
    expect(isCollapsed(true, { viewed: true, collapsed: false })).toBe(false);
    expect(isCollapsed(false, { viewed: false, collapsed: true })).toBe(true);
  });

  it('drops a manual toggle once the mark changes', () => {
    expect(isCollapsed(true, { viewed: false, collapsed: false })).toBe(true);
    expect(isCollapsed(false, { viewed: true, collapsed: true })).toBe(false);
  });
});
