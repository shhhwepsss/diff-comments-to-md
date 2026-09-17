import { Link, Spinner, StateLabel } from '@primer/react';
import { Blankslate } from '@primer/react/experimental';
import { AlertIcon, HistoryIcon, LinkExternalIcon } from '@primer/octicons-react';
import { useReview } from '../review/ReviewContext';
import type { PrMeta } from '../api/types';
import { FileSidebar } from '../diff/FileSidebar';
import { DiffPane } from '../diff/DiffPane';
import { CommitRail } from '../commits/CommitRail';
import { DirtyBanner } from '../commits/DirtyBanner';
import '../diff/diff.css';

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

export function DiffScreen() {
  const { state, loading, loadError, reload, commitsEmpty, commitsMode, commitsLoading } = useReview();

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
        <DirtyBanner />
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

  return (
    <div className="rv-diff-screen">
      <CommitRail />
      <DirtyBanner />
      {state.pr && <PrHeader pr={state.pr} />}
      {/* A reload keeps the previous files on screen; dim them and say what is
          loading, so a fresh commit pick doesn't look like it did nothing. */}
      <div className={`rv-diff-layout${loading ? ' is-loading' : ''}`} aria-busy={loading}>
        <FileSidebar />
        <main className="rv-content">
          <DiffPane />
        </main>
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
