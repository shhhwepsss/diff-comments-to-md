import { useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { Button, Dialog } from '@primer/react';
import { LockIcon, UnlockIcon } from '@primer/octicons-react';
import { useReview } from '../review/ReviewContext';
import { useToast } from '../lib/toast';
import { copyToClipboard } from '../lib/clipboard';
import { clickSelect, selHi, selLo } from '../review/commitSelection';
import { formatCommitWhen } from '../lib/format';
import './commits.css';

type Props = {
  onClose: () => void;
  /** The "Вся история" button that opened this — focus returns there on close. */
  returnFocusRef: RefObject<HTMLElement | null>;
};

/**
 * "Вся история" side sheet: the full commit list, newest first like git log.
 * Opens locked — rows are plain text (selectable/copyable, clicks do nothing) —
 * with a button to unlock and pick a commit/range directly from the list, same
 * rules as the rail (including Shift+click to extend from the current anchor).
 */
export function CommitDrawer({ onClose, returnFocusRef }: Props) {
  const review = useReview();
  const toast = useToast();
  const { commits, commitSel, commitsTruncated, commitsFallback, commitsBase } = review;
  const [locked, setLocked] = useState(true);

  const copyHash = async (sha: string, short: string) => {
    const ok = await copyToClipboard(sha);
    toast(ok ? `Хеш ${short} скопирован` : 'Не удалось скопировать', !ok);
  };

  const onRowClick = (i: number, shiftKey: boolean) => {
    if (locked || !commitSel) return;
    if (shiftKey) {
      review.setCommitSelection(commitSel.anchor, i);
      return;
    }
    const next = clickSelect(commitSel, commits.length, i);
    if (next !== commitSel) review.setCommitSelection(next.anchor, next.head);
  };

  const notes: string[] = [];
  if (commitsFallback) notes.push('точка ветвления не найдена — показаны последние коммиты HEAD');
  else if (commitsBase) notes.push(`от точки ветвления с ${commitsBase}`);
  if (commitsTruncated) notes.push('список обрезан — история длиннее лимита');
  notes.push(locked ? 'Режим чтения: текст можно выделять и копировать. Снимите замок, чтобы менять выбор.' : 'Клик — один коммит · Shift+клик — диапазон от текущего якоря');

  const lo = commitSel ? selLo(commitSel) : -1;
  const hi = commitSel ? selHi(commitSel) : -1;
  const order = commits.map((_, i) => i).reverse();

  return (
    <Dialog
      title={`История ветки · ${commits.length} коммитов`}
      position="right"
      width="large"
      returnFocusRef={returnFocusRef}
      onClose={onClose}
    >
      <div className="cr-drawer-body">
        <div className="cr-drawer-toolbar">
          <Button
            className="cr-lock"
            size="small"
            variant="invisible"
            leadingVisual={locked ? LockIcon : UnlockIcon}
            aria-pressed={locked}
            title={locked ? 'Выбор заблокирован: клик по коммиту ничего не меняет' : 'Выбор разблокирован: клик по коммиту меняет диапазон'}
            onClick={() => setLocked((v) => !v)}
          >
            {locked ? 'выбор заблокирован' : 'выбор разблокирован'}
          </Button>
        </div>

        <ul className="cr-drawer-list">
          {order.map((i) => {
            const c = commits[i];
            const content: ReactNode = (
              <>
                <span className="di-dot" />
                <span>
                  <span className="di-subj">{c.subject || '(без сообщения)'}</span>
                  {c.body && <p className="di-body">{c.body}</p>}
                  <span className="di-meta">{`${c.short} · ${i + 1} · ${c.author} · ${formatCommitWhen(c.date)}`}</span>
                </span>
              </>
            );
            const attrs = {
              className: `drawer-item${locked ? ' locked' : ''}`,
              'data-sel': i >= lo && i <= hi ? '1' : '0',
              'data-merge': c.merge ? '1' : undefined,
            };
            return (
              <li key={c.sha} className="di-row">
                {locked ? (
                  <div {...attrs}>{content}</div>
                ) : (
                  <button type="button" {...attrs} onClick={(e: MouseEvent) => onRowClick(i, e.shiftKey)}>
                    {content}
                  </button>
                )}
                {/* A sibling of the row, not nested in it: nested buttons are
                    invalid and would swallow the commit click. */}
                <button
                  type="button"
                  className="cr-copy"
                  title={`Скопировать ${c.short}`}
                  aria-label={`Скопировать хеш ${c.short}`}
                  onClick={() => void copyHash(c.sha, c.short)}
                >
                  &#10697;
                </button>
              </li>
            );
          })}
        </ul>

        <div className="cr-drawer-foot">{notes.join(' · ')}</div>
      </div>
    </Dialog>
  );
}
