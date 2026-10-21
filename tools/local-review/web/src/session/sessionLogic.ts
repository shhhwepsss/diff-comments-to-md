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

/**
 * What the reviewer has done with a PR of the session. Comments written in
 * this session outrank a mark, a mark outranks comments left from before the
 * session, and those outrank having merely looked.
 */
export type PrStatus = 'comments' | 'lgtm' | 'skip' | 'old' | 'seen' | 'todo';

/** Comments in a PR's store, and how many of them were written before the session began. */
export type PrCount = { total: number; old: number };

/** Comments written during the session: the only ones that say the reviewer has been at work. */
export function freshCount(count: PrCount | undefined): number {
  return count ? Math.max(count.total - count.old, 0) : 0;
}

/**
 * A PR with comments of this session is «есть замечания» whatever was marked
 * on it: the comments are exported, so the status says so. Comments that
 * predate the session are not the reviewer's work of this session: they do
 * not make the PR reviewed, and the status says they are there (they are
 * exported unless deleted). A mark stays on record and shows again if the
 * comments are deleted.
 */
export function statusOf(session: ReviewSession, number: number, count: PrCount | undefined): PrStatus {
  if (freshCount(count) > 0) return 'comments';
  const mark = session.marks[number];
  if (mark) return mark;
  if ((count?.old ?? 0) > 0) return 'old';
  return session.visited[number] ? 'seen' : 'todo';
}

export function statusLabel(status: PrStatus, count: PrCount | undefined, visited = false): string {
  switch (status) {
    case 'comments':
      return `есть замечания · ${freshCount(count)}`;
    case 'lgtm':
      return 'без замечаний';
    case 'skip':
      return 'пропущен';
    case 'old':
      return `${visited ? 'открыт' : 'не открыт'} · есть старые комментарии (${count?.old ?? 0})`;
    case 'seen':
      return 'открыт, не отмечен';
    default:
      return 'не открыт';
  }
}

/** PRs the reviewer is done with: commented on in this session, or marked. */
export function doneCount(session: ReviewSession, counts: SessionCounts): number {
  return session.prs.filter((pr) => {
    const status = statusOf(session, pr.number, counts[pr.number]);
    return status === 'comments' || status === 'lgtm' || status === 'skip';
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

/** The noun after a count of PRs: «1 PR», «2 PR-а», «5 PR-ов» (the same rule as lib/export.js prCount). */
export function prCount(n: number): string {
  const last = n % 10;
  const tens = n % 100;
  if (last === 1 && tens !== 11) return `${n} PR`;
  if (last >= 2 && last <= 4 && (tens < 12 || tens > 14)) return `${n} PR-а`;
  return `${n} PR-ов`;
}

/** The same count after «из»: «из 1 PR», «из 5 PR-ов» — the genitive has no «-а». */
export function prCountOf(n: number): string {
  return n % 10 === 1 && n % 100 !== 11 ? `${n} PR` : `${n} PR-ов`;
}

/**
 * Which of the found PRs the search asks about, and since when. A PR already in
 * the running session has had comments written during it: only those older
 * than the session count as «from a previous session». Every other PR has
 * nothing but older comments, so all of them count (no `before`).
 */
export function oldCommentScopes(
  session: ReviewSession | null,
  repo: { host: string; owner: string; repo: string },
  numbers: number[],
): { before: string | undefined; numbers: number[] }[] {
  const inSession = session && session.host === repo.host && session.owner === repo.owner && session.repo === repo.repo;
  const mine = inSession ? numbers.filter((n) => session.prs.some((p) => p.number === n)) : [];
  const others = numbers.filter((n) => !mine.includes(n));
  const scopes: { before: string | undefined; numbers: number[] }[] = [];
  if (others.length) scopes.push({ before: undefined, numbers: others });
  if (mine.length && session) scopes.push({ before: session.startedAt, numbers: mine });
  return scopes;
}
