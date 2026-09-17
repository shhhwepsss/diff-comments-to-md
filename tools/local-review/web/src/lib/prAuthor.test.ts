import { describe, expect, it } from 'vitest';
import { PR_AUTHOR_KEY, parsePrAuthor, readPrAuthor, writePrAuthor } from './prAuthor';

function memoryStore() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

const blocked = {
  getItem: (): string | null => {
    throw new Error('SecurityError');
  },
  setItem: (): void => {
    throw new Error('QuotaExceededError');
  },
};

describe('PR author filter', () => {
  it('only an exact "mine" narrows the list; anything else is all', () => {
    expect(parsePrAuthor('mine')).toBe('mine');
    expect(parsePrAuthor('all')).toBe('all');
    expect(parsePrAuthor(null)).toBe('all');
    expect(parsePrAuthor('')).toBe('all');
    expect(parsePrAuthor('MINE')).toBe('all');
    expect(parsePrAuthor('@me')).toBe('all');
  });

  it('round-trips through storage', () => {
    const store = memoryStore();
    expect(readPrAuthor(store)).toBe('all');
    writePrAuthor('mine', store);
    expect(store.data.get(PR_AUTHOR_KEY)).toBe('mine');
    expect(readPrAuthor(store)).toBe('mine');
    writePrAuthor('all', store);
    expect(readPrAuthor(store)).toBe('all');
  });

  it('blocked storage falls back to all and never throws', () => {
    expect(readPrAuthor(blocked)).toBe('all');
    expect(() => writePrAuthor('mine', blocked)).not.toThrow();
  });

  it('no storage at all (tests run in node) is not an error', () => {
    expect(readPrAuthor()).toBe('all');
    expect(() => writePrAuthor('mine')).not.toThrow();
  });
});
