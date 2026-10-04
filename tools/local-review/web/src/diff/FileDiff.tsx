import { Component, lazy, memo, Suspense, useCallback, useEffect, useId, useMemo, type ReactNode, type RefObject } from 'react';
import { Button, Checkbox, CounterLabel, IconButton, SegmentedControl, Spinner, ToggleSwitch } from '@primer/react';
import { Blankslate } from '@primer/react/experimental';
import {
  AlertIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CodeIcon,
  CommentIcon,
  EyeClosedIcon,
  EyeIcon,
  FileBinaryIcon,
  FileIcon,
  QuestionIcon,
  ScreenFullIcon,
  ScreenNormalIcon,
} from '@primer/octicons-react';
import type { EditorAnchor } from '../review/ReviewContext';
import type { ActiveDiff } from '../review/diffStore';
import { failureMessage } from '../api/client';
import { useToast } from '../lib/toast';
import type { Comment, DiffResponse, FileEntry } from '../api/types';
import { DiffEditor } from './DiffEditor';
import { CommentCard, CommentForm } from './CommentCard';
import { stripFinalNewline, type LineRange } from './lineMap';
import { markdownToRender } from './markdownFile';
import { fileLayout } from './fileLayout';

// marked + DOMPurify + markdown styles load only when a file is first rendered.
const MarkdownPreview = lazy(() => import('./MarkdownPreview'));

/**
 * A chunk that fails to load throws through render, and with no boundary that
 * unmounts the whole app. Instead the pane goes back to the source diff and
 * `onError` says why.
 */
class PreviewBoundary extends Component<{ onError: (e: unknown) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }
}

function lineCount(text: string): number {
  const t = stripFinalNewline(text);
  let n = 1;
  for (let i = 0; i < t.length; i++) {
    const ch = t.charCodeAt(i);
    if (ch === 10) n++;
    else if (ch === 13) {
      n++;
      if (t.charCodeAt(i + 1) === 10) i++;
    }
  }
  return n;
}

export function Empty({ icon: Icon, title, children }: { icon: typeof FileIcon; title: string; children?: ReactNode }) {
  return (
    <div className="rv-diff-empty">
      <Blankslate spacious>
        <Blankslate.Visual>
          <Icon size={24} />
        </Blankslate.Visual>
        <Blankslate.Heading>{title}</Blankslate.Heading>
        {children && <Blankslate.Description>{children}</Blankslate.Description>}
      </Blankslate>
    </div>
  );
}

/** Why a ready diff can't be shown line by line, or null when it can. */
function unavailableReason(diff: DiffResponse): { icon: typeof FileIcon; title: string; text: string } | null {
  if (diff.binary) {
    return { icon: FileBinaryIcon, title: 'Бинарный файл', text: 'Построчный дифф недоступен — оставь комментарий к файлу.' };
  }
  if (diff.missing) {
    return { icon: QuestionIcon, title: 'Файл не найден', text: 'Файла уже нет на диске.' };
  }
  const hasTexts = diff.oldText != null || diff.newText != null;
  if (!hasTexts) {
    // A file too big to send has no texts, and no hunks either when GitHub
    // left its patch out: that is "unavailable", not "unchanged".
    if (!diff.hunks.length && !diff.textUnavailable) {
      return { icon: FileIcon, title: 'Изменений содержимого нет', text: 'Возможно, изменился только режим файла или имя.' };
    }
    return {
      icon: AlertIcon,
      title: 'Текст файла недоступен',
      text: diff.textUnavailable || 'Сервер не вернул текст файла.',
    };
  }
  if ((diff.oldText ?? '') === (diff.newText ?? '')) {
    return { icon: FileIcon, title: 'Изменений содержимого нет', text: 'Возможно, изменился только режим файла или имя.' };
  }
  return null;
}

/** Unsaved text of the open new-comment form, and the file it belongs to. */
export type FormDraft = { file: string; text: string };

/** What a file does to the review; every one is stable between renders of the caller. */
export type FileDiffActions = {
  openEditor: (anchor: EditorAnchor) => void;
  closeEditor: () => void;
  createComment: (text: string) => Promise<boolean>;
  startEdit: (id: string) => void;
  cancelEdit: () => void;
  updateComment: (id: string, text: string) => Promise<boolean>;
  deleteComment: (id: string) => Promise<void>;
  setCurrentComment: (id: string | null) => void;
  setFileViewed: (path: string, viewed: boolean) => Promise<void>;
};

