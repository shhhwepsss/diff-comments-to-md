import { describe, expect, it } from 'vitest';
import { parseViewMode, resolveViewMode, toggleViewMode } from './viewMode';

describe('parseViewMode', () => {
  it.each(['single', 'all'] as const)('reads the stored %j', (raw) => {
    expect(parseViewMode(raw)).toBe(raw);
  });

  it.each([null, undefined, '', 'All', 'feed', '1', 1, {}])('treats %j as not chosen', (raw) => {
    expect(parseViewMode(raw)).toBeNull();
  });
});

describe('resolveViewMode', () => {
  it("prefers the reviewer's own choice over the settings default", () => {
    expect(resolveViewMode('single', 'all')).toBe('single');
    expect(resolveViewMode('all', 'single')).toBe('all');
  });

  it('falls back to the settings default when nothing was chosen', () => {
    expect(resolveViewMode(null, 'single')).toBe('single');
  });

  it('is unknown while the settings are still loading and nothing was chosen', () => {
    expect(resolveViewMode(null, null)).toBeNull();
  });

  it('does not wait for the settings when there is a choice', () => {
    expect(resolveViewMode('all', null)).toBe('all');
  });
});

describe('toggleViewMode', () => {
  it('flips between the two modes', () => {
    expect(toggleViewMode('all')).toBe('single');
    expect(toggleViewMode('single')).toBe('all');
  });
});
