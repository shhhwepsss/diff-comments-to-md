// Which comments were written against code other than the code on screen.
//
// Every comment has an "own commit": the one it was written against. A comment
// written in commits mode records it (`comment.commit`); any other comment is
// placed by time — the first commit made after it, since that is the commit
// that took the changes it was about (staged → `git commit` lands here). No
// commit after it means it is still about uncommitted changes.
//
// A comment is stale when its own commit is not part of what the current view
// shows. Pure module: no DOM, no fetch.

import type { Comment, Commit, Descriptor } from '../api/types';
import { indexOfSha, selHi, selLo, type CommitSelection } from './commitSelection';

/**
 * What the view on screen is made of:
 * - `uncommitted` — working copy / staged: nothing committed is shown;
 * - `branch` — base mode, a PR's "Все изменения": every commit in the history
 *   plus (for base) uncommitted changes;
 * - `range` — commits mode: only the selected commits.
 */
export type ViewKind = 'uncommitted' | 'branch' | 'range';

export function viewKindOf(d: Descriptor): ViewKind {
  if (d.source === 'pr') return d.from && d.to ? 'range' : 'branch';
  if (d.mode === 'commits') return 'range';
  if (d.mode === 'base') return 'branch';
  return 'uncommitted';
}

/** `null` = uncommitted changes; `-1` = a commit the loaded history does not have. */
export type OwnCommit = number | null;

function time(iso: string | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? NaN : t;
}

/**
 * Index into `history` (oldest first) of the comment's own commit.
 * `truncated`: the history does not reach back to the branch point, so a
 * comment older than its first commit may belong to one that is not loaded.
 */
export function ownCommit(comment: Comment, history: Commit[], truncated = false): OwnCommit {
  if (comment.commit?.to) return indexOfSha(history, comment.commit.to);
  const created = time(comment.createdAt);
  if (Number.isNaN(created)) return null;
  const i = history.findIndex((c) => time(c.committedAt) > created);
  if (i === -1) return null;
  if (i === 0 && truncated) return -1;
  return i;
}

export type AgeContext = {
  view: ViewKind;
  history: Commit[];
  truncated: boolean;
  /** The selected commits; used by the `range` view only. */
  sel: CommitSelection | null;
};

export function isStale(comment: Comment, ctx: AgeContext): boolean {
  const own = ownCommit(comment, ctx.history, ctx.truncated);
  if (own === -1) return true;
  switch (ctx.view) {
    case 'uncommitted':
      return own !== null;
    case 'branch':
      return false;
    case 'range': {
      if (own === null || !ctx.sel) return own === null;
      const lo = selLo(ctx.sel);
      const hi = selHi(ctx.sel);
      // A recorded range must fit the selection whole, like the rail's own rule.
      const from = comment.commit ? indexOfSha(ctx.history, comment.commit.from) : own;
      if (from === -1) return true;
      return from < lo || own > hi;
    }
  }
}

/**
 * The commits «Открыть в …» selects: the recorded range, or the single own
 * commit. Null when there is nothing to open (uncommitted or not in history).
 */
export function openTarget(comment: Comment, history: Commit[], truncated = false): { from: number; to: number } | null {
  const own = ownCommit(comment, history, truncated);
  if (own === null || own === -1) return null;
  if (comment.commit) {
    const from = indexOfSha(history, comment.commit.from);
    if (from !== -1 && from <= own) return { from, to: own };
  }
  return { from: own, to: own };
}

/** What a stale comment was written against, for its chip: «к a41f9c2». */
export function staleTarget(comment: Comment, history: Commit[], truncated = false): string {
  const label = ownCommitLabel(comment, history, truncated);
  if (label) return `к ${label}`;
  return ownCommit(comment, history, truncated) === null ? 'к незакоммиченным изменениям' : 'к коммиту вне истории';
}

/** Short label of the own commit for the chip: `a41f9c2` or `a41f9c2..b7e01d3`. */
export function ownCommitLabel(comment: Comment, history: Commit[], truncated = false): string | null {
  if (comment.commit) {
    const { from, to } = comment.commit;
    return from === to ? to : `${from}..${to}`;
  }
  const own = ownCommit(comment, history, truncated);
  return own === null || own === -1 ? null : history[own].short;
}
