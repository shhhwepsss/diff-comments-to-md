// The repository picker's two pure pieces: how a row's date reads, and what
// counts as a match while typing.
//
// Primer's own Autocomplete filter matches with `startsWith` on the item text
// (AutocompleteMenu.js:25), and the text here is `owner/repo` — so typing the
// repository's own name would filter everything out unless the owner was
// typed first. `matchesRepo` below is what the menu gets instead.

/** "20.09.2026" — the same day-first shape as lib/format.ts, without the time. */
export function formatRepoPushed(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** Case-insensitive substring, so "diff" finds "shhhwepsss/diff-comments-to-md". */
export function matchesRepo(nameWithOwner: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return nameWithOwner.toLowerCase().includes(needle);
}
