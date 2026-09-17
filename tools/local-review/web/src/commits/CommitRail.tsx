import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Button, Spinner } from '@primer/react';
import { HistoryIcon } from '@primer/octicons-react';
import { useReview } from '../review/ReviewContext';
import { useToast } from '../lib/toast';
import { copyToClipboard } from '../lib/clipboard';
import { clickSelect, commitRangeCommand, keySelect, selHi, selLo, type CommitSelection } from '../review/commitSelection';
import { formatCommitWhen } from '../lib/format';
import type { Commit } from '../api/types';
import { CommitDrawer } from './CommitDrawer';
import './commits.css';

// Must match .commit's fixed width in commits.css: the selected-range overlay
// is positioned from indices alone, without measuring the DOM.
const DOT_WIDTH = 92;
const SKELETON_DOTS = 7;

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
 * Full commit text on hover. The rail clamps subjects to two lines, so this is
 * where a long message is read. Clamped to the viewport so the cards of the
 * first/last commits don't slide off-screen.
 */
function HoverCard({ commit, index, anchor }: { commit: Commit; index: number; anchor: DOMRect }) {
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(anchor.left);
  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth ?? 0;
    setLeft(Math.min(Math.max(8, anchor.left + anchor.width / 2 - w / 2), window.innerWidth - w - 8));
  }, [anchor]);
  return (
    <div ref={ref} className="cr-hovercard" style={{ left, top: anchor.bottom + 8 }} role="tooltip">
      <div className="hc-subj">{commit.subject || '(без сообщения)'}</div>
      {commit.body && <p className="hc-body">{commit.body}</p>}
      <div className="hc-meta">
        <span className="hc-sha">{commit.short}</span>
        {` · коммит ${index + 1}${commit.merge ? ' · мердж' : ''} · ${commit.author} · ${formatCommitWhen(commit.date)}`}
      </div>
    </div>
  );
}

