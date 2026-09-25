import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Checkbox, CounterLabel, IconButton, SegmentedControl, Spinner, ToggleSwitch } from '@primer/react';
import { Blankslate } from '@primer/react/experimental';
import {
  AlertIcon,
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
import { useReview } from '../review/ReviewContext';
import { failureMessage } from '../api/client';
import { useToast } from '../lib/toast';
import type { Comment, DiffResponse } from '../api/types';
import { DiffEditor } from './DiffEditor';
import { CommentCard, CommentForm } from './CommentCard';
import type { Block } from './cm/blocks';
import { stripFinalNewline, type LineRange } from './lineMap';
import { markdownToRender } from './markdownFile';
import { setFileHidden, visibleComments, type HiddenFiles } from './hiddenComments';
import { staleTarget } from '../review/commentAge';
import './diff.css';

const WRAP_KEY = 'local-review:wrap';

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

function readWrap(): boolean {
  try {
    return window.localStorage.getItem(WRAP_KEY) !== '0';
  } catch {
    return true;
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

function Empty({ icon: Icon, title, children }: { icon: typeof FileIcon; title: string; children?: ReactNode }) {
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
    if (!diff.hunks.length) {
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

type Props = {
  zen: boolean;
  onZen: (on: boolean) => void;
  /** The comments panel is open: its current comment is highlighted here. */
  panelOpen: boolean;
};

export function DiffPane({ zen, onZen, panelOpen }: Props) {
  const review = useReview();
  const { activeFile, activeDiff, comments, editor, editingId, state, staleIds, age, reveal, currentCommentId } = review;
  const [wrap, setWrap] = useState(readWrap);
  const toast = useToast();
  // Source diff or rendered markdown, per file path; source is the default.
  const [renderedFiles, setRenderedFiles] = useState<Record<string, boolean>>({});
  // Files whose remote images the reviewer chose to load (not persisted).
  const [externalImageFiles, setExternalImageFiles] = useState<Record<string, boolean>>({});
  // Files whose comments the reviewer hid with the header button (not persisted).
  const [hiddenFiles, setHiddenFiles] = useState<HiddenFiles>({});
  // Unsaved text of the open new-comment form. Switching Код/Просмотр remounts
  // the form; it resumes from here. Gone once the form closes (save, cancel,
  // another file), and on reload.
  const draft = useRef('');
  useEffect(() => {
    if (!editor) draft.current = '';
    // A new comment on a hidden file would vanish on save; show the file's comments again.
    if (editor) setHiddenFiles((prev) => setFileHidden(prev, editor.file, false));
  }, [editor]);

  const toggleWrap = (next: boolean) => {
    setWrap(next);
    try {
      window.localStorage.setItem(WRAP_KEY, next ? '1' : '0');
    } catch {
      // storage blocked
    }
  };

  // Every comment of the file, stale ones too: written against other code
  // (another commit, or before a commit), they stay on their line in grey
  // with the commit they belong to (review/commentAge.ts).
  const fileComments = useMemo(() => comments.filter((c) => c.file === activeFile), [comments, activeFile]);
  const staleLabel = useCallback(
    (c: Comment) => (staleIds.has(c.id) ? staleTarget(c, age.history, age.truncated) : null),
    [staleIds, age],
  );
  const diff = activeDiff?.kind === 'ready' ? activeDiff.diff : null;
  const reason = diff ? unavailableReason(diff) : null;
  const showsEditor = Boolean(diff && !reason);
  const docLines = showsEditor && diff ? lineCount(diff.newText ?? '') : 0;
  const markdown = diff && activeFile ? markdownToRender(activeFile, diff) : null;
  const rendered = Boolean(markdown && activeFile && renderedFiles[activeFile]);
  const commentsHidden = Boolean(activeFile && hiddenFiles[activeFile]);

  // Comments whose line is not in the document go above it, with file-level ones.
  // Hidden comments leave both places; the header still counts them.
  const { anchored, unanchored } = useMemo(() => {
    const a: Comment[] = [];
    const u: Comment[] = [];
    for (const c of visibleComments(fileComments, commentsHidden, editingId)) {
      if (showsEditor && c.endLine !== null && c.endLine >= 1 && c.endLine <= docLines) a.push(c);
      else u.push(c);
    }
    return { anchored: a, unanchored: u };
  }, [fileComments, commentsHidden, editingId, showsEditor, docLines]);

  const editorHere = editor && editor.file === activeFile ? editor : null;
  const editorLine = editorHere && editorHere.start !== null && editorHere.end !== null ? Math.max(editorHere.start, editorHere.end) : null;
  // The rendered view has no lines, so an open line-comment form moves above it.
  const editorInDoc = editorLine !== null && showsEditor && !rendered && editorLine <= docLines;

  const blocks = useMemo<Block[]>(() => {
    const out: Block[] = anchored.map((c) => ({ key: `c:${c.id}`, line: c.endLine as number }));
    if (editorInDoc && editorLine !== null) out.push({ key: 'editor', line: editorLine });
    return out;
  }, [anchored, editorInDoc, editorLine]);

  const selected: LineRange | null =
    editorInDoc && editorHere && editorHere.start !== null && editorHere.end !== null
      ? { from: Math.min(editorHere.start, editorHere.end), to: Math.max(editorHere.start, editorHere.end) }
      : null;

  const editorLabel = (file: string, start: number | null, end: number | null) =>
    start === null || end === null ? `${file} — комментарий к файлу` : start === end ? `${file}:L${start}` : `${file}:L${start}-L${end}`;

  const renderComment = (c: Comment) => (
    <CommentCard
      key={c.id}
      comment={c}
      stale={staleLabel(c)}
      current={panelOpen && currentCommentId === c.id}
      onSelect={() => review.setCurrentComment(c.id)}
      editing={editingId === c.id}
      onEdit={() => review.startEdit(c.id)}
      onCancelEdit={review.cancelEdit}
      onSave={(text) => review.updateComment(c.id, text)}
      onDelete={() => void review.deleteComment(c.id)}
    />
  );

  const renderEditor = () =>
    editorHere ? (
      <CommentForm
        key="editor"
        label={editorLabel(editorHere.file, selected?.from ?? editorHere.start, selected?.to ?? editorHere.end)}
        initial={draft.current}
        submitLabel="Сохранить"
        onSubmit={review.createComment}
        onCancel={review.closeEditor}
        onChange={(text) => {
          draft.current = text;
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
    [byKey, editingId, editorHere, selected?.from, selected?.to, staleLabel, panelOpen, currentCommentId],
  );

  // «Scroll to this comment», asked by the comments panel. A handled nonce is
  // not passed again, so reopening the file later does not jump back.
  const handledReveal = useRef(0);
  const [, setRevealTick] = useState(0);
  const markRevealed = useCallback((nonce: number) => {
    handledReveal.current = nonce;
    setRevealTick(nonce);
  }, []);
  const pending = reveal && reveal.nonce !== handledReveal.current ? comments.find((c) => c.id === reveal.commentId) : undefined;
  const revealHere = pending && pending.file === activeFile ? pending : null;
  // The reviewer went to another file before the diff got there: the request
  // is dropped, or revisiting the file later would jump for no reason.
  useEffect(() => {
    if (pending && reveal && activeFile !== null && pending.file !== activeFile) markRevealed(reveal.nonce);
  }, [pending, reveal, activeFile, markRevealed]);
  useEffect(() => {
    if (!revealHere || !activeFile) return;
    // A comment can only be scrolled to where it is drawn: the code view, with
    // the file's comments shown.
    setRenderedFiles((prev) => (prev[activeFile] ? { ...prev, [activeFile]: false } : prev));
    setHiddenFiles((prev) => setFileHidden(prev, activeFile, false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce, revealHere?.id, activeFile]);
  const revealAnchored = revealHere && anchored.some((c) => c.id === revealHere.id) ? revealHere : null;
  const revealAbove = revealHere && unanchored.some((c) => c.id === revealHere.id) ? revealHere : null;
  const diffSettled = activeDiff !== null && activeDiff.kind !== 'loading';
  useEffect(() => {
    if (!revealAbove || !reveal || !diffSettled) return;
    document.getElementById(`rv-comment-${revealAbove.id}`)?.scrollIntoView({ block: 'center' });
    markRevealed(reveal.nonce);
  }, [revealAbove, reveal, diffSettled, markRevealed]);
  const editorReveal =
    revealAnchored && reveal && !rendered
      ? {
          from: revealAnchored.startLine ?? (revealAnchored.endLine as number),
          to: revealAnchored.endLine as number,
          nonce: reveal.nonce,
        }
      : null;

  const onSelectLines = useCallback(
    (r: LineRange) => {
      if (activeFile) review.openEditor({ file: activeFile, start: r.from, end: r.to });
    },
    [activeFile, review],
  );

  if (!state) return null;

  if (!activeFile) {
    return state.files.length ? (
      <Empty icon={FileIcon} title="Выбери файл слева" />
    ) : (
      <Empty icon={FileIcon} title="Изменений нет">
        Дифф пуст.
      </Empty>
    );
  }

  const fileEntry = state.files.find((f) => f.path === activeFile);
  const oldPath = diff?.oldPath ?? fileEntry?.oldPath ?? null;

  return (
    <div className="rv-diff-pane">
      <div className="rv-file-header">
        <div className="rv-file-header__path" title={oldPath ? `${oldPath} → ${activeFile}` : activeFile}>
          {oldPath && oldPath !== activeFile ? (
            <>
              <span className="rv-file-header__old">{oldPath}</span>
              <span className="rv-file-header__arrow">→</span>
            </>
          ) : null}
          <span>{activeFile}</span>
        </div>
        {diff && !diff.binary && (
          <span className="rv-diffstat">
            <span className="rv-diffstat__add">+{diff.additions || 0}</span>
            <span className="rv-diffstat__del">−{diff.deletions || 0}</span>
          </span>
        )}
        {fileComments.length > 0 && (
          <span className="rv-file-header__count" title="Комментариев к файлу">
            <CommentIcon size={14} /> <CounterLabel>{fileComments.length}</CounterLabel>
          </span>
        )}
        <div className="rv-file-header__spacer" />
        {fileComments.length > 0 && (
          <Button
            size="small"
            leadingVisual={commentsHidden ? EyeIcon : EyeClosedIcon}
            aria-pressed={commentsHidden}
            onClick={() => setHiddenFiles((prev) => setFileHidden(prev, activeFile, !commentsHidden))}
          >
            {commentsHidden ? 'Показать комментарии' : 'Скрыть комментарии'}
          </Button>
        )}
        {markdown && (
          <SegmentedControl
            aria-label="Вид файла"
            size="small"
            onChange={(i) => setRenderedFiles((prev) => ({ ...prev, [activeFile]: i === 1 }))}
          >
            <SegmentedControl.Button selected={!rendered} leadingVisual={CodeIcon}>
              Код
            </SegmentedControl.Button>
            <SegmentedControl.Button selected={rendered} leadingVisual={EyeIcon}>
              Просмотр
            </SegmentedControl.Button>
          </SegmentedControl>
        )}
        {showsEditor && !rendered && (
          <span className="rv-file-header__wrap">
            <span id="rv-wrap-label" className="rv-hint">
              Перенос строк
            </span>
            <ToggleSwitch size="small" checked={wrap} onClick={() => toggleWrap(!wrap)} aria-labelledby="rv-wrap-label" />
          </span>
        )}
        <Button
          size="small"
          leadingVisual={CommentIcon}
          onClick={() => review.openEditor({ file: activeFile, start: null, end: null })}
        >
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
          <IconButton
            size="small"
            icon={ScreenFullIcon}
            aria-label="Zen: скрыть всё, кроме диффа"
            onClick={() => onZen(true)}
          />
        )}
        {fileEntry && (
          <label
            className={'rv-file-header__viewed' + (fileEntry.viewed ? ' is-viewed' : '')}
            title={
              fileEntry.fingerprint
                ? 'Отметка снимется сама, если дифф файла изменится'
                : 'Для этого файла нельзя запомнить версию диффа'
            }
          >
            <Checkbox
              checked={fileEntry.viewed}
              disabled={!fileEntry.fingerprint}
              onChange={(e) => void review.setFileViewed(activeFile, e.target.checked)}
            />
            Просмотрено
          </label>
        )}
      </div>

      {(unanchored.length > 0 || (editorHere && !editorInDoc)) && (
        <div className="rv-file-comments">
          {unanchored.length > 0 && <div className="rv-hint">Комментарии к файлу / вне текущего текста файла</div>}
          {unanchored.map(renderComment)}
          {editorHere && !editorInDoc && renderEditor()}
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
                setRenderedFiles((prev) => ({ ...prev, [activeFile]: false }));
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
                <MarkdownPreview
                  text={markdown.text}
                  loadExternalImages={Boolean(externalImageFiles[activeFile])}
                  onLoadExternalImages={() => setExternalImageFiles((prev) => ({ ...prev, [activeFile]: true }))}
                />
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
        <>
          <div className="rv-diff-frame">
            <DiffEditor
              path={activeFile}
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
              onRevealed={markRevealed}
            />
          </div>
        </>
      )}
    </div>
  );
}
