import type { LspLocation } from '../api/types';

// Code navigation without a language server: a GitHub PR with no local clone.
// «Go to definition» looks for lines that declare the word (simple patterns
// per language), «references» for the word itself; both over the new side of
// the files of the diff. A search by text knows nothing about scopes, so it
// may offer several declarations and counts comments and strings as uses:
// the panel says so. Pure: the texts come from the caller.

/** A file of the diff: its path and the text of its new side. */
export type TextFile = { path: string; text: string };

/** At most this many places per answer: a word like `i` must not list the world. */
export const MAX_HITS = 2000;
/** Of a long line, this much is shown, starting a little before the word. */
const PREVIEW_CHARS = 240;
const PREVIEW_LEAD = 60;

/** A letter of a name: Unicode letters and digits, `_` and `$` — as the editor's word under the caret (cm/occurrenceMatch.ts). */
const WORD_CHAR = '[\\p{L}\\p{N}_$]';
const ID = '[\\p{L}_$][\\p{L}\\p{N}_$]*';
/**
 * Longer lines are not searched for declarations: a minified bundle declares
 * nothing anyone navigates to, and the patterns, linear on code, may backtrack
 * quadratically on a pathological line.
 */
export const MAX_DECLARATION_LINE = 1000;

function escape(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The word, whole: `$` and `_` count as letters (JavaScript names), and so does any Unicode letter. */
function whole(word: string): string {
  return `(?<!${WORD_CHAR})${escape(word)}(?!${WORD_CHAR})`;
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

type Lang = 'js' | 'py' | 'go' | 'java' | 'kotlin' | 'rust' | 'ruby' | 'php' | 'c' | 'other';

const LANG_BY_EXT: Record<string, Lang> = {
  ts: 'js', tsx: 'js', mts: 'js', cts: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', vue: 'js', svelte: 'js',
  py: 'py', pyi: 'py',
  go: 'go',
  java: 'java', cs: 'java', scala: 'java', groovy: 'java',
  kt: 'kotlin', kts: 'kotlin',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', m: 'c', mm: 'c', swift: 'c',
};

export function languageOf(path: string): Lang {
  return LANG_BY_EXT[extensionOf(path)] ?? 'other';
}

/**
 * The lines that declare `word` in a file of this language. Each pattern is
 * one line long: a declaration split over lines is found by its first line,
 * which is where the name is.
 */
export function declarationPattern(word: string, path: string): RegExp {
  const w = whole(word);
  const modifiers = (list: string) => `(?:(?:${list})\\s+)*`;
  let parts: string[];
  switch (languageOf(path)) {
    case 'js':
      parts = [
        `\\b(?:function\\*?|class|interface|type|enum|namespace|module|const|let|var)\\s+${w}`,
        // `const { a, b } = …` and `const [a, b] = …` — the word checked by a lookahead, so the
        // two `[^=]*` around it do not backtrack against each other on a long line.
        `\\b(?:const|let|var)\\s+[{[](?=[^=]*${w})[^=]*[}\\]]\\s*=`,
        // A method or a class field: `  async name(…) {`, `  get name(): T {`, `  name = …` / `name: T;` in a class.
        // A call is never followed by `{` on its line; a method with its body is.
        `^\\s*${modifiers('public|private|protected|static|async|readonly|abstract|override|get|set')}\\*?${w}\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::\\s*[^={;]+)?\\{`,
        `^\\s*${modifiers('public|private|protected|static|readonly|declare')}${w}\\??\\s*:\\s*[^=;,)]+[;=]`,
      ];
      break;
    case 'py':
      parts = [`^\\s*(?:async\\s+)?def\\s+${w}`, `^\\s*class\\s+${w}`, `^${w}\\s*(?::[^=]*)?=(?!=)`];
      break;
    case 'go':
      parts = [`\\bfunc\\s+(?:\\([^)]*\\)\\s*)?${w}`, `\\btype\\s+${w}`, `\\b(?:var|const)\\s+${w}`, `^\\s*${w}\\s+(?:${ID}\\s*)?=(?!=)`];
      break;
    case 'java':
      parts = [
        `\\b(?:class|interface|enum|record|struct|@interface)\\s+${w}`,
        // `public static int name(…)` — a type before the name; a call has `return`/`new`/`=` or nothing there.
        `^\\s*${modifiers('public|private|protected|internal|static|final|abstract|synchronized|native|default|override|virtual|async|sealed|partial')}(?!return\\b|new\\b|throw\\b|else\\b)[\\p{L}\\p{N}_<>\\[\\],.?]+(?:\\s*<[^>]*>)?\\s+${w}\\s*\\([^;]*$`,
      ];
      break;
    case 'kotlin':
      parts = [`\\bfun\\s+(?:<[^>]*>\\s*)?(?:[\\p{L}\\p{N}_.<>?, ]+\\.)?${w}`, `\\b(?:class|interface|object|typealias|val|var)\\s+${w}`];
      break;
    case 'rust':
      parts = [`\\b(?:fn|struct|enum|trait|type|mod|const|static|union)\\s+${w}`, `\\bmacro_rules!\\s*${w}`, `\\blet\\s+(?:mut\\s+)?${w}`];
      break;
    case 'ruby':
      parts = [`^\\s*def\\s+(?:self\\.)?${w}`, `^\\s*(?:class|module)\\s+${w}`, `^\\s*${w}\\s*=(?!=)`];
      break;
    case 'php':
      parts = [`\\bfunction\\s+&?${w}`, `\\b(?:class|interface|trait|enum)\\s+${w}`, `\\bconst\\s+${w}`];
      break;
    case 'c':
      parts = [
        `\\b(?:struct|class|enum|union|typedef|namespace|protocol|func|let|var)\\s+${w}`,
        `#\\s*define\\s+${w}`,
        // `int name(…) {` or a prototype: a type (and maybe `*`) right before the name.
        `^[\\p{L}\\p{N}_\\s*&:<>,]*[\\p{L}\\p{N}_*&>]\\s+\\**${w}\\s*\\([^;]*$`,
      ];
      break;
    default:
      parts = [`\\b(?:function|def|fn|func|fun|class|interface|struct|enum|trait|type|const|let|var|val)\\s+${w}`];
  }
  return new RegExp(parts.map((p) => `(?:${p})`).join('|'), 'u');
}

/** Line breaks as LSP counts them, so positions match the editor's. */
function linesOf(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

function preview(line: string, character: number): { text: string; start: number } {
  let start = line.length - line.trimStart().length;
  if (character - start > PREVIEW_CHARS - PREVIEW_LEAD) start = Math.max(0, character - PREVIEW_LEAD);
  return { text: line.slice(start, start + PREVIEW_CHARS).trimEnd(), start };
}

function place(path: string, line: number, character: number, length: number, text: string): LspLocation {
  return { path, line, character, endLine: line, endCharacter: character + length, preview: preview(text, character) };
}

/**
 * Lines of the files that declare `word`, the word itself as the place. In a
 * line that mentions it twice (`const x = x0`) the first whole-word match
 * after the declaring keyword is taken, which is the name.
 */
export function findDeclarations(files: readonly TextFile[], word: string): LspLocation[] {
  if (!word) return [];
  const out: LspLocation[] = [];
  const find = new RegExp(whole(word), 'gu');
  for (const f of files) {
    const re = declarationPattern(word, f.path);
    const lines = linesOf(f.text);
    for (let i = 0; i < lines.length && out.length < MAX_HITS; i++) {
      const line = lines[i];
      if (line.length > MAX_DECLARATION_LINE || !line.includes(word)) continue;
      const m = re.exec(line);
      if (!m) continue;
      find.lastIndex = m.index;
      const at = find.exec(line);
      if (at) out.push(place(f.path, i, at.index, word.length, line));
    }
  }
  return out;
}

/** Every whole-word occurrence of `word`: in code, comments and strings alike. */
export function findWord(files: readonly TextFile[], word: string): LspLocation[] {
  if (!word) return [];
  const out: LspLocation[] = [];
  const re = new RegExp(whole(word), 'gu');
  for (const f of files) {
    const lines = linesOf(f.text);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes(word)) continue;
      re.lastIndex = 0;
      for (let m = re.exec(line); m; m = re.exec(line)) {
        out.push(place(f.path, i, m.index, word.length, line));
        if (out.length >= MAX_HITS) return out;
      }
    }
  }
  return out;
}
