// Zen: the diff screen with nothing above it — no app header, no commit rail,
// no PR title. The file tree stays.
//
// This is window state, not a project setting: it lives in localStorage next
// to the theme (lib/theme.ts:7) and the line wrap (DiffPane.tsx:18), and it is
// deliberately kept out of the hash. A link to a file should open that file,
// not impose someone else's layout on whoever follows it.
//
// Storage can throw (a private window, blocked site data), so every access is
// wrapped and "off" is the answer when anything goes wrong.

export const ZEN_KEY = 'local-review:zen';

/** Stored value -> flag. Anything but '1' means off, including a missing key. */
export function parseZen(raw: string | null): boolean {
  return raw === '1';
}

export function readZen(): boolean {
  try {
    return parseZen(window.localStorage.getItem(ZEN_KEY));
  } catch {
    return false;
  }
}

export function writeZen(on: boolean): void {
  try {
    window.localStorage.setItem(ZEN_KEY, on ? '1' : '0');
  } catch {
    // storage blocked
  }
}
