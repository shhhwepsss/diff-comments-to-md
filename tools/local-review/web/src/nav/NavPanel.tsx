import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { CounterLabel, IconButton, SegmentedControl, Spinner } from '@primer/react';
import { TriangleRightIcon, XIcon } from '@primer/octicons-react';
import type { LspCallNode, LspFailure, LspLocation, LspRequest } from '../api/types';
import { useReview } from '../review/ReviewContext';
import { failureText } from '../lsp/session';
import { hoverBlocks } from '../lsp/hoverText';
import { ResizeHandle, usePaneWidth } from '../diff/paneResize';
import { COMMENTS_PANEL_WIDTH, COMMENTS_PANEL_WIDTH_KEY } from '../lib/commentsPanel';
import { navKeysBlocked } from '../diff/cm/lsp';
import type { NavQuery, NavTab } from './codeNav';
import {
  dirName,
  fileName,
  groupLocations,
  KIND_LABEL,
  kindFromHover,
  kindFromLsp,
  plural,
  previewParts,
  type SymbolKind,
} from './navList';
import { EMPTY_TREE, expand, expandable, focusableRow, setChildren, setError, toggle, treeFromRoots, treeKey, visibleRows, type CallTree, type TreeNode } from './callTree';
import './nav-panel.css';

// The navigation panel: references, implementations and the call hierarchy
// of one symbol, beside the diff. It takes the place of the comments panel
// while it is open (one panel on the right: two would leave the diff a strip
// between them) and gives it back when closed. Picking a row is a jump like
// «go to definition»: a step in Back / Forward, the line flashed in the diff.

type Loaded<T> = { status: 'loading' } | { status: 'error'; message: string; unsupported: boolean } | { status: 'done'; value: T };

function failed(f: LspFailure): Loaded<never> {
  return { status: 'error', message: failureText(f), unsupported: f.reason === 'not-supported' };
}

function thrown(e: unknown): Loaded<never> {
  return { status: 'error', message: e instanceof Error ? e.message : String(e), unsupported: false };
}

const TAB_LABEL: Record<NavTab, string> = { references: 'Ссылки', implementation: 'Реализации', calls: 'Вызовы' };
const TABS: NavTab[] = ['references', 'implementation', 'calls'];

/** A place to go to; external ones (outside the repository) are listed but cannot be opened. */
type Target = { path: string; line: number; character: number };

function targetOf(l: LspLocation | undefined): Target | null {
  return l && l.path !== null ? { path: l.path, line: l.line, character: l.character } : null;
}

function Preview({ loc }: { loc: LspLocation }) {
  const parts = previewParts(loc);
  if (parts.length === 0) return <span className="rv-npanel__pv is-missing">строка недоступна</span>;
  return (
    <span className="rv-npanel__pv">
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="rv-npanel__hit">
            {p.text}
          </mark>
        ) : (
          p.text
        ),
      )}
    </span>
  );
}

function Status({ children, busy }: { children: React.ReactNode; busy?: boolean }) {
  return (
    <div className="rv-npanel__status" role="status">
      {busy && <Spinner size="small" />}
      <span>{children}</span>
    </div>
  );
}

function Failure({ state, other }: { state: { message: string; unsupported: boolean }; other?: string }) {
  return (
    <div className={`rv-npanel__note${state.unsupported ? '' : ' is-error'}`} role="alert">
      {state.message}
      {state.unsupported && other ? `. ${other}` : ''}
    </div>
  );
}

/** Moves the focus between the rows of a list with ↑ ↓; Enter is the row's own (a button). */
function onListKey(e: ReactKeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('.rv-npanel__item:not(:disabled)')];
  if (rows.length === 0) return;
  e.preventDefault();
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const next = at === -1 ? 0 : Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
  rows[next].focus();
}

/** Why a place cannot be opened, for its row and its group. */
function closedReason(l: LspLocation): string {
  return l.gitInternal ? 'служебный .git' : 'вне репозитория';
}

