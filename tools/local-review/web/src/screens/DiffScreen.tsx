import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, IconButton, Link, Spinner, StateLabel } from '@primer/react';
import { Blankslate } from '@primer/react/experimental';
import { AlertIcon, HistoryIcon, LinkExternalIcon, ScreenNormalIcon, XIcon } from '@primer/octicons-react';
import { useReview } from '../review/ReviewContext';
import type { FileEntry, OrphanFile, PrMeta } from '../api/types';
import type { ViewMode } from '../lib/viewMode';
import { useFileFilter } from '../diff/useFileFilter';
import { FileSidebar } from '../diff/FileSidebar';
import { DiffPane } from '../diff/DiffPane';
import { CommitRail } from '../commits/CommitRail';
import { DirtyBanner } from '../commits/DirtyBanner';
import { CommentsPanel } from '../comments/CommentsPanel';
import { selHi, selLo } from '../review/commitSelection';
import { isTypingTarget, matchesEvent } from '../lib/keybindings';
import { portalOpen } from '../lib/portal';
import { CodeNavContext, type CodeNav, type CodeNavKeys, type NavQuery, type TextNav } from '../nav/codeNav';
import { diffTexts } from '../nav/textSources';
import { CloneBar } from '../pr/CloneBar';
import { NavPanel } from '../nav/NavPanel';
import { closeLspMenu, definitionAtCaret, navKeysBlocked, panelAtCaret } from '../diff/cm/lsp';
import { useConversation } from '../conversation/useConversation';
import { conversationFromHash } from '../lib/hash';
import '../diff/diff.css';

// The conversation page brings the markdown parser along; most reviews never open it.
const ConversationPage = lazy(() => import('../conversation/ConversationPage'));

function prStatus(pr: PrMeta): 'pullOpened' | 'pullClosed' | 'pullMerged' | 'draft' {
  if (pr.isDraft) return 'draft';
  const s = String(pr.state || '').toLowerCase();
  if (s === 'merged') return 'pullMerged';
  if (s === 'closed') return 'pullClosed';
  return 'pullOpened';
}

const STATUS_LABEL = { pullOpened: 'Open', pullClosed: 'Closed', pullMerged: 'Merged', draft: 'Draft' } as const;

function PrHeader({ pr }: { pr: PrMeta }) {
  const status = prStatus(pr);
  return (
    <header className="rv-pr-header">
      <h1 className="rv-pr-header__title">
        {pr.title} <span className="rv-pr-header__number">#{pr.number}</span>
      </h1>
      <div className="rv-pr-header__meta">
        <StateLabel status={status} size="small">
          {STATUS_LABEL[status]}
        </StateLabel>
        <span>
          {pr.owner}/{pr.repo}
        </span>
        {pr.author && <span>· {pr.author}</span>}
        {pr.baseRefName && pr.headRefName && (
          <span>
            · <span className="rv-branch">{pr.baseRefName}</span> ← <span className="rv-branch">{pr.headRefName}</span>
          </span>
        )}
        <Link href={pr.url} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto' }}>
          Открыть на GitHub <LinkExternalIcon size={12} />
        </Link>
      </div>
    </header>
  );
}

/**
 * The way out of Zen when there is no file header to put it in: no file
 * chosen, an empty history, a failed load. With a file open the button lives
 * in the file header instead (DiffPane), where it never covers the diff.
 */
function ZenExit({ onZen }: { onZen: (on: boolean) => void }) {
  return (
    <div className="rv-zen-exit">
      <Button leadingVisual={ScreenNormalIcon} onClick={() => onZen(false)}>
        Выйти из Zen <span className="rv-file-header__kbd">Esc</span>
      </Button>
    </div>
  );
}

const MODE_LABEL = { working: 'Рабочая копия', staged: 'Staged', base: 'Base', commits: 'Коммиты' } as const;

/**
 * Shown after «Открыть в <коммит>» from the comments panel: the diff now shows
 * old code, and the way back must not be a hunt for the right tab.
 */
