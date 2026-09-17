import type { Descriptor, Mode } from '../api/types';

// The URL hash is the source of truth about what is open. The route part is
// the one the vanilla UI used, so old bookmarks and `review` links keep working:
//   #/local/<encoded root>
//   #/pr/<host>/<owner>/<repo>/<number>
//   #/local, #/pr — the picker screens
// A diff route also carries the open view as a query, so another tab reproduces it:
//   ?mode=working|staged|base|commits&base=<ref>&from=<sha>&to=<sha>&file=<path>
// Only the route part identifies the review (`hashFor`): the query never
// remounts it. A parameter that is unknown, half-written or meaningless for
// the route falls back to the default instead of breaking the screen.

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

function modeFrom(value: string | null): Mode {
  const modes: Mode[] = ['working', 'staged', 'base', 'commits'];
  return modes.find((m) => m === value) ?? 'working';
}

/** A commit range needs both ends; half of one means nothing and is dropped. */
function rangeFrom(q: URLSearchParams): { from?: string; to?: string } {
  const from = q.get('from') || '';
  const to = q.get('to') || '';
  return from && to ? { from, to } : {};
}

/** The review a hash points at, without its view: `#/local/<root>`, `#/pr/…`. */
export function hashFor(d: Descriptor | null): string {
  if (!d) return '';
  if (d.source === 'local') return `#/local/${encodeURIComponent(d.root)}`;
  return `#/pr/${d.host}/${d.owner}/${d.repo}/${d.number}`;
}

/** The full address of what is on screen: the review, its view, and the open file. */
export function viewHash(d: Descriptor | null, file: string | null): string {
  const route = hashFor(d);
  if (!d || !route) return '';
  const q = new URLSearchParams();
  if (d.source === 'local') {
    if (d.mode !== 'working') q.set('mode', d.mode);
    // An empty base means "ask the repository for its default branch"; there
    // is nothing to carry over, and the next tab resolves it the same way.
    if (d.base) q.set('base', d.base);
  }
  // The range is what selects the commits view for a PR; for a local repository
  // it only means anything in commits mode — same rule as `descriptorQuery`.
  if (d.from && d.to && (d.source === 'pr' || d.mode === 'commits')) {
    q.set('from', d.from);
    q.set('to', d.to);
  }
  if (file) q.set('file', file);
  const query = q.toString();
  return query ? `${route}?${query}` : route;
}

export function descriptorFromHash(hash: string): Descriptor | null {
  const { route, query } = splitHash(hash);
  const q = new URLSearchParams(query);
  const parts = route
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean);
  if (parts[0] === 'local' && parts[1]) {
    const root = safeDecode(parts[1]);
    if (!root) return null;
    const mode = modeFrom(q.get('mode'));
    // No base in the hash: an empty one asks the server for the repository's
    // own default branch, and /api/state answers with what it picked.
    return { source: 'local', root, mode, base: q.get('base') || '', ...(mode === 'commits' ? rangeFrom(q) : {}) };
  }
  if (parts[0] === 'pr' && parts.length >= 5) {
    const number = Number(parts[4]);
    if (!Number.isInteger(number) || number <= 0) return null;
    return { source: 'pr', host: parts[1], owner: parts[2], repo: parts[3], number, ...rangeFrom(q) };
  }
  return null;
}

/** A hand-written `%` in the address must not throw on the way to the screen. */
function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function fileFromHash(hash: string): string | null {
  return new URLSearchParams(splitHash(hash).query).get('file') || null;
}

/** Same review and same diff inside it — only the open file may differ. */
export function sameView(a: Descriptor | null, b: Descriptor | null): boolean {
  if (!a || !b) return false;
  return viewHash(a, null) === viewHash(b, null);
}

export function routeFromHash(hash: string): Route {
  const descriptor = descriptorFromHash(hash);
  if (descriptor) return { screen: 'diff', descriptor, file: fileFromHash(hash) };
  const first = splitHash(hash).route.replace(/^#\/?/, '').split('/')[0];
  return first === 'pr' ? { screen: 'pr' } : { screen: 'local' };
}

/** What Back/Forward (or a hand-edited address) asks the open review to do. */
export type Navigation =
  | { kind: 'ignore' }
  | { kind: 'file'; file: string }
  | { kind: 'view'; descriptor: Descriptor; file: string | null };

/**
 * Reads an address against what is on screen. Another review is nobody's
 * business here — the route changed, so the app remounts the review itself.
 * The same view only ever means "open that file"; anything else reloads the
 * diff the address describes, on the file it names.
 */
export function navigationFor(hash: string, current: Descriptor, currentFile: string | null): Navigation {
  const target = descriptorFromHash(hash);
  if (!target || hashFor(target) !== hashFor(current)) return { kind: 'ignore' };
  const file = fileFromHash(hash);
  if (!sameView(target, current)) return { kind: 'view', descriptor: target, file };
  return file && file !== currentFile ? { kind: 'file', file } : { kind: 'ignore' };
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
