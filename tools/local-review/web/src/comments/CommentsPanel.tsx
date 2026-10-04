import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Button, CounterLabel, IconButton, TextInput } from '@primer/react';
import { ArrowDownIcon, ArrowUpIcon, FilterIcon, HistoryIcon, LinkExternalIcon, PencilIcon, SearchIcon, TrashIcon, TriangleDownIcon, XIcon } from '@primer/octicons-react';
import type { Comment } from '../api/types';
import { useReview } from '../review/ReviewContext';
import { editDraftKey } from '../review/drafts';
import { openTarget, ownCommitLabel, staleTarget } from '../review/commentAge';
import { CommentForm, StaleChip } from '../diff/CommentCard';
import { ResizeHandle, usePaneWidth } from '../diff/paneResize';
import { formatDate } from '../lib/format';
import { isTypingTarget } from '../lib/keybindings';
import { portalOpen } from '../lib/portal';
import { TabbedSelect } from '../components/TabbedSelect';
import { COMMENTS_PANEL_WIDTH, COMMENTS_PANEL_WIDTH_KEY } from '../lib/commentsPanel';
import {
  countByKind,
  excerpt,
  filterItems,
  GROUP_LABEL,
  highlightParts,
  PANEL_FILTERS,
  panelItems,
  searchItems,
  stepId,
  type PanelFilter,
  type PanelItem,
} from './panelList';
import './comments-panel.css';

function lineLabel(c: Comment): string {
  if (c.startLine === null) return 'весь файл';
  return c.endLine !== null && c.endLine !== c.startLine ? `L${c.startLine}–L${c.endLine}` : `L${c.startLine}`;
}

function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** The file name; the whole path when the search matched a folder, so the hit is on screen. */
function pathLabel(path: string, query: string): string {
  const name = baseName(path);
  const hitIn = (text: string) => highlightParts(text, query).some((part) => part.hit);
  return !hitIn(name) && hitIn(path) ? path : name;
}

/** `text` with the search hits marked. */
function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, i) =>
        part.hit ? (
          <mark className="rv-cpanel__hit" key={i}>
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

/**
 * Every comment of the review beside the diff, in export order. Not a dialog:
 * the diff stays usable, and picking a comment scrolls the diff to it. j / k
 * walk the list from anywhere but a text field; / puts the cursor in the text
 * search, which narrows the list by comment text or file path.
 */
export function CommentsPanel({ onClose }: { onClose: () => void }) {
  const review = useReview();
  const { comments, state, staleIds, age, currentCommentId, drafts } = review;
  const [filter, setFilter] = useState<PanelFilter>('all');
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  // Edited here, not through review.editingId: that would open a second form
  // for the same comment in the diff.
  const [editing, setEditing] = useState<string | null>(null);
  const [width, setWidth] = usePaneWidth(COMMENTS_PANEL_WIDTH_KEY, COMMENTS_PANEL_WIDTH);
  const list = useRef<HTMLDivElement>(null);

  const files = useMemo(() => (state?.files ?? []).map((f) => f.path), [state]);
  const all = useMemo(() => panelItems(comments, files, (c) => staleIds.has(c.id)), [comments, files, staleIds]);
  const inFilter = useMemo(() => filterItems(all, filter), [all, filter]);
  const items = useMemo(() => searchItems(inFilter, query), [inFilter, query]);
  const counts = useMemo(() => countByKind(all), [all]);
  // Section headers count what is listed under them; the menu counts it all.
  const shownCounts = useMemo(() => countByKind(items), [items]);
  const searching = query.trim() !== '';
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
      // «/» goes to the text search: the character wherever the layout has it
      // (numpad, Shift+\ in Cyrillic), or its Latin key in any layout.
      if (e.key === '/' || (e.code === 'Slash' && !e.shiftKey)) {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
        return;
      }
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
  }, [currentCommentId, filter, query]);

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

  // The search field is a text field: the global shortcuts (j / k, Alt+V…)
  // stay off while the cursor is in it, so it has keys of its own. Enter and
  // the arrows walk the matches (Enter on the only match goes to it); Esc
  // empties the field, then leaves it.
  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      step(e.key === 'ArrowUp' ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (query) setQuery('');
      else e.currentTarget.blur();
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
          {GROUP_LABEL[item.kind]} <CounterLabel>{shownCounts[item.kind]}</CounterLabel>
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
                <b>
                  <Marked text={pathLabel(c.file, query)} query={query} />
                </b>{' '}
                {lineLabel(c)}
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
          <div className={'rv-cpanel__text' + (current ? ' is-open' : '')}>
            {/* Two lines are shown until the row is picked: start them at the match. */}
            <Marked text={current ? c.text : excerpt(c.text, query)} query={query} />
          </div>
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
        <TextInput
          ref={search}
          block
          size="small"
          className="rv-cpanel__search"
          leadingVisual={SearchIcon}
          aria-label="Поиск по комментариям"
          placeholder="Найти по тексту или файлу"
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
          trailingAction={
            query ? (
              <TextInput.Action
                icon={XIcon}
                aria-label="Очистить поиск"
                onClick={() => {
                  setQuery('');
                  search.current?.focus();
                }}
              />
            ) : undefined
          }
        />
        <TabbedSelect
          label="Какие комментарии показывать"
          options={PANEL_FILTERS.map((f) => ({ value: f.value, label: f.label, trailing: counts[f.value] }))}
          value={filter}
          onChange={setFilter}
          renderAnchor={(props) => (
            <Button {...props} size="small" leadingVisual={FilterIcon} trailingAction={TriangleDownIcon}>
              {filterLabel}
            </Button>
          )}
        />
        {searching ? (
          <span className="rv-hint rv-cpanel__found" role="status">
            {items.length} из {inFilter.length}
          </span>
        ) : (
          <span className="rv-hint">
            <kbd>j</kbd> / <kbd>k</kbd> — по комментариям, <kbd>/</kbd> — поиск
          </span>
        )}
      </div>
      <div className="rv-cpanel__list" ref={list}>
        {items.length === 0 &&
          (searching && inFilter.length > 0 ? (
            <div className="rv-cpanel__empty">
              <div>
                Ничего не найдено по запросу «<span className="rv-cpanel__query">{query.trim()}</span>».
              </div>
              <div className="rv-hint">
                Поиск идёт по тексту комментария и пути файла{filter === 'all' ? '' : `, только в группе «${filterLabel}»`}.
              </div>
              <Button
                size="small"
                onClick={() => {
                  setQuery('');
                  search.current?.focus();
                }}
              >
                Сбросить поиск
              </Button>
            </div>
          ) : (
            <div className="rv-cpanel__empty">{comments.length === 0 ? 'Комментариев пока нет.' : 'В этом фильтре пусто.'}</div>
          ))}
        {rows}
      </div>
    </aside>
  );
}
