import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { Button, Dialog, IconButton } from '@primer/react';
import { DashIcon, PlusIcon } from '@primer/octicons-react';
import { centerView, clampView, fitView, wheelFactor, zoomAt, type Point, type Size, type View } from './mermaidViewport';

// Full-window view of one drawn mermaid diagram: wheel zooms towards the
// pointer, dragging pans. It shows the same data: SVG <img> the document does
// (see mermaidBlocks.ts), so nothing in the diagram can run or load here either.

const BUTTON_STEP = 1.25;
const KEY_PAN = 80;

type Props = {
  /** data: URL of the diagram, as drawn into the document. */
  src: string;
  onClose: () => void;
};

export function MermaidViewer({ src, onClose }: Props) {
  return (
    <Dialog
      title="Диаграмма mermaid"
      width="100vw"
      className="rv-mermaid-viewer"
      style={{ height: 'calc(100dvh - 64px)' }}
      onClose={onClose}
    >
      <Stage src={src} />
    </Dialog>
  );
}

// Separate from the Dialog so that its effects run once the dialog's portal
// has really put the stage into the page.
function Stage({ src }: { src: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<Size | null>(null);
  const [stageSize, setStageSize] = useState<Size | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [dragging, setDragging] = useState(false);
  // True while the view is the fitted one: then a resize of the window refits.
  const fitted = useRef(true);
  const drag = useRef<{ pointer: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setStageSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!image || !stageSize) return;
    setView((current) => (current && !fitted.current ? clampView(current, image, stageSize) : fitView(image, stageSize)));
  }, [image, stageSize]);

  const change = useCallback(
    (next: (current: View) => View) => {
      if (!image || !stageSize) return;
      fitted.current = false;
      setView((current) => current && clampView(next(current), image, stageSize));
    },
    [image, stageSize],
  );

  const fit = useCallback(() => {
    if (!image || !stageSize) return;
    fitted.current = true;
    setView(fitView(image, stageSize));
  }, [image, stageSize]);

  const actualSize = useCallback(() => {
    if (!image || !stageSize) return;
    fitted.current = false;
    setView(centerView(image, stageSize, 1));
  }, [image, stageSize]);

  const zoomCentered = useCallback(
    (factor: number) => {
      if (!stageSize) return;
      const center = { x: stageSize.width / 2, y: stageSize.height / 2 };
      change((current) => zoomAt(current, factor, center));
    },
    [change, stageSize],
  );

  const pointOnStage = (e: { clientX: number; clientY: number }): Point => {
    const box = stage.current!.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };

  // React attaches wheel listeners as passive, and a passive one cannot stop
  // the browser's own Ctrl+wheel page zoom.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const point = pointOnStage(e);
      const factor = wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey);
      change((current) => zoomAt(current, factor, point));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [change]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
      const pan = (dx: number, dy: number) => change((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
      if (e.key === '+' || e.key === '=') zoomCentered(BUTTON_STEP);
      else if (e.key === '-' || e.key === '_') zoomCentered(1 / BUTTON_STEP);
      else if (e.key === '0') fit();
      else if (e.key === '1') actualSize();
      else if (e.key === 'ArrowLeft') pan(KEY_PAN, 0);
      else if (e.key === 'ArrowRight') pan(-KEY_PAN, 0);
      else if (e.key === 'ArrowUp') pan(0, KEY_PAN);
      else if (e.key === 'ArrowDown') pan(0, -KEY_PAN);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [change, zoomCentered, fit, actualSize]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY };
    setDragging(true);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    if (!from || from.pointer !== e.pointerId) return;
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    if (dx === 0 && dy === 0) return;
    drag.current = { pointer: from.pointer, x: e.clientX, y: e.clientY };
    change((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!fitted.current) {
      fit();
      return;
    }
    const point = pointOnStage(e);
    change((current) => zoomAt(current, 1 / current.scale, point));
  };

  return (
    <>
      <div className="rv-mermaid-viewer__toolbar">
        <IconButton size="small" icon={DashIcon} aria-label="Уменьшить" onClick={() => zoomCentered(1 / BUTTON_STEP)} />
        <span className="rv-mermaid-viewer__scale">{view ? `${Math.round(view.scale * 100)}%` : ''}</span>
        <IconButton size="small" icon={PlusIcon} aria-label="Увеличить" onClick={() => zoomCentered(BUTTON_STEP)} />
        <Button size="small" onClick={actualSize}>
          1:1
        </Button>
        <Button size="small" onClick={fit}>
          Вписать
        </Button>
        <span className="rv-hint">Колесо — масштаб, перетаскивание — сдвиг, двойной клик — 1:1 или вписать.</span>
      </div>
      <div
        ref={stage}
        className={dragging ? 'rv-mermaid-viewer__stage rv-mermaid-viewer__stage--dragging' : 'rv-mermaid-viewer__stage'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onDoubleClick={onDoubleClick}
      >
        <img
          className="rv-mermaid-viewer__image"
          src={src}
          alt="Диаграмма mermaid"
          draggable={false}
          onLoad={(e) => setImage({ width: Math.max(1, e.currentTarget.naturalWidth), height: Math.max(1, e.currentTarget.naturalHeight) })}
          style={
            image && view
              ? { width: image.width * view.scale, height: image.height * view.scale, transform: `translate(${view.x}px, ${view.y}px)` }
              : { visibility: 'hidden' }
          }
        />
      </div>
    </>
  );
}
