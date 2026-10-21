import { IconButton } from '@primer/react';
import { PinSlashIcon } from '@primer/octicons-react';
import { SessionPrList } from './SessionPrList';
import { useSessionView } from './useSessionView';
import './session.css';

/**
 * The session's PRs pinned beside the diff, for a reviewer who wants the
 * whole line-up in view while going through it. Off by default: the header's
 * session menu has the same list one click away and costs no width.
 */
export function SessionPanel() {
  const view = useSessionView();
  const { session, index, pinned } = view;
  if (!session || index < 0 || !pinned) return null;
  return (
    <aside className="rv-spanel" aria-label="Сессия ревью">
      <div className="rv-spanel__head">
        <strong>
          просмотрено {view.done} из {session.prs.length}
        </strong>
        <IconButton icon={PinSlashIcon} aria-label="Открепить список" size="small" variant="invisible" onClick={() => view.setPinned(false)} />
      </div>
      <div className="rv-spanel__body">
        <SessionPrList />
      </div>
    </aside>
  );
}
