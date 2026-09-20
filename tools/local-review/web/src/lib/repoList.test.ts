import { describe, expect, it } from 'vitest';
import { formatRepoPushed, matchesRepo } from './repoList';

describe('formatRepoPushed', () => {
  it('shows the day, month and year of the push', () => {
    expect(formatRepoPushed('2026-09-20T12:12:04Z')).toMatch(/^\d{2}\.\d{2}\.2026$/);
  });

  it.each([null, undefined, '', 'позавчера'])('is empty for %j', (raw) => {
    expect(formatRepoPushed(raw)).toBe('');
  });
});

describe('matchesRepo', () => {
  const name = 'shhhwepsss/diff-comments-to-md';

  it('matches the repository name without its owner', () => {
    expect(matchesRepo(name, 'diff')).toBe(true);
  });

  it('matches the owner', () => {
    expect(matchesRepo(name, 'shhh')).toBe(true);
  });

  it('ignores case and surrounding spaces', () => {
    expect(matchesRepo(name, '  DIFF-Comments ')).toBe(true);
  });

  it('matches everything while the field is empty', () => {
    expect(matchesRepo(name, '   ')).toBe(true);
  });

  it('does not match a name that is not there', () => {
    expect(matchesRepo(name, 'kraken')).toBe(false);
  });
});
