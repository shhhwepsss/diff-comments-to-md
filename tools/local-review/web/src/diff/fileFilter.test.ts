import { describe, expect, it } from 'vitest';
import { compileRule, hasRules, matchesSearch, matchesStatus, passesRules, statusKind, toggleStatus, type FileRules, type StatusKind } from './fileFilter';

function rules(include: string, exclude: string): FileRules {
  return { include: compileRule(include).regex, exclude: compileRule(exclude).regex };
}

describe('compileRule', () => {
  it('treats an empty or blank field as no rule', () => {
    expect(compileRule('')).toEqual({ regex: null, error: null });
    expect(compileRule('   ')).toEqual({ regex: null, error: null });
  });

  it('compiles a valid pattern', () => {
    const { regex, error } = compileRule('\\.test\\.ts$');
    expect(error).toBeNull();
    expect(regex?.test('a/b.test.ts')).toBe(true);
  });

  it('reports a broken pattern without the source echoed back', () => {
    const { regex, error } = compileRule('\\.test\\.(ts$');
    expect(regex).toBeNull();
    expect(error).toBeTruthy();
    expect(error).not.toContain('Invalid regular expression');
    expect(error).not.toContain('\\.test');
  });

  it('trims spaces around the pattern', () => {
    const { regex } = compileRule('  ^src/  ');
    expect(regex?.test('src/a.ts')).toBe(true);
    expect(regex?.test(' src/a.ts')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(compileRule('README').regex?.test('readme.md')).toBe(false);
  });

  it('gives a stateless regex, so repeated tests agree', () => {
    const { regex } = compileRule('a');
    expect(regex?.test('a')).toBe(true);
    expect(regex?.test('a')).toBe(true);
  });
});

describe('passesRules', () => {
  it('lets everything through without rules', () => {
    expect(passesRules('any/path.ts', rules('', ''))).toBe(true);
  });

  it('keeps only matching paths when include is set', () => {
    const r = rules('^tools/local-review/web/src/', '');
    expect(passesRules('tools/local-review/web/src/App.tsx', r)).toBe(true);
    expect(passesRules('package.json', r)).toBe(false);
  });

  it('matches anywhere in the path without anchors', () => {
    expect(passesRules('a/FileSidebar.tsx', rules('Sidebar', ''))).toBe(true);
  });

  it('drops excluded paths', () => {
    const r = rules('', '\\.test\\.ts$');
    expect(passesRules('a/b.test.ts', r)).toBe(false);
    expect(passesRules('a/b.ts', r)).toBe(true);
  });

  it('lets exclude win over include', () => {
    const r = rules('^src/', '\\.test\\.ts$');
    expect(passesRules('src/a.test.ts', r)).toBe(false);
    expect(passesRules('src/a.ts', r)).toBe(true);
  });
});

describe('hasRules', () => {
  it('is true when either side is set', () => {
    expect(hasRules(rules('', ''))).toBe(false);
    expect(hasRules(rules('a', ''))).toBe(true);
    expect(hasRules(rules('', 'a'))).toBe(true);
  });

  it('ignores a broken pattern', () => {
    expect(hasRules(rules('(', ''))).toBe(false);
  });
});

describe('matchesSearch', () => {
  it('matches everything on an empty query', () => {
    expect(matchesSearch('a/b.ts', '')).toBe(true);
    expect(matchesSearch('a/b.ts', '  ')).toBe(true);
  });

  it('is a case-insensitive substring match', () => {
    expect(matchesSearch('web/src/FileSidebar.tsx', 'filesidebar')).toBe(true);
    expect(matchesSearch('web/src/FileSidebar.tsx', 'nope')).toBe(false);
  });

  it('takes regexp characters literally', () => {
    expect(matchesSearch('app/[id]/page.tsx', '[id]')).toBe(true);
    expect(matchesSearch('abts', 'a.ts')).toBe(false);
  });
});

describe('statusKind', () => {
  it('groups git statuses the way the sidebar icons do', () => {
    expect(statusKind({ status: 'A' })).toBe('A');
    expect(statusKind({ status: 'M' })).toBe('M');
    expect(statusKind({ status: 'D' })).toBe('D');
    expect(statusKind({ status: 'R100' })).toBe('R');
    expect(statusKind({ status: 'C75' })).toBe('R');
    expect(statusKind({ status: 'T' })).toBe('M');
    expect(statusKind({ status: '' })).toBe('M');
  });

  it('counts an untracked file as added', () => {
    expect(statusKind({ status: 'U', untracked: true })).toBe('A');
    expect(statusKind({ status: '?', untracked: true })).toBe('A');
  });
});

describe('matchesStatus', () => {
  it('passes every file when no status is picked', () => {
    expect(matchesStatus({ status: 'D' }, new Set())).toBe(true);
  });

  it('passes only the picked statuses', () => {
    const kinds = new Set<StatusKind>(['A', 'D']);
    expect(matchesStatus({ status: 'A' }, kinds)).toBe(true);
    expect(matchesStatus({ status: 'D' }, kinds)).toBe(true);
    expect(matchesStatus({ status: 'M' }, kinds)).toBe(false);
    expect(matchesStatus({ status: 'R100' }, kinds)).toBe(false);
  });
});

describe('toggleStatus', () => {
  it('adds and removes a status', () => {
    const one = toggleStatus(new Set(), 'A');
    expect([...one]).toEqual(['A']);
    expect([...toggleStatus(one, 'D')].sort()).toEqual(['A', 'D']);
    expect([...toggleStatus(one, 'A')]).toEqual([]);
  });

  it('keeps only one status, and on a second time shows all again', () => {
    const only = toggleStatus(new Set<StatusKind>(['A', 'M']), 'D', true);
    expect([...only]).toEqual(['D']);
    expect([...toggleStatus(only, 'D', true)]).toEqual([]);
  });

  it('does not change the set it was given', () => {
    const kinds = new Set<StatusKind>(['A']);
    toggleStatus(kinds, 'M');
    expect([...kinds]).toEqual(['A']);
  });
});
