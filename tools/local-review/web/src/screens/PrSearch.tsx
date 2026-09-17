import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, FormControl, Heading, Select, Spinner, TextInput } from '@primer/react';
import { GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestDraftIcon, GitPullRequestIcon, MarkGithubIcon, SearchIcon } from '@primer/octicons-react';
import { api } from '../api/client';
import type { GhStatus, PrItem } from '../api/types';
import { formatDate } from '../lib/format';
import { hashFor } from '../lib/hash';
import './picker.css';

function PrIcon({ item }: { item: PrItem }) {
  const s = String(item.state || '').toLowerCase();
  if (item.isDraft) return <GitPullRequestDraftIcon className="rv-pr-icon rv-pr-icon--draft" aria-label="черновик" />;
  if (s === 'merged') return <GitMergeIcon className="rv-pr-icon rv-pr-icon--merged" aria-label="merged" />;
  if (s === 'closed') return <GitPullRequestClosedIcon className="rv-pr-icon rv-pr-icon--closed" aria-label="closed" />;
  return <GitPullRequestIcon className="rv-pr-icon rv-pr-icon--open" aria-label="open" />;
}

function openPr(item: PrItem) {
  if (!item.owner || !item.repo) return;
  window.location.hash = hashFor({ source: 'pr', host: item.host || 'github.com', owner: item.owner, repo: item.repo, number: item.number });
}

type Result = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; items: PrItem[]; homeDir: string; storedPrs: number };

export function PrSearch() {
  const [status, setStatus] = useState<GhStatus | null>(null);
  const [repo, setRepo] = useState('');
  const [query, setQuery] = useState('');
  const [prState, setPrState] = useState('open');
  const [result, setResult] = useState<Result>({ kind: 'idle' });

  const search = useCallback(async (params: { repo: string; q: string; state: string }) => {
    setResult({ kind: 'loading' });
    try {
      const data = await api.searchPrs({ repo: params.repo.trim(), q: params.q.trim(), state: params.state });
      setResult({ kind: 'ok', items: data.items, homeDir: data.homeDir, storedPrs: data.storedPrs });
    } catch (e) {
      // On screen, not in a toast that disappears.
      setResult({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .ghStatus()
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        if (s.installed && s.authenticated) void search({ repo: '', q: '', state: 'open' });
      })
      .catch((e) => alive && setStatus({ installed: false, authenticated: false, login: null, host: null, message: String(e?.message || e) }));
    return () => {
      alive = false;
    };
  }, [search]);

  const ready = Boolean(status?.installed && status?.authenticated);
  const run = () => void search({ repo, q: query, state: prState });

  return (
    <div className="rv-page">
      <div className="rv-page__head">
        <Heading as="h1" className="rv-page__title">
          GitHub PR
        </Heading>
        {status && ready && (
          <p className="rv-page__hint">
            <MarkGithubIcon /> gh: {status.login || '?'} @ {status.host || 'github.com'}
          </p>
        )}
      </div>

      {!status && <Spinner />}
      {status && !ready && (
        <Banner variant="warning" title="GitHub CLI недоступен" className="rv-page__banner">
          {status.message}
        </Banner>
      )}

      {ready && (
        <>
          <form
            className="rv-pr-form"
            onSubmit={(e) => {
              e.preventDefault();
              run();
            }}
          >
            <FormControl>
              <FormControl.Label>Репозиторий</FormControl.Label>
              <TextInput
                placeholder="owner/repo — необязательно"
                spellCheck={false}
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                className="rv-mono"
              />
            </FormControl>
            <FormControl className="rv-pr-form__grow">
              <FormControl.Label>Запрос</FormControl.Label>
              <TextInput
                block
                leadingVisual={SearchIcon}
                placeholder="поисковый запрос"
                spellCheck={false}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </FormControl>
            <FormControl>
              <FormControl.Label>Состояние</FormControl.Label>
              <Select
                value={prState}
                onChange={(e) => {
                  setPrState(e.target.value);
                  void search({ repo, q: query, state: e.target.value });
                }}
              >
                <Select.Option value="open">open</Select.Option>
                <Select.Option value="closed">closed</Select.Option>
                <Select.Option value="merged">merged</Select.Option>
                <Select.Option value="all">все</Select.Option>
              </Select>
            </FormControl>
            <Button type="submit" variant="primary" className="rv-pr-form__submit">
              Искать
            </Button>
          </form>

          <section className="rv-box">
            <div className="rv-box__head">
              <GitPullRequestIcon />
              <span className="rv-box__title">
                {result.kind === 'ok' ? `Найдено: ${result.items.length}` : 'Результаты'}
              </span>
              {result.kind === 'loading' && <Spinner size="small" />}
            </div>
            <ul className="rv-list">
              {result.kind === 'error' && <li className="rv-list__empty rv-list__empty--error">{result.message}</li>}
              {result.kind === 'ok' && result.items.length === 0 && <li className="rv-list__empty">Ничего не найдено</li>}
              {result.kind === 'ok' &&
                result.items.map((item) => {
                  const canOpen = Boolean(item.owner && item.repo);
                  return (
                    <li key={`${item.owner}/${item.repo}#${item.number}`} className="rv-row rv-row--pr">
                      <button type="button" className="rv-row__main" disabled={!canOpen} onClick={() => openPr(item)}>
                        <PrIcon item={item} />
                        <span className="rv-pr-row">
                          <span className="rv-pr-row__title">
                            {item.title} <span className="rv-pr-row__number">#{item.number}</span>
                          </span>
                          <span className="rv-pr-row__meta">
                            {[
                              item.owner && item.repo ? `${item.owner}/${item.repo}` : '',
                              item.author || '',
                              // Branch is unknown for a global search: gh search prs does not return it.
                              item.headRefName || '',
                              formatDate(item.updatedAt),
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </span>
                      </button>
                      <Button size="small" disabled={!canOpen} onClick={() => openPr(item)}>
                        Открыть
                      </Button>
                    </li>
                  );
                })}
            </ul>
          </section>
          {result.kind === 'ok' && (
            <p className="rv-page__hint">
              Комментарии к PR-ам: <span className="rv-mono">{result.homeDir}</span> (хранится PR-ов: {result.storedPrs})
            </p>
          )}
        </>
      )}
    </div>
  );
}