function OldCommitBanner() {
  const review = useReview();
  const { returnTo, commitsMode, commits, commitSel } = review;
  if (!returnTo || !commitsMode || !commitSel) return null;
  const lo = commits[selLo(commitSel)];
  const hi = commits[selHi(commitSel)];
  if (!lo || !hi) return null;
  const range = lo === hi ? lo.short : `${lo.short}..${hi.short}`;
  const back =
    returnTo.source === 'local'
      ? MODE_LABEL[returnTo.mode]
      : returnTo.from && returnTo.to
        ? 'Коммиты'
        : 'Все изменения';
  return (
    <div className="rv-old-commit" role="status">
      <div className="rv-old-commit__body">
        Открыт коммит <code>{range}</code>, к которому написан комментарий. Дифф показывает код на тот момент.
      </div>
      <Button size="small" onClick={review.returnFromCommit}>
        Вернуться к «{back}»
      </Button>
      <IconButton icon={XIcon} aria-label="Остаться здесь и скрыть плашку" size="small" variant="invisible" onClick={review.dismissReturn} />
    </div>
  );
}

/**
 * GitHub lists at most 3000 files of a PR and 300 of a commit range. The rest
 * is not on screen and cannot be fetched, so the reviewer has to be told: a
 * silently short list reads as "that is the whole change".
 */
function TruncatedBanner() {
  const truncated = useReview().state?.truncated;
  if (!truncated) return null;
  return (
    <div className="cr-notice" role="status">
      <div className="cr-notice__body">
        {truncated.total === null ? (
          <>
            <strong>Список файлов может быть неполным</strong> — показаны первые {truncated.shown}. Для диапазона коммитов GitHub
            не отдаёт больше {truncated.limit} файлов и не сообщает, сколько их всего.
          </>
        ) : (
          <>
            <strong>Список файлов неполный</strong> — показаны первые {truncated.shown} из {truncated.total}. GitHub не отдаёт
            больше {truncated.limit} файлов одного PR-а.
          </>
        )}{' '}
        Остальные файлы здесь недоступны — посмотрите их в локальном клоне (вкладка «Папка»).
      </div>
    </div>
  );
}

type Props = {
  zen: boolean;
  onZen: (on: boolean) => void;
  commentsPanel: boolean;
  onCommentsPanel: (open: boolean) => void;
  /** The «просмотрено» shortcut; lives here and not in App, because it needs the review. */
  viewedKey: string;
  /** One file at a time, or all of them in one scroll; null until it is known. */
  viewMode: ViewMode | null;
  /** The setting: «Код» / «Просмотр» in one file switches every file. */
  renderAllFiles: boolean;
  /** Long lines wrap in every file. */
  wrap: boolean;
  onWrap: (on: boolean) => void;
  /** Go to definition, Back, Forward. */
  navKeys: CodeNavKeys;
  /** The navigation panel opened or closed: the header's «Комментарии» is not «on» behind it. */
  onNavPanel?: (open: boolean) => void;
  /** The PR's conversation page is open in place of the diff. */
  conversation: boolean;
  onConversation: (open: boolean) => void;
  /** Goes up on «Перечитать PR»: an opened conversation is read again. */
  conversationReload: number;
};

// Stable empties, so the filtering memo doesn't rerun while state is loading.
const NO_FILES: FileEntry[] = [];
const NO_ORPHANS: OrphanFile[] = [];

