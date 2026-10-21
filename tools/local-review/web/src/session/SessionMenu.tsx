import { useState } from 'react';
import { ActionList, AnchoredOverlay, Button, ButtonGroup, CounterLabel, IconButton, ProgressBar } from '@primer/react';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CheckIcon,
  CommentDiscussionIcon,
  CopyIcon,
  DownloadIcon,
  EyeIcon,
  ListOrderedIcon,
  PinIcon,
  PinSlashIcon,
  SkipIcon,
  StopIcon,
  TrashIcon,
  TriangleDownIcon,
} from '@primer/octicons-react';
import { PR_COMPOSE_HASH } from '../lib/hash';
import { displayBinding } from '../lib/keybindings';
import { SessionPrList } from './SessionPrList';
import { freshCount, neighbourIndex, prCount } from './sessionLogic';
import { useSessionView } from './useSessionView';
import './session.css';

/**
 * The session in the header of a PR that belongs to it: ‹ prev, the session's
 * menu, next ›. Nothing else of the session lives on the screen unless the
 * list is pinned — the rest is behind the middle button.
 */
export function SessionMenu({ prevKey, nextKey }: { prevKey: string; nextKey: string }) {
  const view = useSessionView();
  const [open, setOpen] = useState(false);
  const { session, index, done, counts } = view;
  if (!session || index < 0) return null;

  const pr = session.prs[index];
  const prev = neighbourIndex(session, index, -1);
  const next = neighbourIndex(session, index, 1);
  // Comments written in this session settle the PR's status; a mark is for the rest.
  const hasComments = freshCount(counts[pr.number]) > 0;
  const mark = session.marks[pr.number];
  const oldTotal = session.prs.reduce((sum, p) => sum + (counts[p.number]?.old ?? 0), 0);
  const hint = (key: string) => (key ? ` (${displayBinding(key)})` : '');

  // Everything in the menu closes it first: most items open a dialog or another PR.
  const act = (fn: () => void | Promise<void>) => () => {
    setOpen(false);
    void fn();
  };

  return (
    <ButtonGroup className="rv-sess-group" aria-label="Сессия ревью">
      <IconButton
        icon={ChevronLeftIcon}
        size="small"
        aria-label={`Предыдущий PR сессии${hint(prevKey)}`}
        disabled={prev === null}
        onClick={() => prev !== null && view.go(prev)}
      />
      <AnchoredOverlay
        open={open}
        onOpen={() => setOpen(true)}
        onClose={() => setOpen(false)}
        width="medium"
        anchorRef={view.focusRef}
        renderAnchor={(props) => (
          <Button {...props} size="small" trailingAction={TriangleDownIcon} title="Сессия ревью" aria-label={`Сессия ${index + 1}/${session.prs.length}`}>
            <span className="rv-sess-word">Сессия </span>
            {index + 1}/{session.prs.length}
          </Button>
        )}
      >
        <div className="rv-sess-menu">
          <div className="rv-sess-menu__head">
            <span className="rv-sess-menu__title">Сессия ревью</span>
            <span className="rv-hint">
              {done} из {session.prs.length}
            </span>
          </div>
          <ProgressBar
            aria-label="Просмотрено PR-ов"
            progress={session.prs.length ? Math.round((done / session.prs.length) * 100) : 0}
            barSize="small"
          />

          <div className="rv-sess-menu__scroll">
            <SessionPrList onPick={() => setOpen(false)} />
          </div>

          <div className="rv-sess-menu__marks">
            <Button
              size="small"
              leadingVisual={CheckIcon}
              className="rv-sess-mark rv-sess-mark--lgtm"
              aria-pressed={mark === 'lgtm'}
              title={mark === 'lgtm' ? 'Нажми ещё раз, чтобы снять отметку' : undefined}
              disabled={hasComments}
              onClick={act(() => view.mark('lgtm'))}
            >
              Без замечаний
            </Button>
            <Button
              size="small"
              leadingVisual={SkipIcon}
              className="rv-sess-mark rv-sess-mark--skip"
              aria-pressed={mark === 'skip'}
              title={mark === 'skip' ? 'Нажми ещё раз, чтобы снять отметку' : undefined}
              disabled={hasComments}
              onClick={act(() => view.mark('skip'))}
            >
              Пропустить
            </Button>
          </div>
          <div className="rv-hint rv-sess-menu__note">
            {hasComments
              ? `У #${pr.number} есть замечания — отметка не нужна`
              : mark
                ? `#${pr.number} отмечен — повторный клик снимает отметку`
                : next === null
                  ? `Отметка ставится на #${pr.number}`
                  : `Отметка ставится на #${pr.number} и переходит к следующему`}
          </div>

          <ActionList>
            <ActionList.Divider />
            <ActionList.Item onSelect={act(view.openGeneral)}>
              <ActionList.LeadingVisual>
                <CommentDiscussionIcon />
              </ActionList.LeadingVisual>
              Общий комментарий сессии…
              <ActionList.TrailingVisual>
                <CounterLabel>{session.general.length}</CounterLabel>
              </ActionList.TrailingVisual>
            </ActionList.Item>
            <ActionList.Item onSelect={act(() => view.copy('all'))}>
              <ActionList.LeadingVisual>
                <CopyIcon />
              </ActionList.LeadingVisual>
              Скопировать всю сессию
              <ActionList.TrailingVisual>{prCount(session.prs.length)}</ActionList.TrailingVisual>
            </ActionList.Item>
            <ActionList.Item onSelect={act(view.openExport)}>
              <ActionList.LeadingVisual>
                <EyeIcon />
              </ActionList.LeadingVisual>
              Предпросмотр экспорта…
            </ActionList.Item>
            <ActionList.Item onSelect={act(() => view.writeMd('all'))}>
              <ActionList.LeadingVisual>
                <DownloadIcon />
              </ActionList.LeadingVisual>
              Сгенерировать .md сессии
            </ActionList.Item>
            <ActionList.Divider />
            <ActionList.Item onSelect={act(() => view.setPinned(!view.pinned))}>
              <ActionList.LeadingVisual>{view.pinned ? <PinSlashIcon /> : <PinIcon />}</ActionList.LeadingVisual>
              {view.pinned ? 'Открепить список PR-ов' : 'Закрепить список PR-ов сбоку'}
            </ActionList.Item>
            <ActionList.Item
              onSelect={act(() => {
                window.location.hash = PR_COMPOSE_HASH;
              })}
            >
              <ActionList.LeadingVisual>
                <ListOrderedIcon />
              </ActionList.LeadingVisual>
              Изменить состав и порядок…
            </ActionList.Item>
            <ActionList.Item onSelect={act(view.finish)}>
              <ActionList.LeadingVisual>
                <StopIcon />
              </ActionList.LeadingVisual>
              Завершить сессию
            </ActionList.Item>
            <ActionList.Divider />
            <ActionList.Item variant="danger" disabled={oldTotal === 0} onSelect={act(view.openCleanup)}>
              <ActionList.LeadingVisual>
                <TrashIcon />
              </ActionList.LeadingVisual>
              Удалить комментарии прошлой сессии…
              {oldTotal > 0 && (
                <ActionList.TrailingVisual>
                  <CounterLabel>{oldTotal}</CounterLabel>
                </ActionList.TrailingVisual>
              )}
            </ActionList.Item>
          </ActionList>
        </div>
      </AnchoredOverlay>
      <IconButton
        icon={ChevronRightIcon}
        size="small"
        aria-label={`Следующий PR сессии${hint(nextKey)}`}
        disabled={next === null}
        onClick={() => next !== null && view.go(next)}
      />
    </ButtonGroup>
  );
}
