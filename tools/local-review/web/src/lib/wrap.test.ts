import { describe, expect, it } from 'vitest';
import { parseWrap } from './wrap';

describe('parseWrap', () => {
  it('is off only for the stored "0"', () => {
    expect(parseWrap('0')).toBe(false);
  });

  it.each([null, '', '1', 'false', 'no'])('is on for %j', (raw) => {
    expect(parseWrap(raw)).toBe(true);
  });
});
