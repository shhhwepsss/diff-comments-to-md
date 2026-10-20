// How a file's diff is drawn: one column ('unified', the new text with the
// deleted lines between its lines) or the old and the new version side by
// side ('split'). One choice for every file of the review.
//
// Window state, like the view mode (lib/viewMode.ts): the reviewer's choice
// lives in localStorage, and until there is one the settings page's default
// applies. Storage can throw, so every access is wrapped; a failed read is
// "nothing chosen yet".

import type { DiffLayout } from '../api/types';

export type { DiffLayout };

export const DIFF_LAYOUT_KEY = 'local-review:diff-layout';

/**
 * Two columns need room. A file narrower than this falls back to one column,
 * whatever was chosen, and its header says so.
 */
export const SPLIT_MIN_WIDTH = 900;

/**
 * Two columns come back only this much above the limit. Without the margin a
 * file right at the limit could flip for ever: two columns make the page
 * taller, its scrollbar appears and takes the width that made them fit.
 */
export const SPLIT_HYSTERESIS = 32;

/** Stored value -> layout. Anything else, a missing key included, is "not chosen". */
export function parseDiffLayout(raw: unknown): DiffLayout | null {
  return raw === 'unified' || raw === 'split' ? raw : null;
}

/** The reviewer's own choice, else the settings default; null while neither is known. */
export function resolveDiffLayout(chosen: DiffLayout | null, settingsDefault: DiffLayout | null): DiffLayout | null {
  return chosen ?? settingsDefault;
}

export function toggleDiffLayout(layout: DiffLayout): DiffLayout {
  return layout === 'split' ? 'unified' : 'split';
}

/**
 * Whether two columns fit a file of this width. `fitted` is the previous
 * answer: once they fit they stay until the width drops below the limit;
 * once they don't they come back only past the limit plus SPLIT_HYSTERESIS.
 */
export function splitFits(width: number, fitted: boolean): boolean {
  return width >= SPLIT_MIN_WIDTH + (fitted ? 0 : SPLIT_HYSTERESIS);
}

/** What a file actually shows: two columns only when they fit. */
export function effectiveDiffLayout(layout: DiffLayout, fits: boolean): DiffLayout {
  return layout === 'split' && !fits ? 'unified' : layout;
}

export function readDiffLayout(): DiffLayout | null {
  try {
    return parseDiffLayout(window.localStorage.getItem(DIFF_LAYOUT_KEY));
  } catch {
    return null;
  }
}

export function writeDiffLayout(layout: DiffLayout): void {
  try {
    window.localStorage.setItem(DIFF_LAYOUT_KEY, layout);
  } catch {
    // storage blocked
  }
}