export type FileDiffProps = {
  path: string;
  /** The file's row of the diff; absent for a file that is not in the diff. */
  entry: FileEntry | undefined;
  diff: ActiveDiff | null;
  /** Every comment of this file, stale ones too. */
  comments: Comment[];
  /** The open new-comment form, when it is this file's. */
  editor: EditorAnchor | null;
  /** The comment being edited, when it is one of this file's. */
  editingId: string | null;
  /** The comments panel's current comment, when the panel is open and it is one of this file's. */
  currentCommentId: string | null;
  /** A pending «scroll to this comment» for a comment of this file. */
  reveal: { comment: Comment; nonce: number } | null;
  onRevealed: (nonce: number) => void;
  /** The commit a stale comment was written against, or null for a current one. */
  staleLabel: (c: Comment) => string | null;
  draft: RefObject<FormDraft>;
  wrap: boolean;
  onWrap: (next: boolean) => void;
  /** Rendered markdown instead of the source diff. */
  rendered: boolean;
  /** The reviewer used the «Код» / «Просмотр» switch; other files may follow (renderMode.ts). */
  onRendered: (path: string, rendered: boolean) => void;
  /** This file alone changes its view: the others are not touched. */
  onFileRendered: (path: string, rendered: boolean) => void;
  commentsHidden: boolean;
  onCommentsHidden: (path: string, hidden: boolean) => void;
  externalImages: boolean;
  onExternalImages: (path: string) => void;
  zen: boolean;
  onZen: (on: boolean) => void;
  actions: FileDiffActions;
  /** Only the header is drawn. Feed only: a file shown alone is never collapsed. */
  collapsed?: boolean;
  /** Given in the feed: the header gets a collapse/expand button. */
  onCollapse?: (path: string, collapsed: boolean) => void;
  /** Height held for a diff nobody has asked for yet, so the feed keeps its length. */
  placeholderHeight?: number;
  /** Given in the feed, where a failed diff is not reloaded by reopening the file. */
  onRetry?: (path: string) => void;
};

/**
 * One file of the diff: its header and, under it, its comments and the diff
 * itself. Takes everything through props and re-renders only when they change,
 * so many of these can sit on one screen.
 */
