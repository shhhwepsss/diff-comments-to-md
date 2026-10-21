import type { Descriptor, ReviewSession, SessionCounts, SessionMark, SessionPr } from '../api/types';

// Pure rules of a review session: which PRs the search screen picks and in
// what order they are reviewed, what state each PR of a running session is in,
// and where the neighbours are. No React, no network — the screens only draw
// what these return.

/** What the order of the picked PRs follows: when they were updated, their number, or the order of the clicks. */
export type SortKey = 'updated' | 'number' | 'manual';

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'updated', label: 'по обновлению' },
  { value: 'number', label: 'по номеру' },
  { value: 'manual', label: 'как отмечал' },
];

/** The part of a search result the picking works with. */
export type PickItem = { host: string; owner: string | null; repo: string | null; number: number; updatedAt: string };

/** Identifies a search row: a search across repositories can list the same number twice. */
export function prKey(item: Pick<PickItem, 'owner' | 'repo' | 'number'>): string {
  return `${item.owner}/${item.repo}#${item.number}`;
}

function repoOf(item: PickItem): string | null {
  return item.owner && item.repo ? `${item.host}/${item.owner}/${item.repo}` : null;
}

/**
 * Can this row be picked next to what is picked? A session is over one
 * repository, so a row with no known repository, or with another one than the
 * first pick, cannot.
 */
export function pickable(items: PickItem[], picked: string[], item: PickItem): boolean {
  const repo = repoOf(item);
  if (!repo) return false;
  const first = items.find((i) => prKey(i) === picked[0]);
  return !first || repoOf(first) === repo;
}

/** A click on a row: picked rows leave the list, the others join it at the end (which is the click order). */
export function togglePick(picked: string[], key: string): string[] {
  return picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key];
}

/**
 * The master checkbox: everything pickable goes in, or everything goes out
 * when everything already is. Rows join in the order the current sort gives, so
 * switching to «как отмечал» afterwards starts from the order the reviewer saw.
 */
export function togglePickAll(items: PickItem[], picked: string[], sort: SortKey): string[] {
  const all = sortItems(allPickable(items), sort === 'manual' ? 'updated' : sort);
  const allKeys = all.map(prKey);
  return allKeys.length > 0 && allKeys.every((k) => picked.includes(k)) ? [] : allKeys;
}

/** Every row of the repository the first pickable row is in; the rest cannot join it. */
export function allPickable<T extends PickItem>(items: T[]): T[] {
  const first = items.find((i) => repoOf(i));
  return first ? items.filter((i) => repoOf(i) === repoOf(first)) : [];
}

/** Newest update first, then highest number first; ties keep the order of the list. */
function sortItems<T extends PickItem>(items: T[], sort: Exclude<SortKey, 'manual'>): T[] {
  const indexed = items.map((item, at) => ({ item, at }));
  indexed.sort((a, b) => {
    const diff =
      sort === 'number'
        ? b.item.number - a.item.number
        : Date.parse(b.item.updatedAt || '') - Date.parse(a.item.updatedAt || '');
    return Number.isNaN(diff) || diff === 0 ? a.at - b.at : diff;
  });
  return indexed.map((i) => i.item);
}

/** The picked rows in the order a session over them would go. */
export function sessionOrder<T extends PickItem>(items: T[], picked: string[], sort: SortKey): T[] {
  const chosen = items.filter((i) => picked.includes(prKey(i)));
  if (sort === 'manual') return picked.map((k) => chosen.find((i) => prKey(i) === k)).filter((i): i is T => Boolean(i));
  return sortItems(chosen, sort);
}

/**
 * «Ревью всех найденных»: every row of the repository, in the chosen order.
 * There are no clicks to follow for rows nobody clicked, so «как отмечал» goes
 * by update time.
 */
export function allOrder<T extends PickItem>(items: T[], sort: SortKey): T[] {
  return sortItems(allPickable(items), sort === 'manual' ? 'updated' : sort);
}

