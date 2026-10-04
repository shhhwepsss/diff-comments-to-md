import { describe, expect, it } from 'vitest';
import { pinBox } from './blockPin';

describe('pinBox', () => {
  it('starts where the gutters end and fills the rest of the scroller', () => {
    expect(pinBox(1158, 88)).toEqual({ left: 88, width: 1070 });
  });

  it('does not depend on how far the code is scrolled or how wide it is', () => {
    // Only the visible width and the gutters matter — not scrollWidth.
    expect(pinBox(600, 88)).toEqual({ left: 88, width: 512 });
  });

  it('keeps fractional gutter widths', () => {
    expect(pinBox(1000, 88.5)).toEqual({ left: 88.5, width: 911.5 });
  });

  it('uses the whole scroller when there are no gutters yet', () => {
    expect(pinBox(800, 0)).toEqual({ left: 0, width: 800 });
  });

  it('never goes negative when the scroller is narrower than the gutters', () => {
    expect(pinBox(40, 88)).toEqual({ left: 88, width: 0 });
    expect(pinBox(0, 0)).toEqual({ left: 0, width: 0 });
  });
});
