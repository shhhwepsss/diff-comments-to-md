import { IconButton } from '@primer/react';
import { XIcon } from '@primer/octicons-react';
import { useReview } from '../review/ReviewContext';
import './commits.css';

/**
 * Warns that the working tree has uncommitted changes while in commits mode:
 * the commit diff can't show them, so the picture may be incomplete. Local
 * repositories only — a PR has no working tree to speak of. Dismissible, and
 * in memory only (review.dirtyNoticeDismissed resets on a page reload).
 */
export function DirtyBanner() {
  const review = useReview();
  const { commitsMode, dirty, dirtyNoticeDismissed, descriptor } = review;

  if (descriptor.source !== 'local' || !commitsMode || !dirty.dirty || dirtyNoticeDismissed) return null;

  return (
    <div className="cr-notice" role="status">
      <div className="cr-notice__body">
        <strong>Есть незакоммиченные изменения</strong> — файлов: {dirty.files}. Дифф по коммитам их не показывает, поэтому
        картина может быть неполной. Переключитесь на «Рабочая копия», чтобы увидеть их.
      </div>
      <IconButton icon={XIcon} aria-label="Скрыть плашку" size="small" variant="invisible" onClick={review.dismissDirtyNotice} />
    </div>
  );
}
