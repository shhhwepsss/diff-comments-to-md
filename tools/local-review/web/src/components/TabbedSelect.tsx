import { useId, useRef, useState, type HTMLAttributes, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import { AnchoredOverlay, CounterLabel, TextInput } from '@primer/react';
import { CheckIcon, SearchIcon } from '@primer/octicons-react';
import { foundBy, splitMatch, stepActive, tabForQuery, type SelectTab } from '../lib/tabbedSelect';
import './tabbed-select.css';

export type TabbedOption<V extends string> = {
  value: V;
  /** What the row says, and what the search looks in. */
  label: string;
  leading?: ReactNode;
  trailing?: ReactNode;
};

/**
 * The two tabs every select's body starts with: «Все» — every option,
 * «Найдено» — the ones the query matches. The counts are always on screen.
 */
export function SelectTabs({ tab, onTab, all, found }: { tab: SelectTab; onTab: (tab: SelectTab) => void; all: number; found: number }) {
  const tabs: { value: SelectTab; label: string; count: number }[] = [
    { value: 'all', label: 'Все', count: all },
    { value: 'found', label: 'Найдено', count: found },
  ];
  return (
    <div className="rv-tsel__tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          className="rv-tsel__tab"
          aria-selected={t.value === tab}
          // The query field keeps the focus: a tab is looked at, typing goes on.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onTab(t.value)}
        >
          {t.label} <CounterLabel>{t.count}</CounterLabel>
        </button>
      ))}
    </div>
  );
}

/** `text` with the part the query matched marked. */
export function MatchText({ text, query }: { text: string; query: string }) {
  const parts = splitMatch(text, query);
  if (!parts) return <>{text}</>;
  return (
    <>
      {parts[0]}
      <mark className="rv-tsel__hit">{parts[1]}</mark>
      {parts[2]}
    </>
  );
}

type Props<V extends string> = {
  options: readonly TabbedOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Names the list for a screen reader. */
  label: string;
  /** The control that opens the select; gets the props that wire it to the overlay. */
  renderAnchor: (props: Omit<HTMLAttributes<HTMLElement>, 'aria-label' | 'aria-labelledby'>) => JSX.Element;
  width?: 'small' | 'medium';
};

/**
 * A select whose body has a search field and the two tabs. Typing moves to
 * «Найдено», erasing the query goes back to «Все»; the arrows walk the rows
 * of the open tab and Enter picks the highlighted one.
 */
export function TabbedSelect<V extends string>({ options, value, onChange, label, renderAnchor, width = 'small' }: Props<V>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<SelectTab>('all');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  const found = foundBy(options, query, (o) => o.label);
  const rows = tab === 'all' ? options : found;
  const activeRow = rows[Math.min(active, rows.length - 1)];
  // By position, not by value: a value may hold characters an id cannot.
  const rowId = (v: V) => `${listId}-${options.findIndex((o) => o.value === v)}`;

  const show = () => {
    // Every opening starts clean, on the option that is chosen now.
    setQuery('');
    setTab('all');
    setActive(Math.max(options.findIndex((o) => o.value === value), 0));
    setOpen(true);
  };

  const pick = (next: V) => {
    setOpen(false);
    if (next !== value) onChange(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(stepActive(active, rows.length, e.key));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeRow) pick(activeRow.value);
    }
  };

  return (
    <AnchoredOverlay
      open={open}
      onOpen={show}
      onClose={() => setOpen(false)}
      renderAnchor={renderAnchor}
      width={width}
      // The rows are walked from the search field (see onKeyDown), not by moving the focus.
      focusZoneSettings={{ disabled: true }}
      focusTrapSettings={{ initialFocusRef: input }}
    >
      <div className="rv-tsel">
        <div className="rv-tsel__search">
          <TextInput
            ref={input}
            block
            size="small"
            name="option-search"
            leadingVisual={SearchIcon}
            placeholder="Поиск по вариантам"
            spellCheck={false}
            value={query}
            aria-label={`${label}: поиск по вариантам`}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={activeRow ? rowId(activeRow.value) : undefined}
            onChange={(e) => {
              setQuery(e.target.value);
              setTab(tabForQuery(e.target.value));
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <SelectTabs
          tab={tab}
          all={options.length}
          found={found.length}
          onTab={(next) => {
            setTab(next);
            setActive(0);
          }}
        />
        {rows.length === 0 ? (
          <p className="rv-tsel__empty" role="status">
            {query.trim() ? `Ничего не нашлось по «${query.trim()}»` : 'Начните вводить запрос — совпадения появятся здесь'}
          </p>
        ) : (
          <ul className="rv-tsel__list" role="listbox" id={listId} aria-label={label}>
            {rows.map((o) => (
              <li
                key={o.value}
                id={rowId(o.value)}
                role="option"
                aria-selected={o.value === value}
                className={'rv-tsel__option' + (o === activeRow ? ' is-active' : '')}
                // As with the tabs: the click must not take the focus out of the field first.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o.value)}
              >
                <span className="rv-tsel__check">{o.value === value && <CheckIcon size={16} />}</span>
                {o.leading && <span className="rv-tsel__leading">{o.leading}</span>}
                <span className="rv-tsel__label">{tab === 'found' ? <MatchText text={o.label} query={query} /> : o.label}</span>
                {o.trailing !== undefined && <span className="rv-tsel__trailing">{o.trailing}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </AnchoredOverlay>
  );
}
