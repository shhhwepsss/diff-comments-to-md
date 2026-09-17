import type { Descriptor } from '../api/types';

// The URL hash is the source of truth about what is open. The format is the
// one the vanilla UI used, so old bookmarks and `review` links keep working:
//   #/local/<encoded root>
//   #/pr/<host>/<owner>/<repo>/<number>
//   #/local, #/pr — the picker screens
//   #/settings, #/settings/<encoded hash to go back to> — the settings page

export type Route =
  | { screen: 'diff'; descriptor: Descriptor }
  | { screen: 'local' }
  | { screen: 'pr' }
  | { screen: 'settings'; back: string };

/** Where an unknown, empty or malformed hash lands, here and in App.tsx. */
export const DEFAULT_HASH = '#/local';

/**
 * Settings is a page, so it has to be openable by address alone. The screen it
 * was opened from rides along in the hash instead of in memory: after a reload
 * «Назад» still knows where to return. Anything that is not an in-app hash —
 * and settings itself, which would make a loop — falls back to the picker.
 */
function backTarget(hash: string | null | undefined): string {
  const value = String(hash || '');
  if (!value.startsWith('#/') || value.startsWith('#/settings')) return DEFAULT_HASH;
  return value;
}

/** A half-typed `%` in the address must not blow the whole app up. */
function decodeSafe(part: string | undefined): string {
  if (!part) return '';
  try {
    return decodeURIComponent(part);
  } catch {
    return '';
  }
}

export function settingsHash(back?: string | null): string {
  const target = backTarget(back);
  return target === DEFAULT_HASH ? '#/settings' : `#/settings/${encodeURIComponent(target)}`;
}

export function hashFor(d: Descriptor | null): string {
  if (!d) return '';
  if (d.source === 'local') return `#/local/${encodeURIComponent(d.root)}`;
  return `#/pr/${d.host}/${d.owner}/${d.repo}/${d.number}`;
}

export function descriptorFromHash(hash: string): Descriptor | null {
  const parts = String(hash || '')
    .replace(/^#\/?/, '')
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

export function routeFromHash(hash: string): Route {
  const parts = String(hash || '')
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean);
  // Checked before the descriptor so `settings` can never read as a source.
  if (parts[0] === 'settings') {
    return { screen: 'settings', back: backTarget(decodeSafe(parts[1])) };
  }
  const descriptor = descriptorFromHash(hash);
  if (descriptor) return { screen: 'diff', descriptor };
  return parts[0] === 'pr' ? { screen: 'pr' } : { screen: 'local' };
}
