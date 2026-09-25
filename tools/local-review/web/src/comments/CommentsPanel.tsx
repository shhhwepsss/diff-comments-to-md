import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ActionList, ActionMenu, Button, CounterLabel, IconButton } from '@primer/react';
import { ArrowDownIcon, ArrowUpIcon, FilterIcon, HistoryIcon, LinkExternalIcon, PencilIcon, TrashIcon, XIcon } from '@primer/octicons-react';
import type { Comment } from '../api/types';
import { useReview } from '../review/ReviewContext';
import { editDraftKey } from '../review/drafts';
import { openTarget, ownCommitLabel, staleTarget } from '../review/commentAge';
import { CommentForm, StaleChip } from '../diff/CommentCard';
import { ResizeHandle, usePaneWidth } from '../diff/paneResize';
import { formatDate } from '../lib/format';
import { isTypingTarget } from '../lib/keybindings';
import { COMMENTS_PANEL_WIDTH, COMMENTS_PANEL_WIDTH_KEY } from '../lib/commentsPanel';
import { countByKind, filterItems, GROUP_LABEL, PANEL_FILTERS, panelItems, stepId, type PanelFilter, type PanelItem } from './panelList';
import './comments-panel.css';

function lineLabel(c: Comment): string {
  if (c.startLine === null) return 'весь файл';
  return c.endLine !== null && c.endLine !== c.startLine ? `L${c.startLine}–L${c.endLine}` : `L${c.startLine}`;
}

function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** True while a Primer dialog or side sheet is open: its keys are its own. */
function portalOpen(): boolean {
  return Boolean(document.getElementById('__primerPortalRoot__')?.childElementCount);
}

/**
 * Every comment of the review beside the diff, in export order. Not a dialog:
 * the diff stays usable, and picking a comment scrolls the diff to it. j / k
 * walk the list from anywhere but a text field.
 */
