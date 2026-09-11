import { describe, expect, it } from 'vitest';
import { descriptorFromHash, hashFor, routeFromHash } from './hash';

describe('hash routing', () => {
  it('round-trips a local root with spaces and Cyrillic', () => {
    const d = { source: 'local' as const, root: 'C:/Users/me/мой проект', mode: 'working' as const, base: 'origin/main' };
    expect(descriptorFromHash(hashFor(d))).toEqual(d);
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
