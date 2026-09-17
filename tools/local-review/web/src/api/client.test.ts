import { describe, expect, it } from 'vitest';
import { commitsListDescriptor, descriptorQuery } from './client';

const local = { source: 'local' as const, root: '/repo', mode: 'working' as const, base: '' };
const pr = { source: 'pr' as const, host: 'github.com', owner: 'o', repo: 'r', number: 25 };

describe('commitsListDescriptor', () => {
  it('asks for the branch history without a range the server would reject', () => {
    // `?mode=commits` out of the address, or a repository with no commits yet:
    // the server needs both ends of the range or answers 400.
    const asked = commitsListDescriptor({ ...local, mode: 'commits' });
    expect(asked).toEqual({ ...local, mode: 'working' });
    expect(new URLSearchParams(descriptorQuery(asked)).get('mode')).toBe('working');
    expect(commitsListDescriptor({ ...local, mode: 'commits', from: 'aaa111' })).toEqual({
      ...local,
      mode: 'working',
      from: 'aaa111',
    });
  });

  it('leaves a resolved range and a PR alone', () => {
    const ranged = { ...local, mode: 'commits' as const, from: 'aaa111', to: 'bbb222' };
    expect(commitsListDescriptor(ranged)).toBe(ranged);
    expect(commitsListDescriptor(local)).toBe(local);
    expect(commitsListDescriptor(pr)).toBe(pr);
    expect(commitsListDescriptor({ ...pr, from: 'aaa111', to: 'bbb222' })).toEqual({ ...pr, from: 'aaa111', to: 'bbb222' });
  });
});
