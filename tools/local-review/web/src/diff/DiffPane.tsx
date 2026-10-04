import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileIcon } from '@primer/octicons-react';
import { useReview } from '../review/ReviewContext';
import { useFileDiff } from '../review/useFileDiff';
import type { Comment, FileEntry } from '../api/types';
import type { ViewMode } from '../lib/viewMode';
import { Empty, FileDiff, type FileDiffActions, type FormDraft } from './FileDiff';
import { FileFeed, type FeedFile } from './FileFeed';
import { buildTree, filesOf } from './fileTree';
import type { FileFilter } from './useFileFilter';
import { setFileHidden, type HiddenFiles } from './hiddenComments';
import { previewKind } from './previewFile';
import { NO_RENDER_CHOICE, isRendered, setFileRendered, switchRendered, type RenderChoice } from './renderMode';
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
  /** One file at a time, or all of them in one scroll; null until it is known. */
  viewMode: ViewMode | null;
  /** The setting: «Код» / «Просмотр» in one file switches every file. */
  renderAllFiles: boolean;
  /** The sidebar's search and rules: the feed shows the same files. */
  filter: FileFilter;
};

/**
 * The diff side of the screen. Holds what outlives a single file — the choices
 * made per file, the unsaved form text, which «scroll to this comment» request
 * is already done — and hands each file its own slice of the review.
 */
