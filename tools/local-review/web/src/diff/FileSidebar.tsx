import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { CounterLabel, FormControl, IconButton, TextInput, TreeView } from '@primer/react';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileAddedIcon,
  FileDiffIcon,
  FileMovedIcon,
  FileRemovedIcon,
  FilterIcon,
  KebabHorizontalIcon,
  QuestionIcon,
  XIcon,
} from '@primer/octicons-react';
import { useReview } from '../review/ReviewContext';
import type { FileEntry, OrphanFile } from '../api/types';
import { buildTree, type TreeNode } from './fileTree';
import { compileRule, hasRules, matchesSearch, passesRules, type FileRules } from './fileFilter';
import { viewHash, wantsNativeLink } from '../lib/hash';
import { clampSidebarWidth, parseSidebarWidth, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_WIDTH_KEY } from './sidebarWidth';
import { viewedCount } from '../review/viewed';

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

// Stable empties, so the filtering memo doesn't rerun while state is loading.
const NO_FILES: FileEntry[] = [];
const NO_ORPHANS: OrphanFile[] = [];

type RuleFieldProps = {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  error: string | null;
  onChange: (next: string) => void;
};

function RuleField({ id, label, placeholder, value, error, onChange }: RuleFieldProps) {
  return (
    <FormControl id={id}>
      <FormControl.Label>{label}</FormControl.Label>
      <TextInput
        block
        monospace
        size="small"
        spellCheck={false}
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        validationStatus={error ? 'error' : undefined}
        onChange={(e) => onChange(e.target.value)}
        trailingAction={
          value ? <TextInput.Action icon={XIcon} aria-label="Очистить" onClick={() => onChange('')} /> : undefined
        }
      />
      {error && <FormControl.Validation variant="error">Неверный regexp: {error}. Правило не применяется.</FormControl.Validation>}
    </FormControl>
  );
}

