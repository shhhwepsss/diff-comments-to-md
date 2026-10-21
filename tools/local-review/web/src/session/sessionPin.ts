// The list of a session's PRs pinned beside the diff: on or off.
//
// A per-browser preference like Zen (lib/zen.ts) and the comments panel
// (lib/commentsPanel.ts): localStorage, not the address and not the session —
// the same session on another screen may well want the list off. Storage can
// throw (a private window, blocked site data), so every access is wrapped and
// "unpinned" is the answer when anything goes wrong.

export const SESSION_PIN_KEY = 'local-review:session-pin';

/** Stored value -> flag. Anything but '1' means unpinned, including a missing key. */
export function parseSessionPin(raw: string | null): boolean {
  return raw === '1';
}

export function readSessionPin(): boolean {
  try {
    return parseSessionPin(window.localStorage.getItem(SESSION_PIN_KEY));
  } catch {
    return false;
  }
}

export function writeSessionPin(on: boolean): void {
  try {
    window.localStorage.setItem(SESSION_PIN_KEY, on ? '1' : '0');
  } catch {
    // storage blocked
  }
}
