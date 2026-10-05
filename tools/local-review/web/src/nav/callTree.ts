import type { LspCall, LspCallNode } from '../api/types';

// The call hierarchy of the navigation panel as data: nodes, which of them
// are open, which are being asked about. A node's children are unknown until
// it is first opened — each level is one request (incomingCalls or
// outgoingCalls), made only when someone opens it. Pure and immutable, so
// the panel just renders what this returns.

export type TreeNode = {
  id: string;
  parent: string | null;
  depth: number;
  node: LspCallNode;
  /** The calls this node stands for (in the caller's file); empty for a root. */
  sites: LspCall['sites'];
  /** null: not asked yet. */
  children: string[] | null;
  expanded: boolean;
  loading: boolean;
  error: string | null;
  /** The same function as an ancestor: opening it would repeat the branch above. */
  recursive: boolean;
};

export type CallTree = { nodes: Readonly<Record<string, TreeNode>>; roots: readonly string[] };

export const EMPTY_TREE: CallTree = { nodes: {}, roots: [] };

/** One function, wherever it is met: its place and name. */
function symbolKey(n: LspCallNode): string {
  return `${n.path ?? n.external ?? ''}:${n.line}:${n.character}:${n.name}`;
}

/** The functions the hierarchy starts from (prepareCallHierarchy), collapsed. */
export function treeFromRoots(items: readonly LspCallNode[]): CallTree {
  const nodes: Record<string, TreeNode> = {};
  const roots = items.map((node, i) => {
    const id = `r${i}`;
    nodes[id] = { id, parent: null, depth: 0, node, sites: [], children: null, expanded: false, loading: false, error: null, recursive: false };
    return id;
  });
  return { nodes, roots };
}

function update(tree: CallTree, id: string, patch: Partial<TreeNode>): CallTree {
  const n = tree.nodes[id];
  if (!n) return tree;
  return { ...tree, nodes: { ...tree.nodes, [id]: { ...n, ...patch } } };
}

/** Can be opened: not known to be empty, and not a repeat of an ancestor. */
export function expandable(n: TreeNode): boolean {
  return !n.recursive && !(n.children !== null && n.children.length === 0);
}

/**
 * Open or close a node. `load` says the node was opened with its children
 * unknown: the caller asks the server, then calls `setChildren` or `setError`.
 */
export function toggle(tree: CallTree, id: string): { tree: CallTree; load: boolean } {
  const n = tree.nodes[id];
  if (!n || !expandable(n)) return { tree, load: false };
  if (n.expanded) return { tree: update(tree, id, { expanded: false }), load: false };
  const load = (n.children === null || n.error !== null) && !n.loading;
  return { tree: update(tree, id, load ? { expanded: true, loading: true, error: null } : { expanded: true }), load };
}

/** Open a node that is closed; one already open stays so. */
export function expand(tree: CallTree, id: string): { tree: CallTree; load: boolean } {
  const n = tree.nodes[id];
  return n && !n.expanded ? toggle(tree, id) : { tree, load: false };
}

function ancestors(tree: CallTree, id: string): TreeNode[] {
  const out: TreeNode[] = [];
  let n: TreeNode | undefined = tree.nodes[id];
  while (n) {
    out.push(n);
    n = n.parent ? tree.nodes[n.parent] : undefined;
  }
  return out;
}

/** The answer for a node opened earlier: its children, each recognised if it repeats the path above. */
export function setChildren(tree: CallTree, id: string, calls: readonly LspCall[]): CallTree {
  const parent = tree.nodes[id];
  if (!parent) return tree;
  const above = new Set(ancestors(tree, id).map((n) => symbolKey(n.node)));
  const nodes: Record<string, TreeNode> = { ...tree.nodes };
  const children = calls.map((call, i) => {
    const child = `${id}/${i}`;
    nodes[child] = {
      id: child,
      parent: id,
      depth: parent.depth + 1,
      node: call.node,
      sites: call.sites,
      children: null,
      expanded: false,
      loading: false,
      error: null,
      recursive: above.has(symbolKey(call.node)),
    };
    return child;
  });
  nodes[id] = { ...parent, children, loading: false, error: null };
  return { ...tree, nodes };
}

/** The request for a node's children failed: the node says so and can be opened again to retry. */
export function setError(tree: CallTree, id: string, message: string): CallTree {
  return update(tree, id, { loading: false, error: message, expanded: true });
}

/** The rows on screen, top to bottom: roots and the children of open nodes. */
export function visibleRows(tree: CallTree): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (id: string) => {
    const n = tree.nodes[id];
    if (!n) return;
    out.push(n);
    if (n.expanded && n.children) for (const c of n.children) walk(c);
  };
  for (const r of tree.roots) walk(r);
  return out;
}

/**
 * The row that takes Tab into the tree (tabindex 0): the focused one while it
 * is on screen, else the first. A row hidden by closing an ancestor would
 * leave the tree with no way in from the keyboard.
 */
export function focusableRow(rows: readonly TreeNode[], focused: string | null): string | null {
  return (focused && rows.some((r) => r.id === focused) ? focused : rows[0]?.id) ?? null;
}

/** What a key does in the tree. */
export type TreeKeyAction = { focus?: string; toggle?: string; activate?: string };

/**
 * The keyboard of a tree view (WAI-ARIA): ↑ ↓ move, → opens a closed node or
 * steps into an open one, ← closes an open node or steps out to its parent,
 * Home / End jump to the ends, Enter goes to the place. null: not a tree key.
 */
export function treeKey(tree: CallTree, focused: string | null, key: string): TreeKeyAction | null {
  const rows = visibleRows(tree);
  if (rows.length === 0) return null;
  const at = focused ? rows.findIndex((r) => r.id === focused) : -1;
  const cur = at >= 0 ? rows[at] : null;
  switch (key) {
    case 'ArrowDown':
      return { focus: rows[Math.min(rows.length - 1, at + 1)].id };
    case 'ArrowUp':
      return { focus: rows[Math.max(0, at - 1)].id };
    case 'Home':
      return { focus: rows[0].id };
    case 'End':
      return { focus: rows[rows.length - 1].id };
    case 'ArrowRight':
      if (!cur) return { focus: rows[0].id };
      if (!cur.expanded) return expandable(cur) ? { toggle: cur.id } : {};
      return cur.children && cur.children.length > 0 ? { focus: cur.children[0] } : {};
    case 'ArrowLeft':
      if (!cur) return { focus: rows[0].id };
      if (cur.expanded) return { toggle: cur.id };
      return cur.parent ? { focus: cur.parent } : {};
    case 'Enter':
      return cur ? { activate: cur.id } : null;
    default:
      return null;
  }
}
