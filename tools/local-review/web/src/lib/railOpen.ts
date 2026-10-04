// The commit rail under the header: the full strip of commits, or one line
// that names the selected range. Folded by default — the strip is wanted when
// picking commits, not while reading the diff they make.
//
// Window state like Zen (lib/zen.ts): localStorage, not the hash. Storage can
// throw (a private window, blocked site data), so every access is wrapped and
// "folded" is the answer when it does.

export const RAIL_OPEN_KEY = 'local-review:rail-open';

/** Stored value -> flag. Anything but '1' means folded, including a missing key. */
export function parseRailOpen(raw: string | null): boolean {
  return raw === '1';
}

export function readRailOpen(): boolean {
  try {
    return parseRailOpen(window.localStorage.getItem(RAIL_OPEN_KEY));
  } catch {
    return false;
  }
}

export function writeRailOpen(open: boolean): void {
  try {
    window.localStorage.setItem(RAIL_OPEN_KEY, open ? '1' : '0');
  } catch {
    // storage blocked
  }
}
