import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HASH,
  descriptorFromHash,
  fileFromHash,
  hashFor,
  navigationFor,
  routeFromHash,
  sameView,
  settingsHash,
  viewHash,
  wantsNativeLink,
} from './hash';

describe('hash routing', () => {
  it('round-trips a local root with spaces and Cyrillic', () => {
    const root = 'C:/Users/me/мой проект';
    const d = { source: 'local' as const, root, mode: 'working' as const, base: 'origin/production' };
    // The route carries the root and nothing else: mode resets to working and
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

  it('falls back to the picker on a root that cannot be decoded', () => {
    expect(descriptorFromHash('#/local/%E0%A4%A')).toBeNull();
    expect(routeFromHash('#/local/%E0%A4%A')).toEqual({ screen: 'local' });
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

  it('carries a whole view as the settings return address, query and all', () => {
    // Settings is recognised from the route part, so a return address with a
    // `?mode=…&file=…` query survives the round trip instead of being cut off.
    const view = viewHash(
      { source: 'local', root: 'C:/repo', mode: 'commits', base: 'origin/main', from: 'aaa111', to: 'bbb222' },
      'src/a b.ts',
    );
    const route = routeFromHash(settingsHash(view));
    expect(route).toEqual({ screen: 'settings', back: view });
    expect(routeFromHash(route.screen === 'settings' ? route.back : '')).toEqual({
      screen: 'diff',
      descriptor: { source: 'local', root: 'C:/repo', mode: 'commits', base: 'origin/main', from: 'aaa111', to: 'bbb222' },
      file: 'src/a b.ts',
    });
  });
});

describe('the view in the hash', () => {
  const local = { source: 'local' as const, root: 'C:/Users/me/мой проект', mode: 'working' as const, base: '' };
  const pr = { source: 'pr' as const, host: 'github.com', owner: 'o', repo: 'r', number: 25 };

  it('round-trips awkward paths through a local and a PR route', () => {
    const paths = ['src/a b/файл.ts', 'x/a+b&c=d?e#f%20.md', 'dir/100%.txt', 'README.md'];
    for (const file of paths) {
      for (const d of [local, pr]) {
        expect(routeFromHash(viewHash(d, file))).toEqual({ screen: 'diff', descriptor: d, file });
      }
    }
  });

  it('round-trips every local mode, a base ref and a commit range', () => {
    const views = [
      { ...local, mode: 'staged' as const },
      { ...local, mode: 'base' as const, base: 'origin/production' },
      { ...local, mode: 'base' as const, base: 'feature/a b+c' },
      { ...local, mode: 'commits' as const, from: 'aaa111', to: 'bbb222' },
      { ...local, mode: 'commits' as const, base: 'origin/main', from: 'aaa111', to: 'bbb222' },
      { ...pr, from: 'aaa111', to: 'bbb222' },
    ];
    for (const d of views) {
      expect(descriptorFromHash(viewHash(d, 'src/a.ts'))).toEqual(d);
      expect(fileFromHash(viewHash(d, 'src/a.ts'))).toBe('src/a.ts');
    }
    expect(viewHash({ ...local, mode: 'commits', from: 'aaa111', to: 'bbb222' }, 'a.ts')).toBe(
      `${hashFor(local)}?mode=commits&from=aaa111&to=bbb222&file=a.ts`,
    );
    expect(viewHash({ ...pr, from: 'aaa111', to: 'bbb222' }, 'a/b.ts')).toBe(
      '#/pr/github.com/o/r/25?from=aaa111&to=bbb222&file=a%2Fb.ts',
    );
  });

  it('keeps the review key (the route) independent of the view and the file', () => {
    const staged = { ...local, mode: 'staged' as const, base: 'origin/main' };
    expect(hashFor(descriptorFromHash(viewHash(staged, 'a.ts')))).toBe(hashFor(local));
    expect(hashFor(descriptorFromHash(viewHash({ ...pr, from: 'a', to: 'b' }, 'a.ts')))).toBe(hashFor(pr));
  });

  it('drops what the view cannot use: half a range, a local range outside commits mode', () => {
    expect(descriptorFromHash(`${hashFor(local)}?mode=commits&from=aaa111`)).toEqual({ ...local, mode: 'commits' });
    expect(descriptorFromHash(`${hashFor(pr)}?to=bbb222`)).toEqual(pr);
    // A range left over from commits mode must not leak into a working diff —
    // `descriptorQuery` would not send it, and the address must not carry it.
    expect(descriptorFromHash(`${hashFor(local)}?mode=staged&from=aaa111&to=bbb222`)).toEqual({ ...local, mode: 'staged' });
    expect(viewHash({ ...local, mode: 'working', from: 'aaa111', to: 'bbb222' }, null)).toBe(hashFor(local));
  });

  it('degrades an unknown or empty mode to working instead of breaking the screen', () => {
    for (const q of ['mode=nonsense', 'mode=', 'mode=WORKING', 'mode[]=commits']) {
      expect(descriptorFromHash(`${hashFor(local)}?${q}`)).toEqual(local);
      expect(routeFromHash(`${hashFor(local)}?${q}`)).toEqual({ screen: 'diff', descriptor: local, file: null });
    }
  });

  it('has no file when the query is absent, empty or unrelated', () => {
    expect(viewHash(local, null)).toBe(hashFor(local));
    expect(viewHash(null, 'a.ts')).toBe('');
    expect(routeFromHash(hashFor(pr))).toEqual({ screen: 'diff', descriptor: pr, file: null });
    expect(fileFromHash('#/pr/github.com/o/r/25?file=')).toBeNull();
    expect(fileFromHash('#/pr/github.com/o/r/25?other=1')).toBeNull();
    expect(fileFromHash('')).toBeNull();
  });

  it('does not let a query turn a picker into a diff or break a PR number', () => {
    expect(routeFromHash('#/local?file=a.ts&mode=commits')).toEqual({ screen: 'local' });
    expect(routeFromHash('#/pr?file=a.ts')).toEqual({ screen: 'pr' });
    expect(routeFromHash('#/pr/github.com/o/r/abc?file=a.ts')).toEqual({ screen: 'pr' });
  });
});

describe('sameView', () => {
  const local = { source: 'local' as const, root: '/repo', mode: 'working' as const, base: '' };
  const pr = { source: 'pr' as const, host: 'github.com', owner: 'o', repo: 'r', number: 25 };

  it('ignores the file but not the mode, the base or the range', () => {
    expect(sameView(descriptorFromHash(viewHash(local, 'a.ts')), descriptorFromHash(viewHash(local, 'b.ts')))).toBe(true);
    expect(sameView(local, { ...local, mode: 'staged' })).toBe(false);
    expect(sameView(local, { ...local, base: 'origin/main' })).toBe(false);
    expect(sameView({ ...pr, from: 'a', to: 'b' }, { ...pr, from: 'a', to: 'c' })).toBe(false);
    expect(sameView({ ...pr, from: 'a', to: 'b' }, { ...pr, from: 'a', to: 'b' })).toBe(true);
    expect(sameView(pr, { ...pr, number: 26 })).toBe(false);
    expect(sameView(null, local)).toBe(false);
  });
});

describe('navigationFor (Back/Forward)', () => {
  const local = { source: 'local' as const, root: '/repo', mode: 'working' as const, base: '' };
  const commits = { ...local, mode: 'commits' as const, from: 'aaa111', to: 'bbb222' };
  const pr = { source: 'pr' as const, host: 'github.com', owner: 'o', repo: 'r', number: 25 };

  it('steps between files of the same view', () => {
    expect(navigationFor(viewHash(local, 'a.ts'), local, 'b.ts')).toEqual({ kind: 'file', file: 'a.ts' });
    // Already there, or the entry names no file: nothing to do.
    expect(navigationFor(viewHash(local, 'a.ts'), local, 'a.ts')).toEqual({ kind: 'ignore' });
    expect(navigationFor(viewHash(local, null), local, 'a.ts')).toEqual({ kind: 'ignore' });
  });

  it('reloads the diff when the entry names another mode, base or range', () => {
    expect(navigationFor(viewHash({ ...local, mode: 'staged' }, 'a.ts'), local, 'a.ts')).toEqual({
      kind: 'view',
      descriptor: { ...local, mode: 'staged' },
      file: 'a.ts',
    });
    expect(navigationFor(viewHash(local, 'a.ts'), commits, 'a.ts')).toEqual({ kind: 'view', descriptor: local, file: 'a.ts' });
    expect(navigationFor(viewHash(commits, null), local, 'a.ts')).toEqual({ kind: 'view', descriptor: commits, file: null });
    expect(navigationFor(viewHash({ ...pr, from: 'a', to: 'b' }, 'a.ts'), pr, null)).toEqual({
      kind: 'view',
      descriptor: { ...pr, from: 'a', to: 'b' },
      file: 'a.ts',
    });
  });

  it('leaves another review (or a broken address) to the app', () => {
    expect(navigationFor(viewHash({ ...local, root: '/other' }, 'a.ts'), local, 'a.ts')).toEqual({ kind: 'ignore' });
    expect(navigationFor(viewHash({ ...pr, number: 26 }, 'a.ts'), pr, null)).toEqual({ kind: 'ignore' });
    expect(navigationFor('#/local', local, 'a.ts')).toEqual({ kind: 'ignore' });
    expect(navigationFor('', local, 'a.ts')).toEqual({ kind: 'ignore' });
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
