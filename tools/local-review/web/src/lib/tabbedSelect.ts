// What a select with two tabs has to work out: «Все» lists every option,
// «Найдено» only the ones the query matches. Kept apart from the components
// (components/TabbedSelect.tsx, the repository field in screens/PrSearch.tsx)
// so both follow the same rules.

export type SelectTab = 'all' | 'found';

/** The tab typing leads to: the matches once there is a query, everything without one. */
export function tabForQuery(query: string): SelectTab {
  return query.trim() ? 'found' : 'all';
}

/** The options whose text has the query in it, in their order. No query finds nothing. */
export function foundBy<T>(options: readonly T[], query: string, textOf: (option: T) => string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return options.filter((option) => textOf(option).toLowerCase().includes(q));
}

/** The row the arrows move to; the list is a ring. */
export function stepActive(index: number, count: number, key: 'ArrowDown' | 'ArrowUp'): number {
  if (count <= 0) return 0;
  // A list that got shorter under the highlight (the query changed) starts over.
  if (index >= count) return 0;
  return (index + (key === 'ArrowDown' ? 1 : count - 1)) % count;
}

/** The text cut around the first match — before, the match, after — to mark it; null without one. */
export function splitMatch(text: string, query: string): [string, string, string] | null {
  const q = query.trim();
  if (!q) return null;
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return null;
  return [text.slice(0, at), text.slice(at, at + q.length), text.slice(at + q.length)];
}
