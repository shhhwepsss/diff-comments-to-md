import { describe, expect, it } from 'vitest';
import type { LspCall, LspCallNode } from '../api/types';
import { EMPTY_TREE, expand, expandable, setChildren, setError, toggle, treeFromRoots, treeKey, visibleRows, type CallTree } from './callTree';

const fn = (name: string, path = 'src/a.ts', line = 0): LspCallNode => ({
  name,
  kind: 12,
  detail: '',
  path,
  line,
  character: 9,
  endLine: line,
  endCharacter: 9 + name.length,
  item: { name },
  token: `t-${name}`,
});

const call = (node: LspCallNode, line = 5): LspCall => ({
  node,
  sites: [{ path: node.path, line, character: 2, endLine: line, endCharacter: 8 }],
});

const ids = (t: CallTree) => visibleRows(t).map((n) => n.id);

/** helper <- top, middle; middle <- top. */
function grown(): CallTree {
  let t = treeFromRoots([fn('helper', 'src/b.ts')]);
  t = toggle(t, 'r0').tree;
  t = setChildren(t, 'r0', [call(fn('top', 'src/c.ts', 1)), call(fn('middle', 'src/c.ts', 4))]);
  return t;
}

describe('call tree: lazy expanding', () => {
  it('starts with the roots closed and their children unknown', () => {
    const t = treeFromRoots([fn('a'), fn('b')]);
    expect(ids(t)).toEqual(['r0', 'r1']);
    expect(t.nodes.r0).toMatchObject({ depth: 0, parent: null, children: null, expanded: false, loading: false });
  });

  it('asks for children on the first opening only', () => {
    const first = toggle(treeFromRoots([fn('a')]), 'r0');
    expect(first.load).toBe(true);
    expect(first.tree.nodes.r0).toMatchObject({ expanded: true, loading: true });
    const loaded = setChildren(first.tree, 'r0', [call(fn('b'))]);
    const closed = toggle(loaded, 'r0');
    expect([closed.load, closed.tree.nodes.r0.expanded]).toEqual([false, false]);
    const again = toggle(closed.tree, 'r0');
    expect([again.load, again.tree.nodes.r0.expanded]).toEqual([false, true]);
  });

  it('shows the children of open nodes, depth first', () => {
    let t = grown();
    expect(ids(t)).toEqual(['r0', 'r0/0', 'r0/1']);
    expect(t.nodes['r0/1']).toMatchObject({ depth: 1, parent: 'r0' });
    t = toggle(t, 'r0/0').tree;
    t = setChildren(t, 'r0/0', [call(fn('main', 'src/main.ts'))]);
    expect(ids(t)).toEqual(['r0', 'r0/0', 'r0/0/0', 'r0/1']);
    // Closing a parent hides the whole branch, and opening it brings it back as it was.
    t = toggle(t, 'r0').tree;
    expect(ids(t)).toEqual(['r0']);
    t = toggle(t, 'r0').tree;
    expect(ids(t)).toEqual(['r0', 'r0/0', 'r0/0/0', 'r0/1']);
  });

  it('knows a node with no children is a leaf once asked', () => {
    let t = toggle(grown(), 'r0/1').tree;
    t = setChildren(t, 'r0/1', []);
    expect(expandable(t.nodes['r0/1'])).toBe(false);
    expect(toggle(t, 'r0/1')).toEqual({ tree: t, load: false });
  });

  it('marks a function that repeats an ancestor as recursion, not to be opened', () => {
    let t = toggle(grown(), 'r0/0').tree;
    t = setChildren(t, 'r0/0', [call(fn('helper', 'src/b.ts')), call(fn('top', 'src/c.ts', 1))]);
    expect(t.nodes['r0/0/0'].recursive).toBe(true);
    expect(t.nodes['r0/0/1'].recursive).toBe(true);
    expect(toggle(t, 'r0/0/0').load).toBe(false);
    // The same name elsewhere is another function.
    t = toggle(t, 'r0/1').tree;
    t = setChildren(t, 'r0/1', [call(fn('helper', 'src/other.ts'))]);
    expect(t.nodes['r0/1/0'].recursive).toBe(false);
  });

  it('keeps a failed node open with its error, and asks again when reopened', () => {
    let t = toggle(treeFromRoots([fn('a')]), 'r0').tree;
    t = setError(t, 'r0', 'timeout');
    expect(t.nodes.r0).toMatchObject({ expanded: true, loading: false, error: 'timeout' });
    t = toggle(t, 'r0').tree;
    const retry = toggle(t, 'r0');
    expect(retry.load).toBe(true);
    expect(retry.tree.nodes.r0).toMatchObject({ loading: true, error: null });
  });

  it('expand opens a closed node and leaves an open one alone', () => {
    const t = grown();
    expect(expand(t, 'r0')).toEqual({ tree: t, load: false });
    expect(expand(t, 'r0/0').load).toBe(true);
  });

  it('ignores unknown ids', () => {
    expect(toggle(EMPTY_TREE, 'x')).toEqual({ tree: EMPTY_TREE, load: false });
    expect(setChildren(EMPTY_TREE, 'x', [])).toBe(EMPTY_TREE);
  });
});

describe('call tree: keyboard', () => {
  it('moves with ↑ ↓ Home End, staying inside the list', () => {
    const t = grown();
    expect(treeKey(t, 'r0', 'ArrowDown')).toEqual({ focus: 'r0/0' });
    expect(treeKey(t, 'r0/1', 'ArrowDown')).toEqual({ focus: 'r0/1' });
    expect(treeKey(t, 'r0', 'ArrowUp')).toEqual({ focus: 'r0' });
    expect(treeKey(t, 'r0/1', 'Home')).toEqual({ focus: 'r0' });
    expect(treeKey(t, 'r0', 'End')).toEqual({ focus: 'r0/1' });
    expect(treeKey(t, null, 'ArrowDown')).toEqual({ focus: 'r0' });
  });

  it('→ opens a closed node, then steps into the open one', () => {
    const t = grown();
    expect(treeKey(t, 'r0/0', 'ArrowRight')).toEqual({ toggle: 'r0/0' });
    expect(treeKey(t, 'r0', 'ArrowRight')).toEqual({ focus: 'r0/0' });
  });

  it('← closes an open node, then steps out to the parent', () => {
    const t = grown();
    expect(treeKey(t, 'r0', 'ArrowLeft')).toEqual({ toggle: 'r0' });
    expect(treeKey(t, 'r0/1', 'ArrowLeft')).toEqual({ focus: 'r0' });
    expect(treeKey(toggle(t, 'r0').tree, 'r0', 'ArrowLeft')).toEqual({});
  });

  it('→ does nothing on a leaf; Enter goes to the place', () => {
    let t = toggle(grown(), 'r0/1').tree;
    t = setChildren(t, 'r0/1', []);
    t = toggle(t, 'r0/1').tree; // closed again: a leaf now
    expect(treeKey(t, 'r0/1', 'ArrowRight')).toEqual({});
    expect(treeKey(t, 'r0/1', 'Enter')).toEqual({ activate: 'r0/1' });
  });

  it('leaves other keys and an empty tree alone', () => {
    expect(treeKey(grown(), 'r0', 'a')).toBeNull();
    expect(treeKey(EMPTY_TREE, null, 'ArrowDown')).toBeNull();
  });
});