export function DiffScreen({
  zen,
  onZen,
  commentsPanel,
  onCommentsPanel,
  viewedKey,
  viewMode,
  renderAllFiles,
  wrap,
  onWrap,
  navKeys,
  onNavPanel,
  conversation,
  onConversation,
  conversationReload,
}: Props) {
  const {
    state,
    activeFile,
    loading,
    loadError,
    reload,
    commitsEmpty,
    commitsMode,
    commitsLoading,
    toggleActiveViewed,
    descriptor,
    lsp,
    navHistory,
    clone,
    diffs,
    reveal,
  } = useReview();

  // Only a PR has a conversation; the address may ask for one anywhere.
  const conversationOpen = conversation && descriptor.source === 'pr';
  const conversationData = useConversation(descriptor, conversationOpen, conversationReload);

  // Going to code from the conversation page — a comment picked in the
  // comments panel, «Открыть» on one — leaves the page: the diff is where
  // that code is. Opening a file takes the page out of the address (the
  // review writes it without `view`); a file that changes while the address
  // still asks for the page is Back returning to it, not a move away.
  const cameWith = useRef({ activeFile, reveal });
  useEffect(() => {
    const before = cameWith.current;
    cameWith.current = { activeFile, reveal };
    if (!conversationOpen) return;
    const fileOpened = before.activeFile !== activeFile && !conversationFromHash(window.location.hash);
    if (fileOpened || before.reveal !== reveal) onConversation(false);
  }, [conversationOpen, activeFile, reveal, onConversation]);
  // Above both panes: the sidebar edits the filter, the feed of all files obeys it.
  const filter = useFileFilter(state?.files ?? NO_FILES, state?.orphanFiles ?? NO_ORPHANS);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target) || portalOpen()) return;
      if (!matchesEvent(viewedKey, e)) return;
      e.preventDefault();
      toggleActiveViewed();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewedKey, toggleActiveViewed]);

  // The shown text goes to the language server when it is not the working
  // tree: the index (staged) or a commit range. Base compares against the
  // working tree, so its new side is on disk. A PR's clone counts as the
  // working tree only while it is at the commit the diff shows.
  const sendText =
    descriptor.source === 'local' ? descriptor.mode === 'staged' || descriptor.mode === 'commits' : clone?.onHead !== true;
  // A PR with no clone has no server: navigation searches the text of the
  // diff's files. Its file list is read at search time, not captured here.
  const noClone = descriptor.source === 'pr' && !(clone?.bound && clone.valid);
  const filesRef = useRef(state?.files);
  filesRef.current = state?.files;
  const textNav = useMemo<TextNav | null>(
    () => (noClone ? { files: () => diffTexts(diffs, filesRef.current ?? []) } : null),
    [noClone, diffs],
  );

  // The navigation panel (references, implementations, calls). It takes the
  // comments panel's place on the right while open — the diff keeps its
  // width — and the comments panel comes back when it closes. Each opening
  // is a new query: `nonce` remounts the panel with fresh answers.
  const [navPanel, setNavPanel] = useState<{ query: NavQuery; nonce: number } | null>(null);
  const openPanel = useCallback((query: NavQuery) => setNavPanel((p) => ({ query, nonce: (p?.nonce ?? 0) + 1 })), []);
  const closePanel = useCallback(() => setNavPanel(null), []);
  // The comments panel asked for (its button, its shortcut) wins the place
  // back. Hidden behind this panel it still reads as open, so the button's
  // click turns it «off» — which here means «show me the comments» too.
  const commentsWas = useRef(commentsPanel);
  const navOpen = useRef(false);
  navOpen.current = navPanel !== null;
  useLayoutEffect(() => {
    if (commentsWas.current === commentsPanel) return;
    commentsWas.current = commentsPanel;
    if (!navOpen.current) return;
    setNavPanel(null);
    if (!commentsPanel) onCommentsPanel(true);
  }, [commentsPanel, onCommentsPanel]);
  // Another repository or view: the answers were about other code.
  // A clone made or dropped meanwhile: the answers were by text, or by a server.
  const viewKey = JSON.stringify(descriptor);
  useEffect(() => setNavPanel(null), [viewKey, noClone]);
  const navPanelOpen = navPanel !== null;
  useEffect(() => onNavPanel?.(navPanelOpen), [navPanelOpen, onNavPanel]);
  useEffect(() => () => onNavPanel?.(false), [onNavPanel]);

  const codeNav = useMemo<CodeNav>(
    () => ({ session: lsp, history: navHistory, keys: navKeys, sendText, openPanel, text: textNav }),
    [lsp, navHistory, navKeys, sendText, openPanel, textNav],
  );

  // F12 (or its replacement) and Alt+←/→. F12 may open DevTools first: the
  // browser decides that, not the page — Ctrl+click and the menu always work.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (navKeysBlocked(e)) return;
      if (matchesEvent(navKeys.definition, e)) {
        if (definitionAtCaret()) e.preventDefault();
        return;
      }
      for (const [key, tab] of [
        [navKeys.references, 'references'],
        [navKeys.implementation, 'implementation'],
        [navKeys.callHierarchy, 'calls'],
      ] as const) {
        if (matchesEvent(key, e)) {
          if (panelAtCaret(tab)) e.preventDefault();
          return;
        }
      }
      // With nothing to go back to inside the review, the key stays the browser's.
      if (matchesEvent(navKeys.navBack, e)) {
        if (navHistory.back()) e.preventDefault();
        return;
      }
      if (matchesEvent(navKeys.navForward, e) && navHistory.forward()) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      closeLspMenu();
    };
  }, [navKeys, navHistory]);

  if (!state && loading) {
    return (
      <div className="rv-center">
        <Spinner size="large" />
      </div>
    );
  }

  // Commits mode with an empty history: /api/state is never called for it, so
  // `state` stays null without this being a load error.
  if (!state && commitsEmpty) {
    return (
      <div className="rv-diff-screen">
        {zen ? <ZenExit onZen={onZen} /> : <DirtyBanner />}
        <div className="rv-center">
          <Blankslate spacious>
            <Blankslate.Visual>
              <HistoryIcon size={24} />
            </Blankslate.Visual>
            <Blankslate.Heading>В репозитории ещё нет коммитов</Blankslate.Heading>
            <Blankslate.Description>Сделайте хотя бы один коммит, чтобы использовать режим «Коммиты».</Blankslate.Description>
            <Blankslate.PrimaryAction onClick={reload}>Обновить</Blankslate.PrimaryAction>
          </Blankslate>
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="rv-center">
        {zen && <ZenExit onZen={onZen} />}
        <Blankslate spacious>
          <Blankslate.Visual>
            <AlertIcon size={24} />
          </Blankslate.Visual>
          <Blankslate.Heading>Не удалось открыть дифф</Blankslate.Heading>
          <Blankslate.Description>{loadError}</Blankslate.Description>
          <Blankslate.PrimaryAction onClick={reload}>Повторить</Blankslate.PrimaryAction>
        </Blankslate>
      </div>
    );
  }

  if (conversationOpen) {
    return (
      <div className="rv-diff-screen">
        {state.pr && <PrHeader pr={state.pr} />}
        <Suspense
          fallback={
            <div className="rv-center">
              <Spinner size="large" />
            </div>
          }
        >
          <ConversationPage conversation={conversationData} commentsPanel={commentsPanel} onCommentsPanel={onCommentsPanel} />
        </Suspense>
      </div>
    );
  }

  return (
    <div className="rv-diff-screen">
      {/* Zen drops everything above the diff. Not rendering beats hiding: the
          commit rail owns key handlers and state of its own. */}
      {zen ? (
        // Also when the feed shows no file at all (the filter hid them): no
        // file, no header to hold the button.
        (!activeFile || (viewMode === 'all' && filter.shown.length + filter.shownOrphans.length === 0)) && <ZenExit onZen={onZen} />
      ) : (
        <>
          <CommitRail />
          <DirtyBanner />
          {state.pr && <PrHeader pr={state.pr} />}
          <CloneBar />
        </>
      )}
      <OldCommitBanner />
      <TruncatedBanner />
      {/* A reload keeps the previous files on screen; dim them and say what is
          loading, so a fresh commit pick doesn't look like it did nothing. */}
      <div className={`rv-diff-layout${loading ? ' is-loading' : ''}`} aria-busy={loading}>
        <FileSidebar filter={filter} />
        <main className="rv-content">
          <CodeNavContext.Provider value={codeNav}>
            <DiffPane
              zen={zen}
              onZen={onZen}
              panelOpen={commentsPanel && !navPanel}
              viewMode={viewMode}
              renderAllFiles={renderAllFiles}
              wrap={wrap}
              onWrap={onWrap}
              filter={filter}
            />
          </CodeNavContext.Provider>
        </main>
        {navPanel ? (
          <NavPanel key={navPanel.nonce} query={navPanel.query} onClose={closePanel} />
        ) : (
          commentsPanel && <CommentsPanel onClose={() => onCommentsPanel(false)} />
        )}
        {loading && (
          <div className="rv-reload" role="status">
            <div className="rv-reload__bar" />
            <div className="rv-reload__chip">
              <Spinner size="small" />
              {commitsLoading ? 'Загружаю историю коммитов…' : commitsMode ? 'Загружаю дифф выбранных коммитов…' : 'Загружаю дифф…'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
