import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, commitsListDescriptor } from '../api/client';
import type { Comment, Commit, Descriptor, DiffResponse, DirtyStatus, LocalDescriptor, Mode, StateResponse } from '../api/types';
import { useToast } from '../lib/toast';
import { useConfirm } from '../lib/confirm';
import { copyToClipboard } from '../lib/clipboard';
import { descriptorFromHash, hashFor, navigationFor, viewHash } from '../lib/hash';
import { createDraftStore, type DraftStore } from './drafts';
import {
  clampIndex,
  commitContextFor,
  defaultSelection,
  expandToComments,
  outsideComments,
  selectionForRange,
  selHi,
  selLo,
  type CommitSelection,
} from './commitSelection';

/** Whether a descriptor currently asks for the "commits" view (local mode, or a PR range). */
function isCommitsMode(d: Descriptor): boolean {
  return d.source === 'local' ? d.mode === 'commits' : Boolean(d.from && d.to);
}

/** Where a new comment goes: a line range in the new file, or the whole file. */
export type EditorAnchor = { file: string; start: number | null; end: number | null };

export type ActiveDiff =
  | { kind: 'loading' }
  | { kind: 'orphan' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; diff: DiffResponse };

export type Review = {
  descriptor: Descriptor;
  state: StateResponse | null;
  loading: boolean;
  loadError: string | null;
  comments: Comment[];
  activeFile: string | null;
  activeDiff: ActiveDiff | null;
  editor: EditorAnchor | null;
  editingId: string | null;
  /** Unsaved general-comment text; survives closing the panel, not a reload. */
  drafts: DraftStore;

  /** Branch history for the "commits" mode; empty when not in that mode (or not loaded yet). */
  commits: Commit[];
  commitsTruncated: boolean;
  commitsFallback: boolean;
  commitsBase: string | null;
  /** Uncommitted-changes status from the last commit-history fetch (local only). */
  dirty: DirtyStatus;
  dirtyNoticeDismissed: boolean;
  /** True once the descriptor asks for the commits view (local mode === 'commits', or a PR range). */
  commitsMode: boolean;
  /** commitsMode is on but the branch has no commits to show. */
  commitsEmpty: boolean;
  /**
   * The commit history is being fetched: set from the moment the «Коммиты»
   * tab is clicked (before the descriptor switches) until the list arrives.
   */
  commitsLoading: boolean;
  /** Selected commit(s) on the rail, as indices into `commits`; null outside commits mode. */
  commitSel: CommitSelection | null;
  /** Comments whose commit context falls outside the current selection. */
  outsideCount: number;

  reload: () => void;
  setMode: (mode: Mode) => void;
  setBase: (base: string) => void;
  /** Toggles the PR "Все изменения"/"Коммиты" view; no-op for a local descriptor. */
  setPrCommitsView: (on: boolean) => void;
  setCommitSelection: (anchor: number, head: number) => void;
  /** Grows the selection to cover every comment currently outside it. */
  expandSelectionToOutside: () => void;
  dismissDirtyNotice: () => void;
  selectFile: (path: string) => void;
  openEditor: (anchor: EditorAnchor) => void;
  closeEditor: () => void;
  startEdit: (id: string) => void;
  cancelEdit: () => void;
  createComment: (text: string) => Promise<boolean>;
  /** A comment about the whole review; needs no editor anchor. */
  createGeneralComment: (text: string) => Promise<boolean>;
  updateComment: (id: string, text: string) => Promise<boolean>;
  deleteComment: (id: string) => Promise<void>;
  copyAll: () => Promise<void>;
  exportMd: () => Promise<void>;
  clearAll: () => Promise<void>;
};

const ReviewContext = createContext<Review | null>(null);

export function useReview(): Review {
  const value = useContext(ReviewContext);
  if (!value) throw new Error('useReview outside ReviewProvider');
  return value;
}

/** For chrome (the header) that renders on every screen. */
export function useOptionalReview(): Review | null {
  return useContext(ReviewContext);
}

