import { describe, expect, it } from 'vitest';
import { parseRailOpen } from './railOpen';

describe('parseRailOpen', () => {
  it('is open only for the stored "1"', () => {
    expect(parseRailOpen('1')).toBe(true);
  });

  it.each([null, '', '0', 'true', ' 1 '])('is folded for %j', (raw) => {
    expect(parseRailOpen(raw)).toBe(false);
  });
});
