// Pure selection logic for the "commits" review mode: which commit(s) on the
// history rail are selected, and how clicks / drags / arrow keys change that.
// No DOM, no fetch — everything here is index arithmetic over a Commit[] so
// it can be unit-tested without mounting a component.
//
// Rules (approved in PR #4 / issue #3), ported from the vanilla-JS commits.js:
//   - default: the latest commit is selected;
//   - click inside a range trims it from the lower bound: 1-9 + click 4 -> 1-4;
//   - click on either bound of a range leaves only that commit selected;
//   - click outside the range resets the selection to just that commit;
//   - click on the single selected commit returns the selection to the latest
//     commit (a no-op if it already is the latest);
//   - dragging across dots gives the same range in either direction;
//   - Left/Right move a single-commit selection, Shift+Left/Right extend a
//     range from the anchor;
//   - the selection is never empty.

import type { Comment, Commit, CommitContext } from '../api/types';

/** anchor = where the selection/drag started; head = the other end (moves on drag/extend). */
export type CommitSelection = { anchor: number; head: number };

export function clampIndex(count: number, i: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, i));
}

export function lastIndex(count: number): number {
  return count - 1;
}

export function selLo(sel: CommitSelection): number {
  return Math.min(sel.anchor, sel.head);
}

export function selHi(sel: CommitSelection): number {
  return Math.max(sel.anchor, sel.head);
}

/** The default selection: just the latest (last) commit. */
export function defaultSelection(count: number): CommitSelection {
  const last = lastIndex(count);
  const i = last < 0 ? 0 : last;
  return { anchor: i, head: i };
}

/**
 * A click (or a drag that didn't move) on commit `i`. See the rules above;
 * ported 1:1 from commits.js `clickCommit`.
 */
export function clickSelect(sel: CommitSelection, count: number, i: number): CommitSelection {
  const idx = clampIndex(count, i);
  const lo = selLo(sel);
  const hi = selHi(sel);
  const single = lo === hi;
  const last = lastIndex(count);

  if (single && idx === sel.anchor) {
    // Click on the single selected commit returns to the latest one; already
    // there, it's a no-op (returning `sel` keeps callers from reloading).
    if (idx === last) return sel;
    return { anchor: last, head: last };
  }
  const inRange = idx >= lo && idx <= hi;
  if (inRange && (idx === lo || idx === hi)) {
    return { anchor: idx, head: idx };
  }
  if (inRange) {
    // Trimming a range always happens from the lower bound.
    return { anchor: lo, head: idx };
  }
  return { anchor: idx, head: idx };
}

/** A drag from `from` to `to`; symmetric in both directions by construction. */
export function dragSelect(count: number, from: number, to: number): CommitSelection {
  return { anchor: clampIndex(count, from), head: clampIndex(count, to) };
}

/** Left/Right (move) or Shift+Left/Right (extend the range from the anchor). */
export function keySelect(sel: CommitSelection, count: number, direction: -1 | 1, extend: boolean): CommitSelection {
  if (extend) return { anchor: sel.anchor, head: clampIndex(count, sel.head + direction) };
  const idx = clampIndex(count, sel.head + direction);
  return { anchor: idx, head: idx };
}

/** Match a comment's stored commit reference to a rail index: full sha, short sha, or a sha prefix. */
export function indexOfSha(commits: Commit[], sha: string | null | undefined): number {
  if (!sha) return -1;
  return commits.findIndex((c) => c.sha === sha || c.short === sha || c.sha.startsWith(sha));
}

/**
 * The rail selection a `from`/`to` pair out of the address means. Null when
 * either end is missing or no longer on the rail (a rebased or trimmed
 * history): the caller then falls back to the default selection.
 */
export function selectionForRange(commits: Commit[], from?: string | null, to?: string | null): CommitSelection | null {
  if (!from || !to) return null;
  const a = indexOfSha(commits, from);
  const b = indexOfSha(commits, to);
  if (a === -1 || b === -1) return null;
  return { anchor: Math.min(a, b), head: Math.max(a, b) };
}

/**
 * Whether a comment's commit context is covered by the current selection.
 * A comment with no context (or one written on the always-uncontexted
 * latest-commit-only selection) is always visible; one whose commit(s) no
 * longer exist on the rail is shown too — there is nothing to hide it from.
 */
export function insideSelection(commits: Commit[], sel: CommitSelection, ctx: CommitContext | null | undefined): boolean {
  if (!ctx || !ctx.to) return true;
  const f = indexOfSha(commits, ctx.from);
  const t = indexOfSha(commits, ctx.to);
  if (f === -1 || t === -1) return true;
  return f >= selLo(sel) && t <= selHi(sel);
}

/** Comments whose commit context falls outside the current selection. */
export function outsideComments(commits: Commit[], sel: CommitSelection, comments: Comment[]): Comment[] {
  return comments.filter((c) => c.commit && !insideSelection(commits, sel, c.commit));
}

/** Grow the selection to cover every outside comment's commit range. */
export function expandToComments(commits: Commit[], count: number, sel: CommitSelection, comments: Comment[]): CommitSelection {
  const idx: number[] = [];
  for (const c of comments) {
    if (!c.commit) continue;
    const f = indexOfSha(commits, c.commit.from);
    const t = indexOfSha(commits, c.commit.to);
    if (f !== -1) idx.push(f);
    if (t !== -1) idx.push(t);
  }
  if (!idx.length) return sel;
  const lo = clampIndex(count, Math.min(selLo(sel), ...idx));
  const hi = clampIndex(count, Math.max(selHi(sel), ...idx));
  return { anchor: lo, head: hi };
}

/**
 * The `commit` payload a new comment should carry: always, the latest commit
 * included. Without it a comment on the latest commit could not be told from
 * one on uncommitted changes, and would turn stale in this very view
 * (review/commentAge.ts).
 */
export function commitContextFor(commits: Commit[], sel: CommitSelection): CommitContext | undefined {
  const lo = selLo(sel);
  const hi = selHi(sel);
  const l = commits[lo];
  const h = commits[hi];
  if (!l || !h) return undefined;
  return {
    from: l.short,
    to: h.short,
    label: lo === hi ? l.subject : `коммиты ${lo + 1}–${hi + 1}`,
  };
}

/** The `git diff`/`git show` command the current selection corresponds to — shown as a hint, never run. */
export function commitRangeCommand(commits: Commit[], sel: CommitSelection): string {
  const lo = selLo(sel);
  const hi = selHi(sel);
  const l = commits[lo];
  const h = commits[hi];
  if (!l || !h) return '';
  if (lo === hi) {
    // A merge is diffed against its first parent, like any other commit.
    if (l.merge) return `git diff ${l.short}^1..${l.short}`;
    return l.root ? `git diff <empty-tree>..${l.short}` : `git show ${l.short}`;
  }
  return l.root ? `git diff <empty-tree>..${h.short}` : `git diff ${l.short}^..${h.short}`;
}
