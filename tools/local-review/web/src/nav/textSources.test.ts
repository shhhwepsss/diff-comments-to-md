import { describe, expect, it } from 'vitest';
import type { DiffResponse, FileEntry } from '../api/types';
import { createDiffStore } from '../review/diffStore';
import { diffTexts } from './textSources';

const entry = (path: string, status = 'M'): FileEntry => ({
  path,
  status,
  kind: status,
  untracked: false,
  additions: 1,
  deletions: 0,
  comments: 0,
  fingerprint: null,
  viewed: false,
});

const diff = (path: string, newText: string | null, binary = false): DiffResponse => ({
  path,
  status: 'M',
  kind: 'M',
  hunks: [],
  binary,
  additions: 1,
  deletions: 0,
  oldText: '',
  newText,
});

describe('diffTexts', () => {
  it('the new side of each file, fetched once; deleted, binary and failed files left out', async () => {
    const asked: string[] = [];
    const store = createDiffStore(async (path) => {
      asked.push(path);
      if (path === 'bad.ts') throw new Error('нет связи');
      if (path === 'logo.png') return diff(path, null, true);
      return diff(path, `text of ${path}`);
    });
    await store.ensure('a.ts');
    const { files, skipped } = await diffTexts(store, [entry('a.ts'), entry('b.ts'), entry('gone.ts', 'D'), entry('logo.png'), entry('bad.ts')]);
    expect(files).toEqual([
      { path: 'a.ts', text: 'text of a.ts' },
      { path: 'b.ts', text: 'text of b.ts' },
    ]);
    expect(skipped).toBe(0);
    expect(asked.filter((p) => p === 'a.ts')).toHaveLength(1);
    expect(asked).not.toContain('gone.ts');
  });

  it('only the first `limit` files, and says how many were skipped', async () => {
    const store = createDiffStore(async (path) => diff(path, path));
    const { files, skipped } = await diffTexts(store, [entry('1'), entry('2'), entry('3', 'D'), entry('4')], 2);
    expect(files.map((f) => f.path)).toEqual(['1', '2']);
    expect(skipped).toBe(1);
  });
});
