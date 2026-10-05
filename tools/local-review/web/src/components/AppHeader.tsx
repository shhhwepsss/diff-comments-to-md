import { useEffect, useRef, useState } from 'react';
import { ActionList, ActionMenu, AnchoredOverlay, Button, CounterLabel, IconButton, SegmentedControl, TextInput, ToggleSwitch, UnderlineNav } from '@primer/react';
import {
  CodeReviewIcon,
  CommentDiscussionIcon,
  CommentIcon,
  CopyIcon,
  DeviceDesktopIcon,
  DownloadIcon,
  GearIcon,
  MarkGithubIcon,
  MoonIcon,
  RepoIcon,
  ScreenFullIcon,
  SlidersIcon,
  SunIcon,
  SyncIcon,
  TrashIcon,
} from '@primer/octicons-react';
import type { Mode } from '../api/types';
import { settingsHash, type Route } from '../lib/hash';
import type { ThemePref } from '../lib/theme';
import type { ViewMode } from '../lib/viewMode';
import { PRODUCT_NAME, repoName, titleFor } from '../lib/title';
import { useOptionalReview, type Review } from '../review/ReviewContext';
import { generalComments } from '../review/generalComments';
import { GeneralComments } from './GeneralComments';
import { TabbedSelect } from './TabbedSelect';
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

