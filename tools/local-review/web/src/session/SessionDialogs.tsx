import { useEffect, useMemo, useState } from 'react';
import { Checkbox, CounterLabel, Dialog, SegmentedControl, Spinner } from '@primer/react';
import { api, failureMessage } from '../api/client';
import type { Comment, SessionCounts, SessionExportScope } from '../api/types';
import { CommentCard, CommentForm } from '../diff/CommentCard';
import { announceCommentsChanged } from '../lib/commentsEvent';
import { useToast } from '../lib/toast';
import { editDraftKey, NEW_GENERAL_DRAFT } from '../review/drafts';
import { useSession } from './sessionContext';
import { cleanupRows, cleanupTotal, shortTitle } from './sessionLogic';
import './session.css';

type Props = {
  dialog: 'general' | 'export' | null;
  onCloseDialog: () => void;
  cleanup: boolean;
  onCloseCleanup: () => void;
  onCleaned: (counts: SessionCounts) => void;
};

/** The three dialogs of a session. Mounted only while a session runs; each one mounts fresh when opened. */
export function SessionDialogs({ dialog, onCloseDialog, cleanup, onCloseCleanup, onCleaned }: Props) {
  return (
    <>
      {dialog === 'general' && <GeneralDialog onClose={onCloseDialog} />}
      {dialog === 'export' && <ExportDialog onClose={onCloseDialog} />}
      {cleanup && <CleanupDialog onClose={onCloseCleanup} onCleaned={onCleaned} />}
    </>
  );
}

/**
 * Remarks for the orchestrator agent, about the whole session rather than a
 * PR. Built like the review's own general comments (components/GeneralComments):
 * the same cards and form, unsaved text kept until it is saved.
 */
function GeneralDialog({ onClose }: { onClose: () => void }) {
  const { session, drafts, refresh } = useSession();
  const toast = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  // Remounting the form is what clears it after a successful save.
  const [formKey, setFormKey] = useState(0);

  const comments = useMemo<Comment[]>(
    () => (session?.general ?? []).map((g) => ({ ...g, file: null, startLine: null, endLine: null })),
    [session],
  );

  const failed = (what: string, e: unknown) => {
    toast(failureMessage(what, e), true);
    return false;
  };

  const add = async (text: string) => {
    try {
      await api.addSessionComment(text);
      drafts.clear(NEW_GENERAL_DRAFT);
      setFormKey((k) => k + 1);
      await refresh();
      return true;
    } catch (e) {
      return failed('Не удалось добавить комментарий', e);
    }
  };

  const save = async (id: string, text: string) => {
    try {
      await api.updateSessionComment(id, text);
      drafts.clear(editDraftKey(id));
      setEditingId(null);
      await refresh();
      return true;
    } catch (e) {
      return failed('Не удалось сохранить комментарий', e);
    }
  };

  const remove = async (id: string) => {
    drafts.clear(editDraftKey(id));
    try {
      await api.deleteSessionComment(id);
      await refresh();
    } catch (e) {
      failed('Не удалось удалить комментарий', e);
    }
  };

  return (
    <Dialog
      title="Общий комментарий сессии"
      subtitle="Для оркестратора: контекст, порядок, «пингани, когда всё проверится». В экспорте — раздел «Для оркестратора»."
      position="right"
      width="large"
      onClose={onClose}
    >
      <div className="rv-general">
        {comments.length === 0 && <div className="rv-hint">Общих комментариев сессии пока нет.</div>}
        {comments.map((c) => (
          <CommentCard
            key={c.id}
            comment={c}
            editing={editingId === c.id}
            draft={drafts.get(editDraftKey(c.id))}
            onDraftChange={(text) => drafts.set(editDraftKey(c.id), text)}
            onEdit={() => setEditingId(c.id)}
            onCancelEdit={() => {
              drafts.clear(editDraftKey(c.id));
              setEditingId(null);
            }}
            onSave={(text) => save(c.id, text)}
            onDelete={() => void remove(c.id)}
          />
        ))}
        <CommentForm
          key={formKey}
          label="Новый общий комментарий сессии"
          submitLabel="Добавить"
          initial={drafts.get(NEW_GENERAL_DRAFT)}
          onChange={(text) => drafts.set(NEW_GENERAL_DRAFT, text)}
          onSubmit={add}
          onCancel={onClose}
        />
      </div>
    </Dialog>
  );
}

