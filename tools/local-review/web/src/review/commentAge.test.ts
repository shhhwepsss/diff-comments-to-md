import { describe, expect, it } from 'vitest';
import type { Comment, Commit, Descriptor } from '../api/types';
import { isStale, openTarget, ownCommit, ownCommitLabel, staleTarget, viewKindOf, type AgeContext } from './commentAge';

// Commit i is committed on 2024-01-(i+1) at 12:00 UTC.
function makeCommits(n = 5): Commit[] {
  return Array.from({ length: n }, (_, i) => ({
    sha: `sha${i}full`,
    short: `c${i}`,
    parents: i === 0 ? [] : [`sha${i - 1}full`],
    author: 'Alice',
    date: `2024-01-${String(i + 1).padStart(2, '0')}T12:00:00Z`,
    committedAt: `2024-01-${String(i + 1).padStart(2, '0')}T12:00:00Z`,
    subject: `Commit ${i}`,
    body: '',
    merge: false,
    root: i === 0,
  }));
}

function comment(createdAt: string, commit?: Comment['commit']): Comment {
  return { id: 'x', file: 'a.ts', startLine: 1, endLine: 1, text: 't', createdAt, updatedAt: createdAt, commit };
}

const history = makeCommits();
const ctx = (view: AgeContext['view'], sel: AgeContext['sel'] = null, truncated = false): AgeContext => ({
  view,
  history,
  truncated,
  sel,
});

describe('viewKindOf', () => {
  const local = (mode: 'working' | 'staged' | 'base' | 'commits'): Descriptor => ({ source: 'local', root: '/r', mode, base: '' });
  const pr = (range: boolean): Descriptor => ({
    source: 'pr',
    host: 'github.com',
    owner: 'o',
    repo: 'r',
    number: 1,
    ...(range ? { from: 'a', to: 'b' } : {}),
  });

  it('maps every mode to what it shows', () => {
    expect(viewKindOf(local('working'))).toBe('uncommitted');
    expect(viewKindOf(local('staged'))).toBe('uncommitted');
    expect(viewKindOf(local('base'))).toBe('branch');
    expect(viewKindOf(local('commits'))).toBe('range');
    expect(viewKindOf(pr(false))).toBe('branch');
    expect(viewKindOf(pr(true))).toBe('range');
  });
});

describe('ownCommit', () => {
  it('uses the recorded commit when there is one', () => {
    expect(ownCommit(comment('2030-01-01T00:00:00Z', { from: 'c1', to: 'c2', label: '' }), history)).toBe(2);
  });

  it('is -1 for a recorded commit the history no longer has', () => {
    expect(ownCommit(comment('2024-01-01T00:00:00Z', { from: 'gone', to: 'gone', label: '' }), history)).toBe(-1);
  });

  it('is the first commit made after the comment', () => {
    // Written on Jan 2 at 13:00, after c1 (12:00) — c2 took the changes.
    expect(ownCommit(comment('2024-01-02T13:00:00Z'), history)).toBe(2);
  });

  it('is uncommitted when nothing was committed after it', () => {
    expect(ownCommit(comment('2024-01-05T12:00:01Z'), history)).toBeNull();
  });

  it('a commit in the same second counts as after the comment (commit dates are whole seconds)', () => {
    // c4 really happened at 12:00:00.800, git stores 12:00:00.
    expect(ownCommit(comment('2024-01-05T12:00:00.500Z'), history)).toBe(4);
    expect(ownCommit(comment('2024-01-05T12:00:01.000Z'), history)).toBeNull();
  });

  it('compares instants, not strings, across time zones', () => {
    // +05:00 12:00 on Jan 3 is 07:00 UTC — before a comment at 10:00 UTC.
    const zoned = history.map((c, i) => (i === 2 ? { ...c, committedAt: '2024-01-03T12:00:00+05:00' } : c));
    expect(ownCommit(comment('2024-01-03T10:00:00Z'), zoned)).toBe(3);
  });

  it('staged, then committed: the comment belongs to that new commit', () => {
    const before = history.slice(0, 4);
    const c = comment('2024-01-04T18:00:00Z');
    expect(ownCommit(c, before)).toBeNull();
    expect(ownCommit(c, history)).toBe(4);
  });

  it('older than a truncated history: unknown', () => {
    expect(ownCommit(comment('2023-12-01T00:00:00Z'), history, true)).toBe(-1);
    expect(ownCommit(comment('2023-12-01T00:00:00Z'), history, false)).toBe(0);
  });

  it('an empty history leaves everything uncommitted', () => {
    expect(ownCommit(comment('2024-01-01T00:00:00Z'), [])).toBeNull();
  });
});

