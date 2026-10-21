import { useMemo } from 'react';
import { useOptionalReview } from '../review/ReviewContext';
import { useSession, type SessionApi } from './sessionContext';
import { commentTotals, doneCount } from './sessionLogic';

export type SessionView = SessionApi & {
  /** Comments per PR number; the open PR's is the live one. */
  totals: Record<number, number>;
  /** PRs the reviewer is done with: commented on or marked. */
  done: number;
};

/**
 * The session as the screens that show its PRs need it. The server's counts
 * were read when the PR was opened; the open PR's comments change under the
 * reviewer's hands, so its count comes from the review itself, once loaded.
 */
export function useSessionView(): SessionView {
  const api = useSession();
  const review = useOptionalReview();
  const { session, counts, index } = api;
  const liveNumber = session && index >= 0 && review?.state ? session.prs[index].number : null;
  const liveTotal = review?.comments.length ?? 0;
  return useMemo(() => {
    const totals = commentTotals(counts, liveNumber === null ? null : { number: liveNumber, total: liveTotal });
    return { ...api, totals, done: session ? doneCount(session, totals) : 0 };
  }, [api, counts, session, liveNumber, liveTotal]);
}
