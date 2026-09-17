import { describe, expect, it } from 'vitest';
import { dismissToast, MAX_TOASTS, pushToast, toastDuration, type ToastItem } from './toastQueue';

const err = (message: string) => ({ message, error: true });
const info = (message: string) => ({ message, error: false });

describe('pushToast', () => {
  it('appends a new toast with the given id and a count of one', () => {
    const { list, id } = pushToast([], err('HTTP 500'), 1);
    expect(id).toBe(1);
    expect(list).toEqual([{ id: 1, message: 'HTTP 500', error: true, count: 1 }]);
  });

  it('stacks different messages newest last', () => {
    let list: ToastItem[] = [];
    list = pushToast(list, err('a'), 1).list;
    list = pushToast(list, info('b'), 2).list;
    expect(list.map((t) => t.message)).toEqual(['a', 'b']);
  });

  it('bumps an identical toast instead of stacking it, and moves it to the newest slot', () => {
    let list: ToastItem[] = [];
    list = pushToast(list, err('down'), 1).list;
    list = pushToast(list, err('other'), 2).list;
    const again = pushToast(list, err('down'), 3);
    expect(again.id).toBe(1);
    expect(again.list.map((t) => [t.id, t.count])).toEqual([
      [2, 1],
      [1, 2],
    ]);
  });

  it('treats the same text as a different toast when the kind differs', () => {
    const first = pushToast([], info('same'), 1).list;
    const { list, id } = pushToast(first, err('same'), 2);
    expect(id).toBe(2);
    expect(list).toHaveLength(2);
  });

  it('drops the oldest toasts past the limit', () => {
    let list: ToastItem[] = [];
    for (let i = 1; i <= MAX_TOASTS + 2; i++) list = pushToast(list, err(`e${i}`), i).list;
    expect(list).toHaveLength(MAX_TOASTS);
    expect(list.map((t) => t.id)).toEqual([3, 4, 5]);
  });

  it('does not mutate the list it was given', () => {
    const list = pushToast([], err('a'), 1).list;
    const snapshot = structuredClone(list);
    pushToast(list, err('a'), 2);
    pushToast(list, err('b'), 2);
    expect(list).toEqual(snapshot);
  });
});

describe('dismissToast', () => {
  it('removes only the toast with that id', () => {
    let list: ToastItem[] = [];
    list = pushToast(list, err('a'), 1).list;
    list = pushToast(list, err('b'), 2).list;
    expect(dismissToast(list, 1).map((t) => t.id)).toEqual([2]);
  });

  it('is a no-op for an id that is already gone (a late timer)', () => {
    const list = pushToast([], err('a'), 1).list;
    expect(dismissToast(list, 42)).toEqual(list);
  });
});

describe('toastDuration', () => {
  it('keeps errors on screen longer than info', () => {
    expect(toastDuration(true)).toBeGreaterThan(toastDuration(false));
  });
});
