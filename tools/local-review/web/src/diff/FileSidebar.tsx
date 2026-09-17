import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { CounterLabel, TextInput, TreeView } from '@primer/react';
import {
  FileAddedIcon,
  FileDiffIcon,
  FileMovedIcon,
  FileRemovedIcon,
  FilterIcon,
  QuestionIcon,
} from '@primer/octicons-react';
import { useReview } from '../review/ReviewContext';
import type { FileEntry, OrphanFile } from '../api/types';
import { buildTree, type TreeNode } from './fileTree';
import { clampSidebarWidth, parseSidebarWidth, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_WIDTH_KEY } from './sidebarWidth';

function StatusIcon({ file }: { file: FileEntry }) {
  const kind = (file.status || 'M')[0];
  if (file.untracked || kind === 'U') return <FileAddedIcon className="rv-status rv-status--untracked" aria-label="untracked" />;
  if (kind === 'A') return <FileAddedIcon className="rv-status rv-status--added" aria-label="добавлен" />;
  if (kind === 'D') return <FileRemovedIcon className="rv-status rv-status--deleted" aria-label="удалён" />;
  if (kind === 'R' || kind === 'C') return <FileMovedIcon className="rv-status rv-status--renamed" aria-label="переименован" />;
  return <FileDiffIcon className="rv-status rv-status--modified" aria-label="изменён" />;
}

function readWidth(): number {
  try {
    return parseSidebarWidth(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function saveWidth(width: number) {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    // storage blocked — the width just won't survive a reload
  }
}

function useViewportWidth(): number {
  const [viewport, setViewport] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return viewport;
}

/**
 * The stored width is what the user chose; the rendered one is re-clamped to
 * the current viewport, so shrinking the window doesn't forget the choice.
 */
function useSidebarWidth(): [number, (next: number, persist: boolean) => void] {
  const viewport = useViewportWidth();
  const [chosen, setChosen] = useState(readWidth);
  const update = useCallback((next: number, persist: boolean) => {
    setChosen(next);
    if (persist) saveWidth(next);
  }, []);
  return [clampSidebarWidth(chosen, viewport), update];
}

function ResizeHandle({ width, onResize }: { width: number; onResize: (next: number, persist: boolean) => void }) {
  const drag = useRef<{ startX: number; startWidth: number; last: number } | null>(null);

  const endDrag = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.body.classList.remove('rv-dragging-sidebar');
    onResize(d.last, true);
  };

  // Mid-drag unmount (e.g. switching screens) must not leave the cursor stuck.
  useEffect(() => () => document.body.classList.remove('rv-dragging-sidebar'), []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // Otherwise the browser selects file names while we drag.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width, last: width };
    document.body.classList.add('rv-dragging-sidebar');
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const next = clampSidebarWidth(d.startWidth + event.clientX - d.startX, window.innerWidth);
    if (next === d.last) return;
    d.last = next;
    onResize(next, false);
  };

  return (
    <div
      className="rv-sidebar__resize"
      role="separator"
      aria-orientation="vertical"
      title="Потяните, чтобы изменить ширину"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}

export function FileSidebar() {
  const review = useReview();
  const { state, comments, activeFile } = review;
  const [filter, setFilter] = useState('');
  const [width, setWidth] = useSidebarWidth();

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of comments) if (c.file !== null) m.set(c.file, (m.get(c.file) || 0) + 1);
    return m;
  }, [comments]);

  const files = state?.files ?? [];
  const orphans = state?.orphanFiles ?? [];
  const needle = filter.trim().toLowerCase();
  const visible = needle ? files.filter((f) => f.path.toLowerCase().includes(needle)) : files;
  const visibleOrphans = needle ? orphans.filter((f) => f.path.toLowerCase().includes(needle)) : orphans;
  const tree = useMemo(() => buildTree(visible, (f) => f.path), [visible]);

  const trailing = (path: string): ReactNode => {
    const n = counts.get(path) || 0;
    return n ? (
      <TreeView.TrailingVisual label={`комментариев: ${n}`}>
        <CounterLabel>{n}</CounterLabel>
      </TreeView.TrailingVisual>
    ) : null;
  };

  const renderNode = (node: TreeNode<FileEntry>): ReactNode =>
    node.type === 'dir' ? (
      <TreeView.Item id={`dir:${node.path}`} key={`dir:${node.path}`} title={node.path} defaultExpanded>
        <TreeView.LeadingVisual>
          <TreeView.DirectoryIcon />
        </TreeView.LeadingVisual>
        {node.name}
        <TreeView.SubTree>{node.children.map(renderNode)}</TreeView.SubTree>
      </TreeView.Item>
    ) : (
      <TreeView.Item
        id={`file:${node.path}`}
        key={`file:${node.path}`}
        current={node.path === activeFile}
        onSelect={() => review.selectFile(node.path)}
        title={node.item.oldPath ? `${node.item.oldPath} → ${node.path}` : node.path}
      >
        <TreeView.LeadingVisual>
          <StatusIcon file={node.item} />
        </TreeView.LeadingVisual>
        {node.name}
        {trailing(node.path)}
      </TreeView.Item>
    );

  const renderOrphan = (f: OrphanFile) => (
    <TreeView.Item
      id={`orphan:${f.path}`}
      key={`orphan:${f.path}`}
      current={f.path === activeFile}
      onSelect={() => review.selectFile(f.path)}
      title={`${f.path} — нет в текущем диффе`}
    >
      <TreeView.LeadingVisual>
        <QuestionIcon className="rv-status" />
      </TreeView.LeadingVisual>
      {f.path}
      {trailing(f.path)}
    </TreeView.Item>
  );

  return (
    <nav className="rv-sidebar" aria-label="Файлы" style={{ width }}>
      <div className="rv-sidebar__head">
        <div className="rv-sidebar__range" title={state?.rangeLabel}>
          <span className="rv-sidebar__count">Файлов: {files.length}</span>
          {state?.rangeLabel && <span className="rv-sidebar__label">{state.rangeLabel}</span>}
        </div>
        <TextInput
          block
          size="small"
          leadingVisual={FilterIcon}
          placeholder="Фильтр файлов"
          aria-label="Фильтр файлов"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="rv-sidebar__tree">
        {files.length === 0 && <div className="rv-sidebar__empty">Дифф пуст</div>}
        {files.length > 0 && visible.length === 0 && <div className="rv-sidebar__empty">Ничего не найдено</div>}
        {tree.length > 0 && (
          <TreeView aria-label="Файлы диффа" truncate>
            {tree.map(renderNode)}
          </TreeView>
        )}
        {visibleOrphans.length > 0 && (
          <>
            <div className="rv-sidebar__section">Вне диффа</div>
            <TreeView aria-label="Файлы вне диффа" truncate>
              {visibleOrphans.map(renderOrphan)}
            </TreeView>
          </>
        )}
      </div>
      <ResizeHandle width={width} onResize={setWidth} />
    </nav>
  );
}
