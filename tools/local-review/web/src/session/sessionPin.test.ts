import { describe, expect, it } from 'vitest';
import { parseSessionPin } from './sessionPin';

describe('parseSessionPin', () => {
  it('is pinned only for the stored "1"', () => {
    expect(parseSessionPin('1')).toBe(true);
  });

  it.each([null, '', '0', 'true', 'yes', '11', ' 1 '])('is unpinned for %j', (raw) => {
    expect(parseSessionPin(raw)).toBe(false);
  });
});
