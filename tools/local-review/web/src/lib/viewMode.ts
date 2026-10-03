// How the diff screen shows files: one at a time ('single'), or all of them
// stacked in one scroll, the way GitHub does ('all').
//
// The choice is window state, like Zen (lib/zen.ts): it lives in localStorage
// and stays out of the hash. Until the reviewer picks a mode there is nothing
// stored, and the mode comes from the settings page's default instead — so
// only an explicit choice is ever written here.
//
// Storage can throw (a private window, blocked site data), so every access is
// wrapped; a failed read is the same as "nothing chosen yet".

import type { ViewMode } from '../api/types';

export type { ViewMode };

export const VIEW_MODE_KEY = 'local-review:view-mode';

/** Stored value -> mode. Anything else, a missing key included, is "not chosen". */
export function parseViewMode(raw: unknown): ViewMode | null {
  return raw === 'single' || raw === 'all' ? raw : null;
}

/**
 * The mode to show: the reviewer's own choice, else the default from the
 * settings. Null while neither is known yet — the settings are still loading.
 */
export function resolveViewMode(chosen: ViewMode | null, settingsDefault: ViewMode | null): ViewMode | null {
  return chosen ?? settingsDefault;
}

export function toggleViewMode(mode: ViewMode): ViewMode {
  return mode === 'all' ? 'single' : 'all';
}

export function readViewMode(): ViewMode | null {
  try {
    return parseViewMode(window.localStorage.getItem(VIEW_MODE_KEY));
  } catch {
    return null;
  }
}

export function writeViewMode(mode: ViewMode): void {
  try {
    window.localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {
    // storage blocked
  }
}
