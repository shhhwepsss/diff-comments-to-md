import { describe, expect, it } from 'vitest';
import { MAX_SCALE, MIN_SCALE, centerView, clampView, fitView, wheelFactor, zoomAt } from './mermaidViewport';

describe('fitView', () => {
  it('scales a wide diagram down to the stage, leaving a margin, and centers it', () => {
    expect(fitView({ width: 1000, height: 500 }, { width: 548, height: 448 })).toEqual({ scale: 0.5, x: 24, y: 99 });
  });

  it('fits a tall diagram by its height', () => {
    expect(fitView({ width: 200, height: 1000 }, { width: 648, height: 548 })).toEqual({ scale: 0.5, x: 274, y: 24 });
  });

  it('enlarges a small diagram to fill the stage', () => {
    expect(fitView({ width: 200, height: 100 }, { width: 848, height: 648 })).toEqual({ scale: 4, x: 24, y: 124 });
  });

  it('stays inside the zoom limits', () => {
    expect(fitView({ width: 10, height: 10 }, { width: 848, height: 648 }).scale).toBe(MAX_SCALE);
    expect(fitView({ width: 100000, height: 100 }, { width: 548, height: 448 }).scale).toBe(MIN_SCALE);
  });

  it('survives a stage smaller than its margin', () => {
    const view = fitView({ width: 100, height: 100 }, { width: 10, height: 10 });
    expect(view.scale).toBe(MIN_SCALE);
    expect(Number.isFinite(view.x) && Number.isFinite(view.y)).toBe(true);
  });
});

describe('centerView', () => {
  it('puts the diagram in the middle at the given scale', () => {
    expect(centerView({ width: 400, height: 200 }, { width: 800, height: 600 }, 1)).toEqual({ scale: 1, x: 200, y: 200 });
    expect(centerView({ width: 400, height: 200 }, { width: 800, height: 600 }, 2)).toEqual({ scale: 2, x: 0, y: 100 });
  });
});

describe('zoomAt', () => {
  it('keeps the spot under the pointer where it is', () => {
    expect(zoomAt({ scale: 1, x: 100, y: 50 }, 2, { x: 300, y: 150 })).toEqual({ scale: 2, x: -100, y: -50 });
    expect(zoomAt({ scale: 2, x: -100, y: -50 }, 0.5, { x: 300, y: 150 })).toEqual({ scale: 1, x: 100, y: 50 });
  });

  it('does not move the diagram once the limit is reached', () => {
    const atMax = { scale: MAX_SCALE, x: 10, y: 20 };
    expect(zoomAt(atMax, 2, { x: 300, y: 150 })).toEqual(atMax);
    const atMin = { scale: MIN_SCALE, x: 10, y: 20 };
    expect(zoomAt(atMin, 0.5, { x: 300, y: 150 })).toEqual(atMin);
  });

  it('stops at the limit instead of overshooting', () => {
    expect(zoomAt({ scale: 0.2, x: 0, y: 0 }, 0.1, { x: 0, y: 0 }).scale).toBe(MIN_SCALE);
    expect(zoomAt({ scale: 5, x: 0, y: 0 }, 10, { x: 0, y: 0 }).scale).toBe(MAX_SCALE);
  });
});

describe('clampView', () => {
  const image = { width: 400, height: 200 };
  const stage = { width: 800, height: 600 };

  it('leaves a view that shows the diagram alone', () => {
    const view = { scale: 1, x: 200, y: 200 };
    expect(clampView(view, image, stage)).toEqual(view);
  });

  it('keeps a strip of the diagram on the stage when dragged away', () => {
    expect(clampView({ scale: 1, x: 5000, y: 5000 }, image, stage)).toEqual({ scale: 1, x: 752, y: 552 });
    expect(clampView({ scale: 1, x: -5000, y: -5000 }, image, stage)).toEqual({ scale: 1, x: -352, y: -152 });
  });

  it('counts the zoomed size', () => {
    expect(clampView({ scale: 2, x: -5000, y: -5000 }, image, stage)).toEqual({ scale: 2, x: -752, y: -352 });
  });

  it('keeps a diagram smaller than the strip fully on the stage', () => {
    const tiny = { width: 20, height: 20 };
    expect(clampView({ scale: 1, x: 5000, y: -5000 }, tiny, stage)).toEqual({ scale: 1, x: 780, y: 0 });
  });
});

describe('wheelFactor', () => {
  it('zooms in on wheel up and out on wheel down, by the same step', () => {
    const zoomIn = wheelFactor(-100, 0, false);
    const zoomOut = wheelFactor(100, 0, false);
    expect(zoomIn).toBeGreaterThan(1);
    expect(zoomOut).toBeLessThan(1);
    expect(zoomIn * zoomOut).toBeCloseTo(1);
  });

  it('reads a delta in lines as 16px per line', () => {
    expect(wheelFactor(-3, 1, false)).toBeCloseTo(wheelFactor(-48, 0, false));
  });

  it('is more sensitive for a trackpad pinch, which sends small deltas', () => {
    expect(wheelFactor(-10, 0, true)).toBeGreaterThan(wheelFactor(-10, 0, false));
  });

  it('caps one event so a huge delta cannot jump across the whole range', () => {
    expect(wheelFactor(-100000, 0, false)).toBeLessThanOrEqual(2);
    expect(wheelFactor(100000, 0, true)).toBeGreaterThanOrEqual(0.5);
  });
});
