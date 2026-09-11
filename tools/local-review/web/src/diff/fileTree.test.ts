import { describe, expect, it } from 'vitest';
import { buildTree } from './fileTree';

const tree = (paths: string[]) =>
  buildTree(paths, (p) => p).map(function strip(n): unknown {
    return n.type === 'dir' ? { dir: n.name, path: n.path, children: n.children.map(strip) } : n.path;
  });

describe('buildTree', () => {
  it('puts directories first, then files, both sorted', () => {
    expect(tree(['b.txt', 'src/x.js', 'a.txt'])).toEqual([{ dir: 'src', path: 'src', children: ['src/x.js'] }, 'a.txt', 'b.txt']);
  });

  it('merges single-child directory chains', () => {
    expect(tree(['tools/local-review/lib/a.js', 'tools/local-review/lib/b.js'])).toEqual([
      { dir: 'tools/local-review/lib', path: 'tools/local-review/lib', children: ['tools/local-review/lib/a.js', 'tools/local-review/lib/b.js'] },
    ]);
  });

  it('stops merging where a directory has files of its own', () => {
    expect(tree(['a/f.txt', 'a/b/g.txt'])).toEqual([
      { dir: 'a', path: 'a', children: [{ dir: 'b', path: 'a/b', children: ['a/b/g.txt'] }, 'a/f.txt'] },
    ]);
  });

  it('keeps names with spaces and Cyrillic', () => {
    expect(tree(['папка/brand new.txt'])).toEqual([{ dir: 'папка', path: 'папка', children: ['папка/brand new.txt'] }]);
  });
});
