import { describe, expect, it } from 'vitest';
import { foundBy, splitMatch, stepActive, tabForQuery } from './tabbedSelect';

const label = (s: string) => s;

describe('tabForQuery', () => {
  it('shows every option while nothing is typed', () => {
    expect(tabForQuery('')).toBe('all');
    expect(tabForQuery('   ')).toBe('all');
  });

  it('shows the matches once something is typed', () => {
    expect(tabForQuery('re')).toBe('found');
  });
});

describe('foundBy', () => {
  const options = ['open', 'closed', 'merged', 'все'];

  it('finds nothing for an empty query', () => {
    expect(foundBy(options, '', label)).toEqual([]);
    expect(foundBy(options, '  ', label)).toEqual([]);
  });

  it('matches anywhere in the text, whatever the case', () => {
    expect(foundBy(options, 'E', label)).toEqual(['open', 'closed', 'merged']);
    expect(foundBy(options, 'osed', label)).toEqual(['closed']);
  });

  it('ignores the spaces around the query', () => {
    expect(foundBy(options, ' все ', label)).toEqual(['все']);
  });

  it('keeps the order of the options', () => {
    expect(foundBy(['b-x', 'a-x'], 'x', label)).toEqual(['b-x', 'a-x']);
  });
});

describe('stepActive', () => {
  it('moves down and up by one', () => {
    expect(stepActive(0, 3, 'ArrowDown')).toBe(1);
    expect(stepActive(2, 3, 'ArrowUp')).toBe(1);
  });

  it('wraps around at both ends', () => {
    expect(stepActive(2, 3, 'ArrowDown')).toBe(0);
    expect(stepActive(0, 3, 'ArrowUp')).toBe(2);
  });

  it('stays put in an empty list', () => {
    expect(stepActive(0, 0, 'ArrowDown')).toBe(0);
    expect(stepActive(0, 0, 'ArrowUp')).toBe(0);
  });

  it('comes back into a list that got shorter', () => {
    expect(stepActive(7, 3, 'ArrowDown')).toBe(0);
  });
});

describe('splitMatch', () => {
  it('cuts the text around the first match, keeping its case', () => {
    expect(splitMatch('Acme/Review-Bot', 'review')).toEqual(['Acme/', 'Review', '-Bot']);
  });

  it('has nothing to cut without a match or a query', () => {
    expect(splitMatch('open', 'x')).toBeNull();
    expect(splitMatch('open', ' ')).toBeNull();
  });
});