/** Placeholder rail while the history is being fetched. */
function RailSkeleton() {
  return (
    <section className="rail-wrap" aria-busy="true">
      <div className="rail-head">
        <div className="rail-head-title">
          <span className="rail-title">История ветки</span>
          <Spinner size="small" />
          <span className="rv-hint">загружаю коммиты…</span>
        </div>
      </div>
      <div className="rail is-skeleton" aria-hidden="true">
        <div className="rail-track">
          <div className="rail-line" />
          {Array.from({ length: SKELETON_DOTS }, (_, i) => (
            <div key={i} className="commit">
              <span className="dot" />
              <span className="subj">
                <span className="sk-line" />
                <span className="sk-line short" />
              </span>
              <span className="sha">
                <span className="sk-line tiny" />
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * History rail under the header: pick one commit or drag/keyboard a range.
 * Selection rules are in review/commitSelection.ts; this component is wiring
 * (pointer/keyboard events, the drag preview) plus rendering.
 */
export function CommitRail() {
  const review = useReview();
  const toast = useToast();
  const { commits, commitSel, commitsMode, commitsLoading, loading } = review;
  const [hover, setHover] = useState<{ i: number; rect: DOMRect } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Local preview during a drag: avoids a reload on every pointermove, and
  // review.commitSel (the committed selection) resumes once the drag ends.
  const [preview, setPreview] = useState<CommitSelection | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
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
    setHover(null);
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

  // A freshly loaded history selects the latest commit, which sits at the far
  // right of a long rail: scroll it into view instead of leaving it off-screen.
  const selHead = commitSel?.head;
  useEffect(() => {
    const rail = railRef.current;
    if (!rail || selHead === undefined) return;
    rail.scrollLeft = selHead * DOT_WIDTH + DOT_WIDTH / 2 - rail.clientWidth / 2;
    // Only on a new history list, not on every pick the user makes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commits, commitsMode]);

  const showCard = useCallback((i: number, el: HTMLElement) => {
    if (dragFrom.current !== null) return;
    setHover({ i, rect: el.getBoundingClientRect() });
  }, []);
  const hideCard = useCallback(() => setHover(null), []);

  if (commitsLoading && (!commitsMode || commits.length === 0 || !sel)) return <RailSkeleton />;
  if (!commitsMode || commits.length === 0 || !sel) return null;

  const lo = selLo(sel);
  const hi = selHi(sel);
  const n = hi - lo + 1;
  const l = commits[lo];
  const h = commits[hi];
  const single = lo === hi;

  const edgeOrIn = (i: number) => (i === lo || i === hi ? 'edge' : i > lo && i < hi ? 'in' : undefined);
  const previewing = (i: number) => (preview && i >= selLo(preview) && i <= selHi(preview) ? '1' : undefined);
  const hovered = hover ? commits[hover.i] : undefined;
  const rangeText = single ? l?.subject : `от «${l?.subject}» до «${h?.subject}»`;
  const cmd = commitRangeCommand(commits, sel);

  return (
    <section className="rail-wrap">
      <div className="rail-head">
        <div className="rail-head-title">
          <span className="rail-title">История ветки</span>
          <span className="rv-hint">
            {single ? `· коммит ${lo + 1} из ${commits.length}` : `· коммиты ${lo + 1}–${hi + 1} · ${n} шт. из ${commits.length}`}
          </span>
          {(loading || commitsLoading) && <Spinner size="small" aria-label="Загрузка" />}
        </div>
        <div className="rail-actions">
          <code className="rail-cmd" title={cmd}>
            {cmd}
          </code>
          <Button ref={historyBtnRef} size="small" leadingVisual={HistoryIcon} onClick={() => setDrawerOpen(true)}>
            Вся история
          </Button>
        </div>
      </div>

      <div className="rail" ref={railRef} tabIndex={0} role="group" aria-label="Коммиты ветки" onKeyDown={onKeyDown} onScroll={hideCard}>
        <div
          className="rail-track"
          ref={trackRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={onPointerCancel}
        >
          <div className="rail-line" />
          {!preview && n > 1 && (
            <div className="rail-line-sel" style={{ left: lo * DOT_WIDTH + DOT_WIDTH / 2, width: (hi - lo) * DOT_WIDTH }} />
          )}
          {commits.map((c, i) => (
            <button
              key={c.sha}
              type="button"
              tabIndex={-1}
              className="commit"
              data-i={i}
              data-state={preview ? undefined : edgeOrIn(i)}
              data-preview={previewing(i)}
              data-merge={c.merge ? '1' : undefined}
              aria-label={`${c.merge ? 'Мердж-коммит' : 'Коммит'} ${i + 1} ${c.short}: ${c.subject}`}
              onPointerEnter={(e) => {
                if (e.pointerType === 'mouse') showCard(i, e.currentTarget);
              }}
              onPointerLeave={hideCard}
            >
              <span className="idx">{i + 1}</span>
              <span className="dot" />
              <span className="subj">{c.subject || '(без сообщения)'}</span>
              <span className="sha">{c.short}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="rail-sum">
        <span className="sum-sha">{single ? l?.short : `${l?.short}..${h?.short}`}</span>
        <span className="sum-subj" title={rangeText}>
          {rangeText}
        </span>
        <button className="cr-copy" type="button" title={single ? 'Скопировать хеш' : 'Скопировать диапазон A..B'} onClick={() => void copySha()}>
          &#10697; хеш
        </button>
      </div>
      <p className="rail-hint">
        Клик — один коммит · протянуть мышью — диапазон (в любую сторону) · наведение — полный текст коммита · ⧉ — хеш в буфер ·{' '}
        <kbd>&larr;</kbd>
        <kbd>&rarr;</kbd> — перейти, <kbd>Shift</kbd> + <kbd>&larr;</kbd>
        <kbd>&rarr;</kbd> — тянуть диапазон
      </p>

      {hover && hovered && <HoverCard commit={hovered} index={hover.i} anchor={hover.rect} />}
      {drawerOpen && <CommitDrawer onClose={() => setDrawerOpen(false)} returnFocusRef={historyBtnRef} />}
    </section>
  );
}
