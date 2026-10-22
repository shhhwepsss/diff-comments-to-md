// Which files the sidebar shows. Three independent mechanisms:
//
// - Rules: an include and an exclude regexp over the whole path, like VS Code's
//   "files to include / exclude". Case-sensitive. A file that fails them is not
//   dropped, it moves to the "hidden by rules" section.
// - Quick search: a case-insensitive substring, characters taken literally.
//   It narrows both the tree and the hidden section and never touches rules.
// - Status: added / modified / deleted / renamed toggles. None picked means all.
//   Narrows like the search; files outside the diff have no status and stay.
//
// Everything here is session-only UI state; nothing reaches the server.

export type CompiledRule = { regex: RegExp | null; error: string | null };

export type FileRules = { include: RegExp | null; exclude: RegExp | null };

/** A blank field is "no rule"; a broken pattern is no rule plus an error to show. */
export function compileRule(source: string): CompiledRule {
  const pattern = source.trim();
  if (!pattern) return { regex: null, error: null };
  try {
    // No flags: case matters, and without `g` test() keeps no state between calls.
    return { regex: new RegExp(pattern), error: null };
  } catch (err) {
    return { regex: null, error: regexpErrorReason(err) };
  }
}

export function passesRules(path: string, rules: FileRules): boolean {
  if (rules.include && !rules.include.test(path)) return false;
  if (rules.exclude && rules.exclude.test(path)) return false;
  return true;
}

export function hasRules(rules: FileRules): boolean {
  return rules.include !== null || rules.exclude !== null;
}

/** The status groups the sidebar offers, in the order it shows them. */
export const STATUS_KINDS = ['A', 'M', 'D', 'R'] as const;

export type StatusKind = (typeof STATUS_KINDS)[number];

/**
 * The same grouping as the sidebar's status icon: an untracked file counts as
 * added, a copy as renamed, anything else unknown as modified.
 */
export function statusKind(file: { status: string; untracked?: boolean }): StatusKind {
  const kind = (file.status || 'M')[0];
  if (file.untracked || kind === 'U' || kind === 'A') return 'A';
  if (kind === 'D') return 'D';
  if (kind === 'R' || kind === 'C') return 'R';
  return 'M';
}

export function matchesStatus(file: { status: string; untracked?: boolean }, kinds: ReadonlySet<StatusKind>): boolean {
  return kinds.size === 0 || kinds.has(statusKind(file));
}

/**
 * Picking a status adds it to the set or takes it out; `only` keeps just that
 * one, and on the one already kept alone shows all again.
 */
export function toggleStatus(kinds: ReadonlySet<StatusKind>, kind: StatusKind, only = false): Set<StatusKind> {
  if (only) return kinds.size === 1 && kinds.has(kind) ? new Set() : new Set([kind]);
  const next = new Set(kinds);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  return next;
}

export function matchesSearch(path: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || path.toLowerCase().includes(needle);
}

/**
 * V8 says "Invalid regular expression: /<source>/: Unterminated group"; the
 * pattern is already in the field above, so keep only the reason.
 */
function regexpErrorReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cut = message.lastIndexOf('/: ');
  return cut === -1 ? message : message.slice(cut + 3);
}
