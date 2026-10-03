import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileIcon } from '@primer/octicons-react';
import { useReview } from '../review/ReviewContext';
import { useFileDiff } from '../review/useFileDiff';
import type { Comment } from '../api/types';
import { Empty, FileDiff, type FileDiffActions, type FormDraft } from './FileDiff';
import { setFileHidden, type HiddenFiles } from './hiddenComments';
import { staleTarget } from '../review/commentAge';
import './diff.css';

const WRAP_KEY = 'local-review:wrap';

function readWrap(): boolean {
  try {
    return window.localStorage.getItem(WRAP_KEY) !== '0';
  } catch {
    return true;
  }
}

const NO_COMMENTS: Comment[] = [];

type Props = {
  zen: boolean;
  onZen: (on: boolean) => void;
  /** The comments panel is open: its current comment is highlighted here. */
  panelOpen: boolean;
};

/**
 * The diff side of the screen. Holds what outlives a single file — the choices
 * made per file, the unsaved form text, which «scroll to this comment» request
 * is already done — and hands each file its own slice of the review.
 */
export function DiffPane({ zen, onZen, panelOpen }: Props) {
  const review = useReview();
  const { activeFile, diffs, comments, editor, editingId, state, staleIds, age, reveal, currentCommentId } = review;
  const activeDiff = useFileDiff(diffs, activeFile);
  const [wrap, setWrap] = useState(readWrap);
  // Source diff or rendered markdown, per file path; source is the default.
  const [renderedFiles, setRenderedFiles] = useState<Record<string, boolean>>({});
  // Files whose remote images the reviewer chose to load (not persisted).
  const [externalImageFiles, setExternalImageFiles] = useState<Record<string, boolean>>({});
  // Files whose comments the reviewer hid with the header button (not persisted).
  const [hiddenFiles, setHiddenFiles] = useState<HiddenFiles>({});
  // Unsaved text of the open new-comment form. Switching Код/Просмотр remounts
  // the form; it resumes from here. Gone once the form closes (save, cancel,
  // another file), and on reload.
  const draft = useRef<FormDraft>({ file: '', text: '' });
  useEffect(() => {
    if (!editor) draft.current = { file: '', text: '' };
    // A new comment on a hidden file would vanish on save; show the file's comments again.
    if (editor) setHiddenFiles((prev) => setFileHidden(prev, editor.file, false));
  }, [editor]);

  const toggleWrap = useCallback((next: boolean) => {
    setWrap(next);
    try {
      window.localStorage.setItem(WRAP_KEY, next ? '1' : '0');
    } catch {
      // storage blocked
    }
  }, []);

  const setRendered = useCallback(
    (path: string, rendered: boolean) =>
      setRenderedFiles((prev) => (Boolean(prev[path]) === rendered ? prev : { ...prev, [path]: rendered })),
    [],
  );
  const setCommentsHidden = useCallback(
    (path: string, hidden: boolean) => setHiddenFiles((prev) => setFileHidden(prev, path, hidden)),
    [],
  );
  const loadExternalImages = useCallback((path: string) => setExternalImageFiles((prev) => ({ ...prev, [path]: true })), []);

  // Every comment of a file, stale ones too: written against other code
  // (another commit, or before a commit), they stay on their line in grey
  // with the commit they belong to (review/commentAge.ts).
  const commentsByFile = useMemo(() => {
    const out = new Map<string, Comment[]>();
    for (const c of comments) {
      if (c.file === null) continue;
      const list = out.get(c.file);
      if (list) list.push(c);
      else out.set(c.file, [c]);
    }
    return out;
  }, [comments]);
  const staleLabel = useCallback(
    (c: Comment) => (staleIds.has(c.id) ? staleTarget(c, age.history, age.truncated) : null),
    [staleIds, age],
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
  // The reviewer went to another file before the diff got there: the request
  // is dropped, or revisiting the file later would jump for no reason.
  useEffect(() => {
    if (pending && reveal && activeFile !== null && pending.file !== activeFile) markRevealed(reveal.nonce);
  }, [pending, reveal, activeFile, markRevealed]);
  const pendingReveal = useMemo(
    () => (pending && reveal ? { comment: pending, nonce: reveal.nonce } : null),
    [pending, reveal],
  );

  const { openEditor, closeEditor, createComment, startEdit, cancelEdit, updateComment, deleteComment, setCurrentComment, setFileViewed } = review;
  const actions = useMemo<FileDiffActions>(
    () => ({ openEditor, closeEditor, createComment, startEdit, cancelEdit, updateComment, deleteComment, setCurrentComment, setFileViewed }),
    [openEditor, closeEditor, createComment, startEdit, cancelEdit, updateComment, deleteComment, setCurrentComment, setFileViewed],
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

  const fileComments = commentsByFile.get(activeFile) ?? NO_COMMENTS;
  const has = (id: string | null) => id !== null && fileComments.some((c) => c.id === id);

  return (
    <div className="rv-diff-pane">
      <FileDiff
        path={activeFile}
        entry={state.files.find((f) => f.path === activeFile)}
        diff={activeDiff}
        comments={fileComments}
        editor={editor && editor.file === activeFile ? editor : null}
        editingId={has(editingId) ? editingId : null}
        currentCommentId={panelOpen && has(currentCommentId) ? currentCommentId : null}
        reveal={pendingReveal && pendingReveal.comment.file === activeFile ? pendingReveal : null}
        onRevealed={markRevealed}
        staleLabel={staleLabel}
        draft={draft}
        wrap={wrap}
        onWrap={toggleWrap}
        rendered={Boolean(renderedFiles[activeFile])}
        onRendered={setRendered}
        commentsHidden={Boolean(hiddenFiles[activeFile])}
        onCommentsHidden={setCommentsHidden}
        externalImages={Boolean(externalImageFiles[activeFile])}
        onExternalImages={loadExternalImages}
        zen={zen}
        onZen={onZen}
        actions={actions}
      />
    </div>
  );
}
