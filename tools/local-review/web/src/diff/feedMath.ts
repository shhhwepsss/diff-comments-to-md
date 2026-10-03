// Geometry of the feed of all files. Pure, so it is tested without a browser.

/**
 * Which file the reviewer is looking at: the one the reading line `y` falls
 * in, i.e. the first whose bottom edge is below it. `bottoms` are in document
 * order (ascending). Going by bottoms, not tops, keeps a file that is only a
 * collapsed header current while that header is at the top of the screen.
 * Past the last file it is still the last one; -1 only for an empty feed.
 */
export function currentIndexAt(bottoms: readonly number[], y: number): number {
  if (bottoms.length === 0) return -1;
  let lo = 0;
  let hi = bottoms.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bottoms[mid] > y) hi = mid;
    else lo = mid + 1;
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
