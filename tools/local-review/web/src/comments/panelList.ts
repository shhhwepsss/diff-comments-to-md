// Order, groups and filters of the "all comments" panel. Pure module.
//
// The order follows the export: general comments, then files in diff order
// by line, then files that are no longer in the diff. Stale comments (written
// against other code, see review/commentAge.ts) go last, in their own group.

import type { Comment } from '../api/types';

export type PanelKind = 'general' | 'file' | 'orphan' | 'stale';
export type PanelFilter = 'all' | PanelKind;
export type PanelItem = { comment: Comment; kind: PanelKind };

export const PANEL_FILTERS: { value: PanelFilter; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'file', label: 'В файлах' },
  { value: 'general', label: 'Общие' },
  { value: 'orphan', label: 'Нет в диффе' },
  { value: 'stale', label: 'Старые' },
];

export const GROUP_LABEL: Record<PanelKind, string> = {
  general: 'Общие',
  file: 'В файлах',
  orphan: 'Нет в диффе',
  stale: 'Старые',
};

const RANK: Record<PanelKind, number> = { general: 0, file: 1, orphan: 2, stale: 3 };

/**
 * `files` — paths in diff order. A general comment is about the whole review
 * and never counts as stale.
 */
export function panelItems(comments: Comment[], files: string[], isStale: (c: Comment) => boolean): PanelItem[] {
  const order = new Map(files.map((p, i) => [p, i]));
  const kindOf = (c: Comment): PanelKind => {
    if (c.file === null) return 'general';
    if (isStale(c)) return 'stale';
    return order.has(c.file) ? 'file' : 'orphan';
  };
  const fileRank = (c: Comment) => (c.file === null ? -1 : order.get(c.file) ?? files.length);
  return comments
    .map((comment) => ({ comment, kind: kindOf(comment) }))
    .sort(
      (a, b) =>
        RANK[a.kind] - RANK[b.kind] ||
        fileRank(a.comment) - fileRank(b.comment) ||
        String(a.comment.file ?? '').localeCompare(String(b.comment.file ?? '')) ||
        (a.comment.startLine ?? 0) - (b.comment.startLine ?? 0) ||
        a.comment.createdAt.localeCompare(b.comment.createdAt),
    );
}

export function filterItems(items: PanelItem[], filter: PanelFilter): PanelItem[] {
  return filter === 'all' ? items : items.filter((i) => i.kind === filter);
}

export function countByKind(items: PanelItem[]): Record<PanelFilter, number> {
  const n: Record<PanelFilter, number> = { all: items.length, general: 0, file: 0, orphan: 0, stale: 0 };
  for (const i of items) n[i.kind] += 1;
  return n;
}

/** The id `delta` steps from `current`; from nothing, the first (or last) one. */
export function stepId(items: PanelItem[], current: string | null, delta: number): string | null {
  if (!items.length) return null;
  const i = items.findIndex((x) => x.comment.id === current);
  if (i === -1) return (delta >= 0 ? items[0] : items[items.length - 1]).comment.id;
  return items[Math.max(0, Math.min(items.length - 1, i + delta))].comment.id;
}
