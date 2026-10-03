// Geometry of the feed of all files. Pure, so it is tested without a browser.

/**
 * Which file the reviewer is looking at: the last one whose top edge is at or
 * above the reading line `y`. `tops` are in document order (ascending). Before
 * the first file starts it is still the first one; -1 only for an empty feed.
 */
export function currentIndexAt(tops: readonly number[], y: number): number {
  if (tops.length === 0) return -1;
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const LINE_PX = 20; // cm/theme.ts: the diff's line height
const CONTEXT_LINES = 6; // three lines of context on each side of a change
const MIN_PX = 80;
const MAX_PX = 1600;
const UNKNOWN_PX = 200;

/**
 * Height to hold for a file whose diff is not loaded yet, from its changed
 * line counts. A guess: folded context and wrapped lines make the real diff
 * taller or shorter, and the feed re-aims after it loads. Capped, so one huge
 * file does not make the scrollbar lie about everything below it.
 */
export function placeholderHeight(additions: number | null | undefined, deletions: number | null | undefined): number {
  if (additions == null || deletions == null) return UNKNOWN_PX;
  const px = (additions + deletions + CONTEXT_LINES) * LINE_PX;
  return Math.min(MAX_PX, Math.max(MIN_PX, px));
}

/** Whether a file is collapsed: the reviewer's own toggle, while the viewed mark it was made against still stands. */
export type CollapseChoice = { viewed: boolean; collapsed: boolean };

/**
 * A viewed file is collapsed and an unviewed one is open, until the reviewer
 * toggles it by hand. The toggle holds only while the viewed mark is what it
 * was then: marking or unmarking the file is a newer decision and wins.
 */
export function isCollapsed(viewed: boolean, choice: CollapseChoice | undefined): boolean {
  return choice && choice.viewed === viewed ? choice.collapsed : viewed;
}
