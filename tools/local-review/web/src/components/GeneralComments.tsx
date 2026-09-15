import { useMemo, useRef, useState } from 'react';
import { Button, Dialog } from '@primer/react';
import { CommentDiscussionIcon } from '@primer/octicons-react';
import { CommentCard, CommentForm } from '../diff/CommentCard';
import { editDraftKey, NEW_GENERAL_DRAFT } from '../review/drafts';
import { generalComments } from '../review/generalComments';
import type { Review } from '../review/ReviewContext';

/**
 * Comments about the review as a whole, like GitHub's review summary. A header
 * button (with its own count) opens a side sheet: the existing general
 * comments, each editable and deletable, and a form for a new one.
 *
 * Closing the sheet (Esc, backdrop, close button, «Отмена» of the new form)
 * keeps unsaved text in review.drafts; only a successful save clears it. An
 * explicit cancel of an edit discards that edit.
 */
export function GeneralComments({ review }: { review: Review }) {
  const { drafts } = review;
  const [open, setOpen] = useState(false);
  // Remounting the form is what clears it after a successful save.
  const [formKey, setFormKey] = useState(0);
  const anchor = useRef<HTMLButtonElement>(null);
  const general = useMemo(() => generalComments(review.comments), [review.comments]);

  const close = () => setOpen(false);

  const add = async (text: string) => {
    const saved = await review.createGeneralComment(text);
    if (saved) {
      drafts.clear(NEW_GENERAL_DRAFT);
      setFormKey((k) => k + 1);
    }
    return saved;
  };

  const save = async (id: string, text: string) => {
    const saved = await review.updateComment(id, text);
    if (saved) drafts.clear(editDraftKey(id));
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
                draft={drafts.get(editDraftKey(c.id))}
                onDraftChange={(text) => drafts.set(editDraftKey(c.id), text)}
                onEdit={() => review.startEdit(c.id)}
                onCancelEdit={() => {
                  drafts.clear(editDraftKey(c.id));
                  review.cancelEdit();
                }}
                onSave={(text) => save(c.id, text)}
                onDelete={() => {
                  drafts.clear(editDraftKey(c.id));
                  void review.deleteComment(c.id);
                }}
              />
            ))}
            <CommentForm
              key={formKey}
              label="Новый общий комментарий"
              submitLabel="Добавить"
              initial={drafts.get(NEW_GENERAL_DRAFT)}
              onChange={(text) => drafts.set(NEW_GENERAL_DRAFT, text)}
              onSubmit={add}
              onCancel={close}
            />
          </div>
        </Dialog>
      )}
    </>
  );
}
