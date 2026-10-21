import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Autocomplete, Banner, Button, Checkbox, FormControl, Heading, Label, Select, Spinner, TextInput } from '@primer/react';
import { GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestDraftIcon, GitPullRequestIcon, MarkGithubIcon, SearchIcon, TriangleDownIcon } from '@primer/octicons-react';
import { api, errorMessage, failureMessage } from '../api/client';
import type { GhStatus, PrItem, RepoItem } from '../api/types';
import { formatDate } from '../lib/format';
import { formatRepoPushed, matchesRepo } from '../lib/repoList';
import { composeFromHash, hashFor, wantsNativeLink } from '../lib/hash';
import { type PrAuthorFilter, readPrAuthor, writePrAuthor } from '../lib/prAuthor';
import { foundBy, tabForQuery, type SelectTab } from '../lib/tabbedSelect';
import { useConfirm } from '../lib/confirm';
import { useToast } from '../lib/toast';
import { useSession } from '../session/sessionContext';
import {
  allOrder,
  commentTotals,
  doneCount,
  oldBadge,
  pickable,
  positionOf,
  prKey,
  SORT_OPTIONS,
  sessionOrder,
  togglePick,
  togglePickAll,
  type SortKey,
} from '../session/sessionLogic';
import { MatchText, SelectTabs, TabbedSelect, type TabbedOption } from '../components/TabbedSelect';
import './picker.css';

function PrIcon({ item }: { item: PrItem }) {
  const s = String(item.state || '').toLowerCase();
  if (item.isDraft) return <GitPullRequestDraftIcon className="rv-pr-icon rv-pr-icon--draft" aria-label="черновик" />;
  if (s === 'merged') return <GitMergeIcon className="rv-pr-icon rv-pr-icon--merged" aria-label="merged" />;
  if (s === 'closed') return <GitPullRequestClosedIcon className="rv-pr-icon rv-pr-icon--closed" aria-label="closed" />;
  return <GitPullRequestIcon className="rv-pr-icon rv-pr-icon--open" aria-label="open" />;
}

/** The address of a PR's diff, or null when the search did not say which repository it is in. */
function prHash(item: PrItem): string | null {
  if (!item.owner || !item.repo) return null;
  return hashFor({ source: 'pr', host: item.host || 'github.com', owner: item.owner, repo: item.repo, number: item.number });
}

type RowProps = {
  item: PrItem;
  picked: boolean;
  /** Place in the session (1-based) of a picked row. */
  position: number | null;
  /** Comments already on the PR from before the session, by earlier work on it. */
  old: number;
  /** The row cannot join the pick: it is in another repository than the first pick, or in an unknown one. */
  locked: boolean;
  onToggle: () => void;
};

/**
 * A result row: a checkbox for the session, and the PR as a real link. A plain
 * click anywhere on the row ticks the checkbox (the link's own navigation is
 * cancelled for that click only); the middle button, Ctrl/Cmd+click and the
 * context menu are the browser's, and open the PR in another tab as before.
 * The checkbox is the keyboard path to the same toggle.
 */
function PrRow({ item, picked, position, old, locked, onToggle }: RowProps) {
  const href = prHash(item);
  const main = (
    <>
      <PrIcon item={item} />
      <span className="rv-pr-row">
        <span className="rv-pr-row__title">
          {position !== null && (
            <span className="rv-pr-row__pos" title="Место в сессии">
              {position}
            </span>
          )}
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
    </>
  );
  const hint = locked
    ? href
      ? 'Сессия идёт по одному репозиторию — этот PR из другого'
      : 'Неизвестно, из какого репозитория этот PR'
    : 'Клик — отметить для сессии. Средняя кнопка или Ctrl+клик — открыть в новой вкладке';
  return (
    <li
      className={'rv-row rv-row--pr' + (picked ? ' is-picked' : '')}
      onClick={(e) => {
        // The row around the link, the badge and the gaps is part of the target;
        // the link, the buttons and the checkbox answer for themselves.
        if (!(e.target as HTMLElement).closest('a, button, input')) onToggle();
      }}
    >
      <Checkbox className="rv-row__check" checked={picked} disabled={locked} onChange={onToggle} aria-label={`Выбрать PR #${item.number}`} />
      {href ? (
        <a
          className="rv-row__main"
          href={href}
          title={hint}
          onClick={(e) => {
            if (wantsNativeLink(e)) return;
            e.preventDefault();
            onToggle();
          }}
        >
          {main}
        </a>
      ) : (
        <button type="button" className="rv-row__main" disabled title={hint}>
          {main}
        </button>
      )}
      {old > 0 && (
        <Label variant="attention" className="rv-row__old">
          {oldBadge(old)}
        </Label>
      )}
      {href ? (
        <Button as="a" href={href} size="small">
          Открыть
        </Button>
      ) : (
        <Button size="small" disabled>
          Открыть
        </Button>
      )}
    </li>
  );
}

