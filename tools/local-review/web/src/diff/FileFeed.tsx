import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FileIcon } from '@primer/octicons-react';
import type { Comment, FileEntry } from '../api/types';
import type { DiffStore } from '../review/diffStore';
import { useFileDiff } from '../review/useFileDiff';
import { Empty, FileDiff, type FileDiffActions, type FileDiffProps } from './FileDiff';
import { currentIndexAt, isCollapsed, placeholderHeight, type CollapseChoice } from './feedMath';

/** One section of the feed: a file of the diff, or (at the end) a file that only has comments left. */
export type FeedFile = { path: string; entry: FileEntry | undefined; orphan: boolean };

/** What the feed decides for a file itself; the rest comes from the pane. */
type OwnProps = 'diff' | 'collapsed' | 'onCollapse' | 'placeholderHeight' | 'onRetry' | 'actions';

type Props = {
  files: FeedFile[];
  diffs: DiffStore;
  /** The file at the top of the screen, as the review knows it. */
  activeFile: string | null;
  /** «Bring this file on screen» (ReviewContext.fileFocus). */
  fileFocus: { path: string; nonce: number } | null;
  /** The reviewer scrolled to this file. */
  onCurrentFile: (path: string) => void;
  /** A pending «scroll to this comment»: its file has to be open and loaded. */
  reveal: { comment: Comment; nonce: number } | null;
  /** The file of the open new-comment form: it has to be open too. */
  editorFile: string | null;
  actions: FileDiffActions;
  fileProps: (file: FeedFile) => Omit<FileDiffProps, OwnProps>;
};

// A file starts loading this far before it scrolls into view.
const NEAR_MARGIN = '600px 0px';
// A file has to stay near this long before it loads, so dragging the scrollbar
// across hundreds of files does not ask the server for every one of them.
const NEAR_DELAY_MS = 150;
// How far below the top edge a file has to reach to become the current one.
const READING_LINE_PX = 64;
const SPY_DELAY_MS = 120;
// After the feed scrolls on its own, scroll events are not the reviewer's.
const QUIET_MS = 400;
// A requested file is kept at the top while the diffs around it load and
// change height: for this long after the last change, and never longer than
// the limit. Any scroll input of the reviewer's ends it at once.
const PIN_MS = 2000;
const PIN_LIMIT_MS = 15000;

type ItemProps = {
  file: FeedFile;
  diffs: DiffStore;
  near: boolean;
  collapsed: boolean;
  shared: Omit<FileDiffProps, OwnProps>;
  actions: FileDiffActions;
  onCollapse: (path: string, collapsed: boolean) => void;
  onRetry: (path: string) => void;
};

function FeedItem({ file, diffs, near, collapsed, shared, actions, onCollapse, onRetry }: ItemProps) {
  const diff = useFileDiff(diffs, file.path);
  // Loads when the file comes near, and again after a reload emptied the store.
  useEffect(() => {
    if (!near || collapsed || diff !== null) return;
    if (file.orphan) diffs.setOrphan(file.path);
    else void diffs.ensure(file.path);
  }, [near, collapsed, diff, diffs, file.orphan, file.path]);

  return (
    <div className="rv-feed__item" data-path={file.path}>
      <FileDiff
        {...shared}
        diff={diff}
        actions={actions}
        collapsed={collapsed}
        onCollapse={onCollapse}
        onRetry={onRetry}
        placeholderHeight={placeholderHeight(file.entry?.additions, file.entry?.deletions)}
      />
    </div>
  );
}

/**
 * Every file of the diff in one scroll. A file's diff is fetched and its
 * editor built only once it comes near the screen; a viewed file is collapsed
 * to its header and never loads. The file at the top is reported back as the
 * current one, and a request to open a file scrolls to it.
 */
