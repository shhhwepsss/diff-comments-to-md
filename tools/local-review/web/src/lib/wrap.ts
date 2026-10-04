// Line wrap in the diff: one switch for every file, in the header's «Вид» menu.
//
// Window state like Zen (lib/zen.ts): localStorage, not the hash. On unless the
// reviewer turned it off — long lines are read more often than they are
// compared column by column. Storage can throw (a private window, blocked site
// data), so every access is wrapped and "on" is the answer when it does.

export const WRAP_KEY = 'local-review:wrap';

/** Stored value -> flag. Only an explicit '0' turns wrapping off. */
export function parseWrap(raw: string | null): boolean {
  return raw !== '0';
}

export function readWrap(): boolean {
  try {
    return parseWrap(window.localStorage.getItem(WRAP_KEY));
  } catch {
    return true;
  }
}

export function writeWrap(on: boolean): void {
  try {
    window.localStorage.setItem(WRAP_KEY, on ? '1' : '0');
  } catch {
    // storage blocked
  }
}
