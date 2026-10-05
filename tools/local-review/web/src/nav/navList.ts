import type { LspLocation } from '../api/types';

// The lists of the navigation panel (NavPanel.tsx): references and
// implementations grouped by file, the piece of a line to show for each, and
// what kind of symbol the panel is about. Pure: no DOM, no requests.

/** Places in one file; `path` null for a group outside the repository. */
export type LocationGroup = {
  key: string;
  path: string | null;
  /** The file outside the repository, for a group with no path. */
  external: string | null;
  items: LspLocation[];
};

export type GroupedLocations = { groups: LocationGroup[]; total: number };

function placeKey(l: LspLocation): string {
  return l.path !== null ? `p:${l.path}` : `x:${l.external ?? ''}`;
}

/**
 * Places by file: the file the search started in first (that is where the
 * reviewer is), then the repository's files by path, then the ones outside
 * it. Within a file, by position. The same place twice (a server reporting a
 * declaration as both definition and reference) is listed once.
 */
export function groupLocations(list: readonly LspLocation[], first?: string | null): GroupedLocations {
  const byFile = new Map<string, LocationGroup>();
  const seen = new Set<string>();
  for (const l of list) {
    const key = placeKey(l);
    const id = `${key}:${l.line}:${l.character}`;
    if (seen.has(id)) continue;
    seen.add(id);
    let g = byFile.get(key);
    if (!g) byFile.set(key, (g = { key, path: l.path, external: l.path === null ? (l.external ?? null) : null, items: [] }));
    g.items.push(l);
  }
  const rank = (g: LocationGroup) => (g.path === null ? 2 : g.path === first ? 0 : 1);
  const name = (g: LocationGroup) => g.path ?? g.external ?? '';
  const groups = [...byFile.values()].sort((a, b) => rank(a) - rank(b) || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));
  for (const g of groups) g.items.sort((a, b) => a.line - b.line || a.character - b.character);
  return { groups, total: seen.size };
}

/** «3 ссылки», «1 файл»: the noun agreeing with the number. */
export function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const dd = n % 100;
  const word = d === 1 && dd !== 11 ? one : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many;
  return `${n} ${word}`;
}

export type PreviewPart = { text: string; hit: boolean };

/**
 * The preview of a place split around the symbol, for marking it. The
 * preview starts at column `start` of its line; the symbol is the place's
 * range, cut to the preview (a range running to another line is marked to
 * the end of this one).
 */
export function previewParts(l: Pick<LspLocation, 'line' | 'character' | 'endLine' | 'endCharacter' | 'preview'>): PreviewPart[] {
  const p = l.preview;
  if (!p) return [];
  const len = p.text.length;
  const from = Math.min(len, Math.max(0, l.character - p.start));
  const to = Math.min(len, Math.max(from, (l.endLine === l.line ? l.endCharacter : Number.MAX_SAFE_INTEGER) - p.start));
  const parts: PreviewPart[] = [];
  if (from > 0) parts.push({ text: p.text.slice(0, from), hit: false });
  if (to > from) parts.push({ text: p.text.slice(from, to), hit: true });
  if (to < len) parts.push({ text: p.text.slice(to), hit: false });
  return parts;
}

/** The last part of a path: the name the list shows in bold. */
export function fileName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return path.slice(cut + 1);
}

/** The folder of a path, with its trailing slash; '' for a file at the root. */
export function dirName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return path.slice(0, cut + 1);
}

// ------------------------------------------------------------- symbol kind

/** What the panel calls a symbol; null for a kind it has no word for. */
export type SymbolKind =
  | 'function'
  | 'method'
  | 'constructor'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'constant'
  | 'property'
  | 'parameter'
  | 'module'
  | 'field';

export const KIND_LABEL: Record<SymbolKind, string> = {
  function: 'функция',
  method: 'метод',
  constructor: 'конструктор',
  class: 'класс',
  interface: 'интерфейс',
  type: 'тип',
  enum: 'перечисление',
  variable: 'переменная',
  constant: 'константа',
  property: 'свойство',
  parameter: 'параметр',
  module: 'модуль',
  field: 'поле',
};

/** LSP SymbolKind numbers, as call hierarchy items carry them. */
const LSP_KINDS: Record<number, SymbolKind> = {
  1: 'module',
  2: 'module',
  3: 'module',
  4: 'module',
  5: 'class',
  6: 'method',
  7: 'property',
  8: 'field',
  9: 'constructor',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  14: 'constant',
  23: 'class',
  26: 'type',
};

export function kindFromLsp(kind: number | null | undefined): SymbolKind | null {
  return (kind != null && LSP_KINDS[kind]) || null;
}

const HOVER_KINDS: [RegExp, SymbolKind][] = [
  [/^\(method\)/, 'method'],
  [/^\(constructor\)|^constructor\b/, 'constructor'],
  [/^\(property\)/, 'property'],
  [/^\(parameter\)/, 'parameter'],
  [/^\((?:local )?function\)|^(?:export )?(?:declare )?(?:async )?function\b/, 'function'],
  [/^(?:export )?(?:declare )?(?:abstract )?class\b/, 'class'],
  [/^(?:export )?(?:declare )?interface\b/, 'interface'],
  [/^(?:export )?(?:declare )?type\b/, 'type'],
  [/^(?:export )?(?:declare )?(?:const )?enum\b/, 'enum'],
  [/^(?:export )?(?:declare )?(?:module|namespace)\b/, 'module'],
  [/^(?:\((?:local )?const\)|(?:export )?(?:declare )?const)\b/, 'constant'],
  [/^(?:\((?:local )?(?:var|let)\)|(?:export )?(?:declare )?(?:let|var))\b/, 'variable'],
];

/**
 * The kind of symbol from the first line of a hover (TypeScript words it as
 * `(method) Store.load(…)`, `function f(…)`, `class C`; an imported name is
 * `(alias) function f(…)`). A guess for the panel header and for which
 * buttons the hover offers; null when unsure.
 */
export function kindFromHover(code: string | null | undefined): SymbolKind | null {
  const line = (String(code ?? '').trim().split('\n')[0] ?? '').replace(/^\(alias\)\s+/, '');
  for (const [re, kind] of HOVER_KINDS) if (re.test(line)) return kind;
  return null;
}

/** Only functions are in a call hierarchy; an unknown kind may be one, so it gets the benefit of the doubt. */
export function mayHaveCalls(kind: SymbolKind | null): boolean {
  return kind === null || kind === 'function' || kind === 'method' || kind === 'constructor';
}

/** Implementations exist for what can be implemented or overridden. */
export function mayHaveImplementations(kind: SymbolKind | null): boolean {
  return kind === null || kind === 'interface' || kind === 'class' || kind === 'method' || kind === 'type' || kind === 'property';
}
