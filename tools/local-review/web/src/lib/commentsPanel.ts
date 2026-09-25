// The "all comments" panel beside the diff: open or closed, and its width.
//
// Window state like Zen (lib/zen.ts): localStorage, not the hash. One flag for
// both Zen and the normal view — the panel stays open across the switch.
// Storage can throw (a private window, blocked site data), so every access is
// wrapped and "closed" / the default width is the answer when it does.

import type { PaneWidth } from '../diff/sidebarWidth';

export const COMMENTS_PANEL_KEY = 'local-review:comments-panel';
export const COMMENTS_PANEL_WIDTH_KEY = 'local-review:comments-panel-width';
/** Narrower cap than the tree: with both open the diff must keep room. */
export const COMMENTS_PANEL_WIDTH: PaneWidth = { min: 280, def: 380, maxShare: 0.45 };

/** Stored value -> flag. Anything but '1' means closed, including a missing key. */
export function parseCommentsPanel(raw: string | null): boolean {
  return raw === '1';
}

export function readCommentsPanel(): boolean {
  try {
    return parseCommentsPanel(window.localStorage.getItem(COMMENTS_PANEL_KEY));
  } catch {
    return false;
  }
}

export function writeCommentsPanel(open: boolean): void {
  try {
    window.localStorage.setItem(COMMENTS_PANEL_KEY, open ? '1' : '0');
  } catch {
    // storage blocked
  }
}
