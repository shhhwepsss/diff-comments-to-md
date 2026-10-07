import { describe, expect, it } from 'vitest';
import type { ConversationList, ConversationThread, ConversationTimelineItem } from '../api/types';
import { appendPage, loadMoreIndex, mergeFeed, threadAnchor, threadLines, threadRef } from './feed';

function remark(id: string, at: string): ConversationTimelineItem {
  return { kind: 'comment', id, url: `u/${id}`, author: 'anna', body: id, at };
}

function thread(id: string, at: string, patch: Partial<ConversationThread> = {}): ConversationThread {
  return {
    id,
    path: 'src/a.ts',
    line: 42,
    startLine: null,
    originalLine: 40,
    resolved: false,
    outdated: false,
    hunk: [' a', '+b'],
    at,
    comments: [{ id: `${id}-1`, url: `u/${id}`, author: 'dima', body: 'Нужен cap', at }],
    more: 0,
    ...patch,
  };
}

function list<T extends { at: string }>(items: T[], done: boolean, through?: string | null): ConversationList<T> {
  return { items, cursor: done ? null : 'c', done, through: through === undefined ? (items[items.length - 1]?.at ?? null) : through };
}

const keys = (feed: { items: { key: string }[] }) => feed.items.map((i) => i.key);

describe('mergeFeed', () => {
  it('merges both lists by time when both are read to the end', () => {
    const feed = mergeFeed(list([remark('c1', '01'), remark('c2', '04')], true), list([thread('t1', '02'), thread('t2', '05')], true));
    expect(keys(feed)).toEqual(['c1', 't1', 'c2', 't2']);
    expect(feed.held).toBe(0);
    expect(feed.done).toBe(true);
  });

  it('holds back threads past what the timeline has been read through', () => {
    // The timeline's next page may still bring a comment from 03 or 04.
    const feed = mergeFeed(list([remark('c1', '01'), remark('c2', '02')], false), list([thread('t1', '02'), thread('t2', '05')], true));
    expect(keys(feed)).toEqual(['c1', 'c2', 't1']);
    expect(feed.held).toBe(1);
    expect(feed.done).toBe(false);
  });

  it('holds back comments past what the threads have been read through', () => {
    const feed = mergeFeed(list([remark('c1', '01'), remark('c2', '09')], true), list([thread('t1', '03')], false));
    expect(keys(feed)).toEqual(['c1', 't1']);
    expect(feed.held).toBe(1);
  });

  it('shows everything once the list behind is read to the end', () => {
    const timeline = list([remark('c1', '01'), remark('c2', '09')], true);
    expect(keys(mergeFeed(timeline, list([thread('t1', '03')], true)))).toEqual(['c1', 't1', 'c2']);
  });

  it('counts a page the server emptied (bare reviews) as read through its last entry', () => {
    // Nothing to show from the timeline page, but it was read through 06.
    const feed = mergeFeed(list<ConversationTimelineItem>([], false, '06'), list([thread('t1', '03'), thread('t2', '07')], true));
    expect(keys(feed)).toEqual(['t1']);
    expect(feed.held).toBe(1);
  });

  it('shows nothing of the other list while a list has not been read at all', () => {
    const feed = mergeFeed(list<ConversationTimelineItem>([], false, null), list([thread('t1', '03')], true));
    expect(keys(feed)).toEqual([]);
    expect(feed.held).toBe(1);
  });

  it('puts a review before the thread it brought at the same moment', () => {
    const review: ConversationTimelineItem = { ...remark('r1', '05'), kind: 'review', state: 'CHANGES_REQUESTED' };
    expect(keys(mergeFeed(list([review], true), list([thread('t1', '05')], true)))).toEqual(['r1', 't1']);
  });
});

describe('loadMoreIndex', () => {
  it('is the entry at 90% of what is shown', () => {
    expect(loadMoreIndex(50)).toBe(45);
    expect(loadMoreIndex(100)).toBe(90);
  });

  it('stays inside a short feed', () => {
    expect(loadMoreIndex(1)).toBe(0);
    expect(loadMoreIndex(3)).toBe(2);
  });

  it('is -1 with nothing to scroll to', () => {
    expect(loadMoreIndex(0)).toBe(-1);
  });
});

describe('appendPage', () => {
  it('adds the page and takes its cursor', () => {
    const next = appendPage(list([remark('c1', '01')], false), { items: [remark('c2', '02')], cursor: null, done: true, through: '02' });
    expect(next.items.map((i) => i.id)).toEqual(['c1', 'c2']);
    expect(next.done).toBe(true);
    expect(next.through).toBe('02');
  });

  it('leaves the list alone when the page was not asked for', () => {
    const before = list([remark('c1', '01')], true);
    expect(appendPage(before, undefined)).toBe(before);
  });
});

describe('a comment under a thread', () => {
  it('is anchored to the thread lines in the current diff', () => {
    expect(threadAnchor(thread('t', '01'))).toEqual({ file: 'src/a.ts', startLine: 42, endLine: 42 });
    expect(threadAnchor(thread('t', '01', { startLine: 40 }))).toEqual({ file: 'src/a.ts', startLine: 40, endLine: 42 });
  });

  it('is anchored to the file alone when the thread is outdated', () => {
    expect(threadAnchor(thread('t', '01', { line: null, outdated: true }))).toEqual({ file: 'src/a.ts', startLine: null, endLine: null });
    expect(threadLines(thread('t', '01', { line: null }))).toBeNull();
  });

  it('names its lines', () => {
    expect(threadLines(thread('t', '01'))).toBe('строка 42');
    expect(threadLines(thread('t', '01', { startLine: 40 }))).toBe('строки 40–42');
  });

  it('quotes the whole exchange, replies with their authors', () => {
    const t = thread('t', '01');
    t.comments.push({ id: 't-2', url: 'u/2', author: 'misha', body: 'Ограничу 15 минутами', at: '02' });
    expect(threadRef(t)).toEqual({
      kind: 'thread',
      id: 't',
      author: 'dima',
      url: 'u/t',
      quote: 'Нужен cap\n\n@misha: Ограничу 15 минутами',
      code: ' a\n+b',
    });
  });
});