/** Where a picked row stands in the session, 1-based; null for a row that is not picked. */
export function positionOf(ordered: PickItem[], item: PickItem): number | null {
  const at = ordered.findIndex((i) => prKey(i) === prKey(item));
  return at < 0 ? null : at + 1;
}

/** The title without a conventional-commit prefix: `feat(scope): text` -> `text`. */
export function shortTitle(title: string): string {
  const short = title.replace(/^\w+(\([^)]*\))?!?:\s+/, '').trim();
  return short || title;
}

/** What the reviewer has done with a PR of the session. Comments outrank marks, marks outrank having looked. */
export type PrStatus = 'comments' | 'lgtm' | 'skip' | 'seen' | 'todo';

/**
 * A PR with comments is «есть замечания» whatever was marked on it: the
 * comments are exported, so the status says so. The mark stays on record and
 * shows again if the comments are deleted.
 */
export function statusOf(session: ReviewSession, number: number, commentCount: number): PrStatus {
  if (commentCount > 0) return 'comments';
  const mark = session.marks[number];
  if (mark) return mark;
  return session.visited[number] ? 'seen' : 'todo';
}

export function statusLabel(status: PrStatus, commentCount: number): string {
  switch (status) {
    case 'comments':
      return `есть замечания · ${commentCount}`;
    case 'lgtm':
      return 'без замечаний';
    case 'skip':
      return 'пропущен';
    case 'seen':
      return 'открыт, не отмечен';
    default:
      return 'не открыт';
  }
}

/** Comments per PR number. The open PR's count is the live one: the server's was read before the last comment. */
export function commentTotals(counts: SessionCounts, live?: { number: number; total: number } | null): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [n, c] of Object.entries(counts)) out[Number(n)] = c.total;
  if (live) out[live.number] = live.total;
  return out;
}

/** PRs the reviewer is done with: commented on, or marked either way. */
export function doneCount(session: ReviewSession, totals: Record<number, number>): number {
  return session.prs.filter((pr) => {
    const status = statusOf(session, pr.number, totals[pr.number] ?? 0);
    return status !== 'seen' && status !== 'todo';
  }).length;
}

/** The index of the session's PR that this address shows; -1 when it is another PR, another repository, or no PR. */
export function sessionIndex(session: ReviewSession, descriptor: Descriptor | null): number {
  if (!descriptor || descriptor.source !== 'pr') return -1;
  if (descriptor.host !== session.host || descriptor.owner !== session.owner || descriptor.repo !== session.repo) return -1;
  return session.prs.findIndex((pr) => pr.number === descriptor.number);
}

/** The PR `delta` steps from `index`, or null at either end. */
export function neighbourIndex(session: ReviewSession, index: number, delta: number): number | null {
  const next = index + delta;
  return index >= 0 && next >= 0 && next < session.prs.length ? next : null;
}

export function descriptorOf(session: ReviewSession, pr: SessionPr): Descriptor {
  return { source: 'pr', host: session.host, owner: session.owner, repo: session.repo, number: pr.number };
}

/** The mark after a click on a mark button: the same one again takes it off. */
export function toggledMark(current: SessionMark | undefined, clicked: SessionMark): SessionMark | null {
  return current === clicked ? null : clicked;
}

/** One line of the cleanup dialog: a PR and how many comments of a previous session it holds. */
export type CleanupRow = { number: number; title: string; old: number };

export function cleanupRows(session: ReviewSession, counts: SessionCounts): CleanupRow[] {
  return session.prs
    .map((pr) => ({ number: pr.number, title: pr.title, old: counts[pr.number]?.old ?? 0 }))
    .filter((row) => row.old > 0);
}

/** The cleanup dialog ticks everything; `kept` holds the numbers the reviewer unticked. */
export function cleanupTotal(rows: CleanupRow[], kept: ReadonlySet<number>): number {
  return rows.reduce((sum, row) => sum + (kept.has(row.number) ? 0 : row.old), 0);
}

/** The badge on a search row that already has comments on it. */
export function oldBadge(count: number): string {
  return `${count} комм. из прошлой сессии`;
}