describe('isStale', () => {
  const fresh = comment('2024-01-06T00:00:00Z');
  const old = comment('2024-01-02T13:00:00Z'); // own commit c2

  it('working copy / staged: stale once a commit followed', () => {
    expect(isStale(fresh, ctx('uncommitted'))).toBe(false);
    expect(isStale(old, ctx('uncommitted'))).toBe(true);
  });

  it('working copy: a comment recorded on HEAD in commits mode is stale', () => {
    expect(isStale(comment('2030-01-01T00:00:00Z', { from: 'c4', to: 'c4', label: '' }), ctx('uncommitted'))).toBe(true);
  });

  it('branch: everything in the history or uncommitted is current', () => {
    expect(isStale(fresh, ctx('branch'))).toBe(false);
    expect(isStale(old, ctx('branch'))).toBe(false);
    expect(isStale(comment('2024-01-01T00:00:00Z', { from: 'gone', to: 'gone', label: '' }), ctx('branch'))).toBe(true);
  });

  it('range: current only inside the selection', () => {
    expect(isStale(old, ctx('range', { anchor: 2, head: 2 }))).toBe(false);
    expect(isStale(old, ctx('range', { anchor: 3, head: 4 }))).toBe(true);
    expect(isStale(old, ctx('range', { anchor: 4, head: 0 }))).toBe(false);
  });

  it('range: uncommitted comments are not in any commit', () => {
    expect(isStale(fresh, ctx('range', { anchor: 4, head: 4 }))).toBe(true);
  });

  it('staged, committed, viewed on HEAD in commits mode: current', () => {
    expect(isStale(comment('2024-01-04T18:00:00Z'), ctx('range', { anchor: 4, head: 4 }))).toBe(false);
  });

  it('range: a recorded range must fit the selection whole', () => {
    const ranged = comment('2030-01-01T00:00:00Z', { from: 'c1', to: 'c3', label: '' });
    expect(isStale(ranged, ctx('range', { anchor: 1, head: 3 }))).toBe(false);
    expect(isStale(ranged, ctx('range', { anchor: 2, head: 4 }))).toBe(true);
  });

  it('unknown commits are stale in every view', () => {
    const lost = comment('2024-01-01T00:00:00Z', { from: 'gone', to: 'gone', label: '' });
    for (const view of ['uncommitted', 'branch', 'range'] as const) {
      expect(isStale(lost, ctx(view, { anchor: 0, head: 4 }))).toBe(true);
    }
  });
});

describe('openTarget / ownCommitLabel', () => {
  it('opens the recorded range', () => {
    const c = comment('2030-01-01T00:00:00Z', { from: 'c1', to: 'c3', label: '' });
    expect(openTarget(c, history)).toEqual({ from: 1, to: 3 });
    expect(ownCommitLabel(c, history)).toBe('c1..c3');
  });

  it('opens the first commit after an unrecorded comment', () => {
    const c = comment('2024-01-02T13:00:00Z');
    expect(openTarget(c, history)).toEqual({ from: 2, to: 2 });
    expect(ownCommitLabel(c, history)).toBe('c2');
  });

  it('has nothing to open for uncommitted or lost comments', () => {
    expect(openTarget(comment('2030-01-01T00:00:00Z'), history)).toBeNull();
    expect(openTarget(comment('2024-01-01T00:00:00Z', { from: 'gone', to: 'gone', label: '' }), history)).toBeNull();
    expect(ownCommitLabel(comment('2030-01-01T00:00:00Z'), history)).toBeNull();
  });

  it('names what a stale comment was written against', () => {
    expect(staleTarget(comment('2024-01-02T13:00:00Z'), history)).toBe('к c2');
    expect(staleTarget(comment('2030-01-01T00:00:00Z'), history)).toBe('к незакоммиченным изменениям');
    // A recorded sha is still the best name, even once the history lost it.
    expect(staleTarget(comment('2024-01-01T00:00:00Z', { from: 'gone', to: 'gone', label: '' }), history)).toBe('к gone');
    expect(staleTarget(comment('2023-12-01T00:00:00Z'), history, true)).toBe('к коммиту вне истории');
  });
});
