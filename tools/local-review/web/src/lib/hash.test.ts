import { describe, expect, it } from 'vitest';
import { DEFAULT_HASH, descriptorFromHash, hashFor, routeFromHash, settingsHash } from './hash';

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

  it('opens the settings page and remembers where to go back', () => {
    expect(routeFromHash('#/settings')).toEqual({ screen: 'settings', back: DEFAULT_HASH });

    const from = hashFor({ source: 'local', root: 'C:/Users/me/мой проект', mode: 'working', base: '' });
    const hash = settingsHash(from);
    // The whole point of putting it in the address: a reload of this very URL
    // still knows the screen to return to.
    expect(routeFromHash(hash)).toEqual({ screen: 'settings', back: from });
    expect(routeFromHash(settingsHash('#/pr/github.com/o/r/25'))).toEqual({
      screen: 'settings',
      back: '#/pr/github.com/o/r/25',
    });
  });

  it('never takes a back target that is not an in-app screen', () => {
    // An outside address, a loop back into settings and a half-typed escape
    // all degrade to the picker instead of navigating somewhere strange.
    expect(settingsHash('https://evil.example')).toBe('#/settings');
    expect(settingsHash('#/settings/%23%2Flocal')).toBe('#/settings');
    expect(settingsHash('')).toBe('#/settings');
    expect(routeFromHash('#/settings/https%3A%2F%2Fevil.example')).toEqual({ screen: 'settings', back: DEFAULT_HASH });
    expect(routeFromHash('#/settings/%E0%A4%A')).toEqual({ screen: 'settings', back: DEFAULT_HASH });
  });

  it('keeps `settings` from being read as a review descriptor', () => {
    expect(descriptorFromHash('#/settings')).toBeNull();
    expect(descriptorFromHash(settingsHash('#/local/C%3A%2Frepo'))).toBeNull();
  });
});