export function DiffPane({ zen, onZen, panelOpen, viewMode, renderAllFiles, filter }: Props) {
  const single = viewMode === 'single';
  const review = useReview();
  const { activeFile, diffs, comments, editor, editingId, state, staleIds, age, reveal, currentCommentId } = review;
  const activeDiff = useFileDiff(diffs, activeFile);
  const [wrap, setWrap] = useState(readWrap);
  // Source diff or rendered markdown / html; source is the default. One choice for
  // every file or one per file, as the setting says (renderMode.ts). Not persisted.
  const [renderChoice, setRenderChoice] = useState<RenderChoice>(NO_RENDER_CHOICE);
  // Files whose remote images the reviewer chose to load (not persisted).
  const [externalImageFiles, setExternalImageFiles] = useState<Record<string, boolean>>({});
  // Html files whose scripts the reviewer chose to run (not persisted).
  const [scriptFiles, setScriptFiles] = useState<Record<string, boolean>>({});
  // Files whose comments the reviewer hid with the header button (not persisted).
  const [hiddenFiles, setHiddenFiles] = useState<HiddenFiles>({});
  // Unsaved text of the open new-comment form. Switching Код/Просмотр remounts
  // the form; it resumes from here. Gone once the form closes (save, cancel,
  // another file), and on reload.
  const draft = useRef<FormDraft>({ file: '', text: '' });
  useEffect(() => {
    // A form in another file is another comment: the text typed for the first
    // file must not come back when a form is opened there again.
    if (!editor || editor.file !== draft.current.file) draft.current = { file: '', text: '' };
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

  // The switch in a file's header: every file follows when the mode is shared.
  const switchRenderedView = useCallback(
    (path: string, rendered: boolean) => setRenderChoice((prev) => switchRendered(prev, path, rendered, renderAllFiles)),
    [renderAllFiles],
  );
  // A file leaving the rendered view on its own (a comment to scroll to, a
  // preview that failed): the other files keep theirs.
  const setFileRenderedView = useCallback(
    (path: string, rendered: boolean) => setRenderChoice((prev) => setFileRendered(prev, path, rendered, renderAllFiles)),
    [renderAllFiles],
  );
  const setCommentsHidden = useCallback(
    (path: string, hidden: boolean) => setHiddenFiles((prev) => setFileHidden(prev, path, hidden)),
    [],
  );
  const loadExternalImages = useCallback((path: string) => setExternalImageFiles((prev) => ({ ...prev, [path]: true })), []);
  const runScripts = useCallback((path: string) => setScriptFiles((prev) => ({ ...prev, [path]: true })), []);

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
  // is dropped, or revisiting the file later would jump for no reason. Not in
  // the feed: there the comment's file is on screen whichever file is current.
  useEffect(() => {
    if (single && pending && reveal && activeFile !== null && pending.file !== activeFile) markRevealed(reveal.nonce);
  }, [single, pending, reveal, activeFile, markRevealed]);
  const pendingReveal = useMemo(
    () => (pending && reveal ? { comment: pending, nonce: reveal.nonce } : null),
    [pending, reveal],
  );

  // One object for the life of the pane, calling whatever the review offers
  // at that moment. Some of these are recreated whenever the open form moves
  // (createComment closes over it); passed as they are, every such move would
  // re-render every file of the feed.
  const latest = useRef(review);
  latest.current = review;
  const actions = useMemo<FileDiffActions>(
    () => ({
      openEditor: (anchor) => latest.current.openEditor(anchor),
      closeEditor: () => latest.current.closeEditor(),
      createComment: (text) => latest.current.createComment(text),
      startEdit: (id) => latest.current.startEdit(id),
      cancelEdit: () => latest.current.cancelEdit(),
      updateComment: (id, text) => latest.current.updateComment(id, text),
      deleteComment: (id) => latest.current.deleteComment(id),
      setCurrentComment: (id) => latest.current.setCurrentComment(id),
      setFileViewed: (path, viewed) => latest.current.setFileViewed(path, viewed),
    }),
    [],
  );

  // The feed shows what the sidebar's tree shows, in the tree's order, and
  // then the files that are out of the diff but still have comments.
  const feedFiles = useMemo<FeedFile[]>(
    () => [
      ...filesOf(buildTree(filter.shown, (f) => f.path)).map((entry) => ({ path: entry.path, entry, orphan: false })),
      ...filter.shownOrphans.map((f) => ({ path: f.path, entry: undefined, orphan: true })),
    ],
    [filter.shown, filter.shownOrphans],
  );

  // «Next unviewed file» has to mean the next one the feed shows.
  const { setFeedOrder } = review;
  useEffect(() => {
    if (single) return;
    setFeedOrder(feedFiles.filter((f) => !f.orphan).map((f) => f.path));
    return () => setFeedOrder(null);
  }, [single, feedFiles, setFeedOrder]);

  // Leaving the feed on a file it never loaded (collapsed, or still on its
  // way): open it the way a click in the sidebar would.
  const { selectFile } = review;
  useEffect(() => {
    if (single && activeFile && activeDiff === null) selectFile(activeFile);
  }, [single, activeFile, activeDiff, selectFile]);

  if (!state || viewMode === null) return null;

  /** One file's slice of the review; every value is stable while that file's part is unchanged. */
  const propsFor = (path: string, entry: FileEntry | undefined) => {
    const fileComments = commentsByFile.get(path) ?? NO_COMMENTS;
    const has = (id: string | null) => id !== null && fileComments.some((c) => c.id === id);
    return {
      path,
      entry,
      comments: fileComments,
      editor: editor && editor.file === path ? editor : null,
      editingId: has(editingId) ? editingId : null,
      currentCommentId: panelOpen && has(currentCommentId) ? currentCommentId : null,
      reveal: pendingReveal && pendingReveal.comment.file === path ? pendingReveal : null,
      onRevealed: markRevealed,
      staleLabel,
      draft,
      wrap,
      onWrap: toggleWrap,
      // Only for a file that has a rendered view: the common switch must not
      // re-render every other file of the feed.
      rendered: previewKind(path) !== null && isRendered(renderChoice, path, renderAllFiles),
      onRendered: switchRenderedView,
      onFileRendered: setFileRenderedView,
      commentsHidden: Boolean(hiddenFiles[path]),
      onCommentsHidden: setCommentsHidden,
      externalImages: Boolean(externalImageFiles[path]),
      onExternalImages: loadExternalImages,
      scripts: Boolean(scriptFiles[path]),
      onRunScripts: runScripts,
      zen,
      onZen,
    };
  };

  if (!single) {
    if (state.files.length === 0 && state.orphanFiles.length === 0) {
      return (
        <Empty icon={FileIcon} title="Изменений нет">
          Дифф пуст.
        </Empty>
      );
    }
    return (
      <div className="rv-diff-pane">
        <FileFeed
          files={feedFiles}
          diffs={diffs}
          activeFile={activeFile}
          fileFocus={review.fileFocus}
          onCurrentFile={review.setCurrentFile}
          reveal={pendingReveal}
          onRevealed={markRevealed}
          editor={editor}
          actions={actions}
          fileProps={(file) => propsFor(file.path, file.entry)}
        />
      </div>
    );
  }

  if (!activeFile) {
    return state.files.length ? (
      <Empty icon={FileIcon} title="Выбери файл слева" />
    ) : (
      <Empty icon={FileIcon} title="Изменений нет">
        Дифф пуст.
      </Empty>
    );
  }

  return (
    <div className="rv-diff-pane">
      <FileDiff {...propsFor(activeFile, state.files.find((f) => f.path === activeFile))} diff={activeDiff} actions={actions} />
    </div>
  );
}
