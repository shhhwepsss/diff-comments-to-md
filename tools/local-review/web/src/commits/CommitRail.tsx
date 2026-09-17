import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Button } from '@primer/react';
import { HistoryIcon } from '@primer/octicons-react';
import { useReview } from '../review/ReviewContext';
import { useToast } from '../lib/toast';
import { copyToClipboard } from '../lib/clipboard';
import { clickSelect, commitRangeCommand, keySelect, selHi, selLo, type CommitSelection } from '../review/commitSelection';
import { commitTooltip, formatCommitWhen } from '../lib/format';
import { CommitDrawer } from './CommitDrawer';
import './commits.css';

// Must match .commit's fixed width in commits.css: the selected-range overlay
// is positioned from indices alone, without measuring the DOM.
const DOT_WIDTH = 150;

/**
 * Geometric hit-test (not elementFromPoint): the connecting line sits on top
 * of the dots during a drag, and the pointer regularly ends up "over" it.
 */
function indexFromX(track: HTMLDivElement, x: number): number {
  const dots = track.querySelectorAll<HTMLButtonElement>('.commit');
  let best = 0;
  let bestDist = Infinity;
  dots.forEach((d, i) => {
    if (bestDist === -1) return;
    const r = d.getBoundingClientRect();
    if (x >= r.left && x <= r.right) {
      best = i;
      bestDist = -1;
      return;
    }
    const dist = x < r.left ? r.left - x : x - r.right;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return best;
}

/**
 * History rail under the header: pick one commit or drag/keyboard a range.
 * Selection rules are in review/commitSelection.ts; this component is wiring
 * (pointer/keyboard events, the drag preview) plus rendering.
 */
export function CommitRail() {
  const review = useReview();
  const toast = useToast();
  const { commits, commitSel, commitsMode } = review;
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Local preview during a drag: avoids a reload on every pointermove, and
  // review.commitSel (the committed selection) resumes once the drag ends.
  const [preview, setPreview] = useState<CommitSelection | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragFrom = useRef<number | null>(null);
  const dragMoved = useRef(false);
  const historyBtnRef = useRef<HTMLButtonElement>(null);

  const sel = preview ?? commitSel;

  const onPointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = (e.target as HTMLElement).closest<HTMLButtonElement>('.commit');
    if (!target) return;
    const i = Number(target.dataset.i);
    dragFrom.current = i;
    dragMoved.current = false;
    trackRef.current?.setPointerCapture(e.pointerId);
    setPreview({ anchor: i, head: i });
  }, []);

  const onPointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (dragFrom.current === null) return;
    const track = trackRef.current;
    if (!track) return;
    const i = indexFromX(track, e.clientX);
    if (i !== dragFrom.current) dragMoved.current = true;
    setPreview({ anchor: dragFrom.current, head: i });
  }, []);

  const finishDrag = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const from = dragFrom.current;
      if (from === null) return;
      const moved = dragMoved.current;
      dragFrom.current = null;
      const track = trackRef.current;
      if (track?.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);
      setPreview(null);
      if (!track || !commitSel) return;
      if (moved) {
        const to = indexFromX(track, e.clientX);
        review.setCommitSelection(from, to);
      } else {
        const next = clickSelect(commitSel, commits.length, from);
        if (next !== commitSel) review.setCommitSelection(next.anchor, next.head);
      }
    },
    [commitSel, commits.length, review],
  );

  const onPointerCancel = useCallback(() => {
    dragFrom.current = null;
    setPreview(null);
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (!commitSel) return;
      const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
      if (!step) return;
      e.preventDefault();
      const next = keySelect(commitSel, commits.length, step, e.shiftKey);
      review.setCommitSelection(next.anchor, next.head);
    },
    [commitSel, commits.length, review],
  );

  const copySha = useCallback(async () => {
    if (!sel) return;
    const l = commits[selLo(sel)];
    const h = commits[selHi(sel)];
    if (!l || !h) return;
    const single = selLo(sel) === selHi(sel);
    const text = single ? l.sha : `${l.sha}..${h.sha}`;
    const ok = await copyToClipboard(text);
    toast(ok ? (single ? `Хеш ${l.short} скопирован` : 'Диапазон скопирован') : 'Не удалось скопировать', !ok);
  }, [sel, commits, toast]);

  if (!commitsMode || commits.length === 0 || !sel) return null;

  const lo = selLo(sel);
  const hi = selHi(sel);
  const n = hi - lo + 1;
  const l = commits[lo];
  const h = commits[hi];
  const single = lo === hi;

  return (
    <section className="rail-wrap">
      <div className="rail-head">
        <div>
          <span className="rail-title">История ветки</span>{' '}
          <span className="rv-hint">{n === 1 ? '· выбран 1 коммит' : `· выбрано коммитов: ${n} из ${commits.length}`}</span>
        </div>
        <div className="rail-actions">
          <code className="rail-cmd">{commitRangeCommand(commits, sel)}</code>
          <Button ref={historyBtnRef} size="small" leadingVisual={HistoryIcon} onClick={() => setDrawerOpen(true)}>
            Вся история
          </Button>
        </div>
      </div>

      <div className="rail" tabIndex={0} role="group" aria-label="Коммиты ветки" onKeyDown={onKeyDown}>
        <div
          className="rail-track"
          ref={trackRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={onPointerCancel}
        >
          <div className="rail-line" />
          <div
            className="rail-line-sel"
            style={{ left: lo * DOT_WIDTH + DOT_WIDTH / 2, width: (hi - lo) * DOT_WIDTH }}
          />
          {commits.map((c, i) => (
            <button
              key={c.sha}
              type="button"
              className={`commit${i >= lo && i <= hi ? ' on' : ''}`}
              data-i={i}
              data-merge={c.merge ? '1' : undefined}
              title={commitTooltip(c)}
            >
              <span className="dot" />
              <span className="subj">{c.subject || '(без сообщения)'}</span>
              <span className="sha">{`${c.short} · ${c.author} · ${formatCommitWhen(c.date)}`}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="rail-sum">
        <span className="sum-sha">{single ? l?.short : `${l?.short}..${h?.short}`}</span>
        <span className="sum-subj" title={single ? (l ? commitTooltip(l) : '') : `${l ? commitTooltip(l) : ''}\n\n—\n\n${h ? commitTooltip(h) : ''}`}>
          {single ? l?.subject : `${l?.subject} … ${h?.subject}`}
        </span>
        <button className="link" type="button" title="Скопировать хеш" onClick={() => void copySha()}>
          &#10697; хеш
        </button>
      </div>
      <p className="rail-hint">
        Клик — один коммит · протяжка мышью — диапазон в любую сторону · наведение — полный текст ·{' '}
        <kbd>&larr;</kbd>
        <kbd>&rarr;</kbd> — перейти, <kbd>Shift</kbd>+<kbd>&larr;</kbd>
        <kbd>&rarr;</kbd> — тянуть диапазон
      </p>

      {drawerOpen && <CommitDrawer onClose={() => setDrawerOpen(false)} returnFocusRef={historyBtnRef} />}
    </section>
  );
}
