import { useEffect, useState } from 'react';
import { ActionList, ActionMenu, Button, CounterLabel, IconButton, SegmentedControl, TextInput, UnderlineNav } from '@primer/react';
import {
  CodeReviewIcon,
  CopyIcon,
  DeviceDesktopIcon,
  DownloadIcon,
  MarkGithubIcon,
  MoonIcon,
  RepoIcon,
  SunIcon,
  SyncIcon,
  TrashIcon,
} from '@primer/octicons-react';
import type { Mode } from '../api/types';
import type { Route } from '../lib/hash';
import type { ThemePref } from '../lib/theme';
import { useOptionalReview } from '../review/ReviewContext';
import { GeneralComments } from './GeneralComments';
import './header.css';

const MODES: { value: Mode; label: string }[] = [
  { value: 'working', label: 'Рабочая копия' },
  { value: 'staged', label: 'Staged' },
  { value: 'base', label: 'Base' },
  { value: 'commits', label: 'Коммиты' },
];

const THEMES: { value: ThemePref; label: string; icon: typeof SunIcon }[] = [
  { value: 'auto', label: 'Как в системе', icon: DeviceDesktopIcon },
  { value: 'light', label: 'Светлая', icon: SunIcon },
  { value: 'dark', label: 'Тёмная', icon: MoonIcon },
];

/**
 * Which repository is on screen is the one thing a reviewer must not have to
 * hunt for: a diff of the wrong repo looks exactly like a diff of the right
 * one, only empty. So the folder name is read first and the full path trails
 * behind it as the confirmation.
 */
function RepoLabel({ root }: { root: string }) {
  const name = root.split(/[/\\]/).filter(Boolean).pop() || root;
  return (
    <span className="rv-header__root" title={root}>
      <RepoIcon size={16} />
      <span className="rv-header__repo">{name}</span>
      <span className="rv-header__path">{root}</span>
    </span>
  );
}

function BaseInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <TextInput
      size="small"
      aria-label="base-ревизия"
      className="rv-header__base"
      value={draft}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(draft);
      }}
    />
  );
}

type Props = { route: Route; theme: ThemePref; onTheme: (t: ThemePref) => void };

export function AppHeader({ route, theme, onTheme }: Props) {
  const review = useOptionalReview();
  const source = route.screen === 'diff' ? route.descriptor.source : route.screen;
  const local = review && review.descriptor.source === 'local' ? review.descriptor : null;
  const count = review?.comments.length ?? 0;
  const noComments = !review || count === 0;
  const ThemeIcon = THEMES.find((t) => t.value === theme)?.icon ?? DeviceDesktopIcon;
  // The «Коммиты» tab lights up on click, not once the history has loaded:
  // otherwise the old tab stays selected for the whole fetch and the click
  // looks ignored.
  const commitsTab = Boolean(review && (review.commitsMode || review.commitsLoading));

  return (
    <header className="rv-header">
      <div className="rv-header__row">
        <a className="rv-header__brand" href="#/local" title="local-review">
          <CodeReviewIcon size={20} />
          <span>local-review</span>
        </a>

        <UnderlineNav aria-label="Источник" className="rv-header__nav">
          <UnderlineNav.Item href="#/local" icon={RepoIcon} aria-current={source === 'local' ? 'page' : undefined}>
            Папка
          </UnderlineNav.Item>
          <UnderlineNav.Item href="#/pr" icon={MarkGithubIcon} aria-current={source === 'pr' ? 'page' : undefined}>
            GitHub PR
          </UnderlineNav.Item>
        </UnderlineNav>

        <div className="rv-header__spacer" />

        {review && (
          <div className="rv-header__actions">
            <span className="rv-header__count" title="Комментариев всего">
              Комментарии <CounterLabel scheme={count ? 'primary' : undefined}>{count}</CounterLabel>
            </span>
            {review.commitsMode && review.outsideCount > 0 && (
              <button
                type="button"
                className="rv-header__outside"
                title="Комментарии, написанные вне выбранного диапазона коммитов"
                onClick={review.expandSelectionToOutside}
              >
                {review.outsideCount} вне выбора
              </button>
            )}
            <GeneralComments review={review} />
            <Button size="small" leadingVisual={CopyIcon} disabled={noComments} onClick={() => void review.copyAll()}>
              Скопировать всё
            </Button>
            <Button size="small" leadingVisual={DownloadIcon} disabled={noComments} onClick={() => void review.exportMd()}>
              Сгенерировать .md
            </Button>
            <Button size="small" variant="danger" leadingVisual={TrashIcon} disabled={noComments} onClick={() => void review.clearAll()}>
              Очистить всё
            </Button>
          </div>
        )}

        <ActionMenu>
          <ActionMenu.Anchor>
            <IconButton icon={ThemeIcon} aria-label="Тема" size="small" variant="invisible" />
          </ActionMenu.Anchor>
          <ActionMenu.Overlay width="small">
            <ActionList selectionVariant="single">
              {THEMES.map((t) => (
                <ActionList.Item key={t.value} selected={t.value === theme} onSelect={() => onTheme(t.value)}>
                  <ActionList.LeadingVisual>
                    <t.icon />
                  </ActionList.LeadingVisual>
                  {t.label}
                </ActionList.Item>
              ))}
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
      </div>

      {local && review && (
        <div className="rv-header__row rv-header__row--sub">
          <RepoLabel root={local.root} />
          {/* onChange (not per-button onClick) keeps the control *controlled*:
              Back/Forward changes the mode without a click, and an uncontrolled
              SegmentedControl would keep lighting up the tab last clicked. */}
          <SegmentedControl aria-label="Режим диффа" size="small" onChange={(i) => review.setMode(MODES[i].value)}>
            {MODES.map((m) => (
              <SegmentedControl.Button key={m.value} selected={m.value === 'commits' ? commitsTab : !commitsTab && local.mode === m.value}>
                {m.label}
              </SegmentedControl.Button>
            ))}
          </SegmentedControl>
          {local.mode === 'base' && <BaseInput value={local.base} onCommit={review.setBase} />}
          <IconButton icon={SyncIcon} aria-label="Перечитать дифф" size="small" onClick={review.reload} />
        </div>
      )}
      {review && review.descriptor.source === 'pr' && (
        <div className="rv-header__row rv-header__row--sub">
          <span className="rv-header__root">
            <MarkGithubIcon size={16} />
            <span className="rv-header__repo">
              {review.descriptor.owner}/{review.descriptor.repo} #{review.descriptor.number}
            </span>
          </span>
          <SegmentedControl aria-label="Режим диффа" size="small" onChange={(i) => review.setPrCommitsView(i === 1)}>
            <SegmentedControl.Button selected={!commitsTab}>Все изменения</SegmentedControl.Button>
            <SegmentedControl.Button selected={commitsTab}>Коммиты</SegmentedControl.Button>
          </SegmentedControl>
          <IconButton icon={SyncIcon} aria-label="Перечитать PR" size="small" onClick={review.reload} />
        </div>
      )}
    </header>
  );
}