export function FileSidebar() {
  const review = useReview();
  const { state, comments, activeFile } = review;
  const [search, setSearch] = useState('');
  // Rules are session-only: they live here and die with a reload.
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [rulesOpen, setRulesOpen] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(true);
  const [width, setWidth] = useSidebarWidth();

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of comments) if (c.file !== null) m.set(c.file, (m.get(c.file) || 0) + 1);
    return m;
  }, [comments]);

  const includeRule = useMemo(() => compileRule(include), [include]);
  const excludeRule = useMemo(() => compileRule(exclude), [exclude]);
  const rules: FileRules = useMemo(
    () => ({ include: includeRule.regex, exclude: excludeRule.regex }),
    [includeRule, excludeRule],
  );
  const rulesActive = hasRules(rules);

  const files = state?.files ?? NO_FILES;
  const orphans = state?.orphanFiles ?? NO_ORPHANS;
  // Search narrows everything; rules only decide between the tree and the
  // hidden section, so a file hidden by a rule can still be found.
  const { shown, hidden, shownOrphans, hiddenOrphans } = useMemo(() => {
    const foundFiles = files.filter((f) => matchesSearch(f.path, search));
    const foundOrphans = orphans.filter((f) => matchesSearch(f.path, search));
    return {
      shown: foundFiles.filter((f) => passesRules(f.path, rules)),
      hidden: foundFiles.filter((f) => !passesRules(f.path, rules)),
      shownOrphans: foundOrphans.filter((f) => passesRules(f.path, rules)),
      hiddenOrphans: foundOrphans.filter((f) => !passesRules(f.path, rules)),
    };
  }, [files, orphans, search, rules]);
  const hiddenCount = hidden.length + hiddenOrphans.length;
  const tree = useMemo(() => buildTree(shown, (f) => f.path), [shown]);

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

  // Files are real links, so the browser's own gestures work: middle click
  // and Ctrl/Cmd/Shift+click open the file in a new tab, on the same diff —
  // the address carries the mode, base and commit range as well as the file.
  // A plain click, Enter or Space stays in this tab without navigating.
  const open = (path: string) => (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    if (wantsNativeLink(event)) return;
    event.preventDefault();
    review.selectFile(path);
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
        as="a"
        href={viewHash(review.descriptor, node.path)}
        className="rv-tree-link"
        id={`file:${node.path}`}
        key={`file:${node.path}`}
        current={node.path === activeFile}
        onSelect={open(node.path)}
        title={node.item.oldPath ? `${node.item.oldPath} → ${node.path}` : node.path}
      >
        <TreeView.LeadingVisual>
          <StatusIcon file={node.item} />
        </TreeView.LeadingVisual>
        <span className={node.item.viewed ? 'rv-tree-name is-viewed' : 'rv-tree-name'}>{node.name}</span>
        {trailing(node.path, node.item.viewed)}
      </TreeView.Item>
    );

  const renderOrphan = (f: OrphanFile, idPrefix = 'orphan') => (
    <TreeView.Item
      as="a"
      href={viewHash(review.descriptor, f.path)}
      className="rv-tree-link"
      id={`${idPrefix}:${f.path}`}
      key={`${idPrefix}:${f.path}`}
      current={f.path === activeFile}
      onSelect={open(f.path)}
      title={`${f.path} — нет в текущем диффе`}
    >
      <TreeView.LeadingVisual>
        <QuestionIcon className="rv-status" />
      </TreeView.LeadingVisual>
      {f.path}
      {trailing(f.path)}
    </TreeView.Item>
  );

  // Hidden files are flat full paths: the path is what the rules matched.
  const renderHidden = (f: FileEntry) => (
    <TreeView.Item
      as="a"
      href={viewHash(review.descriptor, f.path)}
      className="rv-tree-link"
      id={`hidden:${f.path}`}
      key={`hidden:${f.path}`}
      current={f.path === activeFile}
      onSelect={open(f.path)}
      title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
    >
      <TreeView.LeadingVisual>
        <StatusIcon file={f} />
      </TreeView.LeadingVisual>
      <span className={f.viewed ? 'rv-tree-name is-viewed' : 'rv-tree-name'}>{f.path}</span>
      {trailing(f.path, f.viewed)}
    </TreeView.Item>
  );

  return (
    <nav className="rv-sidebar" aria-label="Файлы" style={{ width }}>
      <div className="rv-sidebar__head">
        <div className="rv-sidebar__range" title={state?.rangeLabel}>
          <span className="rv-sidebar__count">
            Файлов: {files.length}
            {files.length > 0 && <span className="rv-sidebar__viewed"> · просмотрено {viewedCount(files)}</span>}
          </span>
          {state?.rangeLabel && <span className="rv-sidebar__label">{state.rangeLabel}</span>}
        </div>
        <div className="rv-sidebar__search">
          <TextInput
            block
            size="small"
            leadingVisual={FilterIcon}
            placeholder="Найти файл"
            aria-label="Найти файл"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="rv-rules-toggle">
            <IconButton
              icon={KebabHorizontalIcon}
              size="small"
              variant="invisible"
              aria-label={rulesActive && !rulesOpen ? 'Правила показа файлов (действуют)' : 'Правила показа файлов'}
              aria-expanded={rulesOpen}
              aria-controls="rv-file-rules"
              className={rulesOpen ? 'is-open' : undefined}
              onClick={() => setRulesOpen((v) => !v)}
            />
            {rulesActive && !rulesOpen && <span className="rv-rules-toggle__dot" aria-hidden="true" />}
          </span>
        </div>
        {rulesOpen && (
          <div id="rv-file-rules" className="rv-rules">
            <RuleField
              id="rv-rule-include"
              label="Показывать файлы"
              placeholder="regexp, напр. ^src/"
              value={include}
              error={includeRule.error}
              onChange={setInclude}
            />
            <RuleField
              id="rv-rule-exclude"
              label="Скрывать файлы"
              placeholder="regexp, напр. \.lock$"
              value={exclude}
              error={excludeRule.error}
              onChange={setExclude}
            />
          </div>
        )}
      </div>
      <div className="rv-sidebar__tree">
        {files.length === 0 && <div className="rv-sidebar__empty">Дифф пуст</div>}
        {files.length > 0 && shown.length === 0 && hidden.length === 0 && (
          <div className="rv-sidebar__empty">Ничего не найдено</div>
        )}
        {shown.length === 0 && hidden.length > 0 && <div className="rv-sidebar__empty">Все файлы скрыты правилами</div>}
        {tree.length > 0 && (
          <TreeView aria-label="Файлы диффа" truncate>
            {tree.map(renderNode)}
          </TreeView>
        )}
        {shownOrphans.length > 0 && (
          <>
            <div className="rv-sidebar__section">Вне диффа</div>
            <TreeView aria-label="Файлы вне диффа" truncate>
              {shownOrphans.map((f) => renderOrphan(f))}
            </TreeView>
          </>
        )}
        {hiddenCount > 0 && (
          <>
            <button
              type="button"
              className="rv-sidebar__section rv-sidebar__section--toggle"
              aria-expanded={hiddenOpen}
              onClick={() => setHiddenOpen((v) => !v)}
            >
              {hiddenOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
              Скрыто правилами
              <CounterLabel>{hiddenCount}</CounterLabel>
            </button>
            {hiddenOpen && (
              <TreeView aria-label="Файлы, скрытые правилами" truncate className="rv-hidden-files">
                {hidden.map(renderHidden)}
                {hiddenOrphans.map((f) => renderOrphan(f, 'hidden-orphan'))}
              </TreeView>
            )}
          </>
        )}
      </div>
      <ResizeHandle width={width} onResize={setWidth} />
    </nav>
  );
}
