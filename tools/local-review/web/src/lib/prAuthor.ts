// Which PRs the search screen lists: everyone's, or only the gh user's own.
// The choice is remembered per browser, like the theme and line wrap.

export type PrAuthorFilter = 'all' | 'mine';

export const PR_AUTHOR_KEY = 'local-review:pr-author';

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStore(): KeyValueStore | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

export function parsePrAuthor(v: string | null | undefined): PrAuthorFilter {
  return v === 'mine' ? 'mine' : 'all';
}

export function readPrAuthor(store: KeyValueStore | null = defaultStore()): PrAuthorFilter {
  try {
    return parsePrAuthor(store?.getItem(PR_AUTHOR_KEY));
  } catch {
    return 'all';
  }
}

export function writePrAuthor(next: PrAuthorFilter, store: KeyValueStore | null = defaultStore()): void {
  try {
    store?.setItem(PR_AUTHOR_KEY, next);
  } catch {
    // storage blocked — the choice just won't survive a reload
  }
}
