import { describe, expect, it } from 'vitest';
import {
  clampSidebarWidth,
  maxSidebarWidth,
  parseSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  sidebarWidthForKey,
} from './sidebarWidth';

describe('clampSidebarWidth', () => {
  it('keeps widths inside the range as they are', () => {
    expect(clampSidebarWidth(400, 1600)).toBe(400);
  });

  it('never goes below the minimum', () => {
    expect(clampSidebarWidth(10, 1600)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(-500, 1600)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it('leaves the diff part of the viewport', () => {
    expect(clampSidebarWidth(5000, 1000)).toBe(700);
  });

  it('prefers the minimum when the viewport is too narrow for both', () => {
    expect(maxSidebarWidth(200)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(400, 200)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it('rounds fractional pointer positions', () => {
    expect(clampSidebarWidth(300.6, 1600)).toBe(301);
  });

  it('falls back to the default for NaN and Infinity', () => {
    expect(clampSidebarWidth(Number.NaN, 1600)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY, 1600)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number.NaN, 300)).toBe(SIDEBAR_MIN_WIDTH);
  });
});

describe('parseSidebarWidth', () => {
  it('reads a stored integer', () => {
    expect(parseSidebarWidth('480')).toBe(480);
  });

  it.each([null, '', 'abc', '12px', '-300', '3.5', '100'])('falls back to the default for %j', (raw) => {
    expect(parseSidebarWidth(raw)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe('sidebarWidthForKey', () => {
  it('steps with the arrows, further with Shift', () => {
    expect(sidebarWidthForKey('ArrowRight', false, 320, 1600)).toBe(336);
    expect(sidebarWidthForKey('ArrowLeft', false, 320, 1600)).toBe(304);
    expect(sidebarWidthForKey('ArrowRight', true, 320, 1600)).toBe(384);
  });

  it('clamps arrow steps at both ends', () => {
    expect(sidebarWidthForKey('ArrowLeft', true, 230, 1600)).toBe(SIDEBAR_MIN_WIDTH);
    expect(sidebarWidthForKey('ArrowRight', true, 1100, 1600)).toBe(1120);
  });

  it('jumps to min, max and the default', () => {
    expect(sidebarWidthForKey('Home', false, 500, 1600)).toBe(SIDEBAR_MIN_WIDTH);
    expect(sidebarWidthForKey('End', false, 500, 1600)).toBe(1120);
    expect(sidebarWidthForKey('Enter', false, 500, 1600)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('ignores other keys', () => {
    expect(sidebarWidthForKey('a', false, 320, 1600)).toBeNull();
    expect(sidebarWidthForKey('ArrowUp', false, 320, 1600)).toBeNull();
  });
});
