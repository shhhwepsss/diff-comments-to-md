import { describe, expect, it } from 'vitest';
import { parseZen } from './zen';

describe('parseZen', () => {
  it('is on only for the stored "1"', () => {
    expect(parseZen('1')).toBe(true);
  });

  it.each([null, '', '0', 'true', 'yes', '11', ' 1 '])('is off for %j', (raw) => {
    expect(parseZen(raw)).toBe(false);
  });
});
