import { useCallback, useEffect, useMemo, useState } from 'react';
import { Autocomplete, Banner, Button, FormControl, Heading, Select, Spinner, TextInput } from '@primer/react';
import { GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestDraftIcon, GitPullRequestIcon, MarkGithubIcon, SearchIcon } from '@primer/octicons-react';
import { api, errorMessage, failureMessage } from '../api/client';
import type { GhStatus, PrItem, RepoItem } from '../api/types';
import { formatDate } from '../lib/format';
import { formatRepoPushed, matchesRepo } from '../lib/repoList';
import { hashFor } from '../lib/hash';
import { type PrAuthorFilter, parsePrAuthor, readPrAuthor, writePrAuthor } from '../lib/prAuthor';
import { useToast } from '../lib/toast';
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
  const [repos, setRepos] = useState<RepoItem[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [prState, setPrState] = useState('open');
  const [author, setAuthor] = useState<PrAuthorFilter>(readPrAuthor);
  const [result, setResult] = useState<Result>({ kind: 'idle' });
  const toast = useToast();

  const search = useCallback(async (params: { repo: string; q: string; state: string; author: PrAuthorFilter }) => {
    setResult({ kind: 'loading' });
    try {
      const data = await api.searchPrs({ repo: params.repo.trim(), q: params.q.trim(), state: params.state, author: params.author });
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
        if (!s.installed || !s.authenticated) return;
        // The first search runs without a repository, with the remembered
        // author filter — the same value the select shows.
        void search({ repo: '', q: '', state: 'open', author: readPrAuthor() });
        // The repository list is fetched beside that search, never in front of
        // it: gh takes about a second and a half, and the results do not wait
        // for the picker. A failure leaves the field a plain text input.
        setReposLoading(true);
        api
          .repos()
          .then((r) => alive && setRepos(r.items))
          .catch((e) => alive && setReposError(errorMessage(e)))
          .finally(() => {
            if (alive) setReposLoading(false);
          });
      })
      .catch((e) => {
        if (!alive) return;
        // A missing gh is a 200 with installed: false; landing here means the
        // request itself failed. The screen still shows it, the toast says why.
        setStatus({ installed: false, authenticated: false, login: null, host: null, message: errorMessage(e) });
        toast(failureMessage('Не удалось проверить gh', e), true);
      });
    return () => {
      alive = false;
    };
  }, [search, toast]);

  const ready = Boolean(status?.installed && status?.authenticated);
  const run = () => void search({ repo, q: query, state: prState, author });

  // The id is the repository name: it is what the field holds, what the menu
  // filters on and what the search sends, so nothing has to be looked up.
  //
  // A row deliberately carries `children` and no `text`. `text` is what Primer
  // completes inline inside the field (AutocompleteInput.js:86-88, writing
  // straight into the DOM node behind React's back), and it does that whenever
  // the highlighted row's text starts with what is typed — which, with an
  // empty field, is every row. The result was the first repository's name
  // silently prepended to what the user then typed. Without `text` there is no
  // suggestion to complete, and the field only ever holds what was typed or
  // picked.
  const repoOptions = useMemo(
    () =>
      repos.map((r) => ({
        id: r.nameWithOwner,
        children: (
          <>
            <span className="rv-mono">{r.nameWithOwner}</span>
            <span className="rv-repo-option__date">{formatRepoPushed(r.pushedAt)}</span>
          </>
        ),
      })),
    [repos],
  );

  const pickRepo = (next: string) => {
    setRepo(next);
    void search({ repo: next, q: query, state: prState, author });
  };

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
            <FormControl id="rv-repo">
              <FormControl.Label>Репозиторий</FormControl.Label>
              {/* Picker over the old text input: the list comes from gh, and a
                  repository missing from it is still typed in by hand. Empty
                  means "all my PRs", the same as before. */}
              <Autocomplete>
                <Autocomplete.Input
                  placeholder="owner/repo — необязательно"
                  spellCheck={false}
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  className="rv-mono"
                  // Enter on a row highlighted with the arrows. Primer has
                  // its own path for it — the input forwards the keypress to
                  // the highlighted row (AutocompleteInput.js:72-80) — but the
                  // row receives it through `onKeyPress` (ActionList/Item.js:
                  // 373), and React 19 no longer has that prop: `keypress`
                  // only survives inside its composition handling. So the key
                  // would do nothing at all — Primer stops the event, and the
                  // form never submits either. With no row highlighted it is
                  // left alone and submits the form, searching what was typed.
                  onKeyDown={(e) => {
                    // Escape empties the field, and Primer does it by writing
                    // into the DOM node (AutocompleteInput.js:50-53) — no
                    // change event, so the state behind it would keep the old
                    // repository and «Искать» would search for a name that is
                    // no longer on screen.
                    if (e.key === 'Escape') {
                      setRepo('');
                      return;
                    }
                    if (e.key !== 'Enter') return;
                    const active = e.currentTarget.getAttribute('aria-activedescendant');
                    if (!active) return;
                    e.preventDefault();
                    pickRepo(active);
                    // Primer closes the menu when the field loses focus.
                    e.currentTarget.blur();
                  }}
                  // The whole point of the picker is seeing the list without
                  // typing first. Primer marks the prop deprecated but still
                  // reads it (AutocompleteInput.js:9,21); if a future version
                  // drops it, the menu opens on the first keystroke instead.
                  openOnFocus
                />
                {/* The list is capped so it opens under the field: an
                    unbounded overlay is taller than the window, and Primer
                    then floats it somewhere else entirely. */}
                <Autocomplete.Overlay width="large" height="medium">
                  <Autocomplete.Menu
                    aria-labelledby="rv-repo-label"
                    items={repoOptions}
                    selectedItemIds={repo ? [repo] : []}
                    selectionVariant="single"
                    loading={reposLoading}
                    // Primer's own filter matches from the start of the text,
                    // and the text here starts with the owner (lib/repoList.ts).
                    filterFn={(item) => matchesRepo(item.id, repo)}
                    emptyStateText={reposLoading ? false : 'Ничего не нашлось — впиши owner/repo целиком'}
                    onSelectedChange={(item) => {
                      // Only a pick counts. Primer toggles a selection, so
                      // clicking the repository that is already in the field
                      // reports "nothing selected" — which would empty the
                      // field under a click that reads as "this one". The
                      // field is cleared by erasing it or with Escape.
                      const picked = Array.isArray(item) ? item[0] : item;
                      if (picked) pickRepo(picked.id);
                    }}
                  />
                </Autocomplete.Overlay>
              </Autocomplete>
              {reposError && (
                <FormControl.Caption>
                  Список репозиториев не загрузился — впиши owner/repo вручную. Причина: {reposError}
                </FormControl.Caption>
              )}
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
                  void search({ repo, q: query, state: e.target.value, author });
                }}
              >
                <Select.Option value="open">open</Select.Option>
                <Select.Option value="closed">closed</Select.Option>
                <Select.Option value="merged">merged</Select.Option>
                <Select.Option value="all">все</Select.Option>
              </Select>
            </FormControl>
            <FormControl>
              <FormControl.Label>Автор</FormControl.Label>
              {/* Without a repository "все" is every PR you are involved in — gh cannot list all of GitHub (lib/pr-search.js). */}
              <Select
                value={author}
                onChange={(e) => {
                  const next = parsePrAuthor(e.target.value);
                  setAuthor(next);
                  writePrAuthor(next);
                  void search({ repo, q: query, state: prState, author: next });
                }}
              >
                <Select.Option value="all">все</Select.Option>
                <Select.Option value="mine">мои</Select.Option>
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
