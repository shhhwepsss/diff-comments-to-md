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
import './header.css';

const MODES: { value: Mode; label: string }[] = [
  { value: 'working', label: 'Рабочая копия' },
  { value: 'staged', label: 'Staged' },
  { value: 'base', label: 'Base' },
];

const THEMES: { value: ThemePref; label: string; icon: typeof SunIcon }[] = [
  { value: 'auto', label: 'Как в системе', icon: DeviceDesktopIcon },
  { value: 'light', label: 'Светлая', icon: SunIcon },
  { value: 'dark', label: 'Тёмная', icon: MoonIcon },
];

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
          <span className="rv-header__root" title={local.root}>
            <RepoIcon size={16} />
            <span>{local.root}</span>
          </span>
          <SegmentedControl aria-label="Режим диффа" size="small">
            {MODES.map((m) => (
              <SegmentedControl.Button key={m.value} selected={local.mode === m.value} onClick={() => review.setMode(m.value)}>
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
            <span>
              {review.descriptor.owner}/{review.descriptor.repo} #{review.descriptor.number}
            </span>
          </span>
          <IconButton icon={SyncIcon} aria-label="Перечитать PR" size="small" onClick={review.reload} />
        </div>
      )}
    </header>
  );
}
