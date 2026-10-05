import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, api, commitsListDescriptor, errorMessage, failureMessage } from '../api/client';
import type {
  Comment,
  Commit,
  Descriptor,
  DiffResponse,
  DirtyStatus,
  FileResponse,
  LocalDescriptor,
  Mode,
  PrCloneStatus,
  StateResponse,
} from '../api/types';
import { useToast } from '../lib/toast';
import { useConfirm } from '../lib/confirm';
import { copyToClipboard } from '../lib/clipboard';
import { descriptorFromHash, fileFromHash, hashFor, lineFromHash, navigationFor, viewHash } from '../lib/hash';
import { LspSession } from '../lsp/session';
import { NavHistory, type StorageLike } from '../nav/history';
import { createDraftStore, type DraftStore } from './drafts';
import { createDiffStore, type DiffStore } from './diffStore';
import { watchReturn } from './focusRevalidate';
import type { ViewMode } from '../lib/viewMode';
import { nextUnviewed, withViewedMany } from './viewed';
import { buildTree, filesOf } from '../diff/fileTree';
import { isStale, openTarget, viewKindOf, type AgeContext } from './commentAge';
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

// Coming back to the tab fires both a focus and a visibility event, and quick
// switching fires them over and over: one re-read per this long is enough.
const RETURN_GAP_MS = 5000;

/** Where a new comment goes: a line range in the new file, or the whole file. */
export type EditorAnchor = { file: string; start: number | null; end: number | null };

/** «Scroll this file to this line» (1-based), with the caret at column `ch`; `nonce` makes a repeat new. */
export type LineReveal = { path: string; line: number; ch?: number; nonce: number };

/** A place to jump to: a repository file and a zero-based LSP position in it. */
export type NavTarget = { path: string; line: number; character: number };

/**
 * A file outside the diff, shown whole: GET /api/file as a diff with nothing
 * changed. A file that is not there (a comment outlived it) is `missing`.
 */
function missingFile(path: string): DiffResponse {
  return { path, status: '', kind: '', hunks: [], binary: false, additions: null, deletions: null, oldText: null, newText: null, fullFile: true, missing: true };
}

function fullFileDiff(file: FileResponse): DiffResponse {
  return {
    path: file.path,
    status: '',
    kind: '',
    hunks: [],
    binary: file.binary,
    additions: null,
    deletions: null,
    oldText: file.text,
    newText: file.text,
    textUnavailable: file.textUnavailable,
    fullFile: true,
  };
}

