import { ActionList } from '@primer/react';
import { CheckCircleFillIcon, CircleIcon, CommentIcon, EyeIcon, SkipIcon } from '@primer/octicons-react';
import { shortTitle, statusLabel, statusOf, type PrStatus } from './sessionLogic';
import { useSessionView } from './useSessionView';

const STATUS_ICON: Record<PrStatus, typeof CommentIcon> = {
  comments: CommentIcon,
  lgtm: CheckCircleFillIcon,
  skip: SkipIcon,
  seen: EyeIcon,
  todo: CircleIcon,
};

/**
 * The session's PRs with where each stands: the list in the session menu and
 * in the pinned panel. The PR on screen is highlighted; a click opens one.
 */
export function SessionPrList({ onPick }: { onPick?: () => void }) {
  const { session, index, totals, go } = useSessionView();
  if (!session) return null;
  return (
    <ActionList className="rv-sess-list" aria-label="PR-ы сессии">
      {session.prs.map((pr, i) => {
        const total = totals[pr.number] ?? 0;
        const status = statusOf(session, pr.number, total);
        const Icon = STATUS_ICON[status];
        return (
          <ActionList.Item
            key={pr.number}
            active={i === index}
            aria-current={i === index ? 'true' : undefined}
            onSelect={() => {
              go(i);
              onPick?.();
            }}
          >
            <ActionList.LeadingVisual className={`rv-sess-status rv-sess-status--${status}`}>
              <Icon />
            </ActionList.LeadingVisual>
            <span className="rv-sess-list__title">
              #{pr.number} {shortTitle(pr.title)}
            </span>
            <ActionList.Description variant="block" className={`rv-sess-status rv-sess-status--${status}`}>
              {statusLabel(status, total)}
            </ActionList.Description>
          </ActionList.Item>
        );
      })}
    </ActionList>
  );
}
