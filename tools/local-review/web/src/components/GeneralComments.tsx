import { useMemo, useRef, useState } from 'react';
import { Button, Dialog } from '@primer/react';
import { CommentDiscussionIcon } from '@primer/octicons-react';
import { CommentCard, CommentForm } from '../diff/CommentCard';
import { generalComments } from '../review/generalComments';
import type { Review } from '../review/ReviewContext';

/**
 * Comments about the review as a whole, like GitHub's review summary. A header
 * button (with its own count) opens a side sheet: the existing general
 * comments, each editable and deletable, and a form for a new one.
 */
export function GeneralComments({ review }: { review: Review }) {
  const [open, setOpen] = useState(false);
  // Remounting the form is what clears it after a successful save.
  const [formKey, setFormKey] = useState(0);
  const anchor = useRef<HTMLButtonElement>(null);
  const general = useMemo(() => generalComments(review.comments), [review.comments]);

  const close = () => {
    if (review.editingId && general.some((c) => c.id === review.editingId)) review.cancelEdit();
    setOpen(false);
  };

  const add = async (text: string) => {
    const saved = await review.createGeneralComment(text);
    if (saved) setFormKey((k) => k + 1);
    return saved;
  };

  return (
    <>
      <Button
        ref={anchor}
        size="small"
        leadingVisual={CommentDiscussionIcon}
        count={general.length || undefined}
        onClick={() => setOpen(true)}
      >
        Общий комментарий
      </Button>
      {open && (
        <Dialog
          title="Общие комментарии"
          subtitle="К ревью целиком, а не к строке. В экспорте идут первыми."
          position="right"
          width="large"
          returnFocusRef={anchor}
          onClose={close}
        >
          <div className="rv-general">
            {general.length === 0 && <div className="rv-hint">Общих комментариев пока нет.</div>}
            {general.map((c) => (
              <CommentCard
                key={c.id}
                comment={c}
                editing={review.editingId === c.id}
                onEdit={() => review.startEdit(c.id)}
                onCancelEdit={review.cancelEdit}
                onSave={(text) => review.updateComment(c.id, text)}
                onDelete={() => void review.deleteComment(c.id)}
              />
            ))}
            <CommentForm
              key={formKey}
              label="Новый общий комментарий"
              submitLabel="Добавить"
              onSubmit={add}
              onCancel={close}
            />
          </div>
        </Dialog>
      )}
    </>
  );
}