function sessionStorageOrNull(): StorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export type Review = {
  descriptor: Descriptor;
  state: StateResponse | null;
  loading: boolean;
  loadError: string | null;
  comments: Comment[];
  /** The open file; in the feed of all files, the one at the top of the screen. */
  activeFile: string | null;
  /**
   * «Bring this file on screen», for the feed: set whenever a file is opened
   * on purpose (the sidebar, Back/Forward, a reload), never by scrolling.
   * `nonce` makes a repeat request for the same file new.
   */
  fileFocus: { path: string; nonce: number } | null;
  /** Diffs by path; read one with useFileDiff, so only that file re-renders when it loads. */
  diffs: DiffStore;
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
  /** What «старый комментарий» is measured against: the view and the branch history. */
  age: AgeContext;
  /** File comments written against code other than the code on screen. */
  staleIds: Set<string>;
  /** The comment the «all comments» panel points at; also highlighted in the diff. */
  currentCommentId: string | null;
  /** A pending «scroll the diff to this comment»; `nonce` makes a repeat request new. */
  reveal: { commentId: string; nonce: number } | null;
  /** The view «Открыть в <коммит>» left; set while that old commit is on screen. */
  returnTo: Descriptor | null;
  /** The language servers of this review: status and requests. */
  lsp: LspSession;
  /** Back / Forward through jumps, on top of the browser history. */
  navHistory: NavHistory;
  /** Files outside the diff that code navigation opened, in the order they were opened. */
  navFiles: string[];
  /** A pending «scroll to this line», set by a jump and by Back/Forward. */
  lineReveal: LineReveal | null;
  /**
   * Files outside the diff can be read: a local folder, or a PR with a clone.
   * They are then shown whole (and commented on); otherwise only listed.
   */
  filesReadable: boolean;
  /** A PR's local clone (lib/pr-clone.js); null for a folder and until it is known. */
  clone: PrCloneStatus | null;
  /** Re-reads the clone's status (and the language servers', which follow it). */
  refreshClone: () => Promise<PrCloneStatus | null>;
  /** A clone action answered with the new status: show it, and what it changes. */
  setCloneStatus: (next: PrCloneStatus) => void;

  reload: () => void;
  setMode: (mode: Mode) => void;
  setBase: (base: string) => void;
  /** Toggles the PR "Все изменения"/"Коммиты" view; no-op for a local descriptor. */
  setPrCommitsView: (on: boolean) => void;
  setCommitSelection: (anchor: number, head: number) => void;
  /** Grows the selection to cover every comment currently outside it. */
  expandSelectionToOutside: () => void;
  dismissDirtyNotice: () => void;
  setCurrentComment: (id: string | null) => void;
  /** Opens the comment's file (if another) and scrolls the diff to it. */
  revealComment: (id: string) => void;
  /** Commits view on the commit a stale comment was written against, then its line. */
  openCommentCommit: (id: string) => void;
  /** Back to the view «Открыть в» left. */
  returnFromCommit: () => void;
  dismissReturn: () => void;
  selectFile: (path: string) => void;
  /**
   * Go to definition's last step: opens `target` (a file of the diff, or any
   * other file of the repository, read-only) at its line, as a history step;
   * the entry left behind remembers `from`, so Back returns to that line.
   */
  navigateTo: (target: NavTarget, from: { path: string; line: number | null }) => void;
  /** Drops a file from «Открыто через навигацию». */
  closeNavFile: (path: string) => void;
  /**
   * The feed scrolled to this file. Only moves `activeFile` (and with it the
   * address): no history step, no fetch, and the open form stays open.
   */
  setCurrentFile: (path: string) => void;
  /** The feed tells which files it shows and in what order; null when it is gone. */
  setFeedOrder: (paths: readonly string[] | null) => void;
  /** Marks a file viewed against the diff currently shown; a changed diff drops the mark server-side. */
  setFileViewed: (path: string, viewed: boolean) => Promise<void>;
  /** The same for several files — a folder marked from the sidebar. */
  setFilesViewed: (paths: readonly string[], viewed: boolean) => Promise<void>;
  /**
   * The «просмотрено» shortcut: unmarks the open file if it is viewed;
   * otherwise marks it and opens the next unviewed file in sidebar order.
   */
  toggleActiveViewed: () => void;
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
  viewMode,
  children,
}: {
  initial: Descriptor;
  /** File named in the URL; opened on load when the diff (or an orphan) has it. */
  initialFile?: string | null;
  /** How the diff screen shows files; null until it is known. Owned by App, like Zen. */
  viewMode: ViewMode | null;
  children: ReactNode;
}) {
  // Read at call time: opening a file means different things in the two modes,
  // and the callbacks that do it outlive a mode switch.
  const feedRef = useRef(false);
  feedRef.current = viewMode === 'all';
  // The files the feed shows, in its order; null while there is no feed.
  const feedOrder = useRef<readonly string[] | null>(null);
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
  const [fileFocus, setFileFocus] = useState<{ path: string; nonce: number } | null>(null);
  const [editor, setEditor] = useState<EditorAnchor | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Back/Forward and the diff fetcher need the file list without re-subscribing on every load.
  const stateRef = useRef<StateResponse | null>(null);
  stateRef.current = state;
  // One store for the life of this review; the provider remounts per descriptor.
  const [drafts] = useState(createDraftStore);
  // Reads the descriptor at fetch time: the view (mode, base, range) changes
  // under one provider, and every change resets the store.
  // A file outside the diff (code navigation led there, or it has comments)
  // is read whole instead — asked for only when files can be read at all.
  // Never past the server's cache: a re-read renews it with the file list
  // (`api.state(d, true)`), and every diff asked for after that is of it.
  const [diffs] = useState(() =>
    createDiffStore((path) =>
      stateRef.current && !stateRef.current.files.some((f) => f.path === path)
        ? api.file(descriptorRef.current, path).then(fullFileDiff, (e: unknown) => {
            if (e instanceof ApiError && e.status === 404) return missingFile(path);
            throw e;
          })
        : api.diff(descriptorRef.current, path),
    ),
  );
  // A PR's clone: what makes its files outside the diff readable, and the
  // language server work.
  const [clone, setClone] = useState<PrCloneStatus | null>(null);
  const filesReadable = initial.source === 'local' || Boolean(clone?.bound && clone.valid);
  // Read by callbacks that outlive the render that knew the clone.
  const filesReadableRef = useRef(filesReadable);
  filesReadableRef.current = filesReadable;

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
  // Branch history outside commits mode, only to tell stale comments apart.
  const [ageHistory, setAgeHistory] = useState<{ commits: Commit[]; truncated: boolean }>({ commits: [], truncated: false });
  const [currentCommentId, setCurrentCommentId] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ commentId: string; nonce: number } | null>(null);
  const [returnTo, setReturnTo] = useState<Descriptor | null>(null);
  const [navFiles, setNavFiles] = useState<string[]>([]);
  // Read by the diff fetcher, which must know before the first render after a jump.
  const navFilesRef = useRef<string[]>([]);
  const [lineReveal, setLineReveal] = useState<LineReveal | null>(null);
  const [lsp] = useState(() => new LspSession(() => descriptorRef.current));
  const [navHistory] = useState(() => new NavHistory(window.history, sessionStorageOrNull(), hashFor(initial)));
  useEffect(() => {
    lsp.start();
    return () => lsp.stop();
  }, [lsp]);

  const cloneSeq = useRef(0);
  const cloneRef = useRef<PrCloneStatus | null>(null);
  const setCloneStatus = useCallback(
    (next: PrCloneStatus) => {
      cloneSeq.current += 1;
      const prev = cloneRef.current;
      // The same answer again (the bar re-reads it while a job runs): the whole
      // review reads `clone` from the context, so nothing re-renders for it.
      if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
      cloneRef.current = next;
      setClone(next);
      filesReadableRef.current = Boolean(next.bound && next.valid);
      // The file on screen was only listed (out of the diff, no clone): now it can be shown.
      const open = activeFileRef.current;
      if (filesReadableRef.current && open && diffs.get(open)?.kind === 'orphan') void diffs.ensure(open, { force: true });
      // The servers follow the clone: another root, another trust, or none — not a job's progress.
      const where = (c: PrCloneStatus | null) => JSON.stringify(c && [c.bound, c.valid, c.path, c.trusted, c.onHead]);
      if (where(prev) !== where(next)) void lsp.refresh();
    },
    [lsp, diffs],
  );
  const refreshClone = useCallback(async () => {
    const d = descriptorRef.current;
    if (d.source !== 'pr') return null;
    const seq = ++cloneSeq.current;
    try {
      const next = await api.prClone(d);
      if (seq !== cloneSeq.current) return next;
      setCloneStatus(next);
      return next;
    } catch {
      // Without the status the PR works by text, as if there were no clone.
      return null;
    }
  }, [setCloneStatus]);
  // Whether the clone is at the commit shown depends on the range, too.
  useEffect(() => {
    if (initial.source === 'pr') void refreshClone();
  }, [initial.source, refreshClone, descriptor.from, descriptor.to]);

  // Responses for a descriptor the user already left must not land. (For a
  // file's diff the store does the same, per path.)
  const stateSeq = useRef(0);
  const commitsSeq = useRef(0);
  const ageSeq = useRef(0);
  // Bumped by a comment re-read and by a viewed mark: the quiet re-read on a
  // return to the tab must not put older data over either.
  const commentsSeq = useRef(0);
  const viewedSeq = useRef(0);
  const activeFileRef = useRef<string | null>(null);
  activeFileRef.current = activeFile;
  // Read at call time by the quiet re-read, which outlives the render that started it.
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const editingIdRef = useRef(editingId);
  editingIdRef.current = editingId;

  const fail = useCallback((e: unknown) => toast(errorMessage(e), true), [toast]);

  const loadDiff = useCallback(
    async (path: string, orphan: boolean, fresh: boolean) => {
      // Re-reading the diff while the feed is on this file keeps the place in
      // it: the loaded diffs stay on screen (the store keeps them, stale), so
      // there is nothing to scroll back to.
      const sameSpot = feedRef.current && fresh && activeFileRef.current === path;
      setActiveFile(path);
      if (!sameSpot) setFileFocus((f) => ({ path, nonce: (f?.nonce ?? 0) + 1 }));
      // A file out of the diff is shown whole when it can be read; otherwise
      // only its comments are (a PR with no clone).
      const listedOnly = orphan && !filesReadableRef.current;
      if (feedRef.current) {
        // In the feed opening a file only scrolls to it: the form the reviewer
        // has open (maybe in another file) stays, and a diff already on screen
        // is not fetched again. A failure shows in the file's own section.
        if (listedOnly) diffs.setOrphan(path);
        else void diffs.ensure(path);
        return;
      }
      setEditor(null);
      setEditingId(null);
      if (listedOnly) {
        diffs.setOrphan(path);
        return;
      }
      // Forced: opening a file always re-reads it, the working copy may have moved on.
      const entry = await diffs.ensure(path, { force: true });
      // A failure of a file the reviewer already left is not worth a toast.
      if (entry?.kind === 'error' && activeFileRef.current === path) fail(entry.cause);
    },
    [diffs, fail],
  );

  /** Puts a file in «Открыто через навигацию»; the ref first, the fetcher reads it right away. */
  const addNavFile = useCallback((path: string) => {
    if (navFilesRef.current.includes(path)) return;
    navFilesRef.current = [...navFilesRef.current, path];
    setNavFiles(navFilesRef.current);
  }, []);

  // Quietly: without the history nothing is marked stale, the diff still works.
  const loadAgeHistory = useCallback(async (d: Descriptor, fresh: boolean) => {
    const seq = ++ageSeq.current;
    try {
      const data = await api.commits(commitsListDescriptor(d), fresh);
      if (seq === ageSeq.current) setAgeHistory({ commits: data.commits || [], truncated: Boolean(data.truncated) });
    } catch {
      if (seq === ageSeq.current) setAgeHistory({ commits: [], truncated: false });
    }
  }, []);

  const load = useCallback(
    async (d: Descriptor, keepFile: string | null, fresh: boolean, opts: { named?: boolean; line?: number } = {}) => {
      const seq = ++stateSeq.current;
      setLoading(true);
      // Commits mode keeps its own history (the rail's); every other view needs it fetched.
      if (!isCommitsMode(d)) void loadAgeHistory(d, fresh);
      try {
        const [next, commentData] = await Promise.all([api.state(d, fresh), api.comments(d)]);
        if (seq !== stateSeq.current) return;
        setState(next);
        // Before the render: the diff fetcher, asked below, tells by it a file of the diff from one outside it.
        stateRef.current = next;
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
        // The file list is of another diff now: nothing loaded before describes
        // it. A re-read of the same view (`fresh`) is the exception — there the
        // loaded diffs are still the best thing to show until the new ones come.
        diffs.reset({ keep: fresh });
        const inDiff = keepFile !== null && next.files.some((f) => f.path === keepFile);
        const inOrphans = keepFile !== null && next.orphanFiles.some((f) => f.path === keepFile);
        // A file outside the diff stays open as one when code navigation
        // opened it, or when the address names it (a reload, a link, Back).
        // Otherwise — a mode switch — a file the new view lacks is left for
        // the first one.
        const asNav =
          keepFile !== null &&
          !inDiff &&
          filesReadableRef.current &&
          (navFilesRef.current.includes(keepFile) || (Boolean(opts.named) && !inOrphans));
        if (asNav) addNavFile(keepFile);
        if (inDiff || inOrphans || asNav) {
          await loadDiff(keepFile, !inDiff && !asNav, fresh);
          if (opts.line) setLineReveal((r) => ({ path: keepFile, line: opts.line as number, nonce: (r?.nonce ?? 0) + 1 }));
        } else if (next.files.length) {
          // The feed starts at its top, and its order is the sidebar tree's.
          const first = feedRef.current ? filesOf(buildTree(next.files, (f) => f.path))[0] : next.files[0];
          await loadDiff(first.path, false, fresh);
        } else {
          setActiveFile(null);
        }
      } catch (e) {
        if (seq !== stateSeq.current) return;
        setLoadError(e instanceof Error ? e.message : String(e));
        fail(e);
      } finally {
        if (seq === stateSeq.current) setLoading(false);
      }
    },
    [diffs, fail, loadDiff, loadAgeHistory, addNavFile],
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
          diffs.reset();
          stateSeq.current += 1;
          setActiveFile(null);
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
    [diffs, fail, load],
  );

  useEffect(() => {
    // An address that already asks for a commit range enters that view the
    // long way: the rail needs its history, and /api/state needs a resolved
    // range, so the range in the address can't just be loaded as a diff.
    if (isCommitsMode(descriptor)) void enterCommitsMode(false, { from: descriptor.from, to: descriptor.to, file: initialFile });
    else void load(descriptor, initialFile, false, { named: true, line: lineFromHash(window.location.hash) ?? undefined });
    // Remember the choice so an empty hash after a restart lands here again.
    // The review works without it, but a silent failure means the next launch
    // quietly opens something else.
    api.saveSession(descriptor).catch((e) => toast(failureMessage('Не удалось запомнить сессию', e), true));
    // Mode/base changes reload through their own actions, keeping the file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror the open view — mode, base, commit range, file — into the address,
  // so a reload or a link copied out of it reproduces the same diff.
  // replaceState: only opening a file is a history step (see selectFile), and
  // it fires no hashchange, so this never re-enters the Back/Forward handler.
  // Skipped once the address points elsewhere (the user is leaving this review).
  useEffect(() => {
    // Not while a view loads: the descriptor is already the new one but the
    // open file is still the old one, and the address (which may name the
    // file and line Back is going to) would be overwritten with that.
    if (!state || loading) return;
    const current = window.location.hash;
    if (hashFor(descriptorFromHash(current)) !== hashFor(descriptor)) return;
    // The line a jump put in the address stays while its file is the open one.
    const line = activeFile && fileFromHash(current) === activeFile ? lineFromHash(current) : null;
    const next = viewHash(descriptor, activeFile, line);
    if (next !== current) window.history.replaceState(window.history.state, '', next);
  }, [state, descriptor, activeFile, loading]);

  const refreshComments = useCallback(async () => {
    commentsSeq.current += 1;
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

  /**
   * The quiet re-read for a return to the tab: what Sync fetches, but nothing
   * on screen is taken away while it runs — no overlay, the open form stays,
   * the place in the diff is kept — and a failure leaves the old data alone
   * (Sync is there to see why).
   */
  const revalidate = useCallback(async () => {
    // A load under way brings fresh data itself; a review that never loaded has Sync.
    if (loadingRef.current || !stateRef.current) return;
    const d = descriptorRef.current;
    const seq = ++stateSeq.current;
    const commitsAtStart = commitsSeq.current;
    const commentsAtStart = commentsSeq.current;
    const viewedAtStart = viewedSeq.current;
    const left = () => seq !== stateSeq.current || commitsAtStart !== commitsSeq.current || descriptorRef.current !== d;
    try {
      if (isCommitsMode(d)) {
        const history = await api.commits(commitsListDescriptor(d), true);
        if (left()) return;
        const list = history.commits || [];
        const sel = selectionForRange(list, d.from, d.to);
        // The range on screen is gone from the history (a rebase): picking
        // another one is a change of view, and that is Sync's to make.
        if (!sel) return;
        setCommits(list);
        setCommitsTruncated(Boolean(history.truncated));
        setCommitsFallback(Boolean(history.fallback));
        setCommitsBase(history.base ?? null);
        setDirty(history.dirty || { dirty: false, files: 0 });
        // The same commits, wherever they are in the list now.
        setCommitSel((prev) => (prev && prev.anchor > prev.head ? { anchor: sel.head, head: sel.anchor } : sel));
      } else {
        void loadAgeHistory(d, true);
      }
      const [next, commentData] = await Promise.all([api.state(d, true), api.comments(d)]);
      // A mark flipped meanwhile is newer than this answer, which would undo it on screen.
      if (left() || viewedAtStart !== viewedSeq.current) return;
      setState(next);
      stateRef.current = next;
      // So is a comment saved meanwhile.
      if (commentsAtStart === commentsSeq.current) setComments(commentData.comments);
      setLoadError(null);
      // The open form sits in the diff: that is not re-read under it.
      if (editorRef.current || editingIdRef.current) return;
      diffs.reset({ keep: true });
      const file = activeFileRef.current;
      if (file && next.files.some((f) => f.path === file)) {
        // Not forced: the diff on screen stays there until its replacement comes.
        void diffs.ensure(file);
      } else if (file && navFilesRef.current.includes(file)) {
        void diffs.ensure(file);
      } else if (file && next.orphanFiles.some((f) => f.path === file)) {
        if (filesReadableRef.current) void diffs.ensure(file);
        else diffs.setOrphan(file);
      } else if (next.files.length) {
        const first = feedRef.current ? filesOf(buildTree(next.files, (f) => f.path))[0] : next.files[0];
        await loadDiff(first.path, false, true);
      } else {
        setActiveFile(null);
      }
    } catch {
      // Quietly: what is on screen is still the best there is.
    }
  }, [diffs, loadAgeHistory, loadDiff]);

  useEffect(
    () =>
      watchReturn({
        win: window,
        doc: document,
        now: () => performance.now(),
        minGapMs: RETURN_GAP_MS,
        onReturn: () => void revalidate(),
      }),
    [revalidate],
  );

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
      setReturnTo(null);
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
      setReturnTo(null);
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

  const commitsMode = useMemo(() => isCommitsMode(descriptor), [descriptor]);
  const age = useMemo<AgeContext>(
    () => ({
      view: viewKindOf(descriptor),
      history: commitsMode ? commits : ageHistory.commits,
      truncated: commitsMode ? commitsTruncated : ageHistory.truncated,
      sel: commitSel,
    }),
    [descriptor, commitsMode, commits, commitsTruncated, ageHistory, commitSel],
  );
  const ageRef = useRef(age);
  ageRef.current = age;

  const openCommentCommit = useCallback(
    (id: string) => {
      const c = commentsRef.current.find((x) => x.id === id);
      if (!c || c.file === null) return;
      const { history, truncated } = ageRef.current;
      const target = openTarget(c, history, truncated);
      if (!target) return;
      const file = c.file;
      // Only the first jump remembers where to return: a second one from the
      // old commit still leads back to where the reviewer started.
      setReturnTo((prev) => prev ?? descriptorRef.current);
      setCurrentCommentId(id);
      void enterCommitsMode(false, { from: history[target.from].sha, to: history[target.to].sha, file }).then(() =>
        setReveal((r) => ({ commentId: id, nonce: (r?.nonce ?? 0) + 1 })),
      );
    },
    [enterCommitsMode],
  );

  const returnFromCommit = useCallback(() => {
    const target = returnTo;
    setReturnTo(null);
    if (!target) return;
    commitsSeq.current += 1;
    if (isCommitsMode(target)) {
      void enterCommitsMode(false, { from: target.from, to: target.to, file: activeFileRef.current });
      return;
    }
    setCommitsLoading(false);
    setCommitSel(null);
    descriptorRef.current = target;
    setDescriptor(target);
    void load(target, activeFileRef.current, false);
  }, [returnTo, enterCommitsMode, load]);

  const dismissReturn = useCallback(() => setReturnTo(null), []);

  /**
   * Opens `path` without touching history — the Back/Forward handler's way in.
   * A path that is neither in the diff nor among the files with comments is a
   * file code navigation led to (Back into it after a reload): shown whole.
   */
  const openFile = useCallback(
    (path: string) => {
      const s = stateRef.current;
      const inDiff = (s?.files ?? []).some((f) => f.path === path);
      const nav =
        !inDiff &&
        (navFilesRef.current.includes(path) || (filesReadableRef.current && !(s?.orphanFiles ?? []).some((f) => f.path === path)));
      if (nav) addNavFile(path);
      void loadDiff(path, !inDiff && !nav, false);
    },
    [loadDiff, addNavFile],
  );

  const selectFile = useCallback(
    (path: string) => {
      // Opening a file is the one history step in a review: Back returns to
      // the file opened before it, and eventually out of the review. Mode,
      // base and range edits only rewrite the entry (see the mirror effect),
      // so Back never silently swaps the diff under the same address.
      const next = viewHash(descriptorRef.current, path);
      if (next && next !== window.location.hash) navHistory.push(next);
      openFile(path);
    },
    [openFile, navHistory],
  );

  const navigateTo = useCallback(
    (target: NavTarget, from: { path: string; line: number | null }) => {
      const d = descriptorRef.current;
      // The entry being left remembers the line the jump started from.
      navHistory.replace(viewHash(d, from.path, from.line));
      navHistory.push(viewHash(d, target.path, target.line + 1));
      const inDiff = (stateRef.current?.files ?? []).some((f) => f.path === target.path);
      if (!inDiff) addNavFile(target.path);
      // Within one file only the line moves: the editor on screen stays.
      if (target.path !== from.path || target.path !== activeFileRef.current) openFile(target.path);
      setLineReveal((r) => ({ path: target.path, line: target.line + 1, ch: target.character, nonce: (r?.nonce ?? 0) + 1 }));
    },
    [navHistory, addNavFile, openFile],
  );

  const closeNavFile = useCallback(
    (path: string) => {
      navFilesRef.current = navFilesRef.current.filter((p) => p !== path);
      setNavFiles(navFilesRef.current);
      if (activeFileRef.current !== path) return;
      const files = stateRef.current?.files ?? [];
      const first = feedRef.current ? filesOf(buildTree(files, (f) => f.path))[0] : files[0];
      if (first) selectFile(first.path);
      else setActiveFile(null);
    },
    [selectFile],
  );

  const setCurrentFile = useCallback((path: string) => setActiveFile(path), []);

  const commentsRef = useRef<Comment[]>([]);
  commentsRef.current = comments;

  const setCurrentComment = useCallback((id: string | null) => setCurrentCommentId(id), []);

  const revealComment = useCallback(
    (id: string) => {
      const c = commentsRef.current.find((x) => x.id === id);
      if (!c || c.file === null) return;
      setCurrentCommentId(id);
      // The feed has every file on screen and scrolls to the comment itself.
      if (!feedRef.current && c.file !== activeFileRef.current) selectFile(c.file);
      setReveal((r) => ({ commentId: id, nonce: (r?.nonce ?? 0) + 1 }));
    },
    [selectFile],
  );

  const setFilesViewed = useCallback(
    async (paths: readonly string[], viewed: boolean) => {
      // The fingerprints and the view must be the ones on screen right now: an
      // address step (see `restore` below) can have changed both since this
      // callback was created. Only files whose flag actually flips are sent.
      const wanted = new Set(paths);
      const entries = (stateRef.current?.files ?? []).filter(
        (f) => wanted.has(f.path) && f.viewed !== viewed && (!viewed || f.fingerprint),
      );
      if (entries.length === 0) return;
      const changed = entries.map((f) => f.path);
      // Flip first: the checkbox must answer the click, not the network.
      viewedSeq.current += 1;
      setState((s) => (s ? withViewedMany(s, changed, viewed) : s));
      const descriptorNow = descriptorRef.current;
      const results = await Promise.allSettled(
        entries.map((f) => api.setViewed(descriptorNow, f.path, f.fingerprint, viewed)),
      );
      const failed = entries.filter((_, i) => results[i].status === 'rejected').map((f) => f.path);
      if (failed.length === 0) return;
      setState((s) => (s ? withViewedMany(s, failed, !viewed) : s));
      const first = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      const what = viewed ? 'Не удалось отметить просмотренным' : 'Не удалось снять отметку';
      const subject = failed.length === 1 ? failed[0] : `файлов: ${failed.length}`;
      toast(failureMessage(`${what}: ${subject}`, first?.reason), true);
    },
    [toast],
  );

  const setFileViewed = useCallback(
    (path: string, viewed: boolean) => setFilesViewed([path], viewed),
    [setFilesViewed],
  );

  const toggleActiveViewed = useCallback(() => {
    const path = activeFileRef.current;
    const files = stateRef.current?.files ?? [];
    const entry = files.find((f) => f.path === path);
    if (!path || !entry) return;
    // The shortcut acts on what the reviewer sees. In the feed the current
    // file can lag behind for a moment after the search or a rule hid it.
    if (feedRef.current && feedOrder.current && !feedOrder.current.includes(path)) return;
    if (entry.viewed) {
      void setFilesViewed([path], false);
      return;
    }
    if (!entry.fingerprint) return;
    // Worked out before the mark lands, so the file being marked is skipped
    // by nextUnviewed as the current one rather than by its (stale) flag.
    // In the feed «next» is the next file the feed shows: one hidden by the
    // search or a rule would become current without ever being on screen.
    const order = (feedRef.current && feedOrder.current) || filesOf(buildTree(files, (f) => f.path)).map((f) => f.path);
    const next = nextUnviewed(files, order, path);
    void setFilesViewed([path], true);
    if (next) selectFile(next);
    // Nowhere to go: the file just collapsed under the reviewer, so bring its
    // header back instead of leaving them in whatever is below it.
    else if (feedRef.current) setFileFocus((f) => ({ path, nonce: (f?.nonce ?? 0) + 1 }));
  }, [setFilesViewed, selectFile]);

  const setFeedOrder = useCallback((paths: readonly string[] | null) => {
    feedOrder.current = paths;
  }, []);

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
        if (nav.file !== activeFileRef.current) openFile(nav.file);
        const line = nav.line;
        if (line) setLineReveal((r) => ({ path: nav.file, line, nonce: (r?.nonce ?? 0) + 1 }));
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
      void load(target, nav.file, false, { named: true, line: nav.line });
    },
    [enterCommitsMode, load, openFile],
  );

  useEffect(() => {
    // popstate covers Back/Forward; hashchange covers an address typed by hand.
    const onNavigate = () => {
      navHistory.sync();
      restore(window.location.hash);
    };
    window.addEventListener('popstate', onNavigate);
    window.addEventListener('hashchange', onNavigate);
    return () => {
      window.removeEventListener('popstate', onNavigate);
      window.removeEventListener('hashchange', onNavigate);
    };
  }, [restore, navHistory]);

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

  const staleIds = useMemo(
    () => new Set(comments.filter((c) => c.file !== null && isStale(c, age)).map((c) => c.id)),
    [comments, age],
  );
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
      fileFocus,
      diffs,
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
      age,
      staleIds,
      currentCommentId,
      reveal,
      returnTo,
      lsp,
      navHistory,
      navFiles,
      lineReveal,
      filesReadable,
      clone,
      refreshClone,
      setCloneStatus,
      reload,
      setMode,
      setBase,
      setPrCommitsView,
      setCommitSelection,
      expandSelectionToOutside,
      dismissDirtyNotice,
      setCurrentComment,
      revealComment,
      openCommentCommit,
      returnFromCommit,
      dismissReturn,
      selectFile,
      navigateTo,
      closeNavFile,
      setCurrentFile,
      setFeedOrder,
      setFileViewed,
      setFilesViewed,
      toggleActiveViewed,
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
      fileFocus,
      diffs,
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
      age,
      staleIds,
      currentCommentId,
      reveal,
      returnTo,
      lsp,
      navHistory,
      navFiles,
      lineReveal,
      filesReadable,
      clone,
      refreshClone,
      setCloneStatus,
      reload,
      setMode,
      setBase,
      setPrCommitsView,
      setCommitSelection,
      expandSelectionToOutside,
      dismissDirtyNotice,
      setCurrentComment,
      revealComment,
      openCommentCommit,
      returnFromCommit,
      dismissReturn,
      selectFile,
      navigateTo,
      closeNavFile,
      setCurrentFile,
      setFeedOrder,
      setFileViewed,
      setFilesViewed,
      toggleActiveViewed,
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
