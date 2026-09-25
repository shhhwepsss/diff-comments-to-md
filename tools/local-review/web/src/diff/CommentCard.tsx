import { useEffect, useRef, useState } from 'react';
import { Button, IconButton, Textarea } from '@primer/react';
import { PencilIcon, TrashIcon } from '@primer/octicons-react';
import type { Comment } from '../api/types';
import { anchorLabel, formatDate } from '../lib/format';
import './comments.css';

type FormProps = {
  label?: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (text: string) => Promise<boolean>;
  onCancel: () => void;
  /** Every keystroke, for callers that keep the unsaved text somewhere. */
  onChange?: (text: string) => void;
};

/** Textarea + Save/Cancel. Ctrl/Cmd+Enter saves, Esc cancels. */
export function CommentForm({ label, initial = '', submitLabel, onSubmit, onCancel, onChange }: FormProps) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onSubmit(text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rv-comment-form">
      {label && <div className="rv-comment-form__label">{label}</div>}
      <Textarea
        ref={area}
        block
        resize="vertical"
        rows={3}
        placeholder="Комментарий…"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange?.(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="rv-comment-form__actions">
        <span className="rv-hint">Ctrl+Enter — сохранить, Esc — отмена</span>
        <Button size="small" onClick={onCancel}>
          Отмена
        </Button>
        <Button size="small" variant="primary" onClick={() => void submit()} loading={busy}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

type CardProps = {
  comment: Comment;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (text: string) => Promise<boolean>;
  onDelete: () => void;
  /** Unsaved edit text to resume from instead of the saved text. */
  draft?: string;
  onDraftChange?: (text: string) => void;
  /** Written against other code: what it was written against («к a41f9c2»). */
  stale?: string | null;
  /** The one the comments panel points at. */
  current?: boolean;
  /** A click anywhere on the card (the panel follows it). */
  onSelect?: () => void;
};

/** «к a41f9c2 · строка могла сместиться» — the comment was written against other code. */
export function StaleChip({ target }: { target: string }) {
  return (
    <span className="commit-chip commit-chip--stale" title="Комментарий написан к другому состоянию кода: строка могла сместиться">
      {target} · строка могла сместиться
    </span>
  );
}

export function CommentCard({
  comment,
  editing,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
  draft,
  onDraftChange,
  stale = null,
  current = false,
  onSelect,
}: CardProps) {
  const cls = 'rv-comment' + (stale !== null ? ' rv-comment--stale' : '') + (current ? ' is-current' : '');
  return (
    <div className={cls} id={`rv-comment-${comment.id}`} onClick={onSelect}>
      <div className="rv-comment__head">
        <span className="rv-comment__anchor">{anchorLabel(comment)}</span>
        {stale !== null ? (
          <StaleChip target={stale} />
        ) : comment.commit && (
          <span className="commit-chip" title="Коммит, в котором написан комментарий">
            {comment.commit.from === comment.commit.to ? comment.commit.to : `${comment.commit.from}..${comment.commit.to}`}
          </span>
        )}
        <span className="rv-comment__date" title={`создан ${formatDate(comment.createdAt)}`}>
          {formatDate(comment.updatedAt)}
        </span>
        {!editing && (
          <span className="rv-comment__actions">
            <IconButton icon={PencilIcon} aria-label="Изменить" size="small" variant="invisible" onClick={onEdit} />
            <IconButton icon={TrashIcon} aria-label="Удалить" size="small" variant="invisible" onClick={onDelete} />
          </span>
        )}
      </div>
      {editing ? (
        <CommentForm
          initial={draft ?? comment.text}
          submitLabel="Сохранить"
          onSubmit={onSave}
          onCancel={onCancelEdit}
          onChange={onDraftChange}
        />
      ) : (
        <div className="rv-comment__body">{comment.text}</div>
      )}
    </div>
  );
}
