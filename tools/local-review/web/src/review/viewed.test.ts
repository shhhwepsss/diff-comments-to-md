import { describe, expect, it } from 'vitest';
import { descriptorQuery } from '../api/client';
import { descriptorFromHash, viewHash } from '../lib/hash';
import type { Descriptor, FileEntry, StateResponse } from '../api/types';
import { viewedCount, withViewed } from './viewed';

function file(path: string, patch: Partial<FileEntry> = {}): FileEntry {
  return { path, status: 'M', kind: 'M', untracked: false, comments: 0, fingerprint: `fp:${path}`, viewed: false, ...patch };
}

function state(files: FileEntry[]): StateResponse {
  return { repoRoot: '/r', source: 'local', pr: null, rangeLabel: '', totalComments: 0, files, orphanFiles: [] };
}

describe('withViewed', () => {
  it('marks only the given file and leaves the input untouched', () => {
    const before = state([file('a'), file('b')]);
    const after = withViewed(before, 'b', true);
    expect(after.files.map((f) => f.viewed)).toEqual([false, true]);
    expect(before.files[1].viewed).toBe(false);
    expect(after.files[0]).toBe(before.files[0]);
  });

  it('unmarks a viewed file', () => {
    const after = withViewed(state([file('a', { viewed: true })]), 'a', false);
    expect(after.files[0].viewed).toBe(false);
  });

  it('keeps the fingerprint: the mark belongs to the diff that was on screen', () => {
    const after = withViewed(state([file('a')]), 'a', true);
    expect(after.files[0].fingerprint).toBe('fp:a');
  });

  it('returns the same state when nothing changes', () => {
    const s = state([file('a', { viewed: true })]);
    expect(withViewed(s, 'a', true)).toBe(s);
    expect(withViewed(s, 'missing', true)).toBe(s);
  });

  it('refuses to mark a file without a fingerprint', () => {
    const s = state([file('a', { fingerprint: null })]);
    expect(withViewed(s, 'a', true)).toBe(s);
  });
});

/**
 * Viewed marks are kept per view server-side, and the server reads the view
 * off the descriptor's query. A view opened straight from an address must
 * therefore ask about the same view the address names — otherwise a link
 * would show another view's marks.
 */
describe('a view opened from an address asks the server about that view', () => {
  const query = (hash: string) => new URLSearchParams(descriptorQuery(descriptorFromHash(hash) as Descriptor));

  it('carries the local mode and base the address names', () => {
    const q = query('#/local/%2Frepo?mode=base&base=origin%2Fproduction&file=a.txt');
    expect(q.get('mode')).toBe('base');
    expect(q.get('base')).toBe('origin/production');
  });

  it('carries a commit range, locally and in a PR', () => {
    const local = query('#/local/%2Frepo?mode=commits&from=a1&to=b2');
    expect([local.get('mode'), local.get('from'), local.get('to')]).toEqual(['commits', 'a1', 'b2']);
    const pr = query('#/pr/github.com/o/r/25?from=a1&to=b2');
    expect([pr.get('from'), pr.get('to')]).toEqual(['a1', 'b2']);
  });

  it('asks about the whole PR when the address names no range', () => {
    const q = query('#/pr/github.com/o/r/25?file=a.txt');
    expect(q.get('from')).toBeNull();
    expect(q.get('to')).toBeNull();
  });

  it('leaves an unnamed base for the server to resolve, as the UI does', () => {
    // Both spellings end up on the same view key server-side, which is why an
    // address with no base still finds a mark made with the base filled in.
    expect(query('#/local/%2Frepo?mode=base').get('base')).toBeNull();
  });

  it('asks about the same view the open one would, file aside', () => {
    const open: Descriptor = { source: 'local', root: '/repo', mode: 'base', base: 'main' };
    expect(query(viewHash(open, 'a.txt'))).toEqual(new URLSearchParams(descriptorQuery(open)));
  });
});

describe('viewedCount', () => {
  it('counts viewed files only', () => {
    expect(viewedCount([file('a', { viewed: true }), file('b'), file('c', { viewed: true })])).toBe(2);
    expect(viewedCount([])).toBe(0);
  });
});
