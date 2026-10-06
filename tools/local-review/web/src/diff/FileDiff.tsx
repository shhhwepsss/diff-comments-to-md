import {
  Component,
  lazy,
  memo,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { ActionList, ActionMenu, Button, Checkbox, CounterLabel, IconButton, SegmentedControl, Spinner } from '@primer/react';
import { Blankslate } from '@primer/react/experimental';
import {
  AlertIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CodeIcon,
  CommentIcon,
  EyeClosedIcon,
  EyeIcon,
  FileBinaryIcon,
  FileIcon,
  FoldIcon,
  KebabHorizontalIcon,
  QuestionIcon,
  ScreenFullIcon,
  ScreenNormalIcon,
} from '@primer/octicons-react';
import type { EditorAnchor, NavTarget } from '../review/ReviewContext';
import type { ActiveDiff } from '../review/diffStore';
import { failureMessage } from '../api/client';
import { copyToClipboard } from '../lib/clipboard';
import { useToast } from '../lib/toast';
import type { Comment, DiffResponse, FileEntry } from '../api/types';
import { DiffEditor } from './DiffEditor';
import { CommentCard, CommentForm } from './CommentCard';
import { stripFinalNewline, type LineRange } from './lineMap';
import { previewToRender } from './previewFile';
import { fileLayout } from './fileLayout';
import { OccurrenceHub } from './cm/occurrences';
import { FoldHub } from './cm/collapse';
import { LspHub } from './cm/lsp';
import { CodeNavContext, type CodeNav } from '../nav/codeNav';
import { indicatorFor } from '../lsp/session';
import { displayBinding } from '../lib/keybindings';

/**
 * «word N of M» with ↑/↓ in the file header. Its own component, subscribed to
 * the hub itself: a click on another word then redraws this, not the file.
 */
function OccurrenceCounter({ hub }: { hub: OccurrenceHub }) {
  const occ = useSyncExternalStore(hub.subscribe, hub.getSnapshot);
  if (!occ) return null;
  const single = occ.total < 2 && occ.index >= 0;
  return (
    <span className="rv-occ-counter" title="Вхождения слова в файле — Esc сбрасывает">
      {/* Only the text is announced, not the buttons beside it. */}
      <span className="rv-occ-counter__status" role="status">
        <code className="rv-occ-counter__word">{occ.word}</code>
        <span className="rv-occ-counter__pos">
          {occ.index >= 0 ? `${occ.index + 1} из ${occ.total}` : `${occ.total}`}
        </span>
      </span>
      <IconButton
        size="small"
        variant="invisible"
        icon={ArrowUpIcon}
        aria-label="Предыдущее вхождение"
        disabled={single}
        onClick={() => hub.step(-1)}
      />
      <IconButton
        size="small"
        variant="invisible"
        icon={ArrowDownIcon}
        aria-label="Следующее вхождение"
        disabled={single}
        onClick={() => hub.step(1)}
      />
    </span>
  );
}

/**
 * «Свернуть неизменённое» in the file header, while the reviewer has unfolded
 * runs of unchanged lines in this file. Subscribed to the hub itself, like the
 * counter above.
 */
function FoldAllButton({ hub }: { hub: FoldHub }) {
  const open = useSyncExternalStore(hub.subscribe, hub.getSnapshot);
  if (!open) return null;
  return (
    <Button size="small" variant="invisible" leadingVisual={FoldIcon} onClick={() => hub.collapseAll()}>
      Свернуть неизменённое
    </Button>
  );
}

/** ← → in the file header: Back / Forward through jumps (nav/history.ts). */
function NavButtons({ nav }: { nav: CodeNav }) {
  const { canBack, canForward } = useSyncExternalStore(nav.history.subscribe, nav.history.getSnapshot);
  const back = displayBinding(nav.keys.navBack);
  const forward = displayBinding(nav.keys.navForward);
  return (
    <span className="rv-nav-buttons">
      <IconButton
        size="small"
        variant="invisible"
        icon={ArrowLeftIcon}
        aria-label="Назад"
        tooltipDirection="s"
        description={back ? `Назад (${back})` : 'Назад'}
        disabled={!canBack}
        onClick={() => nav.history.back()}
      />
      <IconButton
        size="small"
        variant="invisible"
        icon={ArrowRightIcon}
        aria-label="Вперёд"
        tooltipDirection="s"
        description={forward ? `Вперёд (${forward})` : 'Вперёд'}
        disabled={!canForward}
        onClick={() => nav.history.forward()}
      />
    </span>
  );
}

/** «LSP · tsserver» / «индексация…» / «LSP не найден» for this file's language; nothing for a file no server handles. */
function LspIndicator({ nav, path }: { nav: CodeNav; path: string }) {
  const status = useSyncExternalStore(nav.session.subscribe, nav.session.getSnapshot);
  const indicator = indicatorFor(status, path);
  if (!indicator) return null;
  return (
    <span className={`rv-lsp-indicator is-${indicator.tone}`} title={indicator.title}>
      <i className="rv-lsp-indicator__dot" aria-hidden="true" />
      {indicator.text}
    </span>
  );
}

// marked + DOMPurify + markdown styles load only when a file is first rendered.
const MarkdownPreview = lazy(() => import('./MarkdownPreview'));
const HtmlPreview = lazy(() => import('./HtmlPreview'));

/**
 * A chunk that fails to load throws through render, and with no boundary that
 * unmounts the whole app. Instead the pane goes back to the source diff and
 * `onError` says why.
 */
class PreviewBoundary extends Component<{ onError: (e: unknown) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }
}

