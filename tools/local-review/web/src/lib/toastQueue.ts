// Pure state for the toast stack, kept out of the React provider so it can be
// tested without a DOM. The provider owns ids and timers; this owns the list.

export type ToastItem = { id: number; message: string; error: boolean; count: number };

/** How many toasts are on screen at once; the oldest goes first. */
export const MAX_TOASTS = 3;

export const toastDuration = (error: boolean): number => (error ? 8000 : 5000);

/**
 * Add a toast. The same message (and kind) already on screen is not stacked
 * again: it moves to the newest slot with its count bumped, and the returned
 * id is the existing one so the caller restarts that toast's timer.
 */
export function pushToast(
  list: readonly ToastItem[],
  input: { message: string; error: boolean },
  nextId: number,
  max = MAX_TOASTS,
): { list: ToastItem[]; id: number } {
  const same = list.find((t) => t.message === input.message && t.error === input.error);
  if (same) {
    const bumped = { ...same, count: same.count + 1 };
    return { list: [...list.filter((t) => t.id !== same.id), bumped], id: same.id };
  }
  const added = [...list, { id: nextId, message: input.message, error: input.error, count: 1 }];
  return { list: added.slice(Math.max(0, added.length - max)), id: nextId };
}

export function dismissToast(list: readonly ToastItem[], id: number): ToastItem[] {
  return list.filter((t) => t.id !== id);
}
