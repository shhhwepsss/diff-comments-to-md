import type { Descriptor } from '../api/types';

// The URL hash is the source of truth about what is open. The format is the
// one the vanilla UI used, so old bookmarks and `review` links keep working:
//   #/local/<encoded root>
//   #/pr/<host>/<owner>/<repo>/<number>
//   #/local, #/pr — the picker screens
// A diff route may carry the open file as a query: `…?file=<encoded path>`.
// It only picks the file on load, so it is not part of the review's identity.

export type Route =
  | { screen: 'diff'; descriptor: Descriptor; file: string | null }
  | { screen: 'local' }
  | { screen: 'pr' };

/** Splits `#/route?query` at the first `?`; the route part never has a raw one. */
function splitHash(hash: string): { route: string; query: string } {
  const s = String(hash || '');
  const i = s.indexOf('?');
  return i < 0 ? { route: s, query: '' } : { route: s.slice(0, i), query: s.slice(i + 1) };
}

export function hashFor(d: Descriptor | null): string {
  if (!d) return '';
  if (d.source === 'local') return `#/local/${encodeURIComponent(d.root)}`;
  return `#/pr/${d.host}/${d.owner}/${d.repo}/${d.number}`;
}

/** The hash that opens `d` on `file`; a plain `hashFor(d)` when there is no file. */
export function fileHashFor(d: Descriptor, file: string | null): string {
  const base = hashFor(d);
  return base && file ? `${base}?file=${encodeURIComponent(file)}` : base;
}

export function descriptorFromHash(hash: string): Descriptor | null {
  const parts = splitHash(hash)
    .route.replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean);
  if (parts[0] === 'local' && parts[1]) {
    // No base in the hash: an empty one asks the server for the repository's
    // own default branch, and /api/state answers with what it picked.
    return { source: 'local', root: decodeURIComponent(parts[1]), mode: 'working', base: '' };
  }
  if (parts[0] === 'pr' && parts.length >= 5) {
    const number = Number(parts[4]);
    if (!Number.isInteger(number) || number <= 0) return null;
    return { source: 'pr', host: parts[1], owner: parts[2], repo: parts[3], number };
  }
  return null;
}

export function fileFromHash(hash: string): string | null {
  return new URLSearchParams(splitHash(hash).query).get('file') || null;
}

export function routeFromHash(hash: string): Route {
  const descriptor = descriptorFromHash(hash);
  if (descriptor) return { screen: 'diff', descriptor, file: fileFromHash(hash) };
  const first = splitHash(hash).route.replace(/^#\/?/, '').split('/')[0];
  return first === 'pr' ? { screen: 'pr' } : { screen: 'local' };
}

/**
 * A click the browser should handle itself: another button, or a modifier
 * that means "new tab / new window / download" (Ctrl, Cmd, Shift, Alt).
 * Keyboard events have no `button`; only their modifiers count.
 */
export function wantsNativeLink(event: {
  button?: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  if (event.button !== undefined && event.button !== 0) return true;
  return event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
}
