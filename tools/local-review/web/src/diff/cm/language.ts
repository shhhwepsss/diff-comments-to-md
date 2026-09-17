import { LanguageDescription, type LanguageSupport } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

// Syntax highlighting by file name. Language packages are split into their
// own chunks and loaded on first use.

export async function languageFor(path: string): Promise<LanguageSupport | null> {
  const name = path.split('/').pop() || path;
  const desc = LanguageDescription.matchFilename(languages, name);
  if (!desc) return null;
  try {
    return await desc.load();
  } catch {
    return null;
  }
}
