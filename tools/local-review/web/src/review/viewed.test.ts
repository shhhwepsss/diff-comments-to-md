import { describe, expect, it } from 'vitest';
import type { FileEntry, StateResponse } from '../api/types';
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

describe('viewedCount', () => {
  it('counts viewed files only', () => {
    expect(viewedCount([file('a', { viewed: true }), file('b'), file('c', { viewed: true })])).toBe(2);
    expect(viewedCount([])).toBe(0);
  });
});
