import type { CommentRef, ConversationList, ConversationRemark, ConversationThread, ConversationTimelineItem } from '../api/types';

// The conversation page shows one feed, GitHub keeps two lists: the timeline
// (comments, reviews) and the review threads, each read a page at a time with
// its own cursor. Both come oldest first, so the feed is their merge — up to
// the moment the list that is behind has been read through. Anything of the
// other list past that moment is held back: the next page of the list behind
// may still bring something that belongs before it.

export type FeedItem =
  | { kind: 'remark'; key: string; at: string; item: ConversationTimelineItem }
  | { kind: 'thread'; key: string; at: string; thread: ConversationThread };

export type Feed = {
  items: FeedItem[];
  /** Loaded but not shown yet: past what the other list has been read through. */
  held: number;
  /** Neither list has a next page. */
  done: boolean;
};

type Timeline = ConversationList<ConversationTimelineItem>;
type Threads = ConversationList<ConversationThread>;

/** How far a list has been read; null once it is read to the end. */
function bound(list: { done: boolean; through: string | null }): string | null {
  if (list.done) return null;
  // Not read to the end and nothing read yet: nothing of the other list may show.
  return list.through ?? '';
}

export function mergeFeed(timeline: Timeline, threads: Threads): Feed {
  const timelineBound = bound(timeline);
  const threadsBound = bound(threads);
  // An entry waits for the *other* list: its own is in order by construction.
  const remarks = timeline.items.filter((i) => threadsBound === null || i.at <= threadsBound);
  const shownThreads = threads.items.filter((t) => timelineBound === null || t.at <= timelineBound);
  const items: FeedItem[] = [
    ...remarks.map((item) => ({ kind: 'remark' as const, key: item.id, at: item.at, item })),
    ...shownThreads.map((thread) => ({ kind: 'thread' as const, key: thread.id, at: thread.at, thread })),
  ];
  // Stable: at the same moment a review comes before the threads it brought.
  items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return {
    items,
    held: timeline.items.length + threads.items.length - items.length,
    done: timeline.done && threads.done,
  };
}

/** The share of the loaded feed that has to be scrolled through before the next page is asked for. */
export const LOAD_MORE_AT = 0.9;

/**
 * The entry whose arrival on screen asks for the next page: the one at 90% of
 * what is shown. -1 with nothing shown — then there is nothing to scroll to,
 * and the page is asked for at once.
 */
export function loadMoreIndex(count: number): number {
  if (count <= 0) return -1;
  return Math.min(count - 1, Math.floor(count * LOAD_MORE_AT));
}

/** A second page appended to what is already loaded; the newer page says where the list stands. */
export function appendPage<T>(list: ConversationList<T>, page: ConversationList<T> | undefined): ConversationList<T> {
  if (!page) return list;
  return { items: [...list.items, ...page.items], cursor: page.cursor, done: page.done, through: page.through ?? list.through };
}

export const EMPTY_LIST = { items: [], cursor: null, done: true, through: null };

/**
 * What a comment written under a thread answers: the whole exchange, so the
 * agent reads the reply that changed the request along with the request.
 */
export function threadRef(thread: ConversationThread): CommentRef {
  const [first, ...replies] = thread.comments;
  const quote = [first.body.trim(), ...replies.map((r) => `@${r.author}: ${r.body.trim()}`)].join('\n\n');
  return { kind: 'thread', id: thread.id, author: first.author, url: first.url, quote, code: thread.hunk.join('\n') };
}

export function remarkRef(kind: 'comment' | 'review' | 'description', remark: ConversationRemark): CommentRef {
  return { kind, id: remark.id, author: remark.author, url: remark.url, quote: remark.body.trim() };
}

/**
 * Where a comment under a thread is anchored: the thread's lines in the PR's
 * current diff. An outdated thread has none, and the comment is on the file.
 */
export function threadAnchor(thread: ConversationThread): { file: string; startLine: number | null; endLine: number | null } {
  if (thread.line === null) return { file: thread.path, startLine: null, endLine: null };
  return { file: thread.path, startLine: thread.startLine ?? thread.line, endLine: thread.line };
}

/** «строка 42», «строки 41–42», or null for an outdated thread. */
export function threadLines(thread: ConversationThread): string | null {
  if (thread.line === null) return null;
  const start = thread.startLine ?? thread.line;
  return start === thread.line ? `строка ${thread.line}` : `строки ${start}–${thread.line}`;
}
