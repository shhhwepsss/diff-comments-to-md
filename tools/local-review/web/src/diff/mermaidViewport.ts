// Geometry of the full-window diagram viewer: where the diagram sits on the
// stage and how large it is. No DOM here, so it is tested as plain numbers.

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
/** `x`/`y` are the diagram's top-left corner on the stage, in stage pixels. */
export type View = { scale: number; x: number; y: number };

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;

// Free space kept around a fitted diagram.
const FIT_MARGIN = 24;
// How much of the diagram always stays on the stage, so it cannot be lost.
const KEEP_VISIBLE = 48;
const LINE_HEIGHT = 16;
// One wheel event changes the scale at most this many times.
const MAX_WHEEL_STEP = 2;

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function centerView(image: Size, stage: Size, scale: number): View {
  return {
    scale,
    x: (stage.width - image.width * scale) / 2,
    y: (stage.height - image.height * scale) / 2,
  };
}

/** The largest view that shows the whole diagram; a small one is enlarged. */
export function fitView(image: Size, stage: Size): View {
  const scale = Math.min(
    (stage.width - 2 * FIT_MARGIN) / image.width,
    (stage.height - 2 * FIT_MARGIN) / image.height,
  );
  return centerView(image, stage, clampScale(Number.isFinite(scale) ? scale : MIN_SCALE));
}

/** Zooms by `factor`; the part of the diagram under `point` stays under it. */
export function zoomAt(view: View, factor: number, point: Point): View {
  const scale = clampScale(view.scale * factor);
  if (scale === view.scale) return view;
  const ratio = scale / view.scale;
  return {
    scale,
    x: point.x - (point.x - view.x) * ratio,
    y: point.y - (point.y - view.y) * ratio,
  };
}

function clampOffset(offset: number, size: number, stage: number): number {
  const keep = Math.min(KEEP_VISIBLE, size);
  return Math.min(stage - keep, Math.max(keep - size, offset));
}

/** Pulls a view back so that a strip of the diagram is still on the stage. */
export function clampView(view: View, image: Size, stage: Size): View {
  const x = clampOffset(view.x, image.width * view.scale, stage.width);
  const y = clampOffset(view.y, image.height * view.scale, stage.height);
  return x === view.x && y === view.y ? view : { scale: view.scale, x, y };
}

/**
 * Scale change for one wheel event. A trackpad pinch arrives as a wheel event
 * with ctrlKey and a delta of a few pixels, hence the steeper curve for it.
 */
export function wheelFactor(deltaY: number, deltaMode: number, pinch: boolean): number {
  const pixels = deltaMode === 1 ? deltaY * LINE_HEIGHT : deltaY;
  const factor = Math.exp(-pixels * (pinch ? 0.01 : 0.002));
  return Math.min(MAX_WHEEL_STEP, Math.max(1 / MAX_WHEEL_STEP, factor));
}
