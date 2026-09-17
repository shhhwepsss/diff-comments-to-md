// Flat paths -> a directory tree, with single-child directory chains merged
// ("src/lib" instead of "src" > "lib") the way GitHub's file tree does.

export type TreeNode<T> =
  | { type: 'dir'; name: string; path: string; children: TreeNode<T>[] }
  | { type: 'file'; name: string; path: string; item: T };

type MutableDir<T> = { dirs: Map<string, MutableDir<T>>; files: { name: string; path: string; item: T }[] };

export function buildTree<T>(items: readonly T[], pathOf: (item: T) => string): TreeNode<T>[] {
  const root: MutableDir<T> = { dirs: new Map(), files: [] };
  for (const item of items) {
    const parts = pathOf(item).split('/').filter(Boolean);
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.push({ name: parts[parts.length - 1] ?? pathOf(item), path: pathOf(item), item });
  }
  return toNodes(root, '');
}

function toNodes<T>(dir: MutableDir<T>, prefix: string): TreeNode<T>[] {
  const out: TreeNode<T>[] = [];
  const names = [...dir.dirs.keys()].sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    let child = dir.dirs.get(name)!;
    let label = name;
    // Merge chains of directories that hold nothing but one directory.
    while (child.files.length === 0 && child.dirs.size === 1) {
      const [only, next] = [...child.dirs.entries()][0];
      label = `${label}/${only}`;
      child = next;
    }
    const path = prefix ? `${prefix}/${label}` : label;
    out.push({ type: 'dir', name: label, path, children: toNodes(child, path) });
  }
  for (const f of [...dir.files].sort((a, b) => a.name.localeCompare(b.name))) {
    out.push({ type: 'file', name: f.name, path: f.path, item: f.item });
  }
  return out;
}
