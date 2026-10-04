/** The two things a return to the tab is heard from; a window and a document in the browser. */
type Listenable = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export type ReturnWatch = {
  win: Listenable;
  doc: Listenable & { readonly visibilityState: DocumentVisibilityState };
  now: () => number;
  /** Returns closer together than this are one: switching back fires both events. */
  minGapMs: number;
  onReturn: () => void;
};

/**
 * Calls `onReturn` when the reviewer comes back to the tab: it became visible
 * again, or its window got the focus (another window was on top — the tab was
 * visible all along). Returns the function that stops listening.
 */
export function watchReturn({ win, doc, now, minGapMs, onReturn }: ReturnWatch): () => void {
  let last = Number.NEGATIVE_INFINITY;
  const onBack = () => {
    if (doc.visibilityState !== 'visible') return;
    const at = now();
    if (at - last < minGapMs) return;
    last = at;
    onReturn();
  };
  win.addEventListener('focus', onBack);
  doc.addEventListener('visibilitychange', onBack);
  return () => {
    win.removeEventListener('focus', onBack);
    doc.removeEventListener('visibilitychange', onBack);
  };
}
