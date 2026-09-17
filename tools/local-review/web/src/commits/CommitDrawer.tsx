import { useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { Dialog, IconButton } from '@primer/react';
import { CopyIcon, LockIcon, UnlockIcon } from '@primer/octicons-react';
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
 * "Вся история" side sheet: the full commit list. Opens locked — rows are
 * plain text (selectable/copyable, clicks do nothing) — with a button to
 * unlock and pick a commit/range directly from the list, same rules as the
 * rail (including Shift+click to extend from the current anchor).
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

  const lo = commitSel ? selLo(commitSel) : -1;
  const hi = commitSel ? selHi(commitSel) : -1;

  return (
    <Dialog title={`История ветки · ${commits.length}`} position="right" width="large" returnFocusRef={returnFocusRef} onClose={onClose}>
      <div className="cr-drawer-body">
        <div className="cr-drawer-toolbar">
          <IconButton
            icon={locked ? LockIcon : UnlockIcon}
            aria-label={locked ? 'Разблокировать выбор' : 'Заблокировать выбор'}
            aria-pressed={locked}
            title={locked ? 'Клик по строке ничего не меняет — текст можно выделять и копировать' : 'Клик по строке меняет выбор'}
            size="small"
            onClick={() => setLocked((v) => !v)}
          />
          <span className="rv-hint">{locked ? 'Выбор заблокирован' : 'Выбор разблокирован'}</span>
        </div>

        <ul className="cr-drawer-list">
          {commits.map((c, i) => {
            const on = i >= lo && i <= hi;
            const meta = (
              <div className="d-meta">
                <span>{`${c.short} · ${c.author} · ${formatCommitWhen(c.date)}`}</span>
                <IconButton
                  icon={CopyIcon}
                  aria-label="Скопировать хеш"
                  title="Скопировать хеш"
                  size="small"
                  variant="invisible"
                  onClick={(e) => {
                    e.stopPropagation();
                    void copyHash(c.sha, c.short);
                  }}
                />
              </div>
            );
            const content: ReactNode = (
              <>
                <span className="d-subj">{c.subject || '(без сообщения)'}</span>
                {c.body && <span className="d-body">{c.body}</span>}
                {meta}
              </>
            );
            const className = `drawer-item${locked ? ' locked' : ''}${on ? ' on' : ''}`;
            return (
              <li key={c.sha}>
                {locked ? (
                  <div className={className}>{content}</div>
                ) : (
                  <button type="button" className={className} onClick={(e: MouseEvent) => onRowClick(i, e.shiftKey)}>
                    {content}
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        <div className="cr-drawer-foot">{notes.join(' · ') || 'вся история ветки'}</div>
      </div>
    </Dialog>
  );
}
