import { describe, expect, it } from 'vitest';
import type { Comment, Commit } from '../api/types';
import {
  clampIndex,
  clickSelect,
  commitContextFor,
  commitRangeCommand,
  defaultSelection,
  dragSelect,
  expandToComments,
  indexOfSha,
  insideSelection,
  keySelect,
  outsideComments,
  selHi,
  selLo,
  type CommitSelection,
} from './commitSelection';

// 10 commits, oldest (0) to newest (9), matching the rail's index order.
function makeCommits(n = 10): Commit[] {
  return Array.from({ length: n }, (_, i) => ({
    sha: `sha${i}full`,
    short: `c${i}`,
    parents: i === 0 ? [] : [`sha${i - 1}full`],
    author: 'Alice',
    date: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
    subject: `Commit ${i}`,
    body: '',
    merge: false,
    root: i === 0,
  }));
}

describe('defaultSelection', () => {
  it('selects the latest commit by default', () => {
    const commits = makeCommits();
    expect(defaultSelection(commits.length)).toEqual({ anchor: 9, head: 9 });
  });

  it('never breaks on an empty history', () => {
    expect(defaultSelection(0)).toEqual({ anchor: 0, head: 0 });
  });
});

describe('clickSelect', () => {
  const commits = makeCommits();

  it('trims a range from the lower bound: 1-9 + click 4 -> 1-4', () => {
    const sel: CommitSelection = { anchor: 0, head: 8 }; // commits 1..9 (0-indexed 0..8)
    const next = clickSelect(sel, commits.length, 3); // click on commit "4" (index 3)
    expect(next).toEqual({ anchor: 0, head: 3 });
  });

  it('clicking the lower bound of a range leaves only that commit', () => {
    const sel: CommitSelection = { anchor: 0, head: 8 };
    expect(clickSelect(sel, commits.length, 0)).toEqual({ anchor: 0, head: 0 });
  });

  it('clicking the upper bound of a range leaves only that commit', () => {
    const sel: CommitSelection = { anchor: 0, head: 8 };
    expect(clickSelect(sel, commits.length, 8)).toEqual({ anchor: 8, head: 8 });
  });

  it('clicking outside the range resets the selection to that commit', () => {
    const sel: CommitSelection = { anchor: 2, head: 5 };
    expect(clickSelect(sel, commits.length, 8)).toEqual({ anchor: 8, head: 8 });
  });

  it('clicking the single selected (non-latest) commit returns to the latest', () => {
    const sel: CommitSelection = { anchor: 3, head: 3 };
    expect(clickSelect(sel, commits.length, 3)).toEqual({ anchor: 9, head: 9 });
  });

  it('clicking the single selected commit when it is already the latest is a no-op', () => {
    const sel: CommitSelection = { anchor: 9, head: 9 };
    const next = clickSelect(sel, commits.length, 9);
    expect(next).toBe(sel); // same reference: callers use this to skip reloading
  });

  it('never produces an empty selection', () => {
    const sel: CommitSelection = { anchor: 0, head: 0 };
    const next = clickSelect(sel, commits.length, 5);
    expect(selLo(next)).toBeLessThanOrEqual(selHi(next));
  });
});

describe('dragSelect', () => {
  const commits = makeCommits();

  it('gives the same range regardless of drag direction', () => {
    const forward = dragSelect(commits.length, 2, 6);
    const backward = dragSelect(commits.length, 6, 2);
    expect(selLo(forward)).toBe(selLo(backward));
    expect(selHi(forward)).toBe(selHi(backward));
  });

  it('keeps the drag start as the anchor (for later Shift+extend)', () => {
    expect(dragSelect(commits.length, 6, 2)).toEqual({ anchor: 6, head: 2 });
  });

  it('clamps out-of-range indexes', () => {
    expect(dragSelect(commits.length, -3, 99)).toEqual({ anchor: 0, head: 9 });
  });
});

describe('keySelect', () => {
  const commits = makeCommits();

  it('Left/Right move a single-commit selection', () => {
    const sel: CommitSelection = { anchor: 4, head: 4 };
    expect(keySelect(sel, commits.length, 1, false)).toEqual({ anchor: 5, head: 5 });
    expect(keySelect(sel, commits.length, -1, false)).toEqual({ anchor: 3, head: 3 });
  });

  it('Shift+Left/Right extend the range from the anchor', () => {
    const sel: CommitSelection = { anchor: 4, head: 4 };
    const extended = keySelect(sel, commits.length, 1, true);
    expect(extended).toEqual({ anchor: 4, head: 5 });
    const extendedMore = keySelect(extended, commits.length, 1, true);
    expect(extendedMore).toEqual({ anchor: 4, head: 6 });
  });

  it('Shift+extend can cross back over the anchor', () => {
    let sel: CommitSelection = { anchor: 5, head: 7 };
    sel = keySelect(sel, commits.length, -1, true); // 5..6
    sel = keySelect(sel, commits.length, -1, true); // 5..5
    sel = keySelect(sel, commits.length, -1, true); // 4..5 (crossed)
    expect(sel).toEqual({ anchor: 5, head: 4 });
    expect(selLo(sel)).toBe(4);
    expect(selHi(sel)).toBe(5);
  });

  it('clamps at the ends of the history', () => {
    const atStart: CommitSelection = { anchor: 0, head: 0 };
    expect(keySelect(atStart, commits.length, -1, false)).toEqual({ anchor: 0, head: 0 });
    const atEnd: CommitSelection = { anchor: 9, head: 9 };
    expect(keySelect(atEnd, commits.length, 1, false)).toEqual({ anchor: 9, head: 9 });
  });
});

