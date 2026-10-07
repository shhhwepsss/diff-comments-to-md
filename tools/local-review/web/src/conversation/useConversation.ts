import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { ConversationList, ConversationMeta, ConversationThread, ConversationTimelineItem, Descriptor } from '../api/types';
import { appendPage, EMPTY_LIST, mergeFeed, type Feed } from './feed';

type Loaded = {
  meta: ConversationMeta;
  timeline: ConversationList<ConversationTimelineItem>;
  threads: ConversationList<ConversationThread>;
};

export type Conversation = {
  /** idle: the page was never opened, so GitHub was never asked. */
  status: 'idle' | 'loading' | 'ready' | 'error';
  meta: ConversationMeta | null;
  feed: Feed;
  /** Why the first page did not load. */
  error: string | null;
  loadingMore: boolean;
  /** Why the next page did not load; what is on screen stays. */
  moreError: string | null;
  loadMore: () => void;
  /** The first page again; `fresh` goes past the server's cache. */
  reload: (fresh: boolean) => void;
};

const NO_FEED: Feed = { items: [], held: 0, done: true };

/**
 * A PR's conversation, read from GitHub only once the page is opened
 * (`active`) and then kept for as long as the review is: going back to the
 * diff and returning costs nothing. `reloadNonce` is «Перечитать PR».
 */
export function useConversation(descriptor: Descriptor, active: boolean, reloadNonce: number): Conversation {
  const [status, setStatus] = useState<Conversation['status']>('idle');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  // The conversation belongs to the PR, not to the commit range on screen.
  const descriptorRef = useRef(descriptor);
  descriptorRef.current = descriptor;
  // Every request is numbered: an answer that is not the latest one is dropped.
  const seq = useRef(0);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const busyMore = useRef(false);

  const reload = useCallback((fresh: boolean) => {
    const id = ++seq.current;
    busyMore.current = false;
    setLoadingMore(false);
    setMoreError(null);
    setError(null);
    setStatus('loading');
    api
      .conversation(descriptorRef.current, {}, fresh)
      .then((page) => {
        if (id !== seq.current) return;
        if (!page.meta) throw new Error('Сервер не вернул описание PR-а');
        setLoaded({ meta: page.meta, timeline: page.timeline ?? EMPTY_LIST, threads: page.threads ?? EMPTY_LIST });
        setStatus('ready');
      })
      .catch((e) => {
        if (id !== seq.current) return;
        setError(errorMessage(e));
        setStatus('error');
      });
  }, []);

  const loadMore = useCallback(() => {
    const now = loadedRef.current;
    if (!now || busyMore.current) return;
    const timelineAfter = now.timeline.done ? null : now.timeline.cursor;
    const threadsAfter = now.threads.done ? null : now.threads.cursor;
    if (!timelineAfter && !threadsAfter) return;
    const id = seq.current;
    busyMore.current = true;
    setLoadingMore(true);
    setMoreError(null);
    api
      .conversation(descriptorRef.current, { timelineAfter, threadsAfter })
      .then((page) => {
        if (id !== seq.current) return;
        setLoaded((before) =>
          before ? { meta: before.meta, timeline: appendPage(before.timeline, page.timeline), threads: appendPage(before.threads, page.threads) } : before,
        );
      })
      .catch((e) => {
        if (id === seq.current) setMoreError(errorMessage(e));
      })
      .finally(() => {
        if (id !== seq.current) return;
        busyMore.current = false;
        setLoadingMore(false);
      });
  }, []);

  useEffect(() => {
    if (active && status === 'idle') reload(false);
  }, [active, status, reload]);

  // «Перечитать PR»: only a conversation that was opened has anything to re-read.
  const nonceSeen = useRef(reloadNonce);
  useEffect(() => {
    if (nonceSeen.current === reloadNonce) return;
    nonceSeen.current = reloadNonce;
    if (status !== 'idle') reload(true);
  }, [reloadNonce, status, reload]);

  const feed = useMemo(() => (loaded ? mergeFeed(loaded.timeline, loaded.threads) : NO_FEED), [loaded]);

  return { status, meta: loaded?.meta ?? null, feed, error, loadingMore, moreError, loadMore, reload };
}
