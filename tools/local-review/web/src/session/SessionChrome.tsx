import { useEffect } from 'react';
import { Button, IconButton } from '@primer/react';
import { ChevronLeftIcon, ChevronRightIcon } from '@primer/octicons-react';
import { isTypingTarget, matchesEvent } from '../lib/keybindings';
import { portalOpen } from '../lib/portal';
import { useOptionalReview } from '../review/ReviewContext';
import { neighbourIndex } from './sessionLogic';
import { useSession } from './sessionContext';
import './session.css';

/**
 * Zen has no header, so the session's neighbours get a small pill at the
 * bottom of the screen: ‹ #n · i/N ›. Faint until the pointer is on it, and
 * nothing else of the session shows in Zen.
 */
export function SessionZenPill() {
  const { session, index, go } = useSession();
  if (!session || index < 0) return null;
  const prev = neighbourIndex(session, index, -1);
  const next = neighbourIndex(session, index, 1);
  return (
    <div className="rv-sess-pill" role="group" aria-label="Сессия ревью">
      <IconButton
        icon={ChevronLeftIcon}
        size="small"
        variant="invisible"
        aria-label="Предыдущий PR сессии"
        disabled={prev === null}
        onClick={() => prev !== null && go(prev)}
      />
      <span className="rv-sess-pill__text">
        #{session.prs[index].number} · {index + 1}/{session.prs.length}
      </span>
      <IconButton
        icon={ChevronRightIcon}
        size="small"
        variant="invisible"
        aria-label="Следующий PR сессии"
        disabled={next === null}
        onClick={() => next !== null && go(next)}
      />
    </div>
  );
}

/** Under «Конец диффа»: the diff is read to its end, the next PR of the session is one click away. */
export function SessionNextButton() {
  const { session, index, go } = useSession();
  if (!session || index < 0) return null;
  const next = neighbourIndex(session, index, 1);
  if (next === null) return null;
  return (
    <div className="rv-sess-next">
      <Button onClick={() => go(next)}>Следующий PR сессии: #{session.prs[next].number} →</Button>
    </div>
  );
}

/**
 * The shortcuts for the neighbours of the PR on screen. Like the other
 * global ones they keep out of text fields and dialogs, and the key stays the
 * browser's when there is no neighbour to go to.
 */
export function SessionKeys({ prevKey, nextKey }: { prevKey: string; nextKey: string }) {
  const { step } = useSession();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target) || portalOpen()) return;
      const delta = matchesEvent(prevKey, e) ? -1 : matchesEvent(nextKey, e) ? 1 : 0;
      if (delta && step(delta)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prevKey, nextKey, step]);
  return null;
}

/**
 * Keeps the session's counts of the open PR equal to what its review holds.
 * The server's counts were read when the PR was opened; comments written or
 * deleted since (a single comment, «Очистить всё…») change them under the
 * reviewer's hands, and the menu, the list and the cleanup dialog read these.
 * Comments predate the session by their `createdAt`, the rule the server uses.
 */
export function SessionCountsSync() {
  const { session, index, counts, patchCounts } = useSession();
  const review = useOptionalReview();
  const comments = review?.state ? review.comments : null;
  useEffect(() => {
    if (!session || index < 0 || !comments) return;
    const number = session.prs[index].number;
    const limit = Date.parse(session.startedAt);
    const live = { total: comments.length, old: comments.filter((c) => Date.parse(c.createdAt) < limit).length };
    const known = counts[number];
    if (!known || known.total !== live.total || known.old !== live.old) patchCounts(number, live);
  }, [session, index, comments, counts, patchCounts]);
  return null;
}