describe('indexOfSha', () => {
  const commits = makeCommits();

  it('matches by full sha, short sha, or prefix', () => {
    expect(indexOfSha(commits, 'sha3full')).toBe(3);
    expect(indexOfSha(commits, 'c3')).toBe(3);
    expect(indexOfSha(commits, 'sha3f')).toBe(3);
  });

  it('returns -1 for no match or empty input', () => {
    expect(indexOfSha(commits, 'nope')).toBe(-1);
    expect(indexOfSha(commits, null)).toBe(-1);
    expect(indexOfSha(commits, undefined)).toBe(-1);
    expect(indexOfSha(commits, '')).toBe(-1);
  });
});

describe('insideSelection / outsideComments', () => {
  const commits = makeCommits();
  const sel: CommitSelection = { anchor: 3, head: 6 }; // commits 4..7 (indices 3..6)

  const comment = (c: Comment['commit']): Comment => ({
    id: 'x',
    file: 'a.ts',
    startLine: 1,
    endLine: 1,
    text: 't',
    createdAt: '',
    updatedAt: '',
    commit: c,
  });

  it('a comment with no commit context is always visible', () => {
    expect(insideSelection(commits, sel, undefined)).toBe(true);
  });

  it('a comment fully inside the selected range is visible', () => {
    expect(insideSelection(commits, sel, { from: 'c3', to: 'c6', label: 'x' })).toBe(true);
    expect(insideSelection(commits, sel, { from: 'c4', to: 'c5', label: 'x' })).toBe(true);
  });

  it('a comment partially or fully outside the range is hidden', () => {
    expect(insideSelection(commits, sel, { from: 'c2', to: 'c5', label: 'x' })).toBe(false);
    expect(insideSelection(commits, sel, { from: 'c7', to: 'c8', label: 'x' })).toBe(false);
  });

  it('a comment on a commit no longer in the history is shown, not hidden', () => {
    expect(insideSelection(commits, sel, { from: 'gone', to: 'alsoGone', label: 'x' })).toBe(true);
  });

  it('outsideComments filters exactly the ones outside the range', () => {
    const comments = [
      comment(undefined),
      comment({ from: 'c3', to: 'c6', label: 'in' }),
      comment({ from: 'c7', to: 'c8', label: 'out' }),
    ];
    const outside = outsideComments(commits, sel, comments);
    expect(outside).toHaveLength(1);
    expect(outside[0].commit?.label).toBe('out');
  });
});

describe('expandToComments', () => {
  const commits = makeCommits();

  it('grows the selection to cover every outside comment', () => {
    const sel: CommitSelection = { anchor: 4, head: 4 };
    const comments: Comment[] = [
      { id: '1', file: 'a', startLine: 1, endLine: 1, text: '', createdAt: '', updatedAt: '', commit: { from: 'c1', to: 'c2', label: 'x' } },
      { id: '2', file: 'a', startLine: 1, endLine: 1, text: '', createdAt: '', updatedAt: '', commit: { from: 'c7', to: 'c7', label: 'y' } },
    ];
    const next = expandToComments(commits, commits.length, sel, comments);
    expect(selLo(next)).toBe(1);
    expect(selHi(next)).toBe(7);
  });

  it('is a no-op when there is nothing outside', () => {
    const sel: CommitSelection = { anchor: 4, head: 4 };
    expect(expandToComments(commits, commits.length, sel, [])).toEqual(sel);
  });
});

describe('commitContextFor', () => {
  const commits = makeCommits();

  it('omits context for the latest-commit-only selection', () => {
    expect(commitContextFor(commits, { anchor: 9, head: 9 })).toBeUndefined();
  });

  it('labels a single non-latest commit with its subject', () => {
    const ctx = commitContextFor(commits, { anchor: 3, head: 3 });
    expect(ctx).toEqual({ from: 'c3', to: 'c3', label: 'Commit 3' });
  });

  it('labels a range with 1-based positions', () => {
    const ctx = commitContextFor(commits, { anchor: 1, head: 4 });
    expect(ctx).toEqual({ from: 'c1', to: 'c4', label: 'коммиты 2–5' });
  });
});

describe('commitRangeCommand', () => {
  it('shows `git show` for a single non-root commit', () => {
    const commits = makeCommits();
    expect(commitRangeCommand(commits, { anchor: 5, head: 5 })).toBe('git show c5');
  });

  it('shows `git diff <empty-tree>` for the root commit alone', () => {
    const commits = makeCommits();
    expect(commitRangeCommand(commits, { anchor: 0, head: 0 })).toBe('git diff <empty-tree>..c0');
  });

  it('shows a first-parent diff for a selected merge commit', () => {
    const commits = makeCommits();
    commits[5].merge = true;
    expect(commitRangeCommand(commits, { anchor: 5, head: 5 })).toBe('git diff c5^1..c5');
  });

  it('shows a two-dot range for a multi-commit selection', () => {
    const commits = makeCommits();
    expect(commitRangeCommand(commits, { anchor: 2, head: 5 })).toBe('git diff c2^..c5');
  });

  it('shows <empty-tree> diff when the range starts at the root', () => {
    const commits = makeCommits();
    expect(commitRangeCommand(commits, { anchor: 0, head: 5 })).toBe('git diff <empty-tree>..c5');
  });
});

describe('clampIndex', () => {
  it('clamps into [0, count-1]', () => {
    expect(clampIndex(10, -5)).toBe(0);
    expect(clampIndex(10, 50)).toBe(9);
    expect(clampIndex(10, 3)).toBe(3);
  });

  it('never throws on an empty list', () => {
    expect(clampIndex(0, 3)).toBe(0);
  });
});
