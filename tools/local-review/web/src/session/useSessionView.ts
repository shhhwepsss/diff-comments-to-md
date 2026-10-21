import { useMemo } from 'react';
import { useSession, type SessionApi } from './sessionContext';
import { doneCount } from './sessionLogic';

export type SessionView = SessionApi & {
  /** PRs the reviewer is done with: commented on in this session, or marked. */
  done: number;
};

/**
 * The session as the screens that show its PRs need it. The counts are kept
 * current by SessionCountsSync, so what is listed is what the review holds.
 */
export function useSessionView(): SessionView {
  const api = useSession();
  const { session, counts } = api;
  return useMemo(() => ({ ...api, done: session ? doneCount(session, counts) : 0 }), [api, session, counts]);
}