function lineCount(text: string): number {
  const t = stripFinalNewline(text);
  let n = 1;
  for (let i = 0; i < t.length; i++) {
    const ch = t.charCodeAt(i);
    if (ch === 10) n++;
    else if (ch === 13) {
      n++;
      if (t.charCodeAt(i + 1) === 10) i++;
    }
  }
  return n;
}

export function Empty({ icon: Icon, title, children }: { icon: typeof FileIcon; title: string; children?: ReactNode }) {
  return (
    <div className="rv-diff-empty">
      <Blankslate spacious>
        <Blankslate.Visual>
          <Icon size={24} />
        </Blankslate.Visual>
        <Blankslate.Heading>{title}</Blankslate.Heading>
        {children && <Blankslate.Description>{children}</Blankslate.Description>}
      </Blankslate>
    </div>
  );
}

/** Why a ready diff can't be shown line by line, or null when it can. */
function unavailableReason(diff: DiffResponse): { icon: typeof FileIcon; title: string; text: string } | null {
  if (diff.fullFile) {
    if (diff.missing) {
      return { icon: QuestionIcon, title: 'Файла нет в текущем диффе', text: 'И на диске его нет. Комментарии к нему сохранены и попадут в экспорт.' };
    }
    if (diff.binary) return { icon: FileBinaryIcon, title: 'Бинарный файл', text: 'Файл вне диффа, показать его текст нельзя.' };
    if (diff.newText == null) return { icon: AlertIcon, title: 'Текст файла недоступен', text: diff.textUnavailable || 'Сервер не вернул текст файла.' };
    return null;
  }
  if (diff.binary) {
    return { icon: FileBinaryIcon, title: 'Бинарный файл', text: 'Построчный дифф недоступен — оставь комментарий к файлу.' };
  }
  if (diff.missing) {
    return { icon: QuestionIcon, title: 'Файл не найден', text: 'Файла уже нет на диске.' };
  }
  const hasTexts = diff.oldText != null || diff.newText != null;
  if (!hasTexts) {
    // A file too big to send has no texts, and no hunks either when GitHub
    // left its patch out: that is "unavailable", not "unchanged".
    if (!diff.hunks.length && !diff.textUnavailable) {
      return { icon: FileIcon, title: 'Изменений содержимого нет', text: 'Возможно, изменился только режим файла или имя.' };
    }
    return {
      icon: AlertIcon,
      title: 'Текст файла недоступен',
      text: diff.textUnavailable || 'Сервер не вернул текст файла.',
    };
  }
  if ((diff.oldText ?? '') === (diff.newText ?? '')) {
    return { icon: FileIcon, title: 'Изменений содержимого нет', text: 'Возможно, изменился только режим файла или имя.' };
  }
  return null;
}