export function CommentsPanel({ onClose }: { onClose: () => void }) {
  const review = useReview();
  const { comments, state, staleIds, age, currentCommentId, drafts } = review;
  const [filter, setFilter] = useState<PanelFilter>('all');
  // Edited here, not through review.editingId: that would open a second form
  // for the same comment in the diff.
  const [editing, setEditing] = useState<string | null>(null);
  const [width, setWidth] = usePaneWidth(COMMENTS_PANEL_WIDTH_KEY, COMMENTS_PANEL_WIDTH);
  const list = useRef<HTMLDivElement>(null);

  const files = useMemo(() => (state?.files ?? []).map((f) => f.path), [state]);
  const all = useMemo(() => panelItems(comments, files, (c) => staleIds.has(c.id)), [comments, files, staleIds]);
  const items = useMemo(() => filterItems(all, filter), [all, filter]);
  const counts = useMemo(() => countByKind(all), [all]);
  const pos = items.findIndex((i) => i.comment.id === currentCommentId);

  const go = (item: PanelItem) => {
    const c = item.comment;
    setEditing(null);
    if (item.kind === 'general') review.setCurrentComment(c.id);
    else if (item.kind === 'orphan' && c.file) {
      review.setCurrentComment(c.id);
      review.selectFile(c.file);
    } else review.revealComment(c.id);
  };

  const step = (delta: number) => {
    const id = stepId(items, currentCommentId, delta);
    const item = items.find((i) => i.comment.id === id);
    if (item) go(item);
  };
  // The key handler outlives renders; it must see the latest list.
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || isTypingTarget(e.target) || portalOpen()) return;
      // By code, not key: the same physical keys on a Cyrillic layout (о / л).
      const delta = e.code === 'KeyJ' ? 1 : e.code === 'KeyK' ? -1 : 0;
      if (!delta || e.shiftKey) return;
      e.preventDefault();
      stepRef.current(delta);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Follow the current comment, also when it was picked in the diff.
  useEffect(() => {
    if (!currentCommentId) return;
    list.current?.querySelector(`[data-comment-id="${CSS.escape(currentCommentId)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [currentCommentId, filter]);

  const onRowKey = (e: ReactKeyboardEvent, item: PanelItem) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      go(item);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      step(e.key === 'ArrowDown' ? 1 : -1);
      requestAnimationFrame(() => list.current?.querySelector<HTMLElement>('.rv-cpanel__row.is-current')?.focus());
    }
  };

  const save = async (id: string, text: string) => {
    const saved = await review.updateComment(id, text);
    if (saved) {
      drafts.clear(editDraftKey(id));
      setEditing(null);
    }
    return saved;
  };

  const filterLabel = PANEL_FILTERS.find((f) => f.value === filter)?.label ?? 'Все';

  let lastKind: PanelItem['kind'] | null = null;
  const rows = items.map((item) => {
    const c = item.comment;
    const current = c.id === currentCommentId;
    const stale = item.kind === 'stale';
    const target = stale ? openTarget(c, age.history, age.truncated) : null;
    const label = stale ? ownCommitLabel(c, age.history, age.truncated) : null;
    const section =
      item.kind !== lastKind ? (
        <div className="rv-cpanel__section" key={`s:${item.kind}`}>
          {GROUP_LABEL[item.kind]} <CounterLabel>{counts[item.kind]}</CounterLabel>
        </div>
      ) : null;
    lastKind = item.kind;
    const isEditing = editing === c.id;
    return [
      section,
      <div
        key={c.id}
        data-comment-id={c.id}
        className={'rv-cpanel__row' + (current ? ' is-current' : '') + (stale ? ' is-stale' : '')}
        role="button"
        tabIndex={0}
        aria-current={current || undefined}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button, textarea, a')) return;
          if (!isEditing) go(item);
        }}
        onKeyDown={(e) => onRowKey(e, item)}
      >
        <div className="rv-cpanel__meta">
          <span className="rv-cpanel__where" title={c.file ?? undefined}>
            {c.file === null ? (
              'Общий комментарий'
            ) : (
              <>
                <b>{baseName(c.file)}</b> {lineLabel(c)}
              </>
            )}
          </span>
          <span className="rv-cpanel__date">{formatDate(c.updatedAt)}</span>
        </div>
        {stale && <StaleChip target={staleTarget(c, age.history, age.truncated)} />}
        {isEditing ? (
          <CommentForm
            initial={drafts.get(editDraftKey(c.id)) ?? c.text}
            submitLabel="Сохранить"
            onChange={(text) => drafts.set(editDraftKey(c.id), text)}
            onSubmit={(text) => save(c.id, text)}
            onCancel={() => {
              drafts.clear(editDraftKey(c.id));
              setEditing(null);
            }}
          />
        ) : (
          <div className={'rv-cpanel__text' + (current ? ' is-open' : '')}>{c.text}</div>
        )}
        {current && !isEditing && (
          <div className="rv-cpanel__actions">
            {item.kind !== 'general' && item.kind !== 'orphan' && (
              <Button size="small" leadingVisual={LinkExternalIcon} onClick={() => review.revealComment(c.id)}>
                К строке
              </Button>
            )}
            {target && label && (
              <Button size="small" leadingVisual={HistoryIcon} onClick={() => review.openCommentCommit(c.id)}>
                Открыть в {label}
              </Button>
            )}
            <Button size="small" leadingVisual={PencilIcon} onClick={() => setEditing(c.id)}>
              Изменить
            </Button>
            <Button
              size="small"
              variant="danger"
              leadingVisual={TrashIcon}
              onClick={() => {
                drafts.clear(editDraftKey(c.id));
                void review.deleteComment(c.id);
              }}
            >
              Удалить
            </Button>
          </div>
        )}
      </div>,
    ];
  });

  return (
    <aside className="rv-cpanel" style={{ width }} aria-label="Все комментарии">
      <ResizeHandle width={width} onResize={setWidth} pane={COMMENTS_PANEL_WIDTH} edge="left" className="rv-cpanel__resize" />
      <div className="rv-cpanel__head">
        <strong>Комментарии</strong>
        <span className="rv-cpanel__pos">
          {pos === -1 ? '—' : pos + 1} / {items.length}
        </span>
        <IconButton icon={ArrowUpIcon} aria-label="Предыдущий (k)" size="small" variant="invisible" onClick={() => step(-1)} />
        <IconButton icon={ArrowDownIcon} aria-label="Следующий (j)" size="small" variant="invisible" onClick={() => step(1)} />
        <IconButton icon={XIcon} aria-label="Закрыть панель" size="small" variant="invisible" onClick={onClose} />
      </div>
      <div className="rv-cpanel__tools">
        <ActionMenu>
          <ActionMenu.Button size="small" leadingVisual={FilterIcon}>
            {filterLabel}
          </ActionMenu.Button>
          <ActionMenu.Overlay width="small">
            <ActionList selectionVariant="single">
              {PANEL_FILTERS.map((f) => (
                <ActionList.Item key={f.value} selected={f.value === filter} onSelect={() => setFilter(f.value)}>
                  {f.label}
                  <ActionList.TrailingVisual>{counts[f.value]}</ActionList.TrailingVisual>
                </ActionList.Item>
              ))}
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
        <span className="rv-hint">
          <kbd>j</kbd> / <kbd>k</kbd> — по комментариям
        </span>
      </div>
      <div className="rv-cpanel__list" ref={list}>
        {items.length === 0 && (
          <div className="rv-cpanel__empty">{comments.length === 0 ? 'Комментариев пока нет.' : 'В этом фильтре пусто.'}</div>
        )}
        {rows}
      </div>
    </aside>
  );
}