export function ReviewProvider({
  initial,
  initialFile = null,
  children,
}: {
  initial: Descriptor;
  /** File named in the URL; opened on load when the diff (or an orphan) has it. */
  initialFile?: string | null;
  children: ReactNode;
}) {
  const toast = useToast();
  const confirm = useConfirm();

  const [descriptor, setDescriptor] = useState<Descriptor>(initial);
  // Mode and base edits build on the latest descriptor, not on the one a
  // callback happened to close over.
  const descriptorRef = useRef(descriptor);
  const [state, setState] = useState<StateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [activeDiff, setActiveDiff] = useState<ActiveDiff | null>(null);
  const [editor, setEditor] = useState<EditorAnchor | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // One store for the life of this review; the provider remounts per descriptor.
  const [drafts] = useState(createDraftStore);

  // Commits-mode state. The provider does NOT remount when toggling this mode
  // (hashFor ignores from/to on purpose), so it lives alongside the rest here.
  const [commits, setCommits] = useState<Commit[]>([]);
  const [commitsTruncated, setCommitsTruncated] = useState(false);
  const [commitsFallback, setCommitsFallback] = useState(false);
  const [commitsBase, setCommitsBase] = useState<string | null>(null);
  const [dirty, setDirty] = useState<DirtyStatus>({ dirty: false, files: 0 });
  // In-memory only, per the approved design: a page reload brings the banner back.
  const [dirtyNoticeDismissed, setDirtyNoticeDismissed] = useState(false);
  const [commitSel, setCommitSel] = useState<CommitSelection | null>(null);
  const [commitsLoading, setCommitsLoading] = useState(false);

  // Responses for a file or descriptor the user already left must not land.
  const diffSeq = useRef(0);
  const stateSeq = useRef(0);
  const commitsSeq = useRef(0);
  const activeFileRef = useRef<string | null>(null);
  activeFileRef.current = activeFile;
  // Back/Forward needs the file list without re-subscribing on every load.
  const stateRef = useRef<StateResponse | null>(null);
  stateRef.current = state;

  const fail = useCallback((e: unknown) => toast(e instanceof Error ? e.message : String(e), true), [toast]);

  const loadDiff = useCallback(
    async (d: Descriptor, path: string, orphan: boolean, fresh: boolean) => {
      const seq = ++diffSeq.current;
      setActiveFile(path);
      setEditor(null);
      setEditingId(null);
      if (orphan) {
        setActiveDiff({ kind: 'orphan' });
        return;
      }
      setActiveDiff({ kind: 'loading' });
      try {
        const diff = await api.diff(d, path, fresh);
        if (seq === diffSeq.current) setActiveDiff({ kind: 'ready', diff });
      } catch (e) {
        if (seq !== diffSeq.current) return;
        setActiveDiff({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
        fail(e);
      }
    },
    [fail],
  );

  const load = useCallback(
    async (d: Descriptor, keepFile: string | null, fresh: boolean) => {
      const seq = ++stateSeq.current;
      setLoading(true);
      try {
        const [next, commentData] = await Promise.all([api.state(d, fresh), api.comments(d)]);
        if (seq !== stateSeq.current) return;
        setState(next);
        setComments(commentData.comments);
        setLoadError(null);
        // We asked for the repository's default branch without naming it;
        // adopt the answer so the header shows the real revision (and so a
        // later mode switch keeps comparing against the same thing).
        if (d.source === 'local' && !d.base && next.base) {
          const filled: Descriptor = { ...d, base: next.base };
          descriptorRef.current = filled;
          setDescriptor(filled);
        }
        const inDiff = keepFile !== null && next.files.some((f) => f.path === keepFile);
        const inOrphans = keepFile !== null && next.orphanFiles.some((f) => f.path === keepFile);
        if (inDiff || inOrphans) {
          await loadDiff(d, keepFile, !inDiff, fresh);
        } else if (next.files.length) {
          await loadDiff(d, next.files[0].path, false, fresh);
        } else {
          diffSeq.current += 1;
          setActiveFile(null);
          setActiveDiff(null);
        }
      } catch (e) {
        if (seq !== stateSeq.current) return;
        setLoadError(e instanceof Error ? e.message : String(e));
        fail(e);
      } finally {
        if (seq === stateSeq.current) setLoading(false);
      }
    },
    [fail, loadDiff],
  );

  /**
   * Enter (or refresh) the commits view: load the branch history first, pick
   * the selection — the range `desired` names (from the address), else the
   * latest commit — and only then point the descriptor at it and load
   * /api/state + /api/diff. An empty history skips that last step entirely —
   * /api/state is never called without a range.
   */
  const enterCommitsMode = useCallback(
    async (fresh: boolean, desired?: { from?: string; to?: string; file?: string | null }) => {
      const seq = ++commitsSeq.current;
      const stateAtStart = stateSeq.current;
      const current = descriptorRef.current;
      // The user switched mode or picked commits while history was loading:
      // drop this result, and clear the spinner unless a newer load owns it.
      const stale = () => {
        if (seq === commitsSeq.current) return false;
        if (stateSeq.current === stateAtStart) setLoading(false);
        return true;
      };
      setLoading(true);
      setCommitsLoading(true);
      try {
        const data = await api.commits(commitsListDescriptor(current), fresh);
        if (stale()) return;
        setCommitsLoading(false);
        const list = data.commits || [];
        setCommits(list);
        setCommitsTruncated(Boolean(data.truncated));
        setCommitsFallback(Boolean(data.fallback));
        setCommitsBase(data.base ?? null);
        setDirty(data.dirty || { dirty: false, files: 0 });

        if (!list.length) {
          const next: Descriptor =
            current.source === 'local' ? { ...current, mode: 'commits', from: undefined, to: undefined } : { ...current, from: undefined, to: undefined };
          descriptorRef.current = next;
          setDescriptor(next);
          setCommitSel(null);
          diffSeq.current += 1;
          stateSeq.current += 1;
          setActiveFile(null);
          setActiveDiff(null);
          setState(null);
          setComments([]);
          setLoadError(null);
          setLoading(false);
          return;
        }

        // A range out of the address wins; one whose commits are gone (rebase,
        // trimmed history) quietly falls back to the latest commit.
        const sel = selectionForRange(list, desired?.from, desired?.to) ?? defaultSelection(list.length);
        setCommitSel(sel);
        const from = list[selLo(sel)].sha;
        const to = list[selHi(sel)].sha;
        const next: Descriptor =
          current.source === 'local' ? { ...current, mode: 'commits', from, to } : { ...current, from, to };
        descriptorRef.current = next;
        setDescriptor(next);
        await load(next, desired && 'file' in desired ? desired.file ?? null : activeFileRef.current, fresh);
      } catch (e) {
        if (stale()) return;
        setLoading(false);
        setCommitsLoading(false);
        fail(e);
      }
    },
    [fail, load],
  );

  useEffect(() => {
    // An address that already asks for a commit range enters that view the
    // long way: the rail needs its history, and /api/state needs a resolved
    // range, so the range in the address can't just be loaded as a diff.
    if (isCommitsMode(descriptor)) void enterCommitsMode(false, { from: descriptor.from, to: descriptor.to, file: initialFile });
    else void load(descriptor, initialFile, false);
    // Remember the choice so an empty hash after a restart lands here again.
    api.saveSession(descriptor).catch(() => {});
    // Mode/base changes reload through their own actions, keeping the file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror the open view — mode, base, commit range, file — into the address,
  // so a reload or a link copied out of it reproduces the same diff.
  // replaceState: only opening a file is a history step (see selectFile), and
  // it fires no hashchange, so this never re-enters the Back/Forward handler.
  // Skipped once the address points elsewhere (the user is leaving this review).
  useEffect(() => {
    if (!state) return;
    const current = window.location.hash;
    if (hashFor(descriptorFromHash(current)) !== hashFor(descriptor)) return;
    const next = viewHash(descriptor, activeFile);
    if (next !== current) window.history.replaceState(window.history.state, '', next);
  }, [state, descriptor, activeFile]);

  const refreshComments = useCallback(async () => {
    const data = await api.comments(descriptor);
    setComments(data.comments);
  }, [descriptor]);

  const reload = useCallback(() => {
    if (isCommitsMode(descriptorRef.current)) {
      void enterCommitsMode(true);
      return;
    }
    void load(descriptor, activeFileRef.current, true);
  }, [descriptor, load, enterCommitsMode]);

  const updateLocal = useCallback(
    (patch: (d: LocalDescriptor) => LocalDescriptor | null) => {
      const current = descriptorRef.current;
      if (current.source !== 'local') return;
      const next = patch(current);
      if (!next) return;
      descriptorRef.current = next;
      setDescriptor(next);
      void load(next, activeFileRef.current, false);
    },
    [load],
  );

  const setMode = useCallback(
    (mode: Mode) => {
      if (mode === 'commits') {
        // Re-clicking the active tab must not reset the chosen range.
        if (!isCommitsMode(descriptorRef.current)) void enterCommitsMode(false);
        return;
      }
      commitsSeq.current += 1;
      setCommitsLoading(false);
      const wasCommits = descriptorRef.current.source === 'local' && descriptorRef.current.mode === 'commits';
      updateLocal((d) => (d.mode === mode ? null : { ...d, mode, from: undefined, to: undefined }));
      if (wasCommits) setCommitSel(null);
    },
    [updateLocal, enterCommitsMode],
  );

  const setBase = useCallback(
    (base: string) => {
      // Cleared field = back to the repository's default branch.
      const value = base.trim();
      updateLocal((d) => (d.base === value ? null : { ...d, base: value }));
    },
    [updateLocal],
  );

  const setPrCommitsView = useCallback(
    (on: boolean) => {
      const current = descriptorRef.current;
      if (current.source !== 'pr') return;
      if (on) {
        if (!isCommitsMode(current)) void enterCommitsMode(false);
        return;
      }
      commitsSeq.current += 1;
      setCommitsLoading(false);
      if (!current.from && !current.to) return; // already showing "Все изменения"
      const next: Descriptor = { ...current, from: undefined, to: undefined };
      descriptorRef.current = next;
      setDescriptor(next);
      setCommitSel(null);
      void load(next, activeFileRef.current, false);
    },
    [enterCommitsMode, load],
  );

  const setCommitSelection = useCallback(
    (anchor: number, head: number) => {
      const current = descriptorRef.current;
      const count = commits.length;
      if (!count) return;
      commitsSeq.current += 1;
      setCommitsLoading(false);
      const resolved: CommitSelection = { anchor: clampIndex(count, anchor), head: clampIndex(count, head) };
      setCommitSel(resolved);
      const l = commits[selLo(resolved)];
      const h = commits[selHi(resolved)];
      if (!l || !h) return;
      const next: Descriptor = { ...current, from: l.sha, to: h.sha };
      descriptorRef.current = next;
      setDescriptor(next);
      void load(next, activeFileRef.current, false);
    },
    [commits, load],
  );

  const expandSelectionToOutside = useCallback(() => {
    if (!commitSel || !commits.length) return;
    const next = expandToComments(commits, commits.length, commitSel, comments);
    if (next === commitSel) return;
    setCommitSelection(next.anchor, next.head);
  }, [commitSel, commits, comments, setCommitSelection]);

  const dismissDirtyNotice = useCallback(() => setDirtyNoticeDismissed(true), []);

  /** Opens `path` without touching history — the Back/Forward handler's way in. */
  const openFile = useCallback(
    (d: Descriptor, path: string) => {
      const orphan = !(stateRef.current?.files ?? []).some((f) => f.path === path);
      void loadDiff(d, path, orphan, false);
    },
    [loadDiff],
  );

  const selectFile = useCallback(
    (path: string) => {
      // Opening a file is the one history step in a review: Back returns to
      // the file opened before it, and eventually out of the review. Mode,
      // base and range edits only rewrite the entry (see the mirror effect),
      // so Back never silently swaps the diff under the same address.
      const next = viewHash(descriptorRef.current, path);
      if (next && next !== window.location.hash) window.history.pushState(window.history.state, '', next);
      openFile(descriptor, path);
    },
    [descriptor, openFile],
  );

  /**
   * Back/Forward (and a hand-edited address) re-open what the address names.
   * Another review is App's business: the route changes, so it remounts us.
   */
  const restore = useCallback(
    (hash: string) => {
      const current = descriptorRef.current;
      const nav = navigationFor(hash, current, activeFileRef.current);
      if (nav.kind === 'ignore') return;
      if (nav.kind === 'file') {
        openFile(current, nav.file);
        return;
      }
      const target = nav.descriptor;
      commitsSeq.current += 1;
      if (isCommitsMode(target)) {
        void enterCommitsMode(false, { from: target.from, to: target.to, file: nav.file });
        return;
      }
      setCommitsLoading(false);
      setCommitSel(null);
      descriptorRef.current = target;
      setDescriptor(target);
      void load(target, nav.file, false);
    },
    [enterCommitsMode, load, openFile],
  );

  useEffect(() => {
    // popstate covers Back/Forward; hashchange covers an address typed by hand.
    const onNavigate = () => restore(window.location.hash);
    window.addEventListener('popstate', onNavigate);
    window.addEventListener('hashchange', onNavigate);
    return () => {
      window.removeEventListener('popstate', onNavigate);
      window.removeEventListener('hashchange', onNavigate);
    };
  }, [restore]);

  const openEditor = useCallback((anchor: EditorAnchor) => {
    setEditingId(null);
    setEditor(anchor);
  }, []);
  const closeEditor = useCallback(() => setEditor(null), []);
  const startEdit = useCallback((id: string) => {
    setEditor(null);
    setEditingId(id);
  }, []);
  const cancelEdit = useCallback(() => setEditingId(null), []);

  const createComment = useCallback(
    async (text: string) => {
      const value = text.trim();
      if (!editor) return false;
      if (!value) {
        toast('Пустой комментарий не сохраняю', true);
        return false;
      }
      try {
        const lo = editor.start === null || editor.end === null ? null : Math.min(editor.start, editor.end);
        const hi = editor.start === null || editor.end === null ? null : Math.max(editor.start, editor.end);
        const commit = commitSel ? commitContextFor(commits, commitSel) : undefined;
        await api.createComment(descriptor, { file: editor.file, startLine: lo, endLine: hi, text: value, commit });
        setEditor(null);
        await refreshComments();
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },
    [descriptor, editor, fail, refreshComments, toast, commitSel, commits],
  );

  const createGeneralComment = useCallback(
    async (text: string) => {
      const value = text.trim();
      if (!value) {
        toast('Пустой комментарий не сохраняю', true);
        return false;
      }
      try {
        await api.createGeneralComment(descriptor, value);
        await refreshComments();
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },
    [descriptor, fail, refreshComments, toast],
  );

  const updateComment = useCallback(
    async (id: string, text: string) => {
      const value = text.trim();
      if (!value) {
        toast('Пустой комментарий не сохраняю', true);
        return false;
      }
      try {
        await api.updateComment(descriptor, id, value);
        setEditingId(null);
        await refreshComments();
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },
    [descriptor, fail, refreshComments, toast],
  );

  const deleteComment = useCallback(
    async (id: string) => {
      try {
        await api.deleteComment(descriptor, id);
        await refreshComments();
      } catch (e) {
        fail(e);
      }
    },
    [descriptor, fail, refreshComments],
  );

  const copyAll = useCallback(async () => {
    try {
      const text = await api.exportText(descriptor);
      const ok = await copyToClipboard(typeof text === 'string' ? text : String(text));
      // Export never mutates the store; re-read to prove it on screen.
      await refreshComments();
      toast(ok ? `Скопировано комментариев: ${comments.length}` : 'Не удалось скопировать — открой /api/export/text', !ok);
    } catch (e) {
      fail(e);
    }
  }, [comments.length, descriptor, fail, refreshComments, toast]);

  const exportMd = useCallback(async () => {
    try {
      const result = await api.exportFile(descriptor);
      await refreshComments();
      toast(`Записан ${result.file} (${result.count} шт.) → ${result.path}`);
    } catch (e) {
      fail(e);
    }
  }, [descriptor, fail, refreshComments, toast]);

  const clearAll = useCallback(async () => {
    const ok = await confirm({
      title: 'Очистить все комментарии?',
      body: `Будет удалено комментариев: ${comments.length}. Действие необратимо.`,
      confirmLabel: 'Удалить',
      danger: true,
    });
    if (!ok) {
      toast('Отменено — ничего не удалено');
      return;
    }
    try {
      const result = await api.clearAll(descriptor);
      setEditor(null);
      setEditingId(null);
      await refreshComments();
      toast(`Удалено комментариев: ${result.removed}`);
    } catch (e) {
      fail(e);
    }
  }, [comments.length, confirm, descriptor, fail, refreshComments, toast]);

  const commitsMode = useMemo(() => isCommitsMode(descriptor), [descriptor]);
  const commitsEmpty = commitsMode && commits.length === 0;
  const outsideCount = useMemo(
    () => (commitsMode && commitSel ? outsideComments(commits, commitSel, comments).length : 0),
    [commitsMode, commitSel, commits, comments],
  );

  const value = useMemo<Review>(
    () => ({
      descriptor,
      state,
      loading,
      loadError,
      comments,
      activeFile,
      activeDiff,
      editor,
      editingId,
      drafts,
      commits,
      commitsTruncated,
      commitsFallback,
      commitsBase,
      dirty,
      dirtyNoticeDismissed,
      commitsMode,
      commitsEmpty,
      commitsLoading,
      commitSel,
      outsideCount,
      reload,
      setMode,
      setBase,
      setPrCommitsView,
      setCommitSelection,
      expandSelectionToOutside,
      dismissDirtyNotice,
      selectFile,
      openEditor,
      closeEditor,
      startEdit,
      cancelEdit,
      createComment,
      createGeneralComment,
      updateComment,
      deleteComment,
      copyAll,
      exportMd,
      clearAll,
    }),
    [
      descriptor,
      state,
      loading,
      loadError,
      comments,
      activeFile,
      activeDiff,
      editor,
      editingId,
      drafts,
      commits,
      commitsTruncated,
      commitsFallback,
      commitsBase,
      dirty,
      dirtyNoticeDismissed,
      commitsMode,
      commitsEmpty,
      commitsLoading,
      commitSel,
      outsideCount,
      reload,
      setMode,
      setBase,
      setPrCommitsView,
      setCommitSelection,
      expandSelectionToOutside,
      dismissDirtyNotice,
      selectFile,
      openEditor,
      closeEditor,
      startEdit,
      cancelEdit,
      createComment,
      createGeneralComment,
      updateComment,
      deleteComment,
      copyAll,
      exportMd,
      clearAll,
    ],
  );

  return <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>;
}