/** Unsaved text of the open new-comment form, and the file it belongs to. */
export type FormDraft = { file: string; text: string };

/** What a file does to the review; every one is stable between renders of the caller. */
export type FileDiffActions = {
  openEditor: (anchor: EditorAnchor) => void;
  closeEditor: () => void;
  createComment: (text: string) => Promise<boolean>;
  startEdit: (id: string) => void;
  cancelEdit: () => void;
  updateComment: (id: string, text: string) => Promise<boolean>;
  deleteComment: (id: string) => Promise<void>;
  setCurrentComment: (id: string | null) => void;
  setFileViewed: (path: string, viewed: boolean) => Promise<void>;
  /** Go to definition landed somewhere: open it (ReviewContext.navigateTo). */
  navigateTo: (target: NavTarget, from: { path: string; line: number | null }) => void;
};

export type FileDiffProps = {
  path: string;
  /** The file's row of the diff; absent for a file that is not in the diff. */
  entry: FileEntry | undefined;
  diff: ActiveDiff | null;
  /** Every comment of this file, stale ones too. */
  comments: Comment[];
  /** The open new-comment form, when it is this file's. */
  editor: EditorAnchor | null;
  /** The comment being edited, when it is one of this file's. */
  editingId: string | null;
  /** The comments panel's current comment, when the panel is open and it is one of this file's. */
  currentCommentId: string | null;
  /** A pending «scroll to this comment» for a comment of this file. */
  reveal: { comment: Comment; nonce: number } | null;
  onRevealed: (nonce: number) => void;
  /** The commit a stale comment was written against, or null for a current one. */
  staleLabel: (c: Comment) => string | null;
  draft: RefObject<FormDraft>;
  wrap: boolean;
  onWrap: (next: boolean) => void;
  /** Rendered markdown / html instead of the source diff. */
  rendered: boolean;
  /** The reviewer used the «Код» / «Просмотр» switch; other files may follow (renderMode.ts). */
  onRendered: (path: string, rendered: boolean) => void;
  /** This file alone changes its view: the others are not touched. */
  onFileRendered: (path: string, rendered: boolean) => void;
  commentsHidden: boolean;
  onCommentsHidden: (path: string, hidden: boolean) => void;
  /** Remote images (markdown) or resources (html) load for this file. */
  externalImages: boolean;
  onExternalImages: (path: string) => void;
  /** The scripts of this html file run in its preview. */
  scripts: boolean;
  onRunScripts: (path: string) => void;
  zen: boolean;
  onZen: (on: boolean) => void;
  actions: FileDiffActions;
  /** Only the header is drawn. Feed only: a file shown alone is never collapsed. */
  collapsed?: boolean;
  /** Given in the feed: the header gets a collapse/expand button. */
  onCollapse?: (path: string, collapsed: boolean) => void;
  /** Height held for a diff nobody has asked for yet, so the feed keeps its length. */
  placeholderHeight?: number;
  /** Given in the feed, where a failed diff is not reloaded by reopening the file. */
  onRetry?: (path: string) => void;
  /**
   * A file outside the diff: opened by code navigation, or left with comments.
   * When its text can be read (a folder, a PR's clone) it is shown whole, and
   * commented on like any other.
   */
  navFile?: boolean;
  /** A pending «scroll to this line» for this file (a jump, Back/Forward). */
  lineReveal?: { line: number; ch?: number; nonce: number } | null;
  onLineRevealed?: (nonce: number) => void;
};

/**
 * One file of the diff: its header and, under it, its comments and the diff
 * itself. Takes everything through props and re-renders only when they change,
 * so many of these can sit on one screen.
 */