export const FileDiff = memo(function FileDiff({
  path,
  entry,
  diff: activeDiff,
  comments,
  editor,
  editingId,
  currentCommentId,
  reveal,
  onRevealed,
  staleLabel,
  draft,
  wrap,
  onWrap,
  rendered: renderedChoice,
  onRendered,
  onFileRendered,
  commentsHidden,
  onCommentsHidden,
  externalImages,
  onExternalImages,
  zen,
  onZen,
  actions,
  collapsed = false,
  onCollapse,
  placeholderHeight,
  onRetry,
}: FileDiffProps) {
  const toast = useToast();
  const wrapLabelId = useId();

  const diff = activeDiff?.kind === 'ready' ? activeDiff.diff : null;
  const reason = diff ? unavailableReason(diff) : null;
  const showsEditor = Boolean(diff && !reason);
  const docLines = showsEditor && diff ? lineCount(diff.newText ?? '') : 0;
  const markdown = diff ? markdownToRender(path, diff) : null;
  const rendered = Boolean(markdown && renderedChoice);

  const { anchored, unanchored, blocks, selected, editorInDoc } = useMemo(
    () => fileLayout({ comments, commentsHidden, editingId, showsEditor, docLines, rendered, editor }),
    [comments, commentsHidden, editingId, showsEditor, docLines, rendered, editor],
  );

  const editorLabel = (file: string, start: number | null, end: number | null) =>
    start === null || end === null ? `${file} — комментарий к файлу` : start === end ? `${file}:L${start}` : `${file}:L${start}-L${end}`;

  const renderComment = (c: Comment) => (
    <CommentCard
      key={c.id}
      comment={c}
      stale={staleLabel(c)}
      current={currentCommentId === c.id}
      onSelect={() => actions.setCurrentComment(c.id)}
      editing={editingId === c.id}
      onEdit={() => actions.startEdit(c.id)}
      onCancelEdit={actions.cancelEdit}
      onSave={(text) => actions.updateComment(c.id, text)}
      onDelete={() => void actions.deleteComment(c.id)}
    />
  );

  const renderEditor = () =>
    editor ? (
      <CommentForm
        key="editor"
        label={editorLabel(editor.file, selected?.from ?? editor.start, selected?.to ?? editor.end)}
        // Text typed into another file's form is not this form's draft.
        initial={draft.current.file === path ? draft.current.text : ''}
        submitLabel="Сохранить"
        onSubmit={actions.createComment}
        onCancel={actions.closeEditor}
        onChange={(text) => {
          draft.current = { file: path, text };
        }}
      />
    ) : null;

  const byKey = useMemo(() => new Map(anchored.map((c) => [`c:${c.id}`, c])), [anchored]);
  const renderBlock = useCallback(
    (key: string) => {
      if (key === 'editor') return renderEditor();
      const c = byKey.get(key);
      return c ? renderComment(c) : null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byKey, editingId, editor, selected?.from, selected?.to, staleLabel, currentCommentId, actions],
  );

  // «Scroll to this comment», asked by the comments panel. A comment can only
  // be scrolled to where it is drawn: the code view, with the file's comments
  // shown.
  useEffect(() => {
    if (!reveal) return;
    onFileRendered(path, false);
    onCommentsHidden(path, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce, reveal?.comment.id, path]);
  const revealAnchored = reveal && anchored.some((c) => c.id === reveal.comment.id) ? reveal : null;
  const revealAbove = reveal && unanchored.some((c) => c.id === reveal.comment.id) ? reveal : null;
  const diffSettled = activeDiff !== null && activeDiff.kind !== 'loading';
  useEffect(() => {
    if (!revealAbove || !diffSettled) return;
    document.getElementById(`rv-comment-${revealAbove.comment.id}`)?.scrollIntoView({ block: 'center' });
    onRevealed(revealAbove.nonce);
  }, [revealAbove, diffSettled, onRevealed]);
  const editorReveal = useMemo(
    () =>
      revealAnchored && !rendered
        ? {
            from: revealAnchored.comment.startLine ?? (revealAnchored.comment.endLine as number),
            to: revealAnchored.comment.endLine as number,
            nonce: revealAnchored.nonce,
          }
        : null,
    [revealAnchored, rendered],
  );

  const onSelectLines = useCallback(
    (r: LineRange) => actions.openEditor({ file: path, start: r.from, end: r.to }),
    [path, actions],
  );

  const oldPath = diff?.oldPath ?? entry?.oldPath ?? null;
  // The file list knows the counts before the diff is loaded (and for a
  // collapsed file it never is); the diff itself has the last word.
  const stat = diff
    ? diff.binary || diff.additions === null || diff.deletions === null
      ? null
      : { additions: diff.additions || 0, deletions: diff.deletions || 0 }
    : entry && entry.additions != null && entry.deletions != null
      ? { additions: entry.additions, deletions: entry.deletions }
      : null;

  return (
    <section className={collapsed ? 'rv-file is-collapsed' : 'rv-file'} data-path={path}>
      <div className="rv-file-header">
        {onCollapse && (
          <IconButton
            size="small"
            variant="invisible"
            icon={collapsed ? ChevronRightIcon : ChevronDownIcon}
            aria-label={collapsed ? 'Развернуть файл' : 'Свернуть файл'}
            aria-expanded={!collapsed}
            onClick={() => onCollapse(path, !collapsed)}
          />
        )}
        <div className="rv-file-header__path" title={oldPath ? `${oldPath} → ${path}` : path}>
          {oldPath && oldPath !== path ? (
            <>
              <span className="rv-file-header__old">{oldPath}</span>
              <span className="rv-file-header__arrow">→</span>
            </>
          ) : null}
          <span>{path}</span>
        </div>
        {stat && (
          <span className="rv-diffstat">
            <span className="rv-diffstat__add">+{stat.additions}</span>
            <span className="rv-diffstat__del">−{stat.deletions}</span>
          </span>
        )}
        {comments.length > 0 && (
          <span className="rv-file-header__count" title="Комментариев к файлу">
            <CommentIcon size={14} /> <CounterLabel>{comments.length}</CounterLabel>
          </span>
        )}
        <div className="rv-file-header__spacer" />
        {!collapsed && comments.length > 0 && (
          <Button
            size="small"
            leadingVisual={commentsHidden ? EyeIcon : EyeClosedIcon}
            aria-pressed={commentsHidden}
            onClick={() => onCommentsHidden(path, !commentsHidden)}
          >
            {commentsHidden ? 'Показать комментарии' : 'Скрыть комментарии'}
          </Button>
        )}
        {!collapsed && markdown && (
          <SegmentedControl aria-label="Вид файла" size="small" onChange={(i) => onRendered(path, i === 1)}>
            <SegmentedControl.Button selected={!rendered} leadingVisual={CodeIcon}>
              Код
            </SegmentedControl.Button>
            <SegmentedControl.Button selected={rendered} leadingVisual={EyeIcon}>
              Просмотр
            </SegmentedControl.Button>
          </SegmentedControl>
        )}
        {!collapsed && showsEditor && !rendered && (
          <span className="rv-file-header__wrap">
            <span id={wrapLabelId} className="rv-hint">
              Перенос строк
            </span>
            <ToggleSwitch size="small" checked={wrap} onClick={() => onWrap(!wrap)} aria-labelledby={wrapLabelId} />
          </span>
        )}
        <Button size="small" leadingVisual={CommentIcon} onClick={() => actions.openEditor({ file: path, start: null, end: null })}>
          Комментарий к файлу
        </Button>
        {/* In Zen this is the way out, and it says so: the header is sticky, so
            the button stays on screen while the file scrolls. With no file open
            there is no header — DiffScreen puts a floating one there instead. */}
        {zen ? (
          <Button size="small" leadingVisual={ScreenNormalIcon} onClick={() => onZen(false)}>
            Выйти из Zen <span className="rv-file-header__kbd">Esc</span>
          </Button>
        ) : (
          <IconButton size="small" icon={ScreenFullIcon} aria-label="Zen: скрыть всё, кроме диффа" onClick={() => onZen(true)} />
        )}
        {entry && (
          <label
            className={'rv-file-header__viewed' + (entry.viewed ? ' is-viewed' : '')}
            title={
              entry.fingerprint ? 'Отметка снимется сама, если дифф файла изменится' : 'Для этого файла нельзя запомнить версию диффа'
            }
          >
            <Checkbox
              checked={entry.viewed}
              disabled={!entry.fingerprint}
              onChange={(e) => void actions.setFileViewed(path, e.target.checked)}
            />
            Просмотрено
          </label>
        )}
      </div>

      {!collapsed && body()}
    </section>
  );

  function body() {
    return (
      <>
      {activeDiff === null && placeholderHeight !== undefined && (
        <div className="rv-file-placeholder" style={{ height: placeholderHeight }} aria-hidden="true" />
      )}
      {(unanchored.length > 0 || (editor && !editorInDoc)) && (
        <div className="rv-file-comments">
          {unanchored.length > 0 && <div className="rv-hint">Комментарии к файлу / вне текущего текста файла</div>}
          {unanchored.map(renderComment)}
          {editor && !editorInDoc && renderEditor()}
        </div>
      )}

      {activeDiff?.kind === 'loading' && (
        <div className="rv-diff-loading">
          <Spinner size="medium" />
        </div>
      )}
      {activeDiff?.kind === 'orphan' && (
        <Empty icon={QuestionIcon} title="Файла нет в текущем диффе">
          Комментарии к нему сохранены и попадут в экспорт.
        </Empty>
      )}
      {activeDiff?.kind === 'error' && (
        <Empty icon={AlertIcon} title="Не удалось загрузить дифф">
          {activeDiff.message}
          {onRetry && (
            <span className="rv-file-retry">
              <Button size="small" onClick={() => onRetry(path)}>
                Повторить
              </Button>
            </span>
          )}
        </Empty>
      )}
      {rendered && markdown && (
        <>
          <div className="rv-hint rv-diff-hint">
            {markdown.side === 'old' ? 'Файл удалён — показана прежняя версия. ' : ''}
            Только просмотр: комментарии к строкам — в режиме «Код»
            {anchored.length > 0 ? ` (${anchored.length})` : ''}.
          </div>
          <div className="rv-diff-frame">
            <PreviewBoundary
              onError={(e) => {
                onFileRendered(path, false);
                toast(failureMessage('Просмотр markdown не загрузился', e), true);
              }}
            >
              <Suspense
                fallback={
                  <div className="rv-diff-loading">
                    <Spinner size="medium" />
                  </div>
                }
              >
                <MarkdownPreview text={markdown.text} loadExternalImages={externalImages} onLoadExternalImages={() => onExternalImages(path)} />
              </Suspense>
            </PreviewBoundary>
          </div>
        </>
      )}
      {diff && reason && !rendered && (
        <Empty icon={reason.icon} title={reason.title}>
          {reason.text}
        </Empty>
      )}
      {diff && !reason && !rendered && (
        <div className="rv-diff-frame">
          <DiffEditor
            path={path}
            oldText={diff.oldText ?? ''}
            newText={diff.newText ?? ''}
            hunks={diff.hunks}
            deletedFile={diff.newText == null}
            wrap={wrap}
            blocks={blocks}
            selected={selected}
            renderBlock={renderBlock}
            onSelectLines={onSelectLines}
            reveal={editorReveal}
            onRevealed={onRevealed}
          />
        </div>
      )}
      </>
    );
  }
});
