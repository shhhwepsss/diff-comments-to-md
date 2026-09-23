// Which files the sidebar shows. Two independent mechanisms:
//
// - Rules: an include and an exclude regexp over the whole path, like VS Code's
//   "files to include / exclude". Case-sensitive. A file that fails them is not
//   dropped, it moves to the "hidden by rules" section.
// - Quick search: a case-insensitive substring, characters taken literally.
//   It narrows both the tree and the hidden section and never touches rules.
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