export const FileDiff = memo(function FileDiff({
  path,
  entry,
  diff: activeDiff,
  comments,
  editor,
  editingId,
  currentCommentId,
  reveal,
  onRevealed,
  staleLabel,
  draft,
  wrap,
  onWrap,
  rendered: renderedChoice,
  onRendered,
  onFileRendered,
  commentsHidden,
  onCommentsHidden,
  externalImages,
  onExternalImages,
  scripts,
  onRunScripts,
  zen,
  onZen,
  actions,
  collapsed = false,
  onCollapse,
  placeholderHeight,
  onRetry,
  navFile = false,
  lineReveal = null,
  onLineRevealed,
}: FileDiffProps) {
  const toast = useToast();
  const nav = useContext(CodeNavContext);

  const diff = activeDiff?.kind === 'ready' ? activeDiff.diff : null;
  const reason = diff ? unavailableReason(diff) : null;
  const showsEditor = Boolean(diff && !reason);
  const docLines = showsEditor && diff ? lineCount(diff.newText ?? '') : 0;
  const preview = diff ? previewToRender(path, diff) : null;
  const rendered = Boolean(preview && renderedChoice);

  const { anchored, unanchored, blocks, selected, editorInDoc } = useMemo(
    () => fileLayout({ comments, commentsHidden, editingId, showsEditor, docLines, rendered, editor }),
    [comments, commentsHidden, editingId, showsEditor, docLines, rendered, editor],
  );

  const editorLabel = (file: string, start: number | null, end: number | null) =>
    start === null || end === null ? `${file} — комментарий к файлу` : start === end ? `${file}:L${start}` : `${file}:L${start}-L${end}`;

  const renderComment = (c: Comment) => (
    <CommentCard
      key={c.id}
      comment={c}
      stale={staleLabel(c)}
      current={currentCommentId === c.id}
      onSelect={() => actions.setCurrentComment(c.id)}
      editing={editingId === c.id}
      onEdit={() => actions.startEdit(c.id)}
      onCancelEdit={actions.cancelEdit}
      onSave={(text) => actions.updateComment(c.id, text)}
      onDelete={() => void actions.deleteComment(c.id)}
    />
  );

  const renderEditor = () =>
    editor ? (
      <CommentForm
        key="editor"
        label={editorLabel(editor.file, selected?.from ?? editor.start, selected?.to ?? editor.end)}
        // Text typed into another file's form is not this form's draft.
        initial={draft.current.file === path ? draft.current.text : ''}
        submitLabel="Сохранить"
        onSubmit={actions.createComment}
        onCancel={actions.closeEditor}
        onChange={(text) => {
          draft.current = { file: path, text };
        }}
      />
    ) : null;

  const byKey = useMemo(() => new Map(anchored.map((c) => [`c:${c.id}`, c])), [anchored]);
  const renderBlock = useCallback(
    (key: string) => {
      if (key === 'editor') return renderEditor();
      const c = byKey.get(key);
      return c ? renderComment(c) : null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byKey, editingId, editor, selected?.from, selected?.to, staleLabel, currentCommentId, actions],
  );

  // «Scroll to this comment», asked by the comments panel. A comment can only
  // be scrolled to where it is drawn: the code view, with the file's comments
  // shown.
  useEffect(() => {
    if (!reveal) return;
    onFileRendered(path, false);
    onCommentsHidden(path, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce, reveal?.comment.id, path]);
  const revealAnchored = reveal && anchored.some((c) => c.id === reveal.comment.id) ? reveal : null;
  const revealAbove = reveal && unanchored.some((c) => c.id === reveal.comment.id) ? reveal : null;
  const diffSettled = activeDiff !== null && activeDiff.kind !== 'loading';
  useEffect(() => {
    if (!revealAbove || !diffSettled) return;
    document.getElementById(`rv-comment-${revealAbove.comment.id}`)?.scrollIntoView({ block: 'center' });
    onRevealed(revealAbove.nonce);
  }, [revealAbove, diffSettled, onRevealed]);
  // A jump to a line leaves the rendered view too: the line is in the code.
  useEffect(() => {
    if (lineReveal) onFileRendered(path, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineReveal?.nonce, path]);
  // One reveal prop for the editor: a line jump (negative nonce, so the two
  // kinds never collide) or a comment.
  const editorReveal = useMemo(
    () =>
      lineReveal && !rendered
        ? { from: lineReveal.line, to: lineReveal.line, nonce: -lineReveal.nonce, ch: lineReveal.ch }
        : revealAnchored && !rendered
          ? {
              from: revealAnchored.comment.startLine ?? (revealAnchored.comment.endLine as number),
              to: revealAnchored.comment.endLine as number,
              nonce: revealAnchored.nonce,
            }
          : null,
    [lineReveal, revealAnchored, rendered],
  );
  const onEditorRevealed = useCallback(
    (nonce: number) => (nonce < 0 ? onLineRevealed?.(-nonce) : onRevealed(nonce)),
    [onLineRevealed, onRevealed],
  );

  // The clicked word's occurrences: the editor finds them, the header counts.
  const occurrences = useMemo(() => new OccurrenceHub(), []);
  // The runs of unchanged lines the reviewer unfolded: the editor keeps them, the header folds them back.
  const folds = useMemo(() => new FoldHub(), []);

  // Code navigation for this file. The hub outlives editor rebuilds; what it
  // needs from the review is refreshed here on every render.
  const lsp = useMemo(() => new LspHub(), []);
  lsp.path = path;
  lsp.session = nav?.session ?? null;
  lsp.sendText = Boolean(nav?.sendText) && !navFile;
  lsp.keys = nav?.keys ?? null;
  lsp.text = nav?.text ?? null;
  lsp.toast = toast;
  lsp.onNavigate = (loc, fromLine) => {
    if (loc.path) actions.navigateTo({ path: loc.path, line: loc.line, character: loc.character }, { path, line: fromLine });
  };
  lsp.onPanel = (query) => nav?.openPanel(query);

  const onSelectLines = useCallback(
    (r: LineRange) => actions.openEditor({ file: path, start: r.from, end: r.to }),
    [path, actions],
  );

  const copyPath = async () => {
    const ok = await copyToClipboard(path);
    toast(ok ? 'Путь скопирован' : 'Не удалось скопировать', !ok);
  };

  const oldPath = diff?.oldPath ?? entry?.oldPath ?? null;
  // The folder is read once, the name every time: the name stands out.
  const cut = path.lastIndexOf('/') + 1;
  const dir = path.slice(0, cut);
  const base = path.slice(cut);
  // The file list knows the counts before the diff is loaded (and for a
  // collapsed file it never is); the diff itself has the last word.
  const stat = diff
    ? diff.binary || diff.additions === null || diff.deletions === null
      ? null
      : { additions: diff.additions || 0, deletions: diff.deletions || 0 }
    : entry && entry.additions != null && entry.deletions != null
      ? { additions: entry.additions, deletions: entry.deletions }
      : null;

  return (
    <section className={collapsed ? 'rv-file is-collapsed' : 'rv-file'} data-path={path}>
      <div className="rv-file-header">
        {nav && !collapsed && <NavButtons nav={nav} />}
        {onCollapse && (
          <IconButton
            size="small"
            variant="invisible"
            icon={collapsed ? ChevronRightIcon : ChevronDownIcon}
            aria-label={collapsed ? 'Развернуть файл' : 'Свернуть файл'}
            aria-expanded={!collapsed}
            onClick={() => onCollapse(path, !collapsed)}
          />
        )}
        {/* A click copies the path as the repository has it; of a renamed file, the new one. */}
        <button
          type="button"
          className="rv-file-header__path"
          title={`${oldPath ? `${oldPath} → ${path}` : path} — клик копирует путь`}
          aria-label={`Скопировать путь ${path}`}
          onClick={() => void copyPath()}
        >
          {oldPath && oldPath !== path ? (
            <>
              <span className="rv-file-header__old">{oldPath}</span>
              <span className="rv-file-header__arrow">→</span>
            </>
          ) : null}
          <span className="rv-file-header__name">
            {dir && <span className="rv-file-header__dir">{dir}</span>}
            <span className="rv-file-header__base">{base}</span>
          </span>
        </button>
        {navFile && diff?.fullFile && (
          <span className="rv-nav-badge" title="Файл не входит в дифф: открыт переходом по коду или в нём есть комментарии">
            вне диффа
          </span>
        )}
        {stat && !navFile && (
          <span className="rv-diffstat">
            <span className="rv-diffstat__add">+{stat.additions}</span>
            <span className="rv-diffstat__del">−{stat.deletions}</span>
          </span>
        )}
        {comments.length > 0 && (
          // Hiding is in the «⋯» menu now, so the count is where it shows.
          <span
            className="rv-file-header__count"
            title={commentsHidden ? 'Комментарии к файлу скрыты — показать в «⋯»' : 'Комментариев к файлу'}
          >
            {commentsHidden ? <EyeClosedIcon size={14} /> : <CommentIcon size={14} />} <CounterLabel>{comments.length}</CounterLabel>
          </span>
        )}
        <div className="rv-file-header__spacer" />
        {!collapsed && !rendered && <FoldAllButton hub={folds} />}
        {!collapsed && !rendered && <OccurrenceCounter hub={occurrences} />}
        {nav && !collapsed && <LspIndicator nav={nav} path={path} />}
        {!collapsed && preview && (
          <SegmentedControl aria-label="Вид файла" size="small" onChange={(i) => onRendered(path, i === 1)}>
            <SegmentedControl.IconButton icon={CodeIcon} aria-label="Код" selected={!rendered} />
            <SegmentedControl.IconButton icon={EyeIcon} aria-label="Просмотр" selected={rendered} />
          </SegmentedControl>
        )}
        {/* In Zen this is the way out, and it says so: the header is sticky, so
            the button stays on screen while the file scrolls. With no file open
            there is no header — DiffScreen puts a floating one there instead. */}
        {zen && (
          <Button size="small" leadingVisual={ScreenNormalIcon} onClick={() => onZen(false)}>
            Выйти из Zen <span className="rv-file-header__kbd">Esc</span>
          </Button>
        )}
        {entry && (
          <label
            className={'rv-file-header__viewed' + (entry.viewed ? ' is-viewed' : '')}
            title={
              entry.fingerprint ? 'Отметка снимется сама, если дифф файла изменится' : 'Для этого файла нельзя запомнить версию диффа'
            }
          >
            <Checkbox
              checked={entry.viewed}
              disabled={!entry.fingerprint}
              onChange={(e) => void actions.setFileViewed(path, e.target.checked)}
            />
            Просмотрено
          </label>
        )}
        {/* What is done to one file now and then. Repeated on every file of
            the feed, so it is one quiet button rather than a row of them. */}
        <ActionMenu>
          <ActionMenu.Anchor>
            <IconButton icon={KebabHorizontalIcon} aria-label="Действия с файлом" size="small" variant="invisible" className="rv-file-header__more" />
          </ActionMenu.Anchor>
          <ActionMenu.Overlay width="small" align="end">
            <ActionList>
              <ActionList.Item onSelect={() => actions.openEditor({ file: path, start: null, end: null })}>
                <ActionList.LeadingVisual>
                  <CommentIcon />
                </ActionList.LeadingVisual>
                Комментарий к файлу
              </ActionList.Item>
              {!collapsed && comments.length > 0 && (
                <ActionList.Item onSelect={() => onCommentsHidden(path, !commentsHidden)}>
                  <ActionList.LeadingVisual>{commentsHidden ? <EyeIcon /> : <EyeClosedIcon />}</ActionList.LeadingVisual>
                  {commentsHidden ? 'Показать комментарии' : 'Скрыть комментарии'}
                  <ActionList.TrailingVisual>{comments.length}</ActionList.TrailingVisual>
                </ActionList.Item>
              )}
              <ActionList.Divider />
              <ActionList.Group selectionVariant="multiple">
                <ActionList.Item selected={wrap} onSelect={() => onWrap(!wrap)}>
                  Перенос строк
                </ActionList.Item>
              </ActionList.Group>
              {!zen && (
                <ActionList.Item onSelect={() => onZen(true)}>
                  <ActionList.LeadingVisual>
                    <ScreenFullIcon />
                  </ActionList.LeadingVisual>
                  Zen: только дифф
                </ActionList.Item>
              )}
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
      </div>

      {!collapsed && body()}
    </section>
  );

  function body() {
    return (
      <>
      {navFile && diff?.fullFile && !diff.missing && (
        <div className="rv-nav-banner" role="note">
          Файл не входит в дифф и показан целиком. Комментарии к его строкам — как обычно: клик по номеру строки; они попадут в экспорт.
        </div>
      )}
      {activeDiff === null && placeholderHeight !== undefined && (
        <div className="rv-file-placeholder" style={{ height: placeholderHeight }} aria-hidden="true" />
      )}
      {(unanchored.length > 0 || (editor && !editorInDoc)) && (
        <div className="rv-file-comments">
          {unanchored.length > 0 && <div className="rv-hint">Комментарии к файлу / вне текущего текста файла</div>}
          {unanchored.map(renderComment)}
          {editor && !editorInDoc && renderEditor()}
        </div>
      )}

      {activeDiff?.kind === 'loading' && (
        <div className="rv-diff-loading">
          <Spinner size="medium" />
        </div>
      )}
      {activeDiff?.kind === 'orphan' && (
        <Empty icon={QuestionIcon} title="Файла нет в текущем диффе">
          Комментарии к нему сохранены и попадут в экспорт.
        </Empty>
      )}
      {activeDiff?.kind === 'error' && (
        <Empty icon={AlertIcon} title="Не удалось загрузить дифф">
          {activeDiff.message}
          {onRetry && (
            <span className="rv-file-retry">
              <Button size="small" onClick={() => onRetry(path)}>
                Повторить
              </Button>
            </span>
          )}
        </Empty>
      )}
      {rendered && preview && (
        <>
          <div className="rv-hint rv-diff-hint">
            {preview.side === 'old' ? 'Файл удалён — показана прежняя версия. ' : ''}
            Только просмотр: комментарии к строкам — в режиме «Код»
            {anchored.length > 0 ? ` (${anchored.length})` : ''}.
          </div>
          <div className="rv-diff-frame">
            <PreviewBoundary
              onError={(e) => {
                onFileRendered(path, false);
                toast(failureMessage(`Просмотр ${preview.kind === 'html' ? 'HTML' : 'markdown'} не загрузился`, e), true);
              }}
            >
              <Suspense
                fallback={
                  <div className="rv-diff-loading">
                    <Spinner size="medium" />
                  </div>
                }
              >
                {preview.kind === 'html' ? (
                  <HtmlPreview
                    text={preview.text}
                    scripts={scripts}
                    onRunScripts={() => onRunScripts(path)}
                    loadExternal={externalImages}
                    onLoadExternal={() => onExternalImages(path)}
                  />
                ) : (
                  <MarkdownPreview text={preview.text} loadExternalImages={externalImages} onLoadExternalImages={() => onExternalImages(path)} />
                )}
              </Suspense>
            </PreviewBoundary>
          </div>
        </>
      )}
      {diff && reason && !rendered && (
        <Empty icon={reason.icon} title={reason.title}>
          {reason.text}
        </Empty>
      )}
      {diff && !reason && !rendered && (
        <div className="rv-diff-frame">
          <DiffEditor
            path={path}
            oldText={diff.oldText ?? ''}
            newText={diff.newText ?? ''}
            hunks={diff.hunks}
            deletedFile={diff.newText == null}
            wrap={wrap}
            blocks={blocks}
            selected={selected}
            renderBlock={renderBlock}
            onSelectLines={onSelectLines}
            reveal={editorReveal}
            onRevealed={onEditorRevealed}
            occurrences={occurrences}
            lsp={lsp}
            folds={folds}
            full={Boolean(diff.fullFile)}
          />
        </div>
      )}
      </>
    );
  }
});