type Result =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; items: PrItem[]; homeDir: string; storedPrs: number; sessionsDir: string; storedSessions: number };

const PR_STATES: TabbedOption<string>[] = [
  { value: 'open', label: 'open' },
  { value: 'closed', label: 'closed' },
  { value: 'merged', label: 'merged' },
  { value: 'all', label: 'все' },
];

const PR_AUTHORS: TabbedOption<PrAuthorFilter>[] = [
  { value: 'all', label: 'все' },
  { value: 'mine', label: 'мои' },
];

export function PrSearch() {
  const [status, setStatus] = useState<GhStatus | null>(null);
  const [repo, setRepo] = useState('');
  const [repos, setRepos] = useState<RepoItem[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  // Which of the picker's two tabs is open: every repository, or the ones the field's text matches.
  const [repoTab, setRepoTab] = useState<SelectTab>('all');
  const [query, setQuery] = useState('');
  const [prState, setPrState] = useState('open');
  const [author, setAuthor] = useState<PrAuthorFilter>(readPrAuthor);
  const [result, setResult] = useState<Result>({ kind: 'idle' });
  const toast = useToast();
  const confirm = useConfirm();
  const sessionApi = useSession();
  const { session, counts } = sessionApi;

  // `#/pr?compose=1`: the running session's line-up is being changed. The
  // session's PRs come up ticked in their order, and starting again carries
  // the session over (marks, remarks, start time) instead of beginning anew.
  const compose = useMemo(() => composeFromHash(window.location.hash), []);
  const editing = compose ? session : null;
  const composeInit = useRef(false);
  // The picked rows in click order, how they are ordered into a session, and
  // which of the found PRs already carry comments (by `prKey`).
  const [picked, setPicked] = useState<string[]>([]);
  const [sort, setSort] = useState<SortKey>('updated');
  const [oldByKey, setOldByKey] = useState<Record<string, number>>({});
  const [starting, setStarting] = useState(false);

  const search = useCallback(async (params: { repo: string; q: string; state: string; author: PrAuthorFilter }) => {
    setResult({ kind: 'loading' });
    try {
      const data = await api.searchPrs({ repo: params.repo.trim(), q: params.q.trim(), state: params.state, author: params.author });
      setResult({
        kind: 'ok',
        items: data.items,
        homeDir: data.homeDir,
        storedPrs: data.storedPrs,
        sessionsDir: data.sessionsDir,
        storedSessions: data.storedSessions,
      });
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
        // author filter — the same value the select shows. Changing a
        // session's line-up searches its own repository instead (below).
        if (!compose) void search({ repo: '', q: '', state: 'open', author: readPrAuthor() });
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
  }, [search, toast, compose]);

  const ready = Boolean(status?.installed && status?.authenticated);

  // The session is read by the provider; the line-up is set up once it is
  // known. Without a session the address means nothing: an ordinary search.
  useEffect(() => {
    if (!compose || !ready || !sessionApi.loaded || composeInit.current) return;
    composeInit.current = true;
    if (!session) {
      void search({ repo: '', q: '', state: 'open', author });
      return;
    }
    const name = `${session.owner}/${session.repo}`;
    setRepo(name);
    setPicked(session.prs.map((pr) => `${name}#${pr.number}`));
    setSort('manual');
    void search({ repo: name, q: '', state: 'open', author });
  }, [compose, ready, sessionApi.loaded, session, search, author]);

  // The counts are read again on the way in: another tab may have been at work.
  const refreshSession = sessionApi.refresh;
  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const items = useMemo(() => (result.kind === 'ok' ? result.items : []), [result]);
  const since = editing?.startedAt;
  // Comments the found PRs already have. Next to the session being changed they
  // are the ones older than it; otherwise every one is, since a session
  // started now has written none.
  useEffect(() => {
    if (items.length === 0) {
      setOldByKey({});
      return;
    }
    let alive = true;
    const groups = new Map<string, { repo: { host: string; owner: string; repo: string }; numbers: number[] }>();
    for (const item of items) {
      if (!item.owner || !item.repo) continue;
      const key = `${item.host}/${item.owner}/${item.repo}`;
      const group = groups.get(key) ?? { repo: { host: item.host, owner: item.owner, repo: item.repo }, numbers: [] };
      group.numbers.push(item.number);
      groups.set(key, group);
    }
    Promise.all([...groups.values()].map((g) => api.oldComments(g.repo, g.numbers, since).then((r) => ({ g, counts: r.counts }))))
      .then((all) => {
        if (!alive) return;
        const next: Record<string, number> = {};
        for (const { g, counts: found } of all) {
          for (const [n, count] of Object.entries(found)) next[`${g.repo.owner}/${g.repo.repo}#${n}`] = count;
        }
        setOldByKey(next);
      })
      // The badge is advice: without it the list is still right.
      .catch(() => alive && setOldByKey({}));
    return () => {
      alive = false;
    };
  }, [items, since]);

  const pickedItems = useMemo(() => sessionOrder(items, picked, sort), [items, picked, sort]);
  const everyOrder = useMemo(() => allOrder(items, sort), [items, sort]);
  const allPicked = items.length > 0 && everyOrder.length > 0 && everyOrder.every((i) => picked.includes(prKey(i)));
  const missing = editing && result.kind === 'ok' ? editing.prs.filter((pr) => !items.some((i) => i.number === pr.number)) : [];

  const toggle = (item: PrItem) => {
    const key = prKey(item);
    if (!picked.includes(key) && !pickable(items, picked, item)) return;
    setPicked((p) => togglePick(p, key));
  };

  const begin = async (ordered: PrItem[]) => {
    const first = ordered[0];
    if (!first || !first.owner || !first.repo || starting) return;
    // A fresh session replaces the running one: its marks and remarks would
    // go to the finished ones on disk, where nothing in the app opens them.
    if (session && !editing) {
      const done = doneCount(session, commentTotals(counts));
      const ok = await confirm({
        title: 'Начать новую сессию?',
        body: `Незаконченная сессия (просмотрено ${done} из ${session.prs.length} PR-ов) будет завершена: её отметки и общие комментарии в приложении больше не откроются. Комментарии к PR-ам останутся на месте.`,
        confirmLabel: 'Начать новую',
      });
      if (!ok) return;
    }
    setStarting(true);
    const prs = ordered.map((i) => ({ number: i.number, title: i.title, headRefName: i.headRefName, headSha: i.headSha }));
    await sessionApi.start({ host: first.host, owner: first.owner, repo: first.repo }, prs, Boolean(editing));
    setStarting(false);
  };

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
            <span className="rv-mono">{repoTab === 'found' ? <MatchText text={r.nameWithOwner} query={repo} /> : r.nameWithOwner}</span>
            <span className="rv-repo-option__date">{formatRepoPushed(r.pushedAt)}</span>
          </>
        ),
      })),
    [repos, repoTab, repo],
  );
  const reposFound = useMemo(() => foundBy(repos, repo, (r) => r.nameWithOwner).length, [repos, repo]);

  // Typing leads to the matches, an empty field back to the whole list.
  const typeRepo = (next: string) => {
    setRepo(next);
    setRepoTab(tabForQuery(next));
  };

  const pickRepo = (next: string) => {
    setRepo(next);
    // The field now holds a whole name, which only finds itself: the next
    // opening shows the whole list, with the pick marked in it.
    setRepoTab('all');
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
          {/* A session left open is one click from where it stopped. While its
              line-up is being changed the banner would only repeat the page. */}
          {session && !editing && (
            <Banner
              variant="info"
              title="Незаконченная сессия ревью"
              description={`просмотрено ${doneCount(session, commentTotals(counts))} из ${session.prs.length} PR-ов`}
              className="rv-page__banner"
              primaryAction={<Banner.PrimaryAction onClick={() => sessionApi.go(session.current)}>Продолжить</Banner.PrimaryAction>}
              secondaryAction={<Banner.SecondaryAction onClick={() => void sessionApi.finish()}>Завершить</Banner.SecondaryAction>}
            />
          )}
          {editing && (
            <Banner
              variant="info"
              title="Состав и порядок сессии"
              description="Отметь PR-ы и нажми «Начать ревью» — сессия пересоберётся; отметки и общие комментарии сессии останутся."
              className="rv-page__banner"
              secondaryAction={<Banner.SecondaryAction onClick={() => sessionApi.go(editing.current)}>Вернуться к сессии</Banner.SecondaryAction>}
            />
          )}
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
                  onChange={(e) => typeRepo(e.target.value)}
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
                      typeRepo('');
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
                  {/* The field itself is the query, so the body starts with the tabs. */}
                  <SelectTabs tab={repoTab} onTab={setRepoTab} all={repos.length} found={reposFound} />
                  <Autocomplete.Menu
                    aria-labelledby="rv-repo-label"
                    items={repoOptions}
                    selectedItemIds={repo ? [repo] : []}
                    selectionVariant="single"
                    loading={reposLoading}
                    // Primer's own filter matches from the start of the text,
                    // and the text here starts with the owner (lib/repoList.ts).
                    filterFn={(item) => repoTab === 'all' || (repo.trim() !== '' && matchesRepo(item.id, repo))}
                    emptyStateText={
                      reposLoading
                        ? false
                        : repoTab === 'found' && !repo.trim()
                          ? 'Начните вводить — совпадения появятся здесь'
                          : 'Ничего не нашлось — впиши owner/repo целиком'
                    }
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
            {/* Not a FormControl: its label points at a form field, and this control is a button. */}
            <div className="rv-tsel-field">
              <span className="rv-tsel-field__label">Состояние</span>
              <TabbedSelect
                label="Состояние"
                options={PR_STATES}
                value={prState}
                onChange={(next) => {
                  setPrState(next);
                  void search({ repo, q: query, state: next, author });
                }}
                renderAnchor={(props) => (
                  <Button {...props} className="rv-tsel-anchor" alignContent="start" trailingAction={TriangleDownIcon} aria-label={`Состояние: ${prState}`}>
                    {PR_STATES.find((o) => o.value === prState)?.label}
                  </Button>
                )}
              />
            </div>
            <div className="rv-tsel-field">
              <span className="rv-tsel-field__label">Автор</span>
              {/* Without a repository "все" is every PR you are involved in — gh cannot list all of GitHub (lib/pr-search.js). */}
              <TabbedSelect
                label="Автор"
                options={PR_AUTHORS}
                value={author}
                onChange={(next) => {
                  setAuthor(next);
                  writePrAuthor(next);
                  void search({ repo, q: query, state: prState, author: next });
                }}
                renderAnchor={(props) => (
                  <Button {...props} className="rv-tsel-anchor" alignContent="start" trailingAction={TriangleDownIcon} aria-label={`Автор: ${PR_AUTHORS.find((o) => o.value === author)?.label}`}>
                    {PR_AUTHORS.find((o) => o.value === author)?.label}
                  </Button>
                )}
              />
            </div>
            <Button type="submit" variant="primary" className="rv-pr-form__submit">
              Искать
            </Button>
          </form>

          <section className="rv-box">
            <div className="rv-box__head">
              {result.kind === 'ok' && items.length > 0 ? (
                <Checkbox
                  checked={allPicked}
                  indeterminate={pickedItems.length > 0 && !allPicked}
                  onChange={() => setPicked(togglePickAll(items, picked, sort))}
                  aria-label="Выбрать все"
                />
              ) : (
                <GitPullRequestIcon />
              )}
              <span className="rv-box__title">
                {result.kind !== 'ok' ? 'Результаты' : pickedItems.length > 0 ? `Выбрано ${pickedItems.length} из ${items.length}` : `Найдено: ${items.length}`}
              </span>
              {result.kind === 'loading' && <Spinner size="small" />}
              {result.kind === 'ok' && items.length > 0 && (
                <>
                  <span className="rv-box__spacer" />
                  <label className="rv-sort">
                    <span className="rv-hint">Порядок</span>
                    <Select size="small" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Порядок PR-ов в сессии">
                      {SORT_OPTIONS.map((o) => (
                        <Select.Option key={o.value} value={o.value}>
                          {o.label}
                        </Select.Option>
                      ))}
                    </Select>
                  </label>
                  <Button size="small" disabled={everyOrder.length === 0 || starting} onClick={() => void begin(everyOrder)}>
                    Ревью всех найденных ({everyOrder.length})
                  </Button>
                  <Button size="small" variant="primary" disabled={pickedItems.length === 0 || starting} onClick={() => void begin(pickedItems)}>
                    Начать ревью ({pickedItems.length})
                  </Button>
                </>
              )}
            </div>
            <ul className="rv-list">
              {result.kind === 'error' && <li className="rv-list__empty rv-list__empty--error">{result.message}</li>}
              {result.kind === 'ok' && result.items.length === 0 && <li className="rv-list__empty">Ничего не найдено</li>}
              {result.kind === 'ok' &&
                items.map((item) => {
                  const key = prKey(item);
                  const isPicked = picked.includes(key);
                  return (
                    <PrRow
                      key={`${item.owner}/${item.repo}#${item.number}`}
                      item={item}
                      picked={isPicked}
                      position={isPicked ? positionOf(pickedItems, item) : null}
                      old={oldByKey[key] ?? 0}
                      locked={!isPicked && !pickable(items, picked, item)}
                      onToggle={() => toggle(item)}
                    />
                  );
                })}
            </ul>
          </section>
          {missing.length > 0 && (
            <p className="rv-page__hint">
              Поиск не нашёл {missing.map((pr) => `#${pr.number}`).join(', ')} — если начать ревью сейчас, их в сессии не будет.
            </p>
          )}
          {result.kind === 'ok' && (
            <>
              <p className="rv-page__hint">
                Комментарии к PR-ам: <span className="rv-mono">{result.homeDir}</span> (хранится PR-ов: {result.storedPrs})
              </p>
              <p className="rv-page__hint">
                Сессии ревью: <span className="rv-mono">{result.sessionsDir}</span> (хранится сессий: {result.storedSessions})
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
