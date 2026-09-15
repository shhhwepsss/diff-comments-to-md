import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { Comment, Descriptor, DiffResponse, LocalDescriptor, Mode, StateResponse } from '../api/types';
import { useToast } from '../lib/toast';
import { useConfirm } from '../lib/confirm';
import { createDraftStore, type DraftStore } from './drafts';

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

  reload: () => void;
  setMode: (mode: Mode) => void;
  setBase: (base: string) => void;
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

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

export function ReviewProvider({ initial, children }: { initial: Descriptor; children: ReactNode }) {
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

  // Responses for a file or descriptor the user already left must not land.
  const diffSeq = useRef(0);
  const stateSeq = useRef(0);
  const activeFileRef = useRef<string | null>(null);
  activeFileRef.current = activeFile;

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

  useEffect(() => {
    void load(descriptor, null, false);
    // Remember the choice so an empty hash after a restart lands here again.
    api.saveSession(descriptor).catch(() => {});
    // Mode/base changes reload through their own actions, keeping the file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshComments = useCallback(async () => {
    const data = await api.comments(descriptor);
    setComments(data.comments);
  }, [descriptor]);

  const reload = useCallback(() => {
    void load(descriptor, activeFileRef.current, true);
  }, [descriptor, load]);

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
    (mode: Mode) => updateLocal((d) => (d.mode === mode ? null : { ...d, mode })),
    [updateLocal],
  );

  const setBase = useCallback(
    (base: string) => {
      // Cleared field = back to the repository's default branch.
      const value = base.trim();
      updateLocal((d) => (d.base === value ? null : { ...d, base: value }));
    },
    [updateLocal],
  );

  const selectFile = useCallback(
    (path: string) => {
      const orphan = !(state?.files ?? []).some((f) => f.path === path);
      void loadDiff(descriptor, path, orphan, false);
    },
    [descriptor, loadDiff, state],
  );

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
        await api.createComment(descriptor, { file: editor.file, startLine: lo, endLine: hi, text: value });
        setEditor(null);
        await refreshComments();
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },
    [descriptor, editor, fail, refreshComments, toast],
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
      reload,
      setMode,
      setBase,
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
      reload,
      setMode,
      setBase,
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
