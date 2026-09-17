import { LanguageDescription, type LanguageSupport } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

// Syntax highlighting by file name. Language packages are split into their
// own chunks and loaded on first use.

/**
 * Null when nothing matches the file name. A chunk that fails to load (the
 * server went away mid-review) rejects: the caller shows the diff without
 * highlighting and says why, instead of losing the failure here.
 */
export async function languageFor(path: string): Promise<LanguageSupport | null> {
  const name = path.split('/').pop() || path;
  const desc = LanguageDescription.matchFilename(languages, name);
  if (!desc) return null;
  return desc.load();
}
