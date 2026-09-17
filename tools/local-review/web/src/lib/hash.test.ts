import { describe, expect, it } from 'vitest';
import { descriptorFromHash, fileFromHash, fileHashFor, hashFor, routeFromHash, wantsNativeLink } from './hash';

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

describe('file in the hash', () => {
  const local = { source: 'local' as const, root: 'C:/Users/me/мой проект', mode: 'working' as const, base: '' };
  const pr = { source: 'pr' as const, host: 'github.com', owner: 'o', repo: 'r', number: 25 };

  it('round-trips awkward paths through a local and a PR route', () => {
    const paths = ['src/a b/файл.ts', 'x/a+b&c=d?e#f%20.md', 'dir/100%.txt', 'README.md'];
    for (const file of paths) {
      for (const d of [local, pr]) {
        const hash = fileHashFor(d, file);
        expect(routeFromHash(hash)).toEqual({ screen: 'diff', descriptor: descriptorFromHash(hashFor(d)), file });
      }
    }
  });

  it('keeps the descriptor (and so the review key) independent of the file', () => {
    expect(hashFor(descriptorFromHash(fileHashFor(pr, 'a.ts')))).toBe(hashFor(pr));
    expect(hashFor(descriptorFromHash(fileHashFor(local, 'a.ts')))).toBe(hashFor(local));
    expect(fileHashFor(pr, 'a/b.ts')).toBe('#/pr/github.com/o/r/25?file=a%2Fb.ts');
  });

  it('has no file when the query is absent, empty or unrelated', () => {
    expect(fileHashFor(pr, null)).toBe(hashFor(pr));
    expect(routeFromHash(hashFor(pr))).toEqual({ screen: 'diff', descriptor: pr, file: null });
    expect(fileFromHash('#/pr/github.com/o/r/25?file=')).toBeNull();
    expect(fileFromHash('#/pr/github.com/o/r/25?other=1')).toBeNull();
    expect(fileFromHash('')).toBeNull();
  });

  it('does not let a query turn a picker into a diff or break a PR number', () => {
    expect(routeFromHash('#/local?file=a.ts')).toEqual({ screen: 'local' });
    expect(routeFromHash('#/pr?file=a.ts')).toEqual({ screen: 'pr' });
    expect(routeFromHash('#/pr/github.com/o/r/abc?file=a.ts')).toEqual({ screen: 'pr' });
  });
});

describe('wantsNativeLink', () => {
  const plain = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };

  it('leaves a plain left click and a plain key press to the app', () => {
    expect(wantsNativeLink({ ...plain, button: 0 })).toBe(false);
    expect(wantsNativeLink(plain)).toBe(false);
  });

  it('hands middle/right clicks and modified clicks or keys to the browser', () => {
    expect(wantsNativeLink({ ...plain, button: 1 })).toBe(true);
    expect(wantsNativeLink({ ...plain, button: 2 })).toBe(true);
    for (const key of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey'] as const) {
      expect(wantsNativeLink({ ...plain, button: 0, [key]: true })).toBe(true);
      expect(wantsNativeLink({ ...plain, [key]: true })).toBe(true);
    }
  });
});
