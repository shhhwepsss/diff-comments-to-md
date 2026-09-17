import { useMemo, useState, type ReactNode } from 'react';
import { CounterLabel, TextInput, TreeView } from '@primer/react';
import {
  CheckIcon,
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
import { viewedCount } from '../review/viewed';

function StatusIcon({ file }: { file: FileEntry }) {
  const kind = (file.status || 'M')[0];
  if (file.untracked || kind === 'U') return <FileAddedIcon className="rv-status rv-status--untracked" aria-label="untracked" />;
  if (kind === 'A') return <FileAddedIcon className="rv-status rv-status--added" aria-label="добавлен" />;
  if (kind === 'D') return <FileRemovedIcon className="rv-status rv-status--deleted" aria-label="удалён" />;
  if (kind === 'R' || kind === 'C') return <FileMovedIcon className="rv-status rv-status--renamed" aria-label="переименован" />;
  return <FileDiffIcon className="rv-status rv-status--modified" aria-label="изменён" />;
}

export function FileSidebar() {
  const review = useReview();
  const { state, comments, activeFile } = review;
  const [filter, setFilter] = useState('');

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

  const trailing = (path: string, viewed = false): ReactNode => {
    const n = counts.get(path) || 0;
    if (!n && !viewed) return null;
    const label = [n ? `комментариев: ${n}` : '', viewed ? 'просмотрен' : ''].filter(Boolean).join(', ');
    return (
      <TreeView.TrailingVisual label={label}>
        <span className="rv-tree-trailing">
          {n ? <CounterLabel>{n}</CounterLabel> : null}
          {viewed ? <CheckIcon className="rv-viewed-mark" /> : null}
        </span>
      </TreeView.TrailingVisual>
    );
  };

  const renderNode = (node: TreeNode<FileEntry>): ReactNode =>
    node.type === 'dir' ? (
      <TreeView.Item id={`dir:${node.path}`} key={`dir:${node.path}`} defaultExpanded>
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
        <span className={node.item.viewed ? 'rv-tree-name is-viewed' : 'rv-tree-name'}>{node.name}</span>
        {trailing(node.path, node.item.viewed)}
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
    <nav className="rv-sidebar" aria-label="Файлы">
      <div className="rv-sidebar__head">
        <div className="rv-sidebar__range" title={state?.rangeLabel}>
          <span className="rv-sidebar__count">
            Файлов: {files.length}
            {files.length > 0 && <span className="rv-sidebar__viewed"> · просмотрено {viewedCount(files)}</span>}
          </span>
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
    </nav>
  );
}
