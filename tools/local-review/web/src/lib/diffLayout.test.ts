import { describe, expect, it } from 'vitest';
import {
  effectiveDiffLayout,
  parseDiffLayout,
  resolveDiffLayout,
  splitFits,
  SPLIT_HYSTERESIS,
  SPLIT_MIN_WIDTH,
  toggleDiffLayout,
} from './diffLayout';

describe('parseDiffLayout', () => {
  it.each(['unified', 'split'] as const)('reads the stored %j', (raw) => {
    expect(parseDiffLayout(raw)).toBe(raw);
  });

  it.each([null, undefined, '', 'Split', 'columns', 1, {}])('treats %j as not chosen', (raw) => {
    expect(parseDiffLayout(raw)).toBeNull();
  });
});

describe('resolveDiffLayout', () => {
  it("prefers the reviewer's own choice over the settings default", () => {
    expect(resolveDiffLayout('split', 'unified')).toBe('split');
    expect(resolveDiffLayout('unified', 'split')).toBe('unified');
  });

  it('falls back to the settings default, and is unknown while neither is known', () => {
    expect(resolveDiffLayout(null, 'split')).toBe('split');
    expect(resolveDiffLayout(null, null)).toBeNull();
  });
});

describe('toggleDiffLayout', () => {
  it('flips between the two layouts', () => {
    expect(toggleDiffLayout('unified')).toBe('split');
    expect(toggleDiffLayout('split')).toBe('unified');
  });
});

describe('splitFits', () => {
  it('keeps fitting down to the limit, and stops below it', () => {
    expect(splitFits(SPLIT_MIN_WIDTH, true)).toBe(true);
    expect(splitFits(SPLIT_MIN_WIDTH - 1, true)).toBe(false);
  });

  it('comes back only past the limit plus the margin', () => {
    expect(splitFits(SPLIT_MIN_WIDTH, false)).toBe(false);
    expect(splitFits(SPLIT_MIN_WIDTH + SPLIT_HYSTERESIS - 1, false)).toBe(false);
    expect(splitFits(SPLIT_MIN_WIDTH + SPLIT_HYSTERESIS, false)).toBe(true);
  });

  it('does not flip when a scrollbar takes part of the width back', () => {
    // Fits at 905; two columns add a 17px scrollbar -> 888, back to one column;
    // the scrollbar goes away -> 905 again, which must not bring two columns back.
    expect(splitFits(888, true)).toBe(false);
    expect(splitFits(905, false)).toBe(false);
  });
});

describe('effectiveDiffLayout', () => {
  it('shows two columns only when they fit', () => {
    expect(effectiveDiffLayout('split', true)).toBe('split');
    expect(effectiveDiffLayout('split', false)).toBe('unified');
  });

  it('never turns one column into two', () => {
    expect(effectiveDiffLayout('unified', true)).toBe('unified');
  });
});