const VIEW_MODES: { value: ViewMode; label: string }[] = [
  { value: 'single', label: 'Один файл' },
  { value: 'all', label: 'Все файлы' },
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

/**
 * Which repository is on screen is the one thing a reviewer must not have to
 * hunt for: a diff of the wrong repo looks exactly like a diff of the right
 * one, only empty. So its name is the first thing in the row and the full path
 * is one hover (or one click) away. The menu is also where the other sources
 * are: what is open and where to open something else live together.
 */
function RepoMenu({ review }: { review: Review }) {
  const d = review.descriptor;
  const name = d.source === 'local' ? repoName(d.root) : `${d.owner}/${d.repo} #${d.number}`;
  const where = d.source === 'local' ? d.root : `github.com/${d.owner}/${d.repo}/pull/${d.number}`;
  return (
    <ActionMenu>
      <ActionMenu.Button
        size="small"
        variant="invisible"
        leadingVisual={d.source === 'local' ? RepoIcon : MarkGithubIcon}
        className="rv-header__repo"
        title={where}
      >
        {name}
      </ActionMenu.Button>
      <ActionMenu.Overlay width="medium">
        <div className="rv-header__where">
          <span className="rv-header__where-label">Открыто</span>
          <span className="rv-header__path">{where}</span>
        </div>
        <ActionList>
          <ActionList.Divider />
          <ActionList.Group>
            <ActionList.GroupHeading>Открыть другое</ActionList.GroupHeading>
            <ActionList.LinkItem href="#/local">
              <ActionList.LeadingVisual>
                <RepoIcon />
              </ActionList.LeadingVisual>
              Папка
            </ActionList.LinkItem>
            <ActionList.LinkItem href="#/pr">
              <ActionList.LeadingVisual>
                <MarkGithubIcon />
              </ActionList.LeadingVisual>
              GitHub PR
            </ActionList.LinkItem>
          </ActionList.Group>
        </ActionList>
      </ActionMenu.Overlay>
    </ActionMenu>
  );
}

/**
 * Everything done to the review as a whole. Rare next to the comments
 * themselves, so it sits behind one button; «Очистить всё» comes last and red,
 * away from the actions that are safe to click by mistake.
 */
function ReviewMenu({ review }: { review: Review }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [generalOpen, setGeneralOpen] = useState(false);
  const general = generalComments(review.comments).length;
  const noComments = review.comments.length === 0;
  return (
    <>
      <ActionMenu anchorRef={anchor}>
        <ActionMenu.Button size="small">
          Ревью
        </ActionMenu.Button>
        <ActionMenu.Overlay width="small" align="end">
          <ActionList>
            <ActionList.Item onSelect={() => setGeneralOpen(true)}>
              <ActionList.LeadingVisual>
                <CommentDiscussionIcon />
              </ActionList.LeadingVisual>
              Общий комментарий…
              {general > 0 && (
                <ActionList.TrailingVisual>
                  <CounterLabel>{general}</CounterLabel>
                </ActionList.TrailingVisual>
              )}
            </ActionList.Item>
            <ActionList.Divider />
            <ActionList.Item disabled={noComments} onSelect={() => void review.copyAll()}>
              <ActionList.LeadingVisual>
                <CopyIcon />
              </ActionList.LeadingVisual>
              Скопировать всё
            </ActionList.Item>
            <ActionList.Item disabled={noComments} onSelect={() => void review.exportMd()}>
              <ActionList.LeadingVisual>
                <DownloadIcon />
              </ActionList.LeadingVisual>
              Сгенерировать .md
            </ActionList.Item>
            <ActionList.Divider />
            <ActionList.Item variant="danger" disabled={noComments} onSelect={() => void review.clearAll()}>
              <ActionList.LeadingVisual>
                <TrashIcon />
              </ActionList.LeadingVisual>
              Очистить всё…
            </ActionList.Item>
          </ActionList>
        </ActionMenu.Overlay>
      </ActionMenu>
      {generalOpen && <GeneralComments review={review} onClose={() => setGeneralOpen(false)} returnFocusRef={anchor} />}
    </>
  );
}

type ViewProps = {
  viewMode: ViewMode | null;
  onViewMode: (mode: ViewMode) => void;
  wrap: boolean;
  onWrap: (on: boolean) => void;
  onZen: (on: boolean) => void;
  /** The Zen shortcut from the settings; '' when none is bound. */
  zenKey: string;
  theme: ThemePref;
  onTheme: (t: ThemePref) => void;
};

/**
 * How the diff is laid out, not which diff it is: one file or all of them, line
 * wrap, Zen, the theme. Set once and left alone, so all of it is one click away
 * instead of on screen.
 */
function ViewMenu({ viewMode, onViewMode, wrap, onWrap, onZen, zenKey, theme, onTheme }: ViewProps) {
  const [open, setOpen] = useState(false);
  return (
    <AnchoredOverlay
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      align="end"
      width="small"
      renderAnchor={(props) => <IconButton {...props} icon={SlidersIcon} aria-label="Вид" size="small" variant="invisible" />}
    >
      <div className="rv-view-menu">
        <div className="rv-view-menu__label">Раскладка</div>
        <SegmentedControl aria-label="Режим просмотра" size="small" fullWidth onChange={(i) => onViewMode(VIEW_MODES[i].value)}>
          {VIEW_MODES.map((m) => (
            <SegmentedControl.Button key={m.value} selected={m.value === viewMode}>
              {m.label}
            </SegmentedControl.Button>
          ))}
        </SegmentedControl>

        <div className="rv-view-menu__row">
          <span id="rv-view-wrap">Перенос строк</span>
          <ToggleSwitch size="small" checked={wrap} onClick={() => onWrap(!wrap)} aria-labelledby="rv-view-wrap" />
        </div>

        <Button
          size="small"
          block
          leadingVisual={ScreenFullIcon}
          alignContent="start"
          onClick={() => {
            setOpen(false);
            onZen(true);
          }}
        >
          Zen: только дифф{zenKey && <span className="rv-file-header__kbd">{zenKey}</span>}
        </Button>

        <div className="rv-view-menu__label">Тема</div>
        <SegmentedControl aria-label="Тема" size="small" fullWidth onChange={(i) => onTheme(THEMES[i].value)}>
          {THEMES.map((t) => (
            <SegmentedControl.IconButton key={t.value} icon={t.icon} aria-label={t.label} selected={t.value === theme} />
          ))}
        </SegmentedControl>
      </div>
    </AnchoredOverlay>
  );
}

type Props = ViewProps & {
  route: Route;
  /** The «all comments» panel beside the diff is open. */
  commentsPanel: boolean;
  /** The panel is on screen: open, and not behind the navigation panel. Defaults to `commentsPanel`. */
  commentsShown?: boolean;
  onCommentsPanel: (open: boolean) => void;
};

export function AppHeader({ route, commentsPanel, commentsShown = commentsPanel, onCommentsPanel, ...view }: Props) {
  const review = useOptionalReview();
  const source = route.screen === 'diff' ? route.descriptor.source : route.screen;
  const local = review && review.descriptor.source === 'local' ? review.descriptor : null;
  const count = review?.comments.length ?? 0;
  const ThemeIcon = THEMES.find((t) => t.value === view.theme)?.icon ?? DeviceDesktopIcon;
  // The «Коммиты» tab lights up on click, not once the history has loaded:
  // otherwise the old tab stays selected for the whole fetch and the click
  // looks ignored.
  const commitsTab = Boolean(review && (review.commitsMode || review.commitsLoading));

  // Settings is a page, not a dialog: the gear is on every screen and carries
  // the current address so «Назад» comes back here.
  const gear = route.screen !== 'settings' && (
    <IconButton
      icon={GearIcon}
      aria-label="Настройки"
      size="small"
      variant="invisible"
      onClick={() => {
        window.location.hash = settingsHash(window.location.hash);
      }}
    />
  );

  if (!review) {
    // The pickers and the settings: nothing is open yet, so the row is the way
    // to a source and the brand says the product's name.
    return (
      <header className="rv-header">
        <div className="rv-header__row">
          <a className="rv-header__brand" href="#/local" title={titleFor(route)} aria-label={PRODUCT_NAME}>
            <CodeReviewIcon size={20} />
            <span>{titleFor(route)}</span>
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
          {gear}
          <TabbedSelect
            label="Тема"
            options={THEMES.map((t) => ({ value: t.value, label: t.label, leading: <t.icon /> }))}
            value={view.theme}
            onChange={view.onTheme}
            renderAnchor={(props) => <IconButton {...props} icon={ThemeIcon} aria-label="Тема" size="small" variant="invisible" />}
          />
        </div>
      </header>
    );
  }

  // A review is open: one row. What is open and which diff of it on the left,
  // what to do with the review on the right; everything rarer is in a menu.
  return (
    <header className="rv-header">
      <div className="rv-header__row">
        <a className="rv-header__brand" href="#/local" title={PRODUCT_NAME} aria-label={PRODUCT_NAME}>
          <CodeReviewIcon size={20} />
        </a>
        <RepoMenu review={review} />

        {/* onChange (not per-button onClick) keeps the control *controlled*:
            Back/Forward changes the mode without a click, and an uncontrolled
            SegmentedControl would keep lighting up the tab last clicked. */}
        {local ? (
          <SegmentedControl aria-label="Режим диффа" size="small" onChange={(i) => review.setMode(MODES[i].value)}>
            {MODES.map((m) => (
              <SegmentedControl.Button key={m.value} selected={m.value === 'commits' ? commitsTab : !commitsTab && local.mode === m.value}>
                {m.label}
              </SegmentedControl.Button>
            ))}
          </SegmentedControl>
        ) : (
          <SegmentedControl aria-label="Режим диффа" size="small" onChange={(i) => review.setPrCommitsView(i === 1)}>
            <SegmentedControl.Button selected={!commitsTab}>Все изменения</SegmentedControl.Button>
            <SegmentedControl.Button selected={commitsTab}>Коммиты</SegmentedControl.Button>
          </SegmentedControl>
        )}
        {local?.mode === 'base' && <BaseInput value={local.base} onCommit={review.setBase} />}
        <IconButton
          icon={SyncIcon}
          aria-label={local ? 'Перечитать дифф' : 'Перечитать PR'}
          size="small"
          variant="invisible"
          onClick={review.reload}
        />

        <div className="rv-header__spacer" />

        <div className="rv-header__actions">
          {/* Opens the panel beside the diff; the count stays in the label. */}
          <Button
            size="small"
            leadingVisual={CommentIcon}
            aria-pressed={commentsShown}
            className={'rv-header__count' + (commentsShown ? ' is-on' : '')}
            title={commentsShown ? 'Закрыть панель комментариев' : 'Все комментарии ревью'}
            // Behind the navigation panel the comments panel is still «open»:
            // the click turns it off, and DiffScreen takes that as «show it».
            onClick={() => onCommentsPanel(!commentsPanel)}
          >
            Комментарии <CounterLabel scheme={count ? 'primary' : undefined}>{count}</CounterLabel>
          </Button>
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
          <ReviewMenu review={review} />
          <ViewMenu {...view} />
          {gear}
        </div>
      </div>
    </header>
  );
}