function LocationList({
  state,
  first,
  current,
  onGo,
  empty,
  other,
  noun,
  note,
}: {
  state: Loaded<LspLocation[]> | undefined;
  first: string;
  current: string | null;
  onGo: (key: string, target: Target) => void;
  empty: string;
  other: string;
  noun: [string, string, string];
  /** Said above the list instead of the bare count (a search by text says what it is). */
  note?: (count: string) => React.ReactNode;
}) {
  const grouped = useMemo(() => (state?.status === 'done' ? groupLocations(state.value, first) : null), [state, first]);
  if (!state || state.status === 'loading') return <Status busy>Спрашиваю language server…</Status>;
  if (state.status === 'error') return <Failure state={state} other={other} />;
  if (!grouped || grouped.total === 0) return <div className="rv-npanel__note">{empty}</div>;
  const count = `${plural(grouped.total, ...noun)} в ${plural(grouped.groups.length, 'файле', 'файлах', 'файлах')}`;
  return (
    <>
      <div className="rv-npanel__note">{note ? note(count) : count}</div>
      {/* Groups are plain blocks with a heading; each one's places are a list
          of their own, every row a list item holding its button. */}
      <div className="rv-npanel__list" onKeyDown={onListKey}>
        {grouped.groups.map((g) => {
          const name = g.path ?? g.external ?? '';
          const closed = g.path === null ? closedReason(g.items[0]) : null;
          const headId = `rv-npanel-g-${g.key.replace(/[^\w-]/g, '_')}`;
          return (
            <div key={g.key} className="rv-npanel__group">
              <div className={`rv-npanel__file${closed ? ' is-external' : ''}`} title={name} id={headId}>
                <span className="rv-npanel__dir">{dirName(name)}</span>
                <b>{fileName(name)}</b>
                {closed && <span className="rv-npanel__ext">{closed}</span>}
                <CounterLabel>{g.items.length}</CounterLabel>
              </div>
              <ul className="rv-npanel__items" aria-labelledby={headId}>
                {g.items.map((l) => {
                  const key = `${g.key}:${l.line}:${l.character}`;
                  const target = targetOf(l);
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        className={`rv-npanel__item${current === key ? ' is-current' : ''}`}
                        aria-current={current === key || undefined}
                        disabled={!target}
                        title={
                          target
                            ? `${l.path}:${l.line + 1}`
                            : l.gitInternal
                              ? `Служебные файлы .git не открываются: ${l.external ?? ''}`
                              : `Вне репозитория: ${l.external ?? ''}`
                        }
                        onClick={() => target && onGo(key, target)}
                      >
                        <span className="rv-npanel__lno">{l.line + 1}</span>
                        {target ? <Preview loc={l} /> : <span className="rv-npanel__pv is-missing">{fileName(l.external ?? '')}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** Where a row of the call tree leads: the call for a caller, the declaration for a callee and for a root. */
function rowTarget(n: TreeNode, incoming: boolean): LspLocation {
  return incoming && n.sites.length > 0 ? n.sites[0] : n.node;
}

function CallRow({
  n,
  incoming,
  focused,
  current,
  onToggle,
  onGo,
  onFocus,
}: {
  n: TreeNode;
  incoming: boolean;
  focused: boolean;
  current: boolean;
  onToggle: (id: string) => void;
  onGo: (n: TreeNode) => void;
  onFocus: (id: string) => void;
}) {
  const loc = rowTarget(n, incoming);
  const where = loc.path ?? loc.external ?? '';
  const canOpen = expandable(n);
  const kind = kindFromLsp(n.node.kind);
  const calls = n.sites.length;
  return (
    <div
      role="treeitem"
      id={`rv-npanel-node-${n.id}`}
      aria-level={n.depth + 1}
      aria-expanded={canOpen ? n.expanded : undefined}
      aria-selected={current}
      aria-busy={n.loading || undefined}
      tabIndex={focused ? 0 : -1}
      data-node={n.id}
      className={`rv-npanel__node${current ? ' is-current' : ''}${n.depth === 0 ? ' is-root' : ''}`}
      style={{ ['--rv-depth' as string]: n.depth }}
      onFocus={(e) => e.target === e.currentTarget && onFocus(n.id)}
      onClick={() => {
        onFocus(n.id);
        onGo(n);
      }}
    >
      <button
        type="button"
        tabIndex={-1}
        className={`rv-npanel__twisty${canOpen ? '' : ' is-leaf'}`}
        aria-hidden="true"
        onClick={(e) => {
          e.stopPropagation();
          onFocus(n.id);
          onToggle(n.id);
        }}
      >
        <TriangleRightIcon size={16} />
      </button>
      <div className="rv-npanel__call">
        <div className="rv-npanel__callhead">
          {/* A file as a caller is named by its whole path: the name is enough. */}
          <span className="rv-npanel__name">{kind === 'module' ? fileName(n.node.name) : n.node.name}</span>
          {kind && <span className="rv-npanel__kind">{KIND_LABEL[kind]}</span>}
          {n.node.detail && <span className="rv-npanel__detail">{n.node.detail}</span>}
        </div>
        <div className="rv-npanel__loc" title={where}>
          {fileName(where)}:{loc.line + 1}
          {calls > 1 && ` · ${plural(calls, 'вызов', 'вызова', 'вызовов')}`}
          {n.recursive && ' · рекурсия'}
          {loc.path === null && ' · вне репозитория'}
        </div>
        {loc.path !== null && loc.preview && (
          <div className="rv-npanel__callpv">
            <Preview loc={loc} />
          </div>
        )}
      </div>
    </div>
  );
}

function CallTreeView({
  tree,
  incoming,
  current,
  onToggle,
  onGo,
}: {
  tree: CallTree;
  incoming: boolean;
  current: string | null;
  onToggle: (id: string) => void;
  onGo: (n: TreeNode) => void;
}) {
  const rows = visibleRows(tree);
  const [focused, setFocused] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const focusId = focusableRow(rows, focused);

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = treeKey(tree, focusId, e.key);
    if (!action) return;
    e.preventDefault();
    if (action.toggle) onToggle(action.toggle);
    if (action.activate && tree.nodes[action.activate]) onGo(tree.nodes[action.activate]);
    if (action.focus) {
      setFocused(action.focus);
      box.current?.querySelector<HTMLElement>(`[data-node="${CSS.escape(action.focus)}"]`)?.focus();
    }
  };

  const out: React.ReactNode[] = [];
  for (const n of rows) {
    out.push(
      <CallRow
        key={n.id}
        n={n}
        incoming={incoming}
        focused={n.id === focusId}
        current={n.id === current}
        onToggle={onToggle}
        onGo={onGo}
        onFocus={setFocused}
      />,
    );
    // What an open node has to say about its children, as a row under it.
    if (!n.expanded) continue;
    const pad = { ['--rv-depth' as string]: n.depth + 1 };
    if (n.loading) {
      out.push(
        <div key={`${n.id}:loading`} className="rv-npanel__treenote" style={pad} role="status">
          <Spinner size="small" /> Загрузка…
        </div>,
      );
    } else if (n.error) {
      out.push(
        <div key={`${n.id}:error`} className="rv-npanel__treenote is-error" style={pad} role="alert">
          {n.error}. Закройте и раскройте узел, чтобы повторить.
        </div>,
      );
    } else if (n.children && n.children.length === 0) {
      out.push(
        <div key={`${n.id}:empty`} className="rv-npanel__treenote" style={pad}>
          {incoming ? 'Больше никто не вызывает' : 'Ничего не вызывает'}
        </div>,
      );
    }
  }
  return (
    <div className="rv-npanel__tree" role="tree" aria-label={incoming ? 'Кто вызывает' : 'Что вызывает'} ref={box} onKeyDown={onKey}>
      {out}
    </div>
  );
}

export function NavPanel({ query, onClose }: { query: NavQuery; onClose: () => void }) {
  const review = useReview();
  const session = review.lsp;
  const [width, setWidth] = usePaneWidth(COMMENTS_PANEL_WIDTH_KEY, COMMENTS_PANEL_WIDTH);
  const [tab, setTab] = useState<NavTab>(query.tab);
  const [direction, setDirection] = useState(query.direction);
  // The direction as of now, for roots that arrive after a switch made while they loaded.
  const directionNow = useRef(query.direction);
  const [kind, setKind] = useState<SymbolKind | null>(query.kind ?? null);
  // Found by text (a PR with no clone): the list is there already, nothing is asked.
  const text = query.textHits ?? null;
  const [refs, setRefs] = useState<Loaded<LspLocation[]> | undefined>(text ? { status: 'done', value: text.locations } : undefined);
  const [impls, setImpls] = useState<Loaded<LspLocation[]>>();
  const [roots, setRoots] = useState<Loaded<LspCallNode[]>>();
  const [tree, setTree] = useState<CallTree>(EMPTY_TREE);
  const [current, setCurrent] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);

  const req = useMemo<LspRequest>(
    () => ({ path: query.path, line: query.line, character: query.character, ...(query.text !== undefined ? { text: query.text } : {}) }),
    [query],
  );

  // Answers land only while this panel is on screen: a new query remounts it
  // (DiffScreen keys it by the query), a closed one ignores what comes late.
  // Not aborted: StrictMode's second mount must not lose the first requests.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const live = () => mounted.current;

  // The header's «метод» / «класс»: from the hover, when the panel was not opened from one.
  useEffect(() => {
    if (query.kind !== undefined || text) return;
    session
      .hover(req)
      .then((res) => {
        if (!live() || !res.ok || !res.hover) return;
        const k = kindFromHover(hoverBlocks(res.hover).find((b) => b.type === 'code')?.text);
        if (k) setKind((was) => was ?? k);
      })
      .catch(() => undefined);
  }, [session, req, query.kind, text]);

  // Each list is asked for the first time its tab is shown, and kept.
  useEffect(() => {
    if (tab === 'calls' || text) return;
    const set = tab === 'references' ? setRefs : setImpls;
    if ((tab === 'references' ? refs : impls) !== undefined) return;
    set({ status: 'loading' });
    session.locations(tab, req).then(
      (res) => live() && set(res.ok ? { status: 'done', value: res.locations } : failed(res)),
      (e) => live() && set(thrown(e)),
    );
  }, [tab, refs, impls, session, req, text]);

  // The calls: a level per request. `generation` drops answers for a tree
  // that was rebuilt meanwhile (the direction switched).
  const generation = useRef(0);
  const loadChildren = useCallback(
    (id: string, node: LspCallNode, dir: typeof direction) => {
      const gen = generation.current;
      session.calls(dir, { path: req.path, ...(req.text !== undefined ? { text: req.text } : {}), item: node.item, token: node.token }).then(
        (res) => {
          if (!live() || gen !== generation.current) return;
          setTree((t) => (res.ok ? setChildren(t, id, res.calls) : setError(t, id, failureText(res))));
        },
        (e) => {
          if (!live() || gen !== generation.current) return;
          setTree((t) => setError(t, id, e instanceof Error ? e.message : String(e)));
        },
      );
    },
    [session, req],
  );

  /** A fresh tree from the roots, the first root opened: the panel answers the question it was asked. */
  const plant = useCallback(
    (items: LspCallNode[], dir: typeof direction) => {
      generation.current += 1;
      const start = treeFromRoots(items);
      if (items.length === 0) {
        setTree(start);
        return;
      }
      const opened = expand(start, start.roots[0]);
      setTree(opened.tree);
      if (opened.load) loadChildren(start.roots[0], items[0], dir);
    },
    [loadChildren],
  );

  useEffect(() => {
    if (tab !== 'calls' || roots !== undefined || text) return;
    setRoots({ status: 'loading' });
    session.prepareCalls(req).then(
      (res) => {
        if (!live()) return;
        if (!res.ok) {
          setRoots(failed(res));
          return;
        }
        setRoots({ status: 'done', value: res.items });
        const k = kindFromLsp(res.items[0]?.kind);
        if (k) setKind(k);
        plant(res.items, directionNow.current);
      },
      (e) => live() && setRoots(thrown(e)),
    );
  }, [tab, roots, session, req, plant, text]);

  const switchDirection = (dir: typeof direction) => {
    if (dir === direction) return;
    directionNow.current = dir;
    setDirection(dir);
    setCurrent(null);
    if (roots?.status === 'done') plant(roots.value, dir);
  };

  const onToggle = (id: string) => {
    const n = tree.nodes[id];
    if (!n) return;
    const next = toggle(tree, id);
    setTree(next.tree);
    if (next.load) loadChildren(id, n.node, direction);
  };

  // A jump from the panel starts where the previous one landed, the first
  // one at the symbol the panel was opened for: Back returns there. (In the
  // feed of all files the «current» file is whichever scrolled by, not the
  // one the reviewer was reading.)
  const lastJump = useRef<{ path: string; line: number } | null>(null);
  const go = (key: string, target: Target) => {
    setCurrent(key);
    review.navigateTo(target, lastJump.current ?? { path: query.path, line: query.line + 1 });
    lastJump.current = { path: target.path, line: target.line + 1 };
  };

  const goNode = (n: TreeNode) => {
    const target = targetOf(rowTarget(n, direction === 'incoming'));
    if (target) go(n.id, target);
  };

  // Esc closes the panel — after a menu, a dialog or the highlight of
  // occurrences had their turn (those listen on the window in the capture
  // phase), and before Zen (App listens on the window, after the document).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || navKeysBlocked(e)) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The keyboard lands in the panel, so ↑ ↓ and Esc work at once; it goes
  // back where it was when the panel closes with the focus inside.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = panel.current;
    el?.focus({ preventScroll: true });
    return () => {
      if (el?.contains(document.activeElement) && before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  const counts = useMemo<Partial<Record<NavTab, number>>>(
    () => ({
      references: refs?.status === 'done' ? groupLocations(refs.value).total : undefined,
      implementation: impls?.status === 'done' ? groupLocations(impls.value).total : undefined,
    }),
    [refs, impls],
  );

  // Without a server only the list found by text is there to show.
  const tabs = text ? TABS.filter((t) => t === 'references') : TABS;
  const tabLabel = (t: NavTab) => (t === 'references' && text?.kind === 'definitions' ? 'Объявления' : TAB_LABEL[t]);

  const onTabKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    setTab(next);
    e.currentTarget.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  };

  return (
    <aside className="rv-npanel" style={{ width }} aria-label={`Навигация: ${query.word}`} ref={panel} tabIndex={-1}>
      <ResizeHandle width={width} onResize={setWidth} pane={COMMENTS_PANEL_WIDTH} edge="left" className="rv-npanel__resize" />
      <div className="rv-npanel__head">
        <strong className="rv-npanel__word" title={query.word}>
          {query.word}
        </strong>
        {kind && <span className="rv-npanel__kindhead">{KIND_LABEL[kind]}</span>}
        <span className="rv-npanel__origin" title={`${query.path}:${query.line + 1}`}>
          {fileName(query.path)}:{query.line + 1}
        </span>
        <IconButton icon={XIcon} aria-label="Закрыть панель (Esc)" size="small" variant="invisible" onClick={onClose} />
      </div>
      <div className="rv-npanel__tabs" role="tablist" aria-label="Что показать" onKeyDown={onTabKey}>
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            data-tab={t}
            id={`rv-npanel-tab-${t}`}
            aria-selected={tab === t}
            aria-controls="rv-npanel-body"
            tabIndex={tab === t ? 0 : -1}
            className="rv-npanel__tab"
            onClick={() => setTab(t)}
          >
            {tabLabel(t)}
            {counts[t] !== undefined && <CounterLabel>{counts[t]}</CounterLabel>}
          </button>
        ))}
        {text &&
          TABS.filter((t) => t !== 'references').map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={false}
              aria-disabled
              tabIndex={-1}
              className="rv-npanel__tab is-disabled"
              title="Нужен локальный клон: это ищет LSP по типам. «Клонировать…» — над диффом"
            >
              {TAB_LABEL[t]}
            </button>
          ))}
      </div>
      <div className="rv-npanel__body" id="rv-npanel-body" role="tabpanel" aria-labelledby={`rv-npanel-tab-${tab}`}>
        {tab === 'references' && text && (
          <LocationList
            state={refs}
            first={query.path}
            current={current}
            onGo={go}
            empty={`«${query.word}» не найдено в файлах диффа.`}
            other=""
            noun={text.kind === 'definitions' ? ['объявление', 'объявления', 'объявлений'] : ['вхождение', 'вхождения', 'вхождений']}
            note={(count) => (
              <span className="rv-npanel__textnote">
                {text.kind === 'definitions'
                  ? `Без LSP: ${count} с таким именем. Какое из них нужное, поиск по тексту не знает.`
                  : `Поиск слова по файлам диффа: ${count}, включая комментарии, строки и одноимённые переменные.`}
                {text.skipped > 0 && ` Прочитаны не все файлы: пропущено ${text.skipped}.`}
              </span>
            )}
          />
        )}
        {tab === 'references' && !text && (
          <LocationList
            state={refs}
            first={query.path}
            current={current}
            onGo={go}
            empty={`Ссылок на «${query.word}» не найдено.`}
            other=""
            noun={['ссылка', 'ссылки', 'ссылок']}
          />
        )}
        {tab === 'implementation' && (
          <LocationList
            state={impls}
            first={query.path}
            current={current}
            onGo={go}
            empty={`Реализаций «${query.word}» не найдено: это не интерфейс и не абстрактный метод, или их нет в проекте.`}
            other="Откройте вкладку «Ссылки»"
            noun={['реализация', 'реализации', 'реализаций']}
          />
        )}
        {tab === 'calls' && (
          <>
            <div className="rv-npanel__dir-switch">
              <SegmentedControl aria-label="Направление вызовов" size="small" fullWidth onChange={(i) => switchDirection(i === 0 ? 'incoming' : 'outgoing')}>
                <SegmentedControl.Button selected={direction === 'incoming'}>Кто вызывает</SegmentedControl.Button>
                <SegmentedControl.Button selected={direction === 'outgoing'}>Что вызывает</SegmentedControl.Button>
              </SegmentedControl>
            </div>
            {!roots || roots.status === 'loading' ? (
              <Status busy>Спрашиваю language server…</Status>
            ) : roots.status === 'error' ? (
              <Failure state={roots} other="Откройте вкладку «Ссылки»" />
            ) : roots.value.length === 0 ? (
              <div className="rv-npanel__note">
                У «{query.word}» нет иерархии вызовов: она есть только у функций и методов. Откройте вкладку «Ссылки».
              </div>
            ) : (
              <CallTreeView tree={tree} incoming={direction === 'incoming'} current={current} onToggle={onToggle} onGo={goNode} />
            )}
          </>
        )}
      </div>
    </aside>
  );
}
