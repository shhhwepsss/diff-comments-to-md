import type { Descriptor } from '../api/types';

// The URL hash is the source of truth about what is open. The format is the
// one the vanilla UI used, so old bookmarks and `review` links keep working:
//   #/local/<encoded root>
//   #/pr/<host>/<owner>/<repo>/<number>
//   #/local, #/pr — the picker screens

export type Route =
  | { screen: 'diff'; descriptor: Descriptor }
  | { screen: 'local' }
  | { screen: 'pr' };

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
    return { source: 'local', root: decodeURIComponent(parts[1]), mode: 'working', base: 'origin/main' };
  }
  if (parts[0] === 'pr' && parts.length >= 5) {
    const number = Number(parts[4]);
    if (!Number.isInteger(number) || number <= 0) return null;
    return { source: 'pr', host: parts[1], owner: parts[2], repo: parts[3], number };
  }
  return null;
}

export function routeFromHash(hash: string): Route {
  const descriptor = descriptorFromHash(hash);
  if (descriptor) return { screen: 'diff', descriptor };
  const first = String(hash || '').replace(/^#\/?/, '').split('/')[0];
  return first === 'pr' ? { screen: 'pr' } : { screen: 'local' };
}
