import { describe, expect, it } from 'vitest';
import { descriptorFromHash, hashFor, routeFromHash } from './hash';

describe('hash routing', () => {
  it('round-trips a local root with spaces and Cyrillic', () => {
    const root = 'C:/Users/me/мой проект';
    const d = { source: 'local' as const, root, mode: 'working' as const, base: 'origin/production' };
    // The hash carries the root and nothing else: mode resets to working and
    // base comes back empty, meaning "ask the repository for its default".
    expect(descriptorFromHash(hashFor(d))).toEqual({
      source: 'local',
      root,
      mode: 'working',
      base: '',
    });
  });

  it('round-trips a PR', () => {
    const d = { source: 'pr' as const, host: 'github.com', owner: 'o', repo: 'r', number: 25 };
    expect(hashFor(d)).toBe('#/pr/github.com/o/r/25');
    expect(descriptorFromHash(hashFor(d))).toEqual(d);
  });

  it('routes picker screens and rejects bad PR numbers', () => {
    expect(routeFromHash('#/local')).toEqual({ screen: 'local' });
    expect(routeFromHash('#/pr')).toEqual({ screen: 'pr' });
    expect(routeFromHash('')).toEqual({ screen: 'local' });
    expect(routeFromHash('#/pr/github.com/o/r/abc')).toEqual({ screen: 'pr' });
  });
});
