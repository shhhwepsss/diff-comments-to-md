import { describe, expect, it } from 'vitest';
import type { LspLocation } from '../api/types';
import {
  dirName,
  fileName,
  groupLocations,
  kindFromHover,
  kindFromLsp,
  mayHaveCalls,
  mayHaveImplementations,
  plural,
  previewParts,
} from './navList';

const at = (path: string | null, line: number, character = 0, extra: Partial<LspLocation> = {}): LspLocation => ({
  path,
  line,
  character,
  endLine: line,
  endCharacter: character + 3,
  ...(path === null ? { external: '/usr/lib/node/lib.d.ts' } : {}),
  ...extra,
});

describe('groupLocations', () => {
  it('groups by file: the starting file first, then by path, outside the repository last', () => {
    const { groups, total } = groupLocations(
      [at('src/z.ts', 4), at(null, 1), at('src/a.ts', 9), at('src/main.ts', 2), at('src/a.ts', 3)],
      'src/main.ts',
    );
    expect(groups.map((g) => g.path ?? g.external)).toEqual(['src/main.ts', 'src/a.ts', 'src/z.ts', '/usr/lib/node/lib.d.ts']);
    expect(total).toBe(5);
  });

  it('sorts places in a file by line and column', () => {
    const { groups } = groupLocations([at('a.ts', 5, 9), at('a.ts', 5, 2), at('a.ts', 1, 7)]);
    expect(groups[0].items.map((l) => [l.line, l.character])).toEqual([
      [1, 7],
      [5, 2],
      [5, 9],
    ]);
  });

  it('lists the same place once', () => {
    const { groups, total } = groupLocations([at('a.ts', 1, 4), at('a.ts', 1, 4), at('a.ts', 2, 4)]);
    expect(total).toBe(2);
    expect(groups[0].items).toHaveLength(2);
  });

  it('keeps different files outside the repository apart', () => {
    const { groups } = groupLocations([at(null, 0, 0, { external: '/x/a.d.ts' }), at(null, 0, 0, { external: '/x/b.d.ts' })]);
    expect(groups.map((g) => g.external)).toEqual(['/x/a.d.ts', '/x/b.d.ts']);
  });

  it('gives no groups for no places', () => {
    expect(groupLocations([])).toEqual({ groups: [], total: 0 });
  });
});

describe('previewParts', () => {
  it('marks the symbol, counting from where the preview starts in its line', () => {
    const l = at('a.ts', 3, 20, { endCharacter: 26, preview: { text: 'return helper();', start: 13 } });
    expect(previewParts(l)).toEqual([
      { text: 'return ', hit: false },
      { text: 'helper', hit: true },
      { text: '();', hit: false },
    ]);
  });

  it('marks to the end of the line when the range goes on to the next one', () => {
    const l = at('a.ts', 0, 6, { endLine: 2, endCharacter: 1, preview: { text: 'class A {', start: 0 } });
    expect(previewParts(l)).toEqual([
      { text: 'class ', hit: false },
      { text: 'A {', hit: true },
    ]);
  });

  it('clips a range outside the preview and has nothing for no preview', () => {
    expect(previewParts(at('a.ts', 0, 50, { endCharacter: 60, preview: { text: 'short', start: 0 } }))).toEqual([{ text: 'short', hit: false }]);
    expect(previewParts(at('a.ts', 0, 1, { preview: null }))).toEqual([]);
  });
});

describe('words', () => {
  it('agrees the noun with the number', () => {
    expect(plural(1, 'ссылка', 'ссылки', 'ссылок')).toBe('1 ссылка');
    expect(plural(3, 'ссылка', 'ссылки', 'ссылок')).toBe('3 ссылки');
    expect(plural(11, 'ссылка', 'ссылки', 'ссылок')).toBe('11 ссылок');
    expect(plural(21, 'ссылка', 'ссылки', 'ссылок')).toBe('21 ссылка');
    expect(plural(112, 'ссылка', 'ссылки', 'ссылок')).toBe('112 ссылок');
  });

  it('splits a path into folder and name', () => {
    expect([dirName('src/util/a.ts'), fileName('src/util/a.ts')]).toEqual(['src/util/', 'a.ts']);
    expect([dirName('a.ts'), fileName('a.ts')]).toEqual(['', 'a.ts']);
  });
});

describe('symbol kinds', () => {
  it('reads the kind from a TypeScript hover', () => {
    expect(kindFromHover('(method) DiffStore.load(path: string): Promise<string>')).toBe('method');
    expect(kindFromHover('function formatSize(bytes: number): string')).toBe('function');
    expect(kindFromHover('class DiffStore')).toBe('class');
    expect(kindFromHover('(alias) function formatSize(bytes: number): string')).toBe('function');
    expect(kindFromHover('(alias) interface DiffSource\nimport DiffSource')).toBe('interface');
    expect(kindFromHover('interface DiffSource')).toBe('interface');
    expect(kindFromHover('const store: DiffStore')).toBe('constant');
    expect(kindFromHover('let n: number')).toBe('variable');
    expect(kindFromHover('(property) DiffSource.id: string')).toBe('property');
    expect(kindFromHover('(parameter) path: string')).toBe('parameter');
    expect(kindFromHover('type Id = string')).toBe('type');
    expect(kindFromHover('something else')).toBeNull();
    expect(kindFromHover(undefined)).toBeNull();
  });

  it('maps LSP SymbolKind numbers', () => {
    expect([kindFromLsp(12), kindFromLsp(6), kindFromLsp(5), kindFromLsp(999), kindFromLsp(null)]).toEqual(['function', 'method', 'class', null, null]);
  });

  it('offers calls for functions and implementations for what can be implemented, and both when unsure', () => {
    expect([mayHaveCalls('function'), mayHaveCalls('method'), mayHaveCalls('interface'), mayHaveCalls('constant'), mayHaveCalls(null)]).toEqual([
      true,
      true,
      false,
      false,
      true,
    ]);
    expect([mayHaveImplementations('interface'), mayHaveImplementations('function'), mayHaveImplementations(null)]).toEqual([true, false, true]);
  });
});
