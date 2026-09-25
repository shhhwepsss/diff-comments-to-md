import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { clampPaneWidth, parsePaneWidth, type PaneWidth } from './sidebarWidth';

// A side pane's width, dragged on its inner edge and remembered per browser:
// the file tree (left of the diff) and the comments panel (right of it).

function readWidth(key: string, pane: PaneWidth): number {
  try {
    return parsePaneWidth(pane, window.localStorage.getItem(key));
  } catch {
    return pane.def;
  }
}

function saveWidth(key: string, width: number) {
  try {
    window.localStorage.setItem(key, String(width));
  } catch {
    // storage blocked — the width just won't survive a reload
  }
}

function useViewportWidth(): number {
  const [viewport, setViewport] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return viewport;
}

/**
 * The stored width is what the user chose; the rendered one is re-clamped to
 * the current viewport, so shrinking the window doesn't forget the choice.
 */
export function usePaneWidth(key: string, pane: PaneWidth): [number, (next: number, persist: boolean) => void] {
  const viewport = useViewportWidth();
  const [chosen, setChosen] = useState(() => readWidth(key, pane));
  const update = useCallback(
    (next: number, persist: boolean) => {
      setChosen(next);
      if (persist) saveWidth(key, next);
    },
    [key],
  );
  return [clampPaneWidth(pane, chosen, viewport), update];
}

type HandleProps = {
  width: number;
  onResize: (next: number, persist: boolean) => void;
  pane: PaneWidth;
  /** Which side of the pane the handle sits on: dragging away from the pane widens it. */
  edge: 'left' | 'right';
  className: string;
};

const DRAGGING = 'rv-dragging-sidebar';

export function ResizeHandle({ width, onResize, pane, edge, className }: HandleProps) {
  const drag = useRef<{ startX: number; startWidth: number; last: number } | null>(null);

  const endDrag = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.body.classList.remove(DRAGGING);
    onResize(d.last, true);
  };

  // Mid-drag unmount (e.g. switching screens) must not leave the cursor stuck.
  useEffect(() => () => document.body.classList.remove(DRAGGING), []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // Otherwise the browser selects text while we drag.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width, last: width };
    document.body.classList.add(DRAGGING);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = event.clientX - d.startX;
    const next = clampPaneWidth(pane, d.startWidth + (edge === 'right' ? dx : -dx), window.innerWidth);
    if (next === d.last) return;
    d.last = next;
    onResize(next, false);
  };

  return (
    <div
      className={className}
      role="separator"
      aria-orientation="vertical"
      title="Потяните, чтобы изменить ширину"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}