export function FileFeed({ files, diffs, activeFile, fileFocus, onCurrentFile, reveal, editorFile, actions, fileProps }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState<ReadonlySet<string>>(() => new Set());
  const [choices, setChoices] = useState<Record<string, CollapseChoice>>({});
  const quietUntil = useRef(0);
  const pin = useRef<{ path: string; until: number; giveUp: number } | null>(null);
  const activeRef = useRef(activeFile);
  activeRef.current = activeFile;
  const filesRef = useRef(files);
  filesRef.current = files;

  const scroller = () => root.current?.closest<HTMLElement>('.rv-content') ?? null;
  const items = () => Array.from(root.current?.querySelectorAll<HTMLElement>('.rv-feed__item') ?? []);
  const itemOf = (path: string) => items().find((node) => node.dataset.path === path) ?? null;

  /** Puts the file's header at the top of the screen; false when the feed has no such file. */
  const aim = useCallback((path: string) => {
    const box = scroller();
    const node = itemOf(path);
    if (!box || !node) return false;
    const delta = node.getBoundingClientRect().top - box.getBoundingClientRect().top;
    if (Math.abs(delta) >= 1) {
      quietUntil.current = performance.now() + QUIET_MS;
      box.scrollTop += delta;
    }
    return true;
  }, []);

  /** `aim`, kept true while the files above and around finish loading. */
  const focus = useCallback(
    (path: string) => {
      const now = performance.now();
      pin.current = aim(path) ? { path, until: now + PIN_MS, giveUp: now + PIN_LIMIT_MS } : null;
    },
    [aim],
  );

  // Switching to the feed lands on the file that was open; after that, every
  // request to open a file scrolls to it. Scrolling is never an effect of
  // `activeFile` itself — the feed sets that while scrolling.
  const focusedNonce = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (focusedNonce.current === null) {
      focusedNonce.current = fileFocus?.nonce ?? 0;
      if (activeRef.current) focus(activeRef.current);
      return;
    }
    if (!fileFocus || fileFocus.nonce === focusedNonce.current) return;
    focusedNonce.current = fileFocus.nonce;
    focus(fileFocus.path);
  }, [fileFocus, focus]);

  const pathsKey = files.map((f) => f.path).join('\n');

  // Which files are near the screen. One observer for the whole feed.
  useEffect(() => {
    const box = scroller();
    if (!box) return;
    const latest = new Map<string, boolean>();
    let timer: number | undefined;
    const flush = () => {
      timer = undefined;
      setNear((prev) => {
        let next: Set<string> | null = null;
        for (const [path, on] of latest) {
          if (prev.has(path) === on) continue;
          next ??= new Set(prev);
          if (on) next.add(path);
          else next.delete(path);
        }
        latest.clear();
        return next ?? prev;
      });
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const path = (e.target as HTMLElement).dataset.path;
          if (path !== undefined) latest.set(path, e.isIntersecting);
        }
        if (timer === undefined) timer = window.setTimeout(flush, NEAR_DELAY_MS);
      },
      { root: box, rootMargin: NEAR_MARGIN },
    );
    items().forEach((node) => observer.observe(node));
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [pathsKey]);

  // The file at the top of the screen becomes the current one.
  useEffect(() => {
    const box = scroller();
    if (!box) return;
    let timer: number | undefined;
    const measure = () => {
      // While a requested file is being held at the top, that file is the current one.
      if (pin.current && performance.now() > pin.current.until) pin.current = null;
      if (pin.current || performance.now() < quietUntil.current) return;
      const nodes = items();
      const top = box.getBoundingClientRect().top;
      const index = currentIndexAt(
        nodes.map((node) => node.getBoundingClientRect().top - top),
        READING_LINE_PX,
      );
      const path = index >= 0 ? nodes[index].dataset.path : undefined;
      if (path !== undefined && path !== activeRef.current) onCurrentFile(path);
    };
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, SPY_DELAY_MS);
    };
    box.addEventListener('scroll', onScroll, { passive: true });
    // A changed list (the search, a rule) puts another file at the top
    // without any scrolling.
    onScroll();
    return () => {
      box.removeEventListener('scroll', onScroll);
      window.clearTimeout(timer);
    };
  }, [onCurrentFile, pathsKey]);

  // A requested file stays at the top while the feed changes height under it,
  // until the time is up or the reviewer scrolls.
  useEffect(() => {
    const box = scroller();
    const el = root.current;
    if (!box || !el) return;
    const resized = new ResizeObserver(() => {
      const p = pin.current;
      if (!p) return;
      const now = performance.now();
      if (now > p.until || now > p.giveUp) {
        pin.current = null;
        return;
      }
      // Still settling: a slow diff must not outlast the pin.
      p.until = now + PIN_MS;
      aim(p.path);
    });
    resized.observe(el);
    const release = () => {
      pin.current = null;
    };
    box.addEventListener('wheel', release, { passive: true });
    box.addEventListener('touchstart', release, { passive: true });
    box.addEventListener('pointerdown', release);
    window.addEventListener('keydown', release);
    return () => {
      resized.disconnect();
      box.removeEventListener('wheel', release);
      box.removeEventListener('touchstart', release);
      box.removeEventListener('pointerdown', release);
      window.removeEventListener('keydown', release);
    };
  }, [aim]);

  const open = useCallback((path: string) => {
    const viewed = Boolean(filesRef.current.find((f) => f.path === path)?.entry?.viewed);
    setChoices((prev) => (isCollapsed(viewed, prev[path]) ? { ...prev, [path]: { viewed, collapsed: false } } : prev));
  }, []);

  // A toggle made against a viewed mark that has since changed is spent: drop
  // it, or it would come back to life when the mark returns to what it was.
  useEffect(() => {
    setChoices((prev) => {
      let next: Record<string, CollapseChoice> | null = null;
      for (const file of files) {
        const choice = prev[file.path];
        if (!choice || choice.viewed === Boolean(file.entry?.viewed)) continue;
        next ??= { ...prev };
        delete next[file.path];
      }
      return next ?? prev;
    });
  }, [files]);

  // A comment can only be scrolled to in an open, loaded file. The line itself
  // is the editor's to scroll to once it exists (FileDiff); until then the
  // file's header is the nearest thing to show.
  useEffect(() => {
    const path = reveal?.comment.file;
    if (!path) return;
    const file = filesRef.current.find((f) => f.path === path);
    if (!file) return;
    open(path);
    pin.current = null;
    if (diffs.get(path)?.kind === 'ready') return;
    if (file.orphan) diffs.setOrphan(path);
    else void diffs.ensure(path);
    aim(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce]);

  // «Комментарий к файлу» on a collapsed file: the form is in the body.
  useEffect(() => {
    if (editorFile) open(editorFile);
  }, [editorFile, open]);

  // A file collapsed while its header was pinned would leave the reviewer
  // somewhere in the files below; bring its header back instead.
  const settle = useCallback(
    (path: string) => {
      window.requestAnimationFrame(() => {
        const box = scroller();
        const node = itemOf(path);
        if (box && node && node.getBoundingClientRect().top < box.getBoundingClientRect().top) aim(path);
      });
    },
    [aim],
  );

  const onCollapse = useCallback(
    (path: string, collapsed: boolean) => {
      const viewed = Boolean(filesRef.current.find((f) => f.path === path)?.entry?.viewed);
      setChoices((prev) => ({ ...prev, [path]: { viewed, collapsed } }));
      if (collapsed) settle(path);
    },
    [settle],
  );

  const onRetry = useCallback((path: string) => void diffs.ensure(path, { force: true }), [diffs]);

  const feedActions = useMemo<FileDiffActions>(
    () => ({
      ...actions,
      setFileViewed: (path, viewed) => {
        if (viewed) settle(path);
        return actions.setFileViewed(path, viewed);
      },
    }),
    [actions, settle],
  );

  return (
    <div className="rv-feed" ref={root}>
      {files.length === 0 && (
        <Empty icon={FileIcon} title="Нет файлов для показа">
          Поиск или правила в списке слева скрыли все файлы.
        </Empty>
      )}
      {files.map((file) => (
        <FeedItem
          key={file.path}
          file={file}
          diffs={diffs}
          near={near.has(file.path)}
          collapsed={isCollapsed(Boolean(file.entry?.viewed), choices[file.path])}
          shared={fileProps(file)}
          actions={feedActions}
          onCollapse={onCollapse}
          onRetry={onRetry}
        />
      ))}
      {files.length > 0 && <div className="rv-feed__end">Конец диффа · файлов: {files.length}</div>}
    </div>
  );
}