/**
 * The export as the server builds it — what «Скопировать» puts on the
 * clipboard and «Сгенерировать .md» writes, read-only and in monospace, so
 * nothing is handed to the orchestrator unseen.
 */
function ExportDialog({ onClose }: { onClose: () => void }) {
  const { session, index, copy, writeMd } = useSession();
  const [scope, setScope] = useState<SessionExportScope>('all');
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = session && index >= 0 ? session.prs[index] : null;
  const number = scope === 'pr' ? current?.number : undefined;

  useEffect(() => {
    let alive = true;
    setText(null);
    setError(null);
    api
      .sessionExportText(scope, number)
      .then((t) => alive && setText(typeof t === 'string' ? t : String(t)))
      .catch((e) => alive && setError(failureMessage('Не удалось собрать экспорт', e)));
    return () => {
      alive = false;
    };
  }, [scope, number]);

  const scopes: { value: SessionExportScope; label: string }[] = [{ value: 'all', label: 'Вся сессия' }];
  if (current) scopes.push({ value: 'pr', label: `Только #${current.number}` });

  return (
    <Dialog
      title="Предпросмотр экспорта"
      width="xlarge"
      onClose={onClose}
      footerButtons={[
        { buttonType: 'default', content: 'Сгенерировать .md', onClick: () => void writeMd(scope) },
        {
          buttonType: 'primary',
          content: 'Скопировать',
          disabled: text === null,
          onClick: () => {
            void copy(scope);
            onClose();
          },
        },
      ]}
    >
      <div className="rv-sess-export">
        <SegmentedControl aria-label="Что копировать" size="small" onChange={(i) => setScope(scopes[i].value)}>
          {scopes.map((s) => (
            <SegmentedControl.Button key={s.value} selected={s.value === scope}>
              {s.label}
            </SegmentedControl.Button>
          ))}
        </SegmentedControl>
        {error ? (
          <div className="rv-hint rv-sess-export__error">{error}</div>
        ) : text === null ? (
          <Spinner size="small" />
        ) : (
          <pre className="rv-sess-export__text" tabIndex={0} aria-label="Текст экспорта">
            {text}
          </pre>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Comments that were on the session's PRs before it began would go into its
 * export with the new ones. Everything is ticked, and the reviewer unticks
 * what to keep; only comments older than the session can be deleted here.
 */
function CleanupDialog({ onClose, onCleaned }: { onClose: () => void; onCleaned: (counts: SessionCounts) => void }) {
  const { session, counts } = useSession();
  const toast = useToast();
  const [kept, setKept] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const rows = useMemo(() => (session ? cleanupRows(session, counts) : []), [session, counts]);
  const total = cleanupTotal(rows, kept);

  // Nothing left to ask about (deleted in another tab): there is no dialog to show.
  useEffect(() => {
    if (!busy && rows.length === 0) onClose();
  }, [busy, rows.length, onClose]);

  const toggle = (n: number) => {
    const next = new Set(kept);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    setKept(next);
  };

  const remove = async () => {
    setBusy(true);
    try {
      const res = await api.cleanupSession(rows.filter((r) => !kept.has(r.number)).map((r) => r.number));
      onCleaned(res.counts);
      announceCommentsChanged();
      toast(`Удалено комментариев: ${res.removed}`);
      onClose();
    } catch (e) {
      toast(failureMessage('Не удалось удалить комментарии', e), true);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Остались комментарии прошлой сессии"
      subtitle="Если их оставить, они уйдут в новый экспорт вместе с новыми."
      width="large"
      onClose={onClose}
      footerButtons={[
        { buttonType: 'default', content: 'Оставить', onClick: onClose, autoFocus: true },
        { buttonType: 'danger', content: `Удалить отмеченное (${total})`, disabled: total === 0 || busy, onClick: () => void remove() },
      ]}
    >
      <div className="rv-sess-cleanup">
        {rows.map((row) => (
          <label key={row.number} className="rv-sess-cleanup__row">
            <Checkbox checked={!kept.has(row.number)} onChange={() => toggle(row.number)} />
            <span className="rv-sess-cleanup__title">
              #{row.number} {shortTitle(row.title)}
            </span>
            <CounterLabel>{row.old}</CounterLabel>
          </label>
        ))}
        <p className="rv-hint">Удаляются только комментарии, оставленные до начала этой сессии. Отменить нельзя.</p>
      </div>
    </Dialog>
  );
}
