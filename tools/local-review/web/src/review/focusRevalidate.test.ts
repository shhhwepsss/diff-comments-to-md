import { describe, expect, it, vi } from 'vitest';
import { watchReturn } from './focusRevalidate';

/** A window and a document that only know how to fire events, and a clock set by hand. */
function setup(minGapMs = 5000) {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  const clock = { now: 100_000 };
  const onReturn = vi.fn();
  const stop = watchReturn({ win, doc, now: () => clock.now, minGapMs, onReturn });
  const show = (state: DocumentVisibilityState) => {
    doc.visibilityState = state;
    doc.dispatchEvent(new Event('visibilitychange'));
  };
  const focus = () => win.dispatchEvent(new Event('focus'));
  return { clock, onReturn, stop, show, focus };
}

describe('watchReturn', () => {
  it('reports the window getting focus', () => {
    const { onReturn, focus } = setup();
    focus();
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('reports the tab becoming visible', () => {
    const { onReturn, show } = setup();
    show('hidden');
    expect(onReturn).not.toHaveBeenCalled();
    show('visible');
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('ignores focus while the tab is hidden', () => {
    const { onReturn, show, focus } = setup();
    show('hidden');
    focus();
    expect(onReturn).not.toHaveBeenCalled();
  });

  it('reports one return once, though both events fire for it', () => {
    const { onReturn, show, focus } = setup();
    show('hidden');
    show('visible');
    focus();
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('stays quiet until the gap since the last report has passed', () => {
    const { clock, onReturn, focus } = setup(5000);
    focus();
    clock.now += 4999;
    focus();
    expect(onReturn).toHaveBeenCalledTimes(1);
    clock.now += 1;
    focus();
    expect(onReturn).toHaveBeenCalledTimes(2);
  });

  it('stops listening once told to', () => {
    const { onReturn, stop, show, focus } = setup();
    stop();
    focus();
    show('visible');
    expect(onReturn).not.toHaveBeenCalled();
  });
});
